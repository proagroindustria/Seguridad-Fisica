const express   = require('express');
const router    = express.Router();
const { Pool }  = require('pg');
const axios     = require('axios');
const sharp     = require('sharp');

const poolDoc = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.FACIAL_DB_NAME || 'reconocimiento_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const poolMain = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME || 'permisos_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Comprimir imagen antes de enviar a n8n (máx 1.0 MB para imágenes, PDFs pasan si caben)
async function comprimirBase64(base64, mime) {
  // PDFs: validar tamaño y pasar sin modificar (nginx limite ~1.2 MB)
  if (mime === 'application/pdf') {
    const sizeKB = Math.round(base64.length * 3 / 4 / 1024);
    if (sizeKB > 1100) console.warn(`[COMPRESS] PDF grande: ${sizeKB} KB — puede ser rechazado por nginx`);
    return { base64, mime };
  }
  try {
    const buffer = Buffer.from(base64, 'base64');
    const MAX    = 1000 * 1024; // 1.0 MB — seguro bajo límite nginx
    let quality  = 88;
    const maxDim = 1800; // mayor resolución para que GPT-4o lea texto correctamente

    // 4:4:4 preserva mucho mejor el texto que 4:2:0
    let result = await sharp(buffer)
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, chromaSubsampling: '4:4:4' })
      .toBuffer();

    // Reducir calidad de a 5 pero nunca bajar de 65 (por debajo el texto se distorsiona)
    while (result.length > MAX && quality > 65) {
      quality -= 5;
      result = await sharp(buffer)
        .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, chromaSubsampling: '4:4:4' })
        .toBuffer();
    }

    // Último recurso: reducir dimensión pero mantener calidad legible
    if (result.length > MAX) {
      result = await sharp(buffer)
        .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70, chromaSubsampling: '4:4:4' })
        .toBuffer();
    }

    console.log(`[COMPRESS] ${(buffer.length/1024).toFixed(0)} KB → ${(result.length/1024).toFixed(0)} KB (q${quality})`);
    return { base64: result.toString('base64'), mime: 'image/jpeg' };
  } catch(e) {
    console.error('[COMPRESS] Error:', e.message);
    return { base64, mime };
  }
}

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireContratista(req, res, next) {
  if (req.session?.user?.rol !== 'contratista')
    return res.status(403).json({ error: 'Solo contratistas pueden subir documentos' });
  next();
}
function requireSeguridad(req, res, next) {
  if (req.session?.user?.rol !== 'seguridad_fisica')
    return res.status(403).json({ error: 'Acceso restringido a Seguridad Física' });
  next();
}

