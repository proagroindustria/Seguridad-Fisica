const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const poolFacial = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.FACIAL_DB_NAME || 'reconocimiento_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// =====================================================
// GENERADOR PDF CON QR POR TRABAJADOR
// =====================================================
const path = require('path');
const fs   = require('fs');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');


async function generarPDFCredenciales(pool, poolFacial, solicitudId) {
  const rSol = await pool.query(`SELECT * FROM permisos WHERE id = $1`, [solicitudId]);
  if (!rSol.rows.length) return;
  const sol = rSol.rows[0];

  const rPersonal = await pool.query(
    `SELECT pp.nombre, pp.num_credencial, pp.categoria
     FROM permiso_personal pp WHERE pp.permiso_id = $1`, [solicitudId]
  );
  if (!rPersonal.rows.length) return;

  const fechaInicio = sol.fecha_inicio ? new Date(sol.fecha_inicio).toLocaleDateString('es-MX') : '';
  const fechaFin    = sol.fecha_fin    ? new Date(sol.fecha_fin).toLocaleDateString('es-MX')    : '';

  const outputDir = path.join(__dirname, '..', 'public', 'credenciales');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const fileName  = `credenciales_${sol.folio || solicitudId}.pdf`;
  const filePath  = path.join(outputDir, fileName);

  const doc = new PDFDocument({ size: 'A4', margin: 20 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Tamaño INE en puntos (1mm = 2.8346pt)
  const cW = 243; // 85.6mm
  const cH = 153; // 54mm
  const colGap = 14;
  const rowGap = 14;
  const cols = 2;
  const marginX = 20;
  const marginY = 20;

  for (let i = 0; i < rPersonal.rows.length; i++) {
    const p = rPersonal.rows[i];

    // Nueva página cada 8 credenciales
    if (i > 0 && i % 8 === 0) doc.addPage();

    const posInPage = i % 8;
    const col = posInPage % cols;
    const row = Math.floor(posInPage / cols);

    const cX = marginX + col * (cW + colGap);
    const cY = marginY + row * (cH + rowGap);

    // Buscar CURP
    let curp = p.num_credencial || '';
    try {
      const rT = await poolFacial.query(
        `SELECT documento_identidad FROM trabajadores WHERE LOWER(nombre || ' ' || apellido) = LOWER($1) LIMIT 1`,
        [p.nombre]
      );
      if (rT.rows.length) curp = rT.rows[0].documento_identidad || curp;
    } catch(e) {}

    // Contenido QR
    const qrData = JSON.stringify({
      folio: sol.folio || String(solicitudId),
      nombre: p.nombre,
      curp,
      empresa: sol.empresa || '',
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      valido: true
    });

    const qrBuffer = await QRCode.toBuffer(qrData, { width: 100, margin: 1 });

    // Borde
    doc.rect(cX, cY, cW, cH).lineWidth(1.5).stroke('#1a1a1a');

    // Header dorado
    doc.rect(cX, cY, cW, 22).fill('#c9a227');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7)
       .text('PROAGRO INDUSTRIA — PASE DE ACCESO', cX, cY + 7, { width: cW, align: 'center' });

    // QR a la derecha
    doc.image(qrBuffer, cX + cW - 88, cY + 26, { width: 82, height: 82 });

    // Info a la izquierda
    doc.fillColor('#555').font('Helvetica-Bold').fontSize(6)
       .text('TRABAJADOR', cX + 8, cY + 27);
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(8)
       .text(p.nombre, cX + 8, cY + 36, { width: 148 });

    doc.fillColor('#555').font('Helvetica-Bold').fontSize(6)
       .text('CURP', cX + 8, cY + 58);
    doc.fillColor('#000').font('Helvetica').fontSize(6.5)
       .text(curp || '—', cX + 8, cY + 66, { width: 148 });

    doc.fillColor('#555').font('Helvetica-Bold').fontSize(6)
       .text('FOLIO', cX + 8, cY + 78);
    doc.fillColor('#000').font('Helvetica').fontSize(7)
       .text(sol.folio || String(solicitudId), cX + 8, cY + 86);

    doc.fillColor('#555').font('Helvetica-Bold').fontSize(6)
       .text('EMPRESA', cX + 8, cY + 97);
    doc.fillColor('#000').font('Helvetica').fontSize(7)
       .text(sol.empresa || '—', cX + 8, cY + 105, { width: 148 });

    // Footer con fechas
    doc.rect(cX, cY + cH - 22, cW, 22).fill('#f5f5f5');
    doc.fillColor('#555').font('Helvetica-Bold').fontSize(6)
       .text(`VÁLIDO: ${fechaInicio} — ${fechaFin}`, cX, cY + cH - 13, { width: cW, align: 'center' });
  }

  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });
  console.log(`[PDF QR] Generado: ${fileName} (${rPersonal.rows.length} trabajadores)`);
}





