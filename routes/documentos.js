const express  = require('express');
const router   = express.Router();
const { Pool } = require('pg');
const axios    = require('axios');
const sharp    = require('sharp');

const poolDoc = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.FACIAL_DB_NAME || 'reconocimiento_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Comprimir imagen antes de enviar a n8n (máx 1.2 MB)
async function comprimirBase64(base64, mime) {
  if (mime === 'application/pdf') return { base64, mime };
  try {
    const buffer  = Buffer.from(base64, 'base64');
    const MAX     = 1200 * 1024; // 1.2 MB
    let quality   = 85;
    const maxDim  = mime === 'image/png' ? 2000 : 1600;

    let result = await sharp(buffer)
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, chromaSubsampling: '4:4:4' })
      .toBuffer();

    while (result.length > MAX && quality >= 55) {
      quality -= 8;
      result = await sharp(buffer)
        .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
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
async function llamarN8N(request_id, empresa, base64Image, mimeType) {
  const webhookUrl = process.env.N8N_DOCUMENTOS_URL;
  if (!webhookUrl) return null;

  console.log('[N8N] Llamando webhook:', webhookUrl);
  console.log('[N8N] requestId:', request_id, '| empresa:', empresa, '| base64 length:', base64Image?.length);

  try {
    const response = await axios.post(webhookUrl, {
      docType:    'AUTO',
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
    console.log('[N8N] Respuesta recibida:', JSON.stringify(response.data).slice(0, 200));
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
        extracted = await llamarN8N(request_id, empresa, b64c, mimec);
      }

      if (extracted && !extracted.error) {
        // Detectar tipo de documento
        const docType = extracted.tipo_documento ||
          (extracted.nss ? 'IMSS' :
           extracted.clave_elector ? 'INE' :
           extracted.num_acta ? 'ACTA' :
           extracted.numero_pasaporte ? 'PASAPORTE' :
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
    const r = await poolDoc.query(
      `SELECT id, request_id, doc_type, image_base64, image_mime, extracted_json,
              estado_validacion, validado_por, observaciones, created_at
       FROM documentos WHERE empleado_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: r.rows });
  } catch(e) {
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
  const { base64, mime, nombre } = req.body;
  if (!base64) return res.status(400).json({ success: false, error: 'Archivo requerido' });
  try {
    const { base64: b64c, mime: mimec } = await comprimirBase64(base64, mime);
    const extracted = await llamarN8N('preview-' + Date.now(), req.session.user.nombre_completo, b64c, mimec);
    if (!extracted || extracted.error) throw new Error(extracted?.error || 'Error de extracción');
    res.json({ success: true, extracted });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
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

module.exports = router;