// ─── Asegurar tablas ──────────────────────────────
async function initTables() {
  await poolDoc.query(`
    CREATE TABLE IF NOT EXISTS documentos (
      id               SERIAL PRIMARY KEY,
      request_id       UUID NOT NULL DEFAULT gen_random_uuid(),
      empresa          VARCHAR(200) NOT NULL,
      usuario_id       INTEGER,
      doc_type         VARCHAR(20),
      image_base64     TEXT,
      image_mime       VARCHAR(50),
      extracted_json   JSONB,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      estado_validacion VARCHAR(20) DEFAULT 'pendiente',
      validado_por     TEXT,
      validado_en      TIMESTAMPTZ,
      observaciones    TEXT
    );
    CREATE TABLE IF NOT EXISTS etapas (
      id         SERIAL PRIMARY KEY,
      request_id UUID,
      etapa      VARCHAR(50),
      status     VARCHAR(20),
      detalle    TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
initTables().catch(console.error);

// Llamar webhook IMSS vigencia
async function llamarIMSS(request_id, empresa, base64Image, mimeType) {
  const webhookUrl = process.env.N8N_IMSS_URL;
  if (!webhookUrl) return null;
  console.log('[IMSS] Llamando webhook:', webhookUrl);
  try {
    const response = await axios.post(webhookUrl, {
      requestId:  request_id,
      empresa,
      mimeType:   mimeType || 'image/jpeg',
      base64Image,
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    console.log('[IMSS] Respuesta:', JSON.stringify(response.data).slice(0, 200));
    return response.data;
  } catch(e) {
    console.error('[IMSS] Error:', e.response?.data || e.message);
    return null;
  }
}

// Llamar n8n y esperar respuesta con datos extraídos
async function llamarN8N(request_id, empresa, base64Image, mimeType, docType) {
  const webhookUrl = process.env.N8N_DOCUMENTOS_URL;
  if (!webhookUrl) return null;

  const tipoDoc = docType || 'INE';
  console.log('[N8N] Llamando webhook:', webhookUrl, '| docType:', tipoDoc);
  console.log('[N8N] requestId:', request_id, '| empresa:', empresa, '| base64 length:', base64Image?.length);

  try {
    const response = await axios.post(webhookUrl, {
      docType:    tipoDoc,
      requestId:  request_id,
      empresa,
      mimeType:   mimeType || 'image/jpeg',
      base64Image,
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    console.log('[N8N] Respuesta:', JSON.stringify(response.data).slice(0, 200));
    return response.data;
  } catch(e) {
    console.error('[N8N] Error:', e.response?.data || e.message);
    return null;
  }
}

// ─── POST /documentos/subir ───────────────────────
// Body: { archivos: [{ nombre, mime, base64 }] }
router.post('/subir', requireAuth, requireContratista, async (req, res) => {
  const { archivos, empleado_id } = req.body;
  const empresa    = req.session.user.nombre_completo;
  const usuario_id = req.session.user.id;

  if (!archivos || !Array.isArray(archivos) || archivos.length === 0)
    return res.status(400).json({ error: 'No se enviaron archivos' });

  const resultados = [];

  for (const arch of archivos) {
    try {
      // Insertar documento
      const r = await poolDoc.query(
        `INSERT INTO documentos (empresa, usuario_id, image_base64, image_mime, estado_validacion, empleado_id)
         VALUES ($1,$2,$3,$4,'pendiente',$5) RETURNING id, request_id`,
        [empresa, usuario_id, arch.base64, arch.mime || 'image/jpeg', empleado_id || null]
      );
      const { id, request_id } = r.rows[0];

      // Registrar etapa recepción
      await poolDoc.query(
        `INSERT INTO etapas (request_id, etapa, status, detalle) VALUES ($1,'recepcion','ok',$2)`,
        [request_id, `Archivo: ${arch.nombre || 'sin nombre'}, Tamaño: ${Math.round((arch.base64.length * 3/4)/1024)} KB`]
      );

      // Llamar n8n y esperar respuesta con datos extraídos
      await poolDoc.query(
        `INSERT INTO etapas (request_id, etapa, status, detalle) VALUES ($1,'envio_n8n','pending','Enviando a IA...')`,
        [request_id]
      );

      // Comprimir imagen antes de enviar
      const { base64: b64c, mime: mimec } = await comprimirBase64(arch.base64, arch.mime);

      // Si es documento IMSS, usar webhook diferente
      let extracted;
      if (arch.tipo === 'IMSS') {
        const imssData = await llamarIMSS(request_id, empresa, b64c, mimec);
        if (imssData && imssData.ok !== false) {
          extracted = {
            tipo_documento:   'IMSS',
            vigente:          imssData.vigente ?? false,
            estatus:          imssData.estatus || 'DESCONOCIDO',
            fecha_vigencia:   imssData.fecha_vigencia || null,
            nombre_asegurado: imssData.nombre_asegurado || null,
            nss:              imssData.nss || null,
            clinica:          imssData.clinica || null,
            delegacion:       imssData.delegacion || null,
          };
        } else {
          extracted = null;
        }
      } else {
        extracted = await llamarN8N(request_id, empresa, b64c, mimec, arch.tipo || 'INE');
      }

      if (extracted && !extracted.error) {
        // Detectar tipo de documento
           const docType = extracted.tipo_documento ||
            (extracted.nss ? 'IMSS' :
            extracted.clave_elector ? 'INE' :
            extracted.num_acta ? 'ACTA' :
            extracted.numero_pasaporte ? 'PASAPORTE' :
            (extracted.licencia || extracted.numero_licencia || extracted.tipo_licencia) ? 'LICENCIA' :
            extracted.curp && Object.keys(extracted).length < 8 ? 'CURP' : 'INE');




        await poolDoc.query(
          `UPDATE documentos SET extracted_json=$1, doc_type=$2 WHERE id=$3`,
          [JSON.stringify(extracted), docType.toUpperCase(), id]
        );
        await poolDoc.query(
          `UPDATE etapas SET status='ok', detalle=$1 WHERE request_id=$2 AND etapa='envio_n8n'`,
          [`Campos extraídos: ${Object.keys(extracted).length}`, request_id]
        );
        await poolDoc.query(
          `INSERT INTO etapas (request_id, etapa, status, detalle) VALUES ($1,'extraccion_ia','ok',$2)`,
          [request_id, `Tipo: ${docType} | Campos: ${Object.keys(extracted).length}`]
        );

        // Para IMSS: guardar vigencia en empleados y validar automáticamente
        if (extracted.nss || extracted.tipo_documento === 'IMSS') {
          try {
            const nombreIMSS = (extracted.nombre_asegurado || '').trim();
            const vigente    = extracted.vigente === true;

            // Buscar empleado por nombre
            if (nombreIMSS) {
              const partes    = nombreIMSS.split(' ');
              const primerNom = partes[0] || '';
              const empR = await poolDoc.query(
                `SELECT id FROM trabajadores WHERE activo=true AND LOWER(nombre) LIKE $1 LIMIT 1`,
                [`%${primerNom.toLowerCase()}%`]
              );
              if (empR.rows.length > 0) {
                await poolDoc.query(
                  `UPDATE trabajadores SET
                     imss_vigente = $1,
                     imss_estatus = $2,
                     imss_fecha_vigencia = $3,
                     imss_nss = $4
                   WHERE id = $5`,
                  [vigente, extracted.estatus, extracted.fecha_vigencia, extracted.nss, empR.rows[0].id]
                );
              }
            }
            // Auto-aprobar documento IMSS siempre (seguridad lo revisará visualmente)
            await poolDoc.query(
              `UPDATE documentos SET estado_validacion='aprobado', validado_por='Sistema automático', validado_en=NOW() WHERE id=$1`,
              [id]
            );
            await poolDoc.query(
              `INSERT INTO etapas (request_id, etapa, status, detalle) VALUES ($1,'validacion_auto','ok',$2)`,
              [request_id, `IMSS ${vigente ? 'VIGENTE' : 'NO VIGENTE'} — ${extracted.nombre_asegurado || ''}`]
            );
          } catch(imssErr) {
            console.error('Error guardando IMSS:', imssErr.message);
          }
        }

        // Validación automática: buscar si el nombre coincide con empleado activo
        try {
          const nombreDoc   = (extracted.nombre || '').trim().toLowerCase();
          const apellidoDoc = (extracted.apellido_paterno || extracted.apellido || '').trim().toLowerCase();

          if (nombreDoc && apellidoDoc) {
            const empResult = await poolDoc.query(
              `SELECT id, nombre, apellido FROM trabajadores
               WHERE activo = true
                 AND LOWER(nombre) = $1
                 AND LOWER(apellido) LIKE $2
               LIMIT 1`,
              [nombreDoc, `${apellidoDoc}%`]
            );

            if (empResult.rows.length > 0) {
              const emp = empResult.rows[0];
              // Aprobar automáticamente
              await poolDoc.query(
                `UPDATE documentos SET estado_validacion='aprobado', validado_por='Sistema automático', validado_en=NOW()
                 WHERE id=$1`,
                [id]
              );
              await poolDoc.query(
                `INSERT INTO etapas (request_id, etapa, status, detalle) VALUES ($1,'validacion_auto','ok',$2)`,
                [request_id, `Coincide con empleado activo: ${emp.nombre} ${emp.apellido}`]
              );
            } else {
              await poolDoc.query(
                `INSERT INTO etapas (request_id, etapa, status, detalle) VALUES ($1,'validacion_auto','pending',$2)`,
                [request_id, `Sin coincidencia con empleado activo — requiere validación manual`]
              );
            }
          }
        } catch(valErr) {
          console.error('Error validación automática:', valErr.message);
        }

      } else {
        await poolDoc.query(
          `UPDATE etapas SET status='error', detalle='n8n no respondió o hubo un error' WHERE request_id=$1 AND etapa='envio_n8n'`,
          [request_id]
        );
      }

      resultados.push({ id, request_id, nombre: arch.nombre, ok: true });
    } catch(e) {
      console.error('Error subir doc:', e);
      resultados.push({ nombre: arch.nombre, ok: false, error: e.message });
    }
  }

  res.json({ success: true, data: resultados });
});


// ─── GET /documentos/mis-documentos ──────────────
router.get('/mis-documentos', requireAuth, requireContratista, async (req, res) => {
  const empresa = req.session.user.nombre_completo;
  try {
    const r = await poolDoc.query(
      `SELECT id, request_id, doc_type, image_mime, estado_validacion,
              observaciones, created_at, validado_en, extracted_json,
              CASE WHEN image_base64 IS NOT NULL THEN true ELSE false END as tiene_imagen
       FROM documentos WHERE empresa=$1 ORDER BY created_at DESC`,
      [empresa]
    );
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ─── GET /documentos/:id ──────────────────────────
// ─── GET /documentos/por-empleado/:id ────────────
router.get('/por-empleado/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    console.log(`\n[POR-EMPLEADO] ── id recibido: "${id}"`);

    // Verificar si el trabajador es invitado (pase de visita)
    const tRes = await poolDoc.query(
      'SELECT es_invitado, nombre, apellido FROM trabajadores WHERE id=$1',
      [id]
    );
    console.log(`[POR-EMPLEADO] trabajador encontrado en reconocimiento_db: ${tRes.rows.length} fila(s)`);

    if (tRes.rows.length === 0) {
      console.log(`[POR-EMPLEADO] ⚠ No existe trabajador con id=${id}`);
      return res.json({ success: true, data: [] });
    }

    const t = tRes.rows[0];
    console.log(`[POR-EMPLEADO] nombre="${t.nombre}" apellido="${t.apellido}" es_invitado=${t.es_invitado}`);

    if (t.es_invitado) {
      const nombreCompleto = `${t.nombre} ${t.apellido}`.trim();
      console.log(`[POR-EMPLEADO] → Es INVITADO. Buscando en permiso_personal por nombre="${nombreCompleto}"`);

      // Verificar columnas disponibles en permiso_personal
      let columnasDisponibles = [];
      try {
        const colRes = await poolMain.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'permiso_personal' ORDER BY ordinal_position`
        );
        columnasDisponibles = colRes.rows.map(r => r.column_name);
        console.log(`[POR-EMPLEADO] columnas en permiso_personal: ${columnasDisponibles.join(', ')}`);
      } catch(eCol) {
        console.error(`[POR-EMPLEADO] ❌ Error consultando columnas de permiso_personal:`, eCol.message);
      }

      const tieneDocumento = columnasDisponibles.includes('documento');
      console.log(`[POR-EMPLEADO] ¿columna "documento" existe?: ${tieneDocumento}`);

      if (!tieneDocumento) {
        console.log(`[POR-EMPLEADO] ❌ La columna "documento" NO existe en permiso_personal. Devolviendo vacío.`);
        return res.json({ success: true, data: [] });
      }

      // Buscar sin filtro de documento IS NOT NULL para ver todos los registros
      const ppDebug = await poolMain.query(
        `SELECT pp.id, pp.nombre, pp.documento IS NOT NULL as tiene_doc, pp.trabajador_id
         FROM permiso_personal pp
         WHERE LOWER(TRIM(pp.nombre)) = LOWER($1)`,
        [nombreCompleto]
      );
      console.log(`[POR-EMPLEADO] registros en permiso_personal con nombre="${nombreCompleto}": ${ppDebug.rows.length}`);
      ppDebug.rows.forEach((r, i) => {
        console.log(`  [${i}] id=${r.id} nombre="${r.nombre}" tiene_doc=${r.tiene_doc} trabajador_id=${r.trabajador_id}`);
      });

      const ppRes = await poolMain.query(
        `SELECT pp.id, pp.documento, pp.documento_validado, pp.created_at,
                p.folio
         FROM permiso_personal pp
         JOIN permisos p ON p.id = pp.permiso_id
         WHERE LOWER(TRIM(pp.nombre)) = LOWER($1)
           AND pp.documento IS NOT NULL
         ORDER BY pp.id DESC`,
        [nombreCompleto]
      );
      console.log(`[POR-EMPLEADO] registros con documento IS NOT NULL: ${ppRes.rows.length}`);

      const docs = ppRes.rows.map(row => {
        let base64 = row.documento || '';
        let mime   = 'image/jpeg';

        if (base64.startsWith('data:')) {
          const m = base64.match(/^data:([^;]+);base64,(.+)$/);
          if (m) { mime = m[1]; base64 = m[2]; }
        } else {
          if (base64.startsWith('/9j/'))      mime = 'image/jpeg';
          else if (base64.startsWith('iVBOR')) mime = 'image/png';
          else if (base64.startsWith('JVBERi0')) mime = 'application/pdf';
          else if (base64.startsWith('UklGR')) mime = 'image/webp';
        }

        console.log(`[POR-EMPLEADO] doc id=${row.id} folio=${row.folio} mime=${mime} base64_len=${base64.length}`);
        return {
          id:                row.id,
          request_id:        null,
          doc_type:          'CREDENCIAL',
          image_base64:      base64,
          image_mime:        mime,
          extracted_json:    null,
          estado_validacion: row.documento_validado ? 'aprobado' : 'pendiente',
          validado_por:      null,
          observaciones:     row.folio || null,
          created_at:        row.created_at,
        };
      });

      console.log(`[POR-EMPLEADO] ✅ Devolviendo ${docs.length} documento(s) para invitado`);
      return res.json({ success: true, data: docs });
    }

    // Trabajador normal — leer de tabla documentos
    console.log(`[POR-EMPLEADO] → Es trabajador NORMAL. Buscando en documentos WHERE empleado_id=${id}`);
    const r = await poolDoc.query(
      `SELECT id, request_id, doc_type, image_base64, image_mime, extracted_json,
              estado_validacion, validado_por, observaciones, created_at
       FROM documentos WHERE empleado_id=$1 ORDER BY created_at DESC`,
      [id]
    );
    console.log(`[POR-EMPLEADO] ✅ Devolviendo ${r.rows.length} documento(s) para trabajador normal`);
    res.json({ success: true, data: r.rows });
  } catch(e) {
    console.error(`[POR-EMPLEADO] ❌ ERROR:`, e.message);
    console.error(e.stack);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  const user = req.session.user;
  try {
    const r = await poolDoc.query(
      `SELECT id, request_id, empresa, doc_type, image_base64, image_mime,
              extracted_json, estado_validacion, validado_por, validado_en,
              observaciones, created_at
       FROM documentos WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    const doc = r.rows[0];

    // Solo el dueño (contratista) o seguridad puede ver
    if (user.rol === 'contratista' && doc.empresa !== user.nombre_completo)
      return res.status(403).json({ error: 'Sin acceso' });

    // Etapas
    const etapas = await poolDoc.query(
      `SELECT etapa, status, detalle, created_at FROM etapas WHERE request_id=$1 ORDER BY created_at ASC`,
      [doc.request_id]
    );
    res.json({ success: true, data: { ...doc, etapas: etapas.rows } });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── DELETE /documentos/:id ───────────────────────
router.delete('/:id', requireAuth, requireContratista, async (req, res) => {
  const empresa = req.session.user.nombre_completo;
  try {
    const r = await poolDoc.query(
      `SELECT id, empresa, estado_validacion FROM documentos WHERE id=$1`, [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    if (r.rows[0].empresa !== empresa)
      return res.status(403).json({ error: 'Solo puedes eliminar tus propios documentos' });
    if (r.rows[0].estado_validacion === 'aprobado')
      return res.status(400).json({ error: 'No puedes eliminar un documento ya aprobado' });

    await poolDoc.query(`DELETE FROM etapas WHERE request_id=(SELECT request_id FROM documentos WHERE id=$1)`, [req.params.id]);
    await poolDoc.query(`DELETE FROM documentos WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── PUT /documentos/:id/resubir ─────────────────
router.put('/:id/resubir', requireAuth, requireContratista, async (req, res) => {
  const empresa = req.session.user.nombre_completo;
  const { base64, mime, nombre } = req.body;
  try {
    const r = await poolDoc.query(`SELECT empresa, estado_validacion, request_id FROM documentos WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    if (r.rows[0].empresa !== empresa) return res.status(403).json({ error: 'Sin acceso' });
    if (r.rows[0].estado_validacion === 'aprobado')
      return res.status(400).json({ error: 'No puedes reemplazar un documento aprobado' });

    const request_id = r.rows[0].request_id;
    await poolDoc.query(
      `UPDATE documentos SET image_base64=$1, image_mime=$2, estado_validacion='pendiente',
       extracted_json=NULL, doc_type=NULL, validado_por=NULL, validado_en=NULL, observaciones=NULL
       WHERE id=$3`,
      [base64, mime || 'image/jpeg', req.params.id]
    );
    await poolDoc.query(
      `INSERT INTO etapas (request_id, etapa, status, detalle) VALUES ($1,'recepcion','ok',$2)`,
      [request_id, `Actualización: ${nombre || 'sin nombre'}`]
    );
    const extracted2 = await llamarN8N(request_id, empresa, base64, mime);
    if (extracted2 && !extracted2.error) {
      const docType2 = extracted2.tipo_documento || extracted2.doc_type ||
        (extracted2.clave_elector ? 'INE' : extracted2.num_acta ? 'ACTA' :
         extracted2.numero_pasaporte ? 'PASAPORTE' : 'INE');
      await poolDoc.query(
        `UPDATE documentos SET extracted_json=$1, doc_type=$2 WHERE id=$3`,
        [JSON.stringify(extracted2), docType2.toUpperCase(), req.params.id]
      );
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── GET /documentos/empresas/lista (Seguridad Física) ─
router.get('/empresas/lista', requireAuth, requireSeguridad, async (req, res) => {
  try {
    const r = await poolDoc.query(
      `SELECT empresa,
              COUNT(*) as total,
              COUNT(*) FILTER (WHERE estado_validacion='pendiente') as pendientes,
              COUNT(*) FILTER (WHERE estado_validacion='aprobado')  as aprobados,
              COUNT(*) FILTER (WHERE estado_validacion='rechazado') as rechazados,
              MAX(created_at) as ultimo_doc
       FROM documentos
       GROUP BY empresa
       ORDER BY MAX(created_at) DESC`
    );
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── GET /documentos/empresa/:nombre (Seguridad Física) ─
router.get('/empresa/:nombre', requireAuth, requireSeguridad, async (req, res) => {
  try {
    const r = await poolDoc.query(
      `SELECT id, request_id, doc_type, image_mime, estado_validacion,
              observaciones, validado_por, validado_en, created_at,
              CASE WHEN image_base64 IS NOT NULL THEN true ELSE false END as tiene_imagen
       FROM documentos WHERE empresa=$1 ORDER BY created_at DESC`,
      [decodeURIComponent(req.params.nombre)]
    );
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── PUT /documentos/:id/validar (Seguridad Física) ──
router.put('/:id/validar', requireAuth, requireSeguridad, async (req, res) => {
  const { estado, observaciones } = req.body;
  if (!['aprobado','rechazado'].includes(estado))
    return res.status(400).json({ error: 'Estado inválido' });
  try {
    await poolDoc.query(
      `UPDATE documentos SET estado_validacion=$1, validado_por=$2, validado_en=NOW(), observaciones=$3 WHERE id=$4`,
      [estado, req.session.user.nombre_completo, observaciones || null, req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── POST /documentos/procesar-doc ── Procesa credencial con IA sin guardar
router.post('/procesar-doc', requireAuth, async (req, res) => {
  const { base64, mime, nombre, docType } = req.body;
  if (!base64) return res.status(400).json({ success: false, error: 'Archivo requerido' });

  const tipoDoc = docType || 'INE';
  console.log(`[PROCESAR-DOC] docType="${tipoDoc}" | mime="${mime}" | size=${Math.round(base64.length * 3/4 / 1024)} KB`);

  try {
    const { base64: b64c, mime: mimec } = await comprimirBase64(base64, mime);

    // Reintentar hasta 3 veces si n8n falla
    let extracted = null;
    let intentos  = 0;
    const MAX_INTENTOS = 3;

    while (intentos < MAX_INTENTOS) {
      intentos++;
      console.log(`[PROCESAR-DOC] Intento ${intentos}/${MAX_INTENTOS} | docType=${tipoDoc}`);

      const resultado = await llamarN8N('preview-' + Date.now(), req.session.user.nombre_completo, b64c, mimec, tipoDoc);

      if (!resultado || resultado.ok === false) {
        console.warn(`[PROCESAR-DOC] Intento ${intentos} falló:`, resultado?.error || 'sin respuesta');
        if (intentos < MAX_INTENTOS) {
          await new Promise(r => setTimeout(r, 1500 * intentos));
          continue;
        }
        return res.json({ success: false, n8n_no_disponible: true, error: 'Servicio de validación no disponible. El documento se revisará manualmente.' });
      }

      // n8n responde { ok: true, extracted: {...} } o directamente el objeto extraído
      extracted = resultado.extracted || resultado;
      break;
    }

    if (!extracted) return res.json({ success: false, n8n_no_disponible: true, error: 'No se pudo extraer información del documento.' });

    res.json({ success: true, extracted });
  } catch(e) {
    console.error('[PROCESAR-DOC] Error final:', e.message);
    // Devolver 200 con success:false para no generar error rojo en la consola del navegador
    res.json({ success: false, error: e.message });
  }
});

// ─── POST /documentos/procesar-imss ── Procesa vigencia IMSS con IA sin guardar
router.post('/procesar-imss', requireAuth, async (req, res) => {
  const { base64, mime, nombre } = req.body;
  if (!base64) return res.status(400).json({ success: false, error: 'Archivo requerido' });
  try {
    const { base64: b64c, mime: mimec } = await comprimirBase64(base64, mime);
    const imssData = await llamarIMSS('preview-' + Date.now(), req.session.user.nombre_completo, b64c, mimec);
    if (!imssData || imssData.ok === false) throw new Error('Error al procesar vigencia IMSS');
    const extracted = {
      tipo_documento: 'IMSS',
      vigente: imssData.vigente ?? false,
      estatus: imssData.estatus || 'DESCONOCIDO',
      fecha_vigencia: imssData.fecha_vigencia || null,
      nombre_asegurado: imssData.nombre_asegurado || null,
      nss: imssData.nss || null,
      clinica: imssData.clinica || null,
      delegacion: imssData.delegacion || null,
    };
    res.json({ success: true, extracted });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ─── POST /documentos/procesar-tarjeta ──
router.post('/procesar-tarjeta', requireAuth, async (req, res) => {
  const { base64, mime, nombre } = req.body;
  if (!base64) return res.status(400).json({ success: false, error: 'Archivo requerido' });
  try {
    const webhookUrl = process.env.N8N_TARJETA_URL;
    if (!webhookUrl) throw new Error('N8N_TARJETA_URL no configurado');
    const { base64: b64c, mime: mimec } = await comprimirBase64(base64, mime);
    let resultado = null;
    for (let i = 1; i <= 3; i++) {
      try {
        const r = await axios.post(webhookUrl, {
          requestId: 'tarjeta-' + Date.now(),
          mimeType: mimec,
          base64File: b64c
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 60000, maxBodyLength: Infinity });
        if (r.data && !r.data.error) { resultado = r.data; break; }
      } catch(e) {
        console.warn(`[TARJETA] Intento ${i} falló:`, e.message);
        if (i < 3) await new Promise(r => setTimeout(r, 1500 * i));
      }
    }
    if (!resultado) throw new Error('No se pudo procesar la tarjeta de circulación');
    res.json({ success: true, extracted: resultado });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


module.exports = router;