// =====================================================
// WEBHOOK N8N — dispara cuando la solicitud queda Activo
// =====================================================
async function dispararWebhookN8N(pool, solicitud_id) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) return; // Si no está configurado, no hace nada

  try {
    const [rP, rPer, rVeh, rEq] = await Promise.all([
      pool.query('SELECT * FROM vista_permisos WHERE id=$1', [solicitud_id]),
      pool.query('SELECT * FROM permiso_personal  WHERE permiso_id=$1 ORDER BY id', [solicitud_id]),
      pool.query('SELECT * FROM permiso_vehiculos WHERE permiso_id=$1 ORDER BY id', [solicitud_id]),
      pool.query('SELECT * FROM permiso_equipos   WHERE permiso_id=$1 ORDER BY id', [solicitud_id]),
    ]);
    
    const payload = {
      solicitud:   rP.rows[0],
      personal:  rPer.rows,
      vehiculos: rVeh.rows,
      equipos:   rEq.rows,
    };

    // Node.js nativo fetch (v18+) o usar http module
    const https = require('https');
    const http  = require('http');
    const url   = new URL(webhookUrl);
    const body  = JSON.stringify(payload);
    const lib   = url.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      console.log(`✅ Webhook N8N disparado: ${res.statusCode}`);
    });
    req.on('error', e => console.error('❌ Error webhook N8N:', e.message));
    req.write(body);
    req.end();

  } catch(e) {
    console.error('❌ Error preparando webhook N8N:', e.message);
  }
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

const ESTADO_LABEL = {
  borrador:             'Borrador',
  en_espera_area:       'En espera del Área',
  aprobado_area:        'Aprobado por Área',
  en_espera_seguridad:  'En espera de Seguridad',
  activo:               'Activo',
  rechazado:            'Rechazado',
  vencido:              'Vencido'
};

// Modo offline
let solicitudesMemoria = [];
let historialMemoria = [];
let contadorFolio = 1;

function generarFolioOffline() {
  const año = new Date().getFullYear();
  return `SOL-${año}-${String(contadorFolio++).padStart(4, '0')}`;
}

function puedeAprobar(rol, estado) {
  if (rol === 'area'             && estado === 'en_espera_area')      return true;
  if (rol === 'seguridad_fisica' && estado === 'en_espera_seguridad') return true;
  return false;
}

function puedeRechazar(rol, estado) {
  return puedeAprobar(rol, estado);
}

// =====================================================
// GET /solicitudes
// =====================================================
router.get('/', requireAuth, (req, res) => {
  const offline = process.env.OFFLINE_MODE !== 'false';
  if (offline) {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    solicitudesMemoria.forEach(p => {
      if (p.estado === 'activo' && new Date(p.fecha_fin) < hoy) p.estado = 'vencido';
    });
    return res.json({ success: true, data: solicitudesMemoria });
  }

  const pool = require('../db/connection');
  pool.query('SELECT * FROM vista_permisos ORDER BY creado_en DESC')
    .then(r => res.json({ success: true, data: r.rows }))
    .catch(e => res.status(500).json({ success: false, error: e.message }));
});

// =====================================================
// POST /solicitudes — crear
// =====================================================
router.post('/', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.rol !== 'contratista')
    return res.status(403).json({ success: false, error: 'Solo contratistas pueden crear solicitudes.' });

  const { empresa, contrato, fecha_inicio, fecha_fin, secciones } = req.body;
  if (!empresa || !contrato || !fecha_inicio || !fecha_fin)
    return res.status(400).json({ success: false, error: 'Todos los campos son requeridos.' });

  const fi = new Date(fecha_inicio), ff = new Date(fecha_fin);
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const fiSoloFecha = new Date(fecha_inicio + 'T12:00:00');
const hoySoloFecha = new Date(); hoySoloFecha.setHours(0,0,0,0);
if (fiSoloFecha < hoySoloFecha) return res.status(400).json({ success: false, error: 'La fecha de inicio no puede ser anterior a hoy.' });
  if (ff <= fi)   return res.status(400).json({ success: false, error: 'La fecha fin debe ser posterior al inicio.' });
  if (Math.ceil((ff - fi) / (1000*60*60*24)) > 30)
    return res.status(400).json({ success: false, error: 'El período no puede exceder 30 días.' });

  const offline = process.env.OFFLINE_MODE !== 'false';

  // ---- MODO OFFLINE ----
  if (offline) {
    const nuevo = {
      id: solicitudesMemoria.length + 1,
      folio: generarFolioOffline(),
      empresa: empresa.trim(), contrato: contrato.trim(),
      responsable_contrato: 'PROAGRO',
      fecha_inicio, fecha_fin,
      estado: 'en_espera_area',
      creado_por: user.id, creado_por_username: user.username,
      secciones: secciones || {},
      creado_en: new Date().toISOString()
    };
    solicitudesMemoria.unshift(nuevo);
    return res.json({ success: true, data: nuevo });
  }

  // ---- MODO POSTGRESQL ----
  const pool = require('../db/connection');
  try {
    // 1. Insertar con folio temporal para obtener el ID real
    const { responsable_contrato, responsable1, responsable2 } = req.body;
    const r1 = await pool.query(
      `INSERT INTO permisos (folio, empresa, contrato, responsable_contrato, responsable1, responsable2, fecha_inicio, fecha_fin, estado, creado_por, fecha_envio)
      VALUES ('TEMP', $1, $2, $3, $4, $5, $6, $7, 'en_espera_area', $8, NOW()) RETURNING id`,
      [empresa.trim(), contrato.trim(), responsable_contrato || 'PROAGRO', responsable1||null, responsable2||null, fecha_inicio, fecha_fin, user.id]
    );
    
    const newId = r1.rows[0].id;

    // 2. Actualizar con folio definitivo usando el ID real (sin duplicados)
    const año = new Date().getFullYear();
    const folio = `SOL-${año}-${String(newId).padStart(4, '0')}`;
    const r2 = await pool.query(
      'UPDATE permisos SET folio=$1 WHERE id=$2 RETURNING *',
      [folio, newId]
    );
    const solicitud = r2.rows[0];
    const pid = solicitud.id;
    const sec = secciones || {};

    // 3. Insertar personal
    if (sec.personal && Array.isArray(sec.personal)) {
      for (const p of sec.personal) {
        if (!p.nombre && !p.num_credencial) continue;
        await pool.query(
          `INSERT INTO permiso_personal (permiso_id, num_credencial, nombre, categoria, observaciones)
           VALUES ($1,$2,$3,$4,$5)`,
          [pid, p.num_credencial||null, p.nombre||null, p.categoria||null, p.observaciones||null]
        );
      }
    }

    // 4. Insertar vehículos
if (sec.vehiculo && Array.isArray(sec.vehiculo)) {
  for (const v of sec.vehiculo) {
    if (!v.marca && !v.placas) continue;

    const segExt  = v.seguro_extracted  || {};
    const licExt  = v.licencia_extracted || {};

    await pool.query(
      `INSERT INTO permiso_vehiculos 
        (permiso_id, marca, modelo, placas, seguro, licencia,
         seguro_poliza, seguro_aseguradora, seguro_vigencia_inicio, seguro_vigencia_fin, seguro_vigente,
         licencia_nombre, licencia_numero, licencia_tipo, licencia_vigencia_fin, licencia_vigente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        pid,
        v.marca    || null,
        v.modelo   || null,
        v.placas   || null,
        v.seguro   || null,
        v.licencia || null,
        segExt.numero_poliza   || null,
        segExt.aseguradora     || null,
        segExt.vigencia_inicio || null,
        segExt.vigencia_fin    || null,
        segExt.vigente         ?? null,
        licExt.nombre_conductor || null,
        licExt.numero_licencia  || null,
        licExt.tipo_licencia    || null,
        licExt.vigencia_fin     || null,
        licExt.vigente          ?? null,
      ]
    );
  }
}
    // 5. Insertar equipos
    if (sec.equipo && Array.isArray(sec.equipo)) {
      for (const e of sec.equipo) {
        if (!e.descripcion && !e.cantidad) continue;
        await pool.query(
          `INSERT INTO permiso_equipos (permiso_id, cantidad, descripcion, marca, modelo, serie, observaciones)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [pid, parseInt(e.cantidad)||1, e.descripcion||null, e.marca||null,
           e.modelo||null, e.serie||null, e.observaciones||null]
        );
      }
    }

    return res.json({ success: true, data: solicitud });

  } catch(e) {
    console.error('Error creando solicitud:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =====================================================
// PUT /solicitudes/:id/aprobar
// =====================================================
router.put('/:id/aprobar', requireAuth, async (req, res) => {
  const user = req.session.user;
  const id = parseInt(req.params.id);
  const offline = process.env.OFFLINE_MODE !== 'false';

  if (offline) {
    const p = solicitudesMemoria.find(x => x.id === id);
    if (!p) return res.status(404).json({ success: false, error: 'Solicitud no encontrado.' });
    if (!puedeAprobar(user.rol, p.estado))
      return res.status(403).json({ success: false, error: `No puedes aprobar una solicitud en estado "${ESTADO_LABEL[p.estado]}".` });
    if (user.rol === 'area') {
      p.estado = 'en_espera_seguridad';
      p.aprobado_por_area = user.username;
    } else {
      p.estado = 'activo';
      p.aprobado_por_seguridad = user.username;
    }
    return res.json({ success: true, data: p });
  }

  const pool = require('../db/connection');
  try {
    const r = await pool.query('SELECT * FROM permisos WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Solicitud no encontrado.' });
    const p = r.rows[0];
    if (!puedeAprobar(user.rol, p.estado))
      return res.status(403).json({ success: false, error: `No puedes aprobar una solicitud en estado "${ESTADO_LABEL[p.estado]}".` });

    let query, params;
    if (user.rol === 'area') {
      query = `UPDATE permisos SET estado='en_espera_seguridad', aprobado_por_area=$1, fecha_aprobacion_area=NOW() WHERE id=$2 RETURNING *`;
      params = [user.id, id];
    } else {
      query = `UPDATE permisos SET estado='activo', aprobado_por_seguridad=$1, fecha_aprobacion_seg=NOW() WHERE id=$2 RETURNING *`;
      params = [user.id, id];
    }
    const r2 = await pool.query(query, params);

    // Disparar webhook N8N si Seguridad acaba de aprobar (solicitud = activo)
    if (user.rol === 'seguridad_fisica') {
      dispararWebhookN8N(pool, id);
      // Generar PDF con QR por trabajador (async, no bloquea respuesta)
      generarPDFCredenciales(pool, poolFacial, id).catch(e => console.error('[PDF QR] Error:', e.message));
    }

    return res.json({ success: true, data: r2.rows[0] });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =====================================================
// PUT /solicitudes/:id/rechazar
// =====================================================
router.put('/:id/rechazar', requireAuth, async (req, res) => {
  const user = req.session.user;
  const id = parseInt(req.params.id);
  const { motivo } = req.body;
  const offline = process.env.OFFLINE_MODE !== 'false';

  if (offline) {
    const p = solicitudesMemoria.find(x => x.id === id);
    if (!p) return res.status(404).json({ success: false, error: 'Solicitud no encontrado.' });
    if (!puedeRechazar(user.rol, p.estado))
      return res.status(403).json({ success: false, error: `No puedes rechazar una solicitud en estado "${ESTADO_LABEL[p.estado]}".` });
    p.estado = 'rechazado';
    p.rechazado_por = user.username;
    p.motivo_rechazo = motivo || null;
    return res.json({ success: true, data: p });
  }

  const pool = require('../db/connection');
  try {
    const r = await pool.query('SELECT * FROM permisos WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Solicitud no encontrado.' });
    const p = r.rows[0];
    if (!puedeRechazar(user.rol, p.estado))
      return res.status(403).json({ success: false, error: `No puedes rechazar una solicitud en estado "${ESTADO_LABEL[p.estado]}".` });
    const r2 = await pool.query(
      `UPDATE permisos SET estado='rechazado', rechazado_por=$1, motivo_rechazo=$2, fecha_rechazo=NOW() WHERE id=$3 RETURNING *`,
      [user.id, motivo||null, id]
    );
    return res.json({ success: true, data: r2.rows[0] });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =====================================================
// GET /solicitudes/:id/historial
// =====================================================
router.get('/:id/historial', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const offline = process.env.OFFLINE_MODE !== 'false';
  if (offline) {
    return res.json({ success: true, data: historialMemoria.filter(x => x.solicitud_id === id) });
  }
  const pool = require('../db/connection');
  pool.query(
    `SELECT h.*, u.nombre_completo AS usuario_nombre FROM permiso_historial h
     LEFT JOIN usuarios u ON h.cambiado_por = u.id
     WHERE h.permiso_id=$1 ORDER BY h.creado_en ASC`, [id]
  ).then(r => res.json({ success: true, data: r.rows }))
   .catch(e => res.status(500).json({ success: false, error: e.message }));
});

// =====================================================
// GET /solicitudes/:id — detalle completo
// =====================================================
router.get('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const offline = process.env.OFFLINE_MODE !== 'false';

  if (offline) {
    const p = solicitudesMemoria.find(x => x.id === id);
    if (!p) return res.status(404).json({ success: false, error: 'No encontrado.' });
    return res.json({ success: true, data: { solicitud: p, personal: [], vehiculos: [], equipos: [] } });
  }

  const pool = require('../db/connection');
  try {
    const [rP, rPer, rVeh, rEq] = await Promise.all([
      pool.query('SELECT * FROM vista_permisos WHERE id=$1', [id]),
      pool.query('SELECT * FROM permiso_personal WHERE permiso_id=$1 ORDER BY id', [id]),
      pool.query('SELECT * FROM permiso_vehiculos WHERE permiso_id=$1 ORDER BY id', [id]),
      pool.query('SELECT * FROM permiso_equipos   WHERE permiso_id=$1 ORDER BY id', [id]),
    ]);
    if (!rP.rows.length) return res.status(404).json({ success: false, error: 'No encontrado.' });

    // Enriquecer personal con datos IMSS desde reconocimiento_db
    const personal = rPer.rows;
    try {
      for (const p of personal) {
        if (!p.nombre) continue;
        const primerNombre = p.nombre.trim().split(' ')[0].toLowerCase();
        const empR = await poolFacial.query(
          `SELECT imss_vigente, imss_estatus, imss_fecha_vigencia, imss_nss
           FROM trabajadores
           WHERE activo=true AND LOWER(nombre) LIKE $1 LIMIT 1`,
          [`%${primerNombre}%`]
        );
        if (empR.rows.length > 0) {
          p.imss_vigente        = empR.rows[0].imss_vigente;
          p.imss_estatus        = empR.rows[0].imss_estatus;
          p.imss_fecha_vigencia = empR.rows[0].imss_fecha_vigencia;
          p.imss_nss            = empR.rows[0].imss_nss;
        }
      }
    } catch(imssErr) {
      console.error('Error enriqueciendo IMSS:', imssErr.message);
    }

    
      // Enriquecer personal con imágenes de documentos
      try {
        for (const p of personal) {
          if (!p.nombre) continue;
          const partes = p.nombre.trim().toLowerCase().split(' ');
          const primerNombre = partes[0];
          const docResult = await poolFacial.query(`
            SELECT t.id,
              dc.image_base64 as cred_base64, dc.image_mime as cred_mime,
              di.image_base64 as imss_base64, di.image_mime as imss_mime
            FROM trabajadores t
            LEFT JOIN documentos dc ON dc.empleado_id = t.id 
              AND dc.doc_type IN ('INE','PASAPORTE')
            LEFT JOIN documentos di ON di.empleado_id = t.id 
              AND di.doc_type = 'IMSS'
            WHERE LOWER(t.nombre) LIKE $1
            LIMIT 1
          `, [`%${primerNombre}%`]);
          if (docResult.rows.length > 0) {
            p.cred_base64 = docResult.rows[0].cred_base64 || null;
            p.cred_mime   = docResult.rows[0].cred_mime   || 'image/jpeg';
            p.imss_base64 = docResult.rows[0].imss_base64 || null;
            p.imss_mime   = docResult.rows[0].imss_mime   || 'image/jpeg';
          }
        }
      } catch(e) {
        console.error('Error enriqueciendo docs personal:', e.message);
      }

      return res.json({
        success: true,
        data: {
          solicitud:   rP.rows[0],
          personal,
          vehiculos: rVeh.rows,
          equipos:   rEq.rows,
        }
      });

  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});


// =====================================================
// POST /solicitudes/:id/salida — registrar salida
// Solo seguridad_fisica, solo solicitudes activos
// =====================================================
router.post('/:id/salida', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.rol !== 'seguridad_fisica')
    return res.status(403).json({ success: false, error: 'Solo Seguridad Física puede registrar salidas.' });

  const solicitud_id = parseInt(req.params.id);
  const { tipo_item, item_id, cantidad, observaciones } = req.body;

  if (!tipo_item || !item_id)
    return res.status(400).json({ success: false, error: 'Datos incompletos.' });

  const offline = process.env.OFFLINE_MODE !== 'false';
  if (offline) {
    // En offline guardamos en memoria
    if (!global.bitacoraMemoria) global.bitacoraMemoria = [];
    const reg = {
      id: global.bitacoraMemoria.length + 1,
      permiso_id, tipo_item,
      item_id: parseInt(item_id),
      cantidad: parseInt(cantidad) || 1,
      observaciones: observaciones || null,
      registrado_por_username: user.username,
      registrado_en: new Date().toISOString()
    };
    global.bitacoraMemoria.push(reg);
    return res.json({ success: true, data: reg });
  }

  const pool = require('../db/connection');
  try {
    // Validar que la solicitud esté activo
    const rP = await pool.query('SELECT estado FROM permisos WHERE id=$1', [solicitud_id]);
    if (!rP.rows.length) return res.status(404).json({ success: false, error: 'Solicitud no encontrado.' });
    if (rP.rows[0].estado !== 'activo')
      return res.status(400).json({ success: false, error: 'Solo se pueden registrar salidas en solicitudes activos.' });

    // Validar cantidad disponible para equipos
    if (tipo_item === 'equipo') {
      const rEq = await pool.query('SELECT cantidad FROM permiso_equipos WHERE id=$1 AND solicitud_id=$2', [item_id, solicitud_id]);
      if (!rEq.rows.length) return res.status(404).json({ success: false, error: 'Equipo no encontrado.' });
      const rSalidas = await pool.query(
        'SELECT COALESCE(SUM(cantidad),0) AS total FROM bitacora_salidas WHERE item_id=$1 AND tipo_item=$2',
        [item_id, 'equipo']
      );
      const yaRegistrado = parseInt(rSalidas.rows[0].total);
      const cantMax = rEq.rows[0].cantidad;
      const cantPedir = parseInt(cantidad) || 1;
      if (yaRegistrado + cantPedir > cantMax)
        return res.status(400).json({ success: false, error: `Solo quedan ${cantMax - yaRegistrado} unidades disponibles.` });
    }

    const r = await pool.query(
      `INSERT INTO bitacora_salidas (permiso_id, tipo_item, item_id, cantidad, observaciones, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [permiso_id, tipo_item, parseInt(item_id), parseInt(cantidad)||1, observaciones||null, user.id]
    );
    return res.json({ success: true, data: r.rows[0] });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =====================================================
// GET /solicitudes/:id/bitacora — obtener bitácora completa
// =====================================================
router.get('/:id/bitacora', requireAuth, async (req, res) => {
  const solicitud_id = parseInt(req.params.id);
  const offline = process.env.OFFLINE_MODE !== 'false';

  if (offline) {
    const data = (global.bitacoraMemoria || []).filter(x => x.solicitud_id === solicitud_id);
    return res.json({ success: true, data });
  }

  const pool = require('../db/connection');
  try {
    const r = await pool.query(
      `SELECT b.*, u.nombre_completo AS registrado_por_nombre,
        CASE b.tipo_item
          WHEN 'personal' THEN pp.nombre
          WHEN 'vehiculo' THEN CONCAT(pv.marca,' ',pv.modelo,' - ',pv.placas)
          WHEN 'equipo'   THEN pe.descripcion
        END AS item_descripcion,
        CASE b.tipo_item
          WHEN 'personal' THEN pp.num_credencial
          WHEN 'vehiculo' THEN pv.placas
          WHEN 'equipo'   THEN CAST(pe.cantidad AS TEXT)
        END AS item_referencia
       FROM bitacora_salidas b
       LEFT JOIN usuarios u           ON b.registrado_por = u.id
       LEFT JOIN permiso_personal pp  ON b.tipo_item='personal' AND b.item_id = pp.id
       LEFT JOIN permiso_vehiculos pv ON b.tipo_item='vehiculo' AND b.item_id = pv.id
       LEFT JOIN permiso_equipos pe   ON b.tipo_item='equipo'   AND b.item_id = pe.id
       WHERE b.solicitud_id = $1
       ORDER BY b.registrado_en DESC`,
      [solicitud_id]
    );
    return res.json({ success: true, data: r.rows });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});


// =====================================================
// POST /solicitudes/:id/lote — registrar lote de salida
// Solo seguridad_fisica, solo solicitudes activos
// items = [{ tipo_item, item_id, cantidad }]
// =====================================================
router.post('/:id/lote', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.rol !== 'seguridad_fisica')
    return res.status(403).json({ success: false, error: 'Solo Seguridad Física puede registrar salidas.' });

  const solicitud_id = parseInt(req.params.id);
  const { items, observaciones } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ success: false, error: 'No hay items en el lote.' });

  const offline = process.env.OFFLINE_MODE !== 'false';
  if (offline) {
    if (!global.lotesMemoria)     global.lotesMemoria = [];
    if (!global.loteItemsMemoria) global.loteItemsMemoria = [];
    const lote = {
      id: global.lotesMemoria.length + 1,
      solicitud_id, observaciones: observaciones || null,
      registrado_por_username: user.username,
      registrado_en: new Date().toISOString(),
      items
    };
    global.lotesMemoria.push(lote);
    return res.json({ success: true, data: lote });
  }

  const pool = require('../db/connection');
  try {
    // Validar solicitud activo
    const rP = await pool.query('SELECT estado FROM permisos WHERE id=$1', [solicitud_id]);
    if (!rP.rows.length) return res.status(404).json({ success: false, error: 'Solicitud no encontrado.' });
    if (rP.rows[0].estado !== 'activo')
      return res.status(400).json({ success: false, error: 'Solo se pueden registrar salidas en solicitudes activos.' });

    // Validar cantidades disponibles para equipos
    for (const item of items) {
      if (item.tipo_item === 'equipo') {
        const rEq = await pool.query(
          'SELECT cantidad FROM permiso_equipos WHERE id=$1 AND solicitud_id=$2',
          [item.item_id, solicitud_id]
        );
        if (!rEq.rows.length) return res.status(404).json({ success: false, error: `Equipo id=${item.item_id} no encontrado.` });
        const rSal = await pool.query(
          `SELECT COALESCE(SUM(bli.cantidad),0) AS total
          FROM bitacora_lote_items bli
          JOIN bitacora_lotes bl ON bl.id = bli.lote_id
          WHERE bl.permiso_id=$1 AND bli.tipo_item='equipo' AND bli.item_id=$2`,
          [solicitud_id, item.item_id]  // ← pero el nombre del parámetro es permiso_id
        );
        const yaRegistrado = parseInt(rSal.rows[0].total);
        const cantMax = rEq.rows[0].cantidad;
        const cantPedir = parseInt(item.cantidad) || 1;
        if (yaRegistrado + cantPedir > cantMax)
          return res.status(400).json({
            success: false,
            error: `Item id=${item.item_id}: solo quedan ${cantMax - yaRegistrado} unidades disponibles.`
          });
      }
    }

    // Insertar lote
 
    const rL = await pool.query(
        `INSERT INTO bitacora_lotes (permiso_id, registrado_por, observaciones)
        VALUES ($1,$2,$3) RETURNING *`,
        [solicitud_id, user.id, observaciones || null]
      );

    const lote = rL.rows[0];

    // Insertar items del lote
    for (const item of items) {
      await pool.query(
        `INSERT INTO bitacora_lote_items (lote_id, tipo_item, item_id, cantidad)
         VALUES ($1,$2,$3,$4)`,
        [lote.id, item.tipo_item, parseInt(item.item_id), parseInt(item.cantidad) || 1]
      );
    }

    return res.json({ success: true, data: lote });
  } catch(e) {
    console.error('Error lote:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =====================================================
// GET /solicitudes/:id/lotes — historial de lotes
// =====================================================
router.get('/:id/lotes', requireAuth, async (req, res) => {
  const solicitud_id = parseInt(req.params.id);
  const offline = process.env.OFFLINE_MODE !== 'false';

  if (offline) {
    const lotes = (global.lotesMemoria || []).filter(x => x.solicitud_id === solicitud_id);
    return res.json({ success: true, data: lotes });
  }

  const pool = require('../db/connection');
  try {
    // Traer lotes con sus items enriquecidos
    const rL = await pool.query(
      `SELECT bl.*, u.nombre_completo AS registrado_por_nombre
       FROM bitacora_lotes bl
       LEFT JOIN usuarios u ON bl.registrado_por = u.id
       WHERE bl.permiso_id=$1
       ORDER BY bl.registrado_en DESC`,
      [solicitud_id]
    );

    const lotes = [];
    for (const lote of rL.rows) {
      const rI = await pool.query(
        `SELECT bli.*,
           CASE bli.tipo_item
             WHEN 'personal' THEN pp.nombre
             WHEN 'vehiculo' THEN CONCAT(pv.marca,' ',pv.modelo,' (',pv.placas,')')
             WHEN 'equipo'   THEN pe.descripcion
           END AS descripcion,
           CASE bli.tipo_item
             WHEN 'personal' THEN pp.num_credencial
             WHEN 'vehiculo' THEN pv.placas
             WHEN 'equipo'   THEN CAST(pe.cantidad AS TEXT)
           END AS referencia
         FROM bitacora_lote_items bli
         LEFT JOIN permiso_personal  pp ON bli.tipo_item='personal' AND bli.item_id=pp.id
         LEFT JOIN permiso_vehiculos pv ON bli.tipo_item='vehiculo' AND bli.item_id=pv.id
         LEFT JOIN permiso_equipos   pe ON bli.tipo_item='equipo'   AND bli.item_id=pe.id
         WHERE bli.lote_id=$1
         ORDER BY bli.tipo_item, bli.id`,
        [lote.id]
      );
      lotes.push({ ...lote, items: rI.rows });
    }

    return res.json({ success: true, data: lotes });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── GET /:id/accesos — accesos faciales ligados a esta solicitud ───
router.get('/:id/accesos', requireAuth, async (req, res) => {
  const solicitud_id = parseInt(req.params.id);
  try {
    // Buscar accesos donde solicitud_id coincide O donde el nombre del empleado
    // está en solicitud_personal de esta solicitud (para hoy)
    const result = await poolFacial.query(
      `SELECT a.id, a.tipo_movimiento, a.fecha_hora, a.resultado,
              e.nombre, e.apellido, e.empresa
       FROM accesos a
       LEFT JOIN trabajadores e ON a.empleado_id = e.id
       WHERE a.permiso_id = $1
         AND a.resultado = 'exitoso'
       ORDER BY a.fecha_hora DESC
       LIMIT 100`,
      [solicitud_id]
    );
    res.json({ success: true, data: result.rows });
  } catch(e) {
    console.error('Error accesos solicitud:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── GET /solicitudes/:id/credenciales ── Descarga PDF credenciales
router.get('/:id/credenciales', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const pool = require('../db/connection');
    const rSol = await pool.query('SELECT folio FROM permisos WHERE id=$1', [id]);
    if (!rSol.rows.length) return res.status(404).json({ error: 'No encontrado' });
    const folio = rSol.rows[0].folio || String(id);
    const filePath = path.join(__dirname, '..', 'public', 'credenciales', `credenciales_${folio}.pdf`);
   
   // Siempre regenerar
    await generarPDFCredenciales(pool, poolFacial, id);
    res.download(filePath);

  
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
