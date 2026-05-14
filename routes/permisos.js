const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const path = require('path');
const fs   = require('fs');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const https = require('https');
const http  = require('http');

// ── Conexión principal ──────────────────────────
// 

const pool = require('../db/connection');

// ── Conexión reconocimiento facial ───────────────
const poolFacial = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.FACIAL_DB_NAME || 'reconocimiento_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ── Conexión bd_principal (empleados, proveedores, usuarios) ───────────────
const poolBDPrincipal = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.BD_PRINCIPAL_NAME || 'bd_principal',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Obtiene los correos relevantes para notificaciones de un permiso
async function obtenerCorreosPermiso(empresa, responsable_contrato) {
  try {
    const [rEmpresa, rArea, rSeguridad] = await Promise.all([
      // Correo de la empresa contratista
      poolBDPrincipal.query(
        `SELECT correo FROM proveedores WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1)) LIMIT 1`,
        [empresa || '']
      ),
      // Correo del responsable del área (empleado interno)
      poolBDPrincipal.query(
        `SELECT e.correo FROM empleados e
         WHERE e.activo = true
           AND LOWER(TRIM(e.nombre || ' ' || e.apellido_paterno || COALESCE(' ' || e.apellido_materno, ''))) = LOWER(TRIM($1))
         LIMIT 1`,
        [responsable_contrato || '']
      ),
      // Correos de todos los usuarios de seguridad física
      poolBDPrincipal.query(
        `SELECT e.correo FROM usuarios u
         JOIN empleados e ON u.empleado_id = e.id
         JOIN usuarios_roles ur ON u.id = ur.usuario_id
         JOIN roles r ON ur.rol_id = r.id
         WHERE r.nombre = 'seguridad_fisica' AND u.activo = true AND e.correo IS NOT NULL`
      ),
    ]);
    return {
      correo_empresa:    rEmpresa.rows[0]?.correo   || null,
      correo_area:       rArea.rows[0]?.correo      || null,
      correos_seguridad: rSeguridad.rows.map(r => r.correo),
    };
  } catch(e) {
    console.error('❌ obtenerCorreosPermiso:', e.message);
    return { correo_empresa: null, correo_area: null, correos_seguridad: [] };
  }
}

// ── Migración: columnas documento en permiso_personal ──
(async () => {
  try {
    await pool.query(`
      ALTER TABLE permiso_personal
        ADD COLUMN IF NOT EXISTS documento               TEXT,
        ADD COLUMN IF NOT EXISTS documento_nombre_extraido TEXT,
        ADD COLUMN IF NOT EXISTS documento_validado      BOOLEAN DEFAULT FALSE
    `);
  } catch(e) {
    console.error('[MIGRACIÓN] permiso_personal:', e.message);
  }
})();

// =====================================================
// HELPERS
// =====================================================
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}


let loteAreaParaRechazar = null;


async function generarFolioRetiro(pool) {
  const año = new Date().getFullYear();
  const r = await pool.query(
    `SELECT COUNT(*) AS total FROM bitacora_lotes WHERE EXTRACT(YEAR FROM registrado_en) = $1`, [año]
  );
  return `RET-${año}-${String(parseInt(r.rows[0].total) + 1).padStart(4, '0')}`;
}


async function dispararWebhook(url, payload) {
  if (!url) return;
  try {
    const urlObj = new URL(url);
    const body = JSON.stringify(payload);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => console.log(`✅ Webhook: ${res.statusCode}`));
    req.on('error', e => console.error('❌ Webhook:', e.message));
    req.write(body); req.end();
  } catch(e) { console.error('❌ Webhook:', e.message); }
}


async function dispararWebhookN8N(pool, solicitud_id) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    const [rP, rPer, rVeh, rEq] = await Promise.all([
      pool.query('SELECT * FROM vista_permisos WHERE id=$1', [solicitud_id]),
      pool.query('SELECT * FROM permiso_personal  WHERE permiso_id=$1 ORDER BY id', [solicitud_id]),
      pool.query('SELECT * FROM permiso_vehiculos WHERE permiso_id=$1 ORDER BY id', [solicitud_id]),
      pool.query('SELECT * FROM permiso_equipos   WHERE permiso_id=$1 ORDER BY id', [solicitud_id]),
    ]);
    const solicitud = rP.rows[0];
    const correos = await obtenerCorreosPermiso(solicitud?.empresa, solicitud?.responsable_contrato);
    await dispararWebhook(webhookUrl, {
      solicitud: { ...solicitud, ...correos },
      personal: rPer.rows, vehiculos: rVeh.rows, equipos: rEq.rows
    });
  } catch(e) { console.error('❌ WebhookN8N:', e.message); }
}

async function generarPDFCredenciales(pool, poolFacial, solicitudId) {
  const rSol = await pool.query(`SELECT * FROM permisos WHERE id = $1`, [solicitudId]);
  if (!rSol.rows.length) return;
  const sol = rSol.rows[0];
  const rPersonal = await pool.query(`SELECT pp.nombre, pp.num_credencial, pp.categoria, pp.trabajador_id FROM permiso_personal pp WHERE pp.permiso_id = $1`, [solicitudId]);
  if (!rPersonal.rows.length) return;
  const fechaInicio = sol.fecha_inicio ? new Date(sol.fecha_inicio).toLocaleDateString('es-MX') : '';
  const fechaFin    = sol.fecha_fin    ? new Date(sol.fecha_fin).toLocaleDateString('es-MX')    : '';
  const outputDir = path.join(__dirname, '..', 'public', 'credenciales');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `credenciales_${sol.folio || solicitudId}.pdf`;
  const filePath = path.join(outputDir, fileName);
  const doc = new PDFDocument({ size: 'A4', margin: 20 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  const cW = 243, cH = 153, colGap = 14, rowGap = 14, cols = 2, marginX = 20, marginY = 20;
  for (let i = 0; i < rPersonal.rows.length; i++) {
    const p = rPersonal.rows[i];
    if (i > 0 && i % 8 === 0) doc.addPage();
    const col = (i % 8) % cols, row = Math.floor((i % 8) / cols);
    const cX = marginX + col * (cW + colGap), cY = marginY + row * (cH + rowGap);
    let curp = p.num_credencial || '';
    let trabajadorIdParaQR = p.trabajador_id || null;
    let idPersonal = null;
    try {
      if (p.trabajador_id) {
        const rT = await poolFacial.query(`SELECT documento_identidad, id_personal FROM trabajadores WHERE id = $1 LIMIT 1`, [p.trabajador_id]);
        if (rT.rows.length) {
          curp = rT.rows[0].documento_identidad || curp;
          idPersonal = rT.rows[0].id_personal || null;
        }
      } else {
        const rT = await poolFacial.query(`SELECT id, documento_identidad, id_personal FROM trabajadores WHERE LOWER(nombre || ' ' || apellido) = LOWER($1) LIMIT 1`, [p.nombre]);
        if (rT.rows.length) {
          curp = rT.rows[0].documento_identidad || curp;
          trabajadorIdParaQR = rT.rows[0].id || null;
          idPersonal = rT.rows[0].id_personal || null;
        }
      }
    } catch(e) {}
    const qrBuffer = await QRCode.toBuffer(JSON.stringify({ folio: sol.folio || String(solicitudId), nombre: p.nombre, curp, trabajador_id: trabajadorIdParaQR, id_personal: idPersonal, empresa: sol.empresa || '', fecha_inicio: fechaInicio, fecha_fin: fechaFin, valido: true }), { width: 300, margin: 1 });
    // Layout: izquierda = texto + válido, derecha = QR grande hasta el borde inferior
    const half = Math.floor(cW / 2);                          // 121px
    const bodyH = cH - 22;                                    // 131px (solo sin header, sin footer)
    const qrSize = Math.min(half - 2, bodyH - 4);             // 119px
    const qrX = cX + half + Math.floor((cW - half - qrSize) / 2);
    const qrY = cY + 22 + Math.floor((bodyH - qrSize) / 2);
    const textW = half - 12;                                   // 109px
    doc.rect(cX, cY, cW, cH).lineWidth(1.5).stroke('#1a1a1a');
    doc.rect(cX, cY, cW, 22).fill('#c9a227');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7).text('PROAGRO INDUSTRIA — PASE DE ACCESO', cX, cY + 7, { width: cW, align: 'center' });
    doc.moveTo(cX + half, cY + 22).lineTo(cX + half, cY + cH).lineWidth(0.5).stroke('#ddd');
    doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
    doc.fillColor('#555').font('Helvetica-Bold').fontSize(6).text('TRABAJADOR', cX + 8, cY + 27);
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(8).text(p.nombre, cX + 8, cY + 36, { width: textW });
    doc.fillColor('#555').font('Helvetica-Bold').fontSize(6).text('FOLIO', cX + 8, cY + 60);
    doc.fillColor('#000').font('Helvetica').fontSize(7).text(sol.folio || String(solicitudId), cX + 8, cY + 69);
    doc.fillColor('#555').font('Helvetica-Bold').fontSize(6).text('EMPRESA', cX + 8, cY + 82);
    doc.fillColor('#000').font('Helvetica').fontSize(7).text(sol.empresa || '—', cX + 8, cY + 91, { width: textW });
    doc.fillColor('#555').font('Helvetica-Bold').fontSize(6).text('VÁLIDO', cX + 8, cY + 110);
    doc.fillColor('#000').font('Helvetica').fontSize(6.5).text(`${fechaInicio} — ${fechaFin}`, cX + 8, cY + 119, { width: textW });
  }
  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });
  console.log(`[PDF QR] Generado: ${fileName}`);
}

const ESTADO_LABEL = { borrador:'Borrador', en_espera_area:'En espera del Área', aprobado_area:'Aprobado por Área', en_espera_seguridad:'En espera de Seguridad', activo:'Activo', rechazado:'Rechazado', vencido:'Vencido' };
let solicitudesMemoria = [], contadorFolio = 1;
function generarFolioOffline() { return `SOL-${new Date().getFullYear()}-${String(contadorFolio++).padStart(4,'0')}`; }
function puedeAprobar(rol, estado) { return (rol==='area' && estado==='en_espera_area') || (rol==='seguridad_fisica' && estado==='en_espera_seguridad'); }

// =====================================================
// RUTAS DE LOTE — ANTES de /:id para evitar conflictos
// =====================================================

// PUT /lote/:lote_id/aprobar
// PUT /lote/:lote_id/aprobar-area
router.put('/lote/:lote_id/aprobar-area', requireAuth, async (req, res) => {
  if (req.session.user.rol !== 'area')
    return res.status(403).json({ success: false, error: 'Solo el Área puede aprobar.' });
  try {
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const { firma_aprobacion_ubicacion, firma_aprobacion_ip_privada } = req.body;
    const usuario = req.session.user.username || null;
    const r = await pool.query(
      `UPDATE bitacora_lotes SET 
        estado='aprobado_area', aprobado_por_area=$1, fecha_aprobacion_area=NOW(),
        firma_area_ip=$3, firma_area_ip_privada=$4, firma_area_ubicacion=$5, firma_area_usuario=$6
       WHERE id=$2 AND estado='pendiente' RETURNING *`,
      [req.session.user.id, req.params.lote_id, ip, firma_aprobacion_ip_privada||null, firma_aprobacion_ubicacion||null, usuario]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Lote no encontrado o ya procesado.' });
    return res.json({ success: true, data: r.rows[0] });
  } catch(e) { return res.status(500).json({ success: false, error: e.message }); }
});

// PUT /lote/:lote_id/rechazar-area
router.put('/lote/:lote_id/rechazar-area', requireAuth, async (req, res) => {
  if (req.session.user.rol !== 'area')
    return res.status(403).json({ success: false, error: 'Solo el Área puede rechazar.' });
  try {
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const { motivo, firma_aprobacion_ubicacion, firma_aprobacion_ip_privada } = req.body;
    const usuario = req.session.user.username || null;
    const r = await pool.query(
      `UPDATE bitacora_lotes SET 
        estado='rechazado_area', aprobado_por_area=$1, fecha_aprobacion_area=NOW(),
        motivo_rechazo_area=$2,
        firma_area_ip=$4, firma_area_ip_privada=$5, firma_area_ubicacion=$6, firma_area_usuario=$7
       WHERE id=$3 AND estado='pendiente' RETURNING *`,
      [req.session.user.id, motivo||null, req.params.lote_id, ip, firma_aprobacion_ip_privada||null, firma_aprobacion_ubicacion||null, usuario]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Lote no encontrado o ya procesado.' });
    return res.json({ success: true, data: r.rows[0] });
  } catch(e) { return res.status(500).json({ success: false, error: e.message }); }
});




// PUT /lote/:lote_id/aprobar (Jiadan - seguridad fisica)
router.put('/lote/:lote_id/aprobar', requireAuth, async (req, res) => {
  if (req.session.user.rol !== 'seguridad_fisica')
    return res.status(403).json({ success: false, error: 'Solo Seguridad Física puede aprobar.' });
  try {
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const { firma_aprobacion_ubicacion, firma_aprobacion_ip_privada } = req.body;
    const usuario = req.session.user.username || null;
    const r = await pool.query(
      `UPDATE bitacora_lotes SET 
        estado='aprobado', aprobado_por=$1, fecha_aprobacion=NOW(),
        firma_aprobacion_ip=$3, firma_aprobacion_ip_privada=$4, firma_aprobacion_ubicacion=$5, firma_aprobacion_usuario=$6
       WHERE id=$2 AND estado='aprobado_area' RETURNING *`,
      [req.session.user.id, req.params.lote_id, ip, firma_aprobacion_ip_privada||null, firma_aprobacion_ubicacion||null, usuario]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Lote no encontrado o no aprobado por área.' });
    return res.json({ success: true, data: r.rows[0] });
  } catch(e) { return res.status(500).json({ success: false, error: e.message }); }
});




// PUT /lote/:lote_id/rechazar (Jiadan - seguridad fisica)
router.put('/lote/:lote_id/rechazar', requireAuth, async (req, res) => {
  if (req.session.user.rol !== 'seguridad_fisica')
    return res.status(403).json({ success: false, error: 'Solo Seguridad Física puede rechazar.' });
  try {
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const { motivo, firma_aprobacion_ubicacion, firma_aprobacion_ip_privada } = req.body;
    const usuario = req.session.user.username || null;
    const r = await pool.query(
      `UPDATE bitacora_lotes SET 
        estado='rechazado', aprobado_por=$1, fecha_aprobacion=NOW(), motivo_rechazo=$2,
        firma_aprobacion_ip=$4, firma_aprobacion_ip_privada=$5, firma_aprobacion_ubicacion=$6, firma_aprobacion_usuario=$7
       WHERE id=$3 AND estado='aprobado_area' RETURNING *`,
      [req.session.user.id, motivo||null, req.params.lote_id, ip, firma_aprobacion_ip_privada||null, firma_aprobacion_ubicacion||null, usuario]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Lote no encontrado o no aprobado por área.' });
    return res.json({ success: true, data: r.rows[0] });
  } catch(e) { return res.status(500).json({ success: false, error: e.message }); }
});







// GET /lote/:lote_id/pdf
router.get('/lote/:lote_id/pdf', requireAuth, async (req, res) => {
  try {
    const rL = await pool.query(
      `SELECT bl.*, p.folio AS permiso_folio, p.empresa, p.contrato, p.responsable1, p.responsable2, p.responsable_contrato
       FROM bitacora_lotes bl
       LEFT JOIN permisos p ON bl.permiso_id = p.id
       WHERE bl.id = $1`,
      [req.params.lote_id]
    );
    if (!rL.rows.length) return res.status(404).json({ error: 'Lote no encontrado' });
    const lote = rL.rows[0];
    const rI = await pool.query(
      `SELECT bli.*, pe.descripcion, pe.marca, pe.modelo, pe.serie FROM bitacora_lote_items bli LEFT JOIN permiso_equipos pe ON bli.tipo_item='equipo' AND bli.item_id=pe.id WHERE bli.lote_id=$1 ORDER BY bli.id`,
      [lote.id]
    );
    const items = rI.rows;
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="retiro_${lote.folio}.pdf"`);
    doc.pipe(res);

    const drawPage = (responsableNombre) => {
      doc.rect(50, 40, 495, 52).fill('#1a1a1a');
      doc.fillColor('#c9a227').font('Helvetica-Bold').fontSize(16).text('PROAGRO INDUSTRIA', 50, 50, { width: 495, align: 'center' });
      doc.fillColor('#ffffff').font('Helvetica').fontSize(9).text('REGISTRO DE SALIDA DE HERRAMIENTAS', 50, 68, { width: 495, align: 'center' });
      const estadoColor = lote.estado==='aprobado' ? '#16a34a' : lote.estado==='rechazado' ? '#dc2626' : '#d97706';
      doc.rect(390, 100, 155, 22).fill(estadoColor);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text((lote.estado||'pendiente').toUpperCase(), 390, 106, { width: 155, align: 'center' });
      let y = 100;
      const campo = (label, valor, x, yPos, w=220) => {
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#888').text(label, x, yPos);
        doc.font('Helvetica').fontSize(10).fillColor('#000').text(valor||'—', x, yPos+10, { width: w });
      };
      campo('FOLIO DE RETIRO', lote.folio, 50, y); y+=34;
      campo('PERMISO PADRE', lote.permiso_folio, 50, y); campo('EMPRESA', lote.empresa, 280, y); y+=34;
      campo('RESPONSABLE DEL RETIRO', responsableNombre, 50, y); y+=34;
      campo('FECHA DE SOLICITUD', new Date(lote.registrado_en).toLocaleString('es-MX'), 50, y);
      campo(lote.estado === 'rechazado' ? 'FECHA DE RECHAZO' : 'FECHA AUTORIZACIÓN', lote.fecha_aprobacion ? new Date(lote.fecha_aprobacion).toLocaleString('es-MX') : '—', 280, y); y+=34;
      if (lote.observaciones) { campo('OBSERVACIONES', lote.observaciones, 50, y, 495); y+=34; }
      if (lote.motivo_rechazo) { campo('MOTIVO DE RECHAZO', lote.motivo_rechazo, 50, y, 495); y+=34; }

      // ── Tabla herramientas ──
      y+=8;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text('HERRAMIENTAS / EQUIPOS', 50, y);
      doc.moveTo(50, y+14).lineTo(545, y+14).lineWidth(1).stroke('#c9a227'); y+=22;
      doc.rect(50, y, 495, 18).fill('#1a1a1a');
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
      doc.text('DESCRIPCIÓN', 55, y+5); doc.text('MARCA', 240, y+5); doc.text('MODELO / SERIE', 340, y+5); doc.text('CANT.', 468, y+5, { width:72, align:'center' });
      y+=18;
      items.forEach((item, idx) => {
        if (idx%2===0) doc.rect(50, y, 495, 18).fill('#f9f9f9');
        doc.fillColor('#000').font('Helvetica').fontSize(8);
        doc.text(item.descripcion||'—', 55, y+5, { width:180 });
        doc.text(item.marca||'—', 240, y+5, { width:95 });
        doc.text([item.modelo, item.serie].filter(Boolean).join(' / ')||'—', 340, y+5, { width:125 });
        doc.text(String(item.cantidad||1), 468, y+5, { width:72, align:'center' });
        doc.rect(50, y, 495, 18).lineWidth(0.5).stroke('#ddd'); y+=18;
      });

      // ── 1. Firmas digitales ──
      y += 20; if (y > 580) { doc.addPage(); y = 60; }

      if (lote.firma_registro_ip || lote.firma_registro_ip_privada) {
        doc.rect(50, y, 495, 42).lineWidth(0.5).stroke('#c9a227');
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#c9a227')
           .text('✍ FIRMA DIGITAL — REGISTRO DE SALIDA', 58, y + 5);
        doc.font('Helvetica').fontSize(7).fillColor('#555')
           .text(`${lote.firma_registro_usuario||'—'} / ${lote.firma_registro_ip_privada||'—'} / ${lote.firma_registro_ubicacion||'—'} / ${lote.registrado_en ? new Date(lote.registrado_en).toLocaleString('es-MX') : '—'}`, 58, y + 16, { width: 479 });
        y += 50;
      }


      if (lote.firma_area_ip_privada) {
        doc.rect(50, y, 495, 42).lineWidth(0.5).stroke('#3b82f6');
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#3b82f6')
          .text('✍ FIRMA DIGITAL — APROBACIÓN ÁREA', 58, y + 5);
        doc.font('Helvetica').fontSize(7).fillColor('#555')
          .text(`${lote.firma_area_usuario||'—'} / ${lote.firma_area_ip_privada||'—'} / ${lote.firma_area_ubicacion||'—'} / ${lote.fecha_aprobacion_area ? new Date(lote.fecha_aprobacion_area).toLocaleString('es-MX') : '—'}`, 58, y + 16, { width: 479 });
        y += 50;
      }


      if (lote.firma_aprobacion_ip || lote.firma_aprobacion_ip_privada) {
        doc.rect(50, y, 495, 42).lineWidth(0.5).stroke('#16a34a');
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#16a34a')
           .text('✍ FIRMA DIGITAL — AUTORIZACIÓN SEGURIDAD FÍSICA', 58, y + 5);
        doc.font('Helvetica').fontSize(7).fillColor('#555')
           .text(`${lote.firma_aprobacion_usuario||'—'} / ${lote.firma_aprobacion_ip_privada||'—'} / ${lote.firma_aprobacion_ubicacion||'—'} / ${lote.fecha_aprobacion ? new Date(lote.fecha_aprobacion).toLocaleString('es-MX') : '—'}`, 58, y + 16, { width: 479 });
        y += 50;
      }

      // ── 2. Firmas de conformidad (líneas físicas) ──
      y += 20; if (y > 660) { doc.addPage(); y = 60; }
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text('FIRMAS DE CONFORMIDAD', 50, y);
      doc.moveTo(50, y+14).lineTo(545, y+14).lineWidth(1).stroke('#c9a227'); y+=44;
      doc.moveTo(50, y+50).lineTo(240, y+50).lineWidth(1).stroke('#000');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text('RESPONSABLE DE RETIRO', 50, y+55, { width:190, align:'center' });
      doc.font('Helvetica').fontSize(8).fillColor('#555').text(responsableNombre||'—', 50, y+66, { width:190, align:'center' });
      doc.moveTo(305, y+50).lineTo(545, y+50).lineWidth(1).stroke('#000');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text('AUTORIZA — JEFE DE SEGURIDAD FÍSICA', 305, y+55, { width:240, align:'center' });
      doc.font('Helvetica').fontSize(8).fillColor('#555').text(lote.firma_aprobacion_usuario||'—', 305, y+66, { width:240, align:'center' });

      // ── 3. Pie de página ──
      doc.font('Helvetica').fontSize(7).fillColor('#bbb')
         .text(`${lote.folio} · ${new Date().toLocaleString('es-MX')} · PROAGRO Industria`, 50, y+100, { width:495, align:'center' });
    };
    const responsables = [lote.responsable1, lote.responsable2].filter(Boolean);
    if (!responsables.length) responsables.push(lote.responsable_contrato || lote.responsable_nombre || '—');
    responsables.forEach((resp, i) => { if (i>0) doc.addPage(); drawPage(resp); });
    doc.end();

  } catch(e) { console.error('PDF lote:', e.message); res.status(500).json({ error: e.message }); }
});

// =====================================================
// GET /
// =====================================================
router.get('/', requireAuth, (req, res) => {
  if (process.env.OFFLINE_MODE !== 'false') {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    solicitudesMemoria.forEach(p => { if (p.estado==='activo' && new Date(p.fecha_fin)<hoy) p.estado='vencido'; });
    return res.json({ success: true, data: solicitudesMemoria });
  }

  const user = req.session.user;

  let query, params;

  if (user.rol === 'contratista') {
    // Solo ve sus propios permisos
    query = 'SELECT * FROM vista_permisos WHERE empresa = $1 ORDER BY creado_en DESC';
    params = [user.nombre_completo];
  } else if (user.rol === 'area') {
    // Solo ve permisos donde él es el responsable del contrato
    query = 'SELECT * FROM vista_permisos WHERE responsable_contrato = $1 ORDER BY creado_en DESC';
    params = [user.nombre_completo];
  } else {
    // seguridad_fisica ve todo
    query = 'SELECT * FROM vista_permisos ORDER BY creado_en DESC';
    params = [];
  }

  pool.query(query, params)
    .then(r => res.json({ success: true, data: r.rows }))
    .catch(e => res.status(500).json({ success: false, error: e.message }));
});


// =====================================================
// POST / — crear solicitud
// =====================================================
router.post('/', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.rol !== 'contratista') return res.status(403).json({ success: false, error: 'Solo contratistas pueden crear solicitudes.' });
  

  const { empresa, contrato, fecha_inicio, fecha_fin, secciones, responsable_contrato, responsable1, responsable2, responsable1_tel, responsable2_tel, firma_creacion_ubicacion, firma_creacion_ip_privada, es_pase_visita } = req.body;
  

  //if (!empresa || !contrato || !fecha_inicio || !fecha_fin) return res.status(400).json({ success: false, error: 'Todos los campos son requeridos.' });
  if (!empresa  || !fecha_inicio || !fecha_fin) return res.status(400).json({ success: false, error: 'Todos los campos son requeridos.' });
  const fi = new Date(fecha_inicio), ff = new Date(fecha_fin);
  const fiSoloFecha = new Date(fecha_inicio+'T12:00:00'), hoySoloFecha = new Date(); hoySoloFecha.setHours(0,0,0,0);
  if (fiSoloFecha < hoySoloFecha) return res.status(400).json({ success: false, error: 'La fecha de inicio no puede ser anterior a hoy.' });
  if (ff < fi) return res.status(400).json({ success: false, error: 'La fecha fin no puede ser anterior al inicio.' });
  if (Math.ceil((ff-fi)/(1000*60*60*24)) > 30) return res.status(400).json({ success: false, error: 'El período no puede exceder 30 días.' });
  if (process.env.OFFLINE_MODE !== 'false') {
    const nuevo = { id: solicitudesMemoria.length+1, folio: generarFolioOffline(), empresa: empresa.trim(), contrato: contrato.trim(), responsable_contrato: responsable_contrato||'—', responsable1: responsable1||null, responsable2: responsable2||null, fecha_inicio, fecha_fin, estado:'en_espera_area', creado_por: user.id, creado_en: new Date().toISOString() };
    solicitudesMemoria.unshift(nuevo); return res.json({ success: true, data: nuevo });
  }
  try {
    const ip_creacion = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const usuario_creacion = user.username || null;

    const r1 = await pool.query(
      `INSERT INTO permisos (folio, empresa, contrato, responsable_contrato, responsable1, responsable2, responsable1_tel, responsable2_tel, fecha_inicio, fecha_fin, estado, creado_por, fecha_envio, firma_creacion_ip, firma_creacion_ip_privada, firma_creacion_ubicacion, firma_creacion_fecha, firma_creacion_usuario, es_pase_visita)
 VALUES ('TEMP',$1,$2,$3,$4,$5,$6,$7,$8,$9,'en_espera_area',$10,NOW(),$11,$12,$13,NOW(),$14,$15) RETURNING id`,
[empresa?.trim()||null, contrato?.trim()||null, responsable_contrato||null, responsable1||null, responsable2||null, responsable1_tel||null, responsable2_tel||null, fecha_inicio||null, fecha_fin||null, user.rol === 'contratista' ? null : user.id||null, ip_creacion||null, firma_creacion_ip_privada||null, firma_creacion_ubicacion||null, usuario_creacion, es_pase_visita === true]
    );
    const newId = r1.rows[0].id;
    const folio = `SOL-${new Date().getFullYear()}-${String(newId).padStart(4,'0')}`;
    const r2 = await pool.query('UPDATE permisos SET folio=$1 WHERE id=$2 RETURNING *', [folio, newId]);
    const solicitud = r2.rows[0]; const pid = solicitud.id; const sec = secciones||{};
    if (sec.personal&&Array.isArray(sec.personal)) { for (const p of sec.personal) { if (!p.nombre&&!p.num_credencial) continue; await pool.query(`INSERT INTO permiso_personal (permiso_id, num_credencial, nombre, categoria, observaciones, nss, trabajador_id, documento, documento_nombre_extraido, documento_validado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [pid, p.num_credencial||null, p.nombre||null, p.categoria||null, p.observaciones||null, p._nss||null, p._empleadoId||null, p.documento_ine||p.documento||null, p._nombreExtraido||null, p._docInlineValidado===true]); } }

    // Pase de Visita: registrar cada persona como invitado en reconocimiento_db y generar su QR
    if (es_pase_visita === true && sec.personal && Array.isArray(sec.personal)) {
      for (const p of sec.personal) {
        if (!p.nombre) continue;
        const partes      = p.nombre.trim().split(/\s+/);
        const nombreParte = partes[0] || '';
        const apellidoParte = partes.slice(1).join(' ') || '';
        try {
          const insInv = await poolFacial.query(
            `INSERT INTO trabajadores (nombre, apellido, empresa, estatus, activo, es_invitado, fecha_induccion)
             VALUES ($1,$2,$3,'activo',true,true,CURRENT_DATE) RETURNING id`,
            [nombreParte, apellidoParte, empresa?.trim() || '']
          );
          const invId = insInv.rows[0].id;
          const qrData = JSON.stringify({ nombre: p.nombre.trim(), empresa: empresa?.trim() || '', es_invitado: true, id: invId });
          await QRCode.toBuffer(qrData, { width: 300, margin: 2 }); // warm-up / validation
          await poolFacial.query(`UPDATE trabajadores SET qr_code=$1 WHERE id=$2`, [qrData, invId]);
          console.log(`[INVITADO] Registrado id=${invId} nombre="${p.nombre.trim()}"`);
        } catch(eInv) {
          console.error('[INVITADO] Error registrando en trabajadores:', eInv.message);
        }
      }
    }

    if (sec.vehiculo&&Array.isArray(sec.vehiculo)) { for (const v of sec.vehiculo) { if (!v.marca&&!v.placas) continue; const segExt=v.seguro_extracted||{}, licExt=v.licencia_extracted||{}; const tarExt = v.tarjeta_circulacion_extracted || v.tarjeta_extracted || {};
await pool.query(`INSERT INTO permiso_vehiculos (permiso_id, marca, modelo, placas, seguro, licencia, tarjeta, seguro_poliza, seguro_aseguradora, seguro_vigencia_inicio, seguro_vigencia_fin, seguro_vigente, licencia_nombre, licencia_numero, licencia_tipo, licencia_vigencia_fin, licencia_vigente, tarjeta_serie, tarjeta_placas, tarjeta_vigencia_fin, tarjeta_vigente) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
[pid, v.marca||null, v.modelo||null, v.placas||null, v.seguro||null, v.licencia||null, (v.tarjeta_circulacion||v.tarjeta)||null, segExt.numero_poliza||null, segExt.aseguradora||null, segExt.vigencia_inicio||null, segExt.vigencia_fin||null, segExt.vigente??null, licExt.nombre_conductor||null, licExt.numero_licencia||null, licExt.tipo_licencia||null, licExt.vigencia_fin||null, licExt.vigente??null, tarExt.numero_serie||null, tarExt.placas||null, tarExt.vigencia_fin||null, tarExt.vigente??null]); } }
    if (sec.equipo&&Array.isArray(sec.equipo)) { for (const e of sec.equipo) { if (!e.descripcion&&!e.cantidad) continue; await pool.query(`INSERT INTO permiso_equipos (permiso_id, cantidad, descripcion, marca, modelo, serie, observaciones) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [pid, parseInt(e.cantidad)||1, e.descripcion||null, e.marca||null, e.modelo||null, e.serie||null, e.observaciones||null]); } }
    const correosCreado = await obtenerCorreosPermiso(empresa.trim(), responsable_contrato);
    dispararWebhook(process.env.N8N_WEBHOOK_PERMISO_CREADO, { evento:'permiso_creado', folio, empresa: empresa.trim(), contrato: contrato.trim(), responsable_contrato: responsable_contrato||'', fecha_inicio, fecha_fin, creado_por: user.nombre_completo||user.username, url_sistema:'https://seguridadfisica.proagroindustria.com/dashboard', ...correosCreado });
    return res.json({ success: true, data: solicitud });
  } catch(e) { console.error('Error creando solicitud:', e.message); return res.status(500).json({ success: false, error: e.message }); }
});

// PUT /:id/aprobar
router.put('/:id/aprobar', requireAuth, async (req, res) => {
  const user = req.session.user; const id = parseInt(req.params.id);
  if (process.env.OFFLINE_MODE !== 'false') {
    const p = solicitudesMemoria.find(x=>x.id===id);
    if (!p) return res.status(404).json({ success:false, error:'No encontrado.' });
    if (!puedeAprobar(user.rol, p.estado)) return res.status(403).json({ success:false, error:`No puedes aprobar en estado "${ESTADO_LABEL[p.estado]}".` });
    if (user.rol==='area') { p.estado='en_espera_seguridad'; } else { p.estado='activo'; }
    return res.json({ success:true, data:p });
  }
  try {
    const r = await pool.query('SELECT * FROM permisos WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ success:false, error:'No encontrado.' });
    const p = r.rows[0];
    if (!puedeAprobar(user.rol, p.estado)) return res.status(403).json({ success:false, error:`No puedes aprobar en estado "${ESTADO_LABEL[p.estado]}".` });
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const { firma_ubicacion, firma_ip_privada } = req.body;
    const usuario = user.username || null;
    let query, params;
    if (user.rol==='area') {
      query=`UPDATE permisos SET estado='en_espera_seguridad', aprobado_por_area=$1, fecha_aprobacion_area=NOW(),
            firma_area_ip=$3, firma_area_ip_privada=$4, firma_area_ubicacion=$5, firma_area_fecha=NOW(), firma_area_usuario=$6
            WHERE id=$2 RETURNING *`;
      params=[user.id, id, ip, firma_ip_privada||null, firma_ubicacion||null, usuario];
    } else {
      query=`UPDATE permisos SET estado='activo', aprobado_por_seguridad=$1, fecha_aprobacion_seg=NOW(),
            firma_aprobacion_ip=$3, firma_aprobacion_ip_privada=$4, firma_aprobacion_ubicacion=$5, firma_aprobacion_fecha=NOW(), firma_aprobacion_usuario=$6
            WHERE id=$2 RETURNING *`;
      params=[user.id, id, ip, firma_ip_privada||null, firma_ubicacion||null, usuario];
    }
    const r2 = await pool.query(query, params);
    if (user.rol==='area') {
      const correosAprobArea = await obtenerCorreosPermiso(p.empresa, p.responsable_contrato);
      dispararWebhook(process.env.N8N_WEBHOOK_APROBADO_AREA, { evento:'aprobado_area', folio:p.folio, empresa:p.empresa, contrato:p.contrato, responsable_contrato:p.responsable_contrato||'', fecha_inicio:p.fecha_inicio, fecha_fin:p.fecha_fin, aprobado_por:user.nombre_completo||user.username, fecha_aprobacion: new Date().toLocaleString('es-MX'), url_sistema:'https://seguridadfisica.proagroindustria.com/dashboard', ...correosAprobArea });
    }
    if (user.rol==='seguridad_fisica') { dispararWebhookN8N(pool, id); generarPDFCredenciales(pool, poolFacial, id).catch(e=>console.error('[PDF QR] Error:', e.message)); }
    return res.json({ success:true, data:r2.rows[0] });
  } catch(e) { return res.status(500).json({ success:false, error:e.message }); }
});

// PUT /:id/rechazar
router.put('/:id/rechazar', requireAuth, async (req, res) => {
  const user = req.session.user; const id = parseInt(req.params.id);
  if (process.env.OFFLINE_MODE !== 'false') {
    const p = solicitudesMemoria.find(x=>x.id===id);
    if (!p) return res.status(404).json({ success:false, error:'No encontrado.' });
    if (!puedeAprobar(user.rol, p.estado)) return res.status(403).json({ success:false, error:`No puedes rechazar en estado "${ESTADO_LABEL[p.estado]}".` });
    p.estado='rechazado'; p.motivo_rechazo=req.body.motivo||null; return res.json({ success:true, data:p });
  }
  try {
    const r = await pool.query('SELECT * FROM permisos WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ success:false, error:'No encontrado.' });
    const p = r.rows[0];
    if (!puedeAprobar(user.rol, p.estado)) return res.status(403).json({ success:false, error:`No puedes rechazar en estado "${ESTADO_LABEL[p.estado]}".` });
    const ip_rechazo = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const { motivo, firma_ubicacion: firma_ub_rec, firma_ip_privada: firma_ip_rec } = req.body;
    const usuario = user.username || null;
    const r2 = await pool.query(
      `UPDATE permisos SET estado='rechazado', rechazado_por=$1, motivo_rechazo=$2, fecha_rechazo=NOW(),
       firma_rechazo_ip=$4, firma_rechazo_ip_privada=$5, firma_rechazo_ubicacion=$6, firma_rechazo_fecha=NOW(), firma_rechazo_usuario=$7
       WHERE id=$3 RETURNING *`,
      [user.id, motivo||null, id, ip_rechazo, firma_ip_rec||null, firma_ub_rec||null, usuario]
    );
    const payload = { folio:p.folio, empresa:p.empresa, contrato:p.contrato, responsable:p.responsable_contrato||'', fecha_inicio:p.fecha_inicio, fecha_fin:p.fecha_fin, motivo_rechazo:motivo||'Sin motivo especificado', rechazado_por:user.nombre_completo||user.username, url_sistema:'https://seguridadfisica.proagroindustria.com/dashboard' };
    const correosRec = await obtenerCorreosPermiso(p.empresa, p.responsable_contrato);
    if (user.rol==='area') dispararWebhook(process.env.N8N_WEBHOOK_RECHAZADO_AREA, { ...payload, evento:'rechazado_area', ...correosRec });
    if (user.rol==='seguridad_fisica') dispararWebhook(process.env.N8N_WEBHOOK_RECHAZADO_SEGURIDAD, { ...payload, evento:'rechazado_seguridad', ...correosRec });
    return res.json({ success:true, data:r2.rows[0] });
  } catch(e) { console.error('Error rechazando:', e.message); return res.status(500).json({ success:false, error:e.message }); }
});

// GET /:id/historial
router.get('/:id/historial', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (process.env.OFFLINE_MODE !== 'false') return res.json({ success:true, data:[] });
  pool.query(`SELECT h.*, u.nombre_completo AS usuario_nombre FROM permiso_historial h LEFT JOIN usuarios u ON h.cambiado_por=u.id WHERE h.permiso_id=$1 ORDER BY h.creado_en ASC`, [id])
    .then(r=>res.json({ success:true, data:r.rows })).catch(e=>res.status(500).json({ success:false, error:e.message }));
});


// GET /:id/lotes
router.get('/:id/lotes', requireAuth, async (req, res) => {
  const solicitud_id = parseInt(req.params.id);
  if (process.env.OFFLINE_MODE !== 'false') return res.json({ success:true, data:(global.lotesMemoria||[]).filter(x=>x.solicitud_id===solicitud_id) });
  try {
    const rL = await pool.query(
      `SELECT bl.*
       FROM bitacora_lotes bl
       WHERE bl.permiso_id=$1 ORDER BY bl.registrado_en DESC`,
      [solicitud_id]
    );
    const lotes = [];
    for (const lote of rL.rows) {
      const rI = await pool.query(
        `SELECT bli.*, CASE bli.tipo_item WHEN 'personal' THEN pp.nombre WHEN 'vehiculo' THEN CONCAT(pv.marca,' ',pv.modelo,' (',pv.placas,')') WHEN 'equipo' THEN pe.descripcion END AS descripcion, CASE bli.tipo_item WHEN 'personal' THEN pp.num_credencial WHEN 'vehiculo' THEN pv.placas WHEN 'equipo' THEN CAST(pe.cantidad AS TEXT) END AS referencia FROM bitacora_lote_items bli LEFT JOIN permiso_personal pp ON bli.tipo_item='personal' AND bli.item_id=pp.id LEFT JOIN permiso_vehiculos pv ON bli.tipo_item='vehiculo' AND bli.item_id=pv.id LEFT JOIN permiso_equipos pe ON bli.tipo_item='equipo' AND bli.item_id=pe.id WHERE bli.lote_id=$1 ORDER BY bli.tipo_item, bli.id`,
        [lote.id]
      );
      lotes.push({ ...lote, items: rI.rows });
    }
    return res.json({ success:true, data:lotes });
  } catch(e) { return res.status(500).json({ success:false, error:e.message }); }
});


// GET /:id/accesos
router.get('/:id/accesos', requireAuth, async (req, res) => {
  const solicitud_id = parseInt(req.params.id);
  try {
    const result =  await poolFacial.query(`SELECT a.id, a.tipo_movimiento, a.fecha_hora, a.resultado, e.nombre, e.apellido, e.empresa FROM accesos a LEFT JOIN trabajadores e ON a.empleado_id=e.id WHERE a.permiso_id=$1 AND a.resultado='exitoso' ORDER BY a.fecha_hora DESC LIMIT 100`, [solicitud_id]);
    res.json({ success:true, data:result.rows });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// GET /verificar-personal — debe ir ANTES de /:id
router.get('/verificar-personal', requireAuth, async (req, res) => {
  const { nombre, trabajador_id } = req.query;
  if (!nombre && !trabajador_id) return res.json({ ocupado: false });
  try {
    // Verificación primaria: por trabajador_id (único e inequívoco)
    if (trabajador_id) {
      const r = await pool.query(
        `SELECT p.folio, p.empresa, p.estado, p.fecha_fin
         FROM permiso_personal pp
         JOIN permisos p ON p.id = pp.permiso_id
         WHERE pp.trabajador_id = $1
           AND p.estado IN ('en_espera_area','aprobado_area','en_espera_seguridad','activo')
           AND pp.liberado = FALSE`,
        [parseInt(trabajador_id)]
      );
      if (r.rows.length > 0) {
        const s = r.rows[0];
        return res.json({ ocupado: true, solo_nombre: false, folio: s.folio, empresa: s.empresa, estado: s.estado, fecha_fin: s.fecha_fin });
      }
      return res.json({ ocupado: false });
    }

    // Sin trabajador_id: solo avisar por nombre, nunca bloquear
    if (nombre) {
      const r = await pool.query(
        `SELECT p.folio, p.empresa, p.estado, p.fecha_fin
         FROM permiso_personal pp
         JOIN permisos p ON p.id = pp.permiso_id
         WHERE LOWER(TRIM(pp.nombre)) = LOWER(TRIM($1))
           AND p.estado IN ('en_espera_area','aprobado_area','en_espera_seguridad','activo')
           AND pp.liberado = FALSE`,
        [nombre]
      );
      if (r.rows.length > 0) {
        const s = r.rows[0];
        return res.json({ ocupado: true, solo_nombre: true, folio: s.folio, empresa: s.empresa, estado: s.estado, fecha_fin: s.fecha_fin });
      }
    }

    res.json({ ocupado: false });
  } catch(e) {
    console.error('[verificar-personal] ERROR:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /proximas-a-vencer — debe ir ANTES de /:id
router.get('/proximas-a-vencer', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let query, params;
    if (user.rol === 'contratista') {
      query = `SELECT id, folio, empresa, fecha_fin
               FROM permisos
               WHERE estado = 'activo' AND empresa = $1
                 AND fecha_fin >= CURRENT_DATE
                 AND fecha_fin <= CURRENT_DATE + INTERVAL '3 days'
               ORDER BY fecha_fin ASC`;
      params = [user.nombre_completo];
    } else {
      query = `SELECT id, folio, empresa, fecha_fin
               FROM permisos
               WHERE estado = 'activo'
                 AND fecha_fin >= CURRENT_DATE
                 AND fecha_fin <= CURRENT_DATE + INTERVAL '3 days'
               ORDER BY fecha_fin ASC`;
      params = [];
    }
    const r = await pool.query(query, params);
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /:id — detalle completo
router.get('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (process.env.OFFLINE_MODE !== 'false') {
    const p = solicitudesMemoria.find(x=>x.id===id);
    if (!p) return res.status(404).json({ success:false, error:'No encontrado.' });
    return res.json({ success:true, data:{ solicitud:p, personal:[], vehiculos:[], equipos:[] } });
  }
  try {
    const [rP, rPer, rVeh, rEq] = await Promise.all([
      pool.query('SELECT * FROM vista_permisos WHERE id=$1', [id]),
      pool.query('SELECT * FROM permiso_personal WHERE permiso_id=$1 ORDER BY id', [id]),
      pool.query('SELECT * FROM permiso_vehiculos WHERE permiso_id=$1 ORDER BY id', [id]),
      pool.query('SELECT * FROM permiso_equipos   WHERE permiso_id=$1 ORDER BY id', [id]),
    ]);
    if (!rP.rows.length) return res.status(404).json({ success:false, error:'No encontrado.' });
    const personal = rPer.rows;
    try {
      for (const p of personal) {
        if (!p.nombre) continue;
        const pri = p.nombre.trim().split(' ')[0].toLowerCase();
        const empR = await poolFacial.query(`SELECT imss_vigente, imss_estatus, imss_fecha_vigencia, imss_nss FROM trabajadores WHERE activo=true AND LOWER(nombre) LIKE $1 LIMIT 1`, [`%${pri}%`]);
        if (empR.rows.length>0) { p.imss_vigente=empR.rows[0].imss_vigente; p.imss_estatus=empR.rows[0].imss_estatus; p.imss_fecha_vigencia=empR.rows[0].imss_fecha_vigencia; p.imss_nss=empR.rows[0].imss_nss; }
      }
    } catch(e) { console.error('Error IMSS:', e.message); }
    try {
      for (const p of personal) {
        if (!p.nombre) continue;
        const pri = p.nombre.trim().toLowerCase().split(' ')[0];
        const docResult = await poolFacial.query(`
          SELECT t.id,
            COALESCE(
              (SELECT image_base64 FROM documentos WHERE id::text = t.documento_identidad LIMIT 1),
              (SELECT image_base64 FROM documentos
               WHERE empleado_id = t.id AND image_base64 IS NOT NULL
               ORDER BY CASE WHEN doc_type IN ('INE','PASAPORTE','LICENCIA') THEN 0 ELSE 1 END, id DESC
               LIMIT 1)
            ) AS cred_base64,
            COALESCE(
              (SELECT image_mime FROM documentos WHERE id::text = t.documento_identidad LIMIT 1),
              (SELECT image_mime FROM documentos
               WHERE empleado_id = t.id AND image_base64 IS NOT NULL
               ORDER BY CASE WHEN doc_type IN ('INE','PASAPORTE','LICENCIA') THEN 0 ELSE 1 END, id DESC
               LIMIT 1),
              'image/jpeg'
            ) AS cred_mime,
            (SELECT image_base64 FROM documentos WHERE empleado_id = t.id AND doc_type = 'IMSS' LIMIT 1) AS imss_base64,
            (SELECT image_mime    FROM documentos WHERE empleado_id = t.id AND doc_type = 'IMSS' LIMIT 1) AS imss_mime
          FROM trabajadores t
          WHERE activo = true AND LOWER(t.nombre) LIKE $1
          LIMIT 1`, [`%${pri}%`]);
        if (docResult.rows.length>0) { p.cred_base64=docResult.rows[0].cred_base64||null; p.cred_mime=docResult.rows[0].cred_mime||'image/jpeg'; p.imss_base64=docResult.rows[0].imss_base64||null; p.imss_mime=docResult.rows[0].imss_mime||'image/jpeg'; }
      }
    } catch(e) { console.error('Error docs:', e.message); }
    // Fallback: si no hay cred_base64 del enrolado, usar el documento subido en el permiso
    for (const p of personal) {
      if (!p.cred_base64 && p.documento) {
        p.cred_base64 = p.documento;
        p.cred_mime   = 'image/jpeg';
      }
    }
    return res.json({ success:true, data:{ solicitud:rP.rows[0], personal, vehiculos:rVeh.rows, equipos:rEq.rows } });
  } catch(e) { return res.status(500).json({ success:false, error:e.message }); }
});

// POST /:id/salida
router.post('/:id/salida', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.rol!=='seguridad_fisica') return res.status(403).json({ success:false, error:'Solo Seguridad Física puede registrar salidas.' });
  const solicitud_id = parseInt(req.params.id); const { tipo_item, item_id, cantidad, observaciones } = req.body;
  if (!tipo_item||!item_id) return res.status(400).json({ success:false, error:'Datos incompletos.' });
  if (process.env.OFFLINE_MODE !== 'false') { if (!global.bitacoraMemoria) global.bitacoraMemoria=[]; const reg={id:global.bitacoraMemoria.length+1, permiso_id:solicitud_id, tipo_item, item_id:parseInt(item_id), cantidad:parseInt(cantidad)||1, observaciones:observaciones||null, registrado_por_username:user.username, registrado_en:new Date().toISOString()}; global.bitacoraMemoria.push(reg); return res.json({ success:true, data:reg }); }
  try {
    const rP=await pool.query('SELECT estado FROM permisos WHERE id=$1',[solicitud_id]); if (!rP.rows.length) return res.status(404).json({ success:false, error:'No encontrado.' }); if (rP.rows[0].estado!=='activo') return res.status(400).json({ success:false, error:'Solo se pueden registrar salidas en solicitudes activos.' });
    if (tipo_item==='equipo') { const rEq=await pool.query('SELECT cantidad FROM permiso_equipos WHERE id=$1 AND permiso_id=$2',[item_id,solicitud_id]); if (!rEq.rows.length) return res.status(404).json({ success:false, error:'Equipo no encontrado.' }); const rSalidas=await pool.query('SELECT COALESCE(SUM(cantidad),0) AS total FROM bitacora_salidas WHERE item_id=$1 AND tipo_item=$2',[item_id,'equipo']); const yaRegistrado=parseInt(rSalidas.rows[0].total); const cantMax=rEq.rows[0].cantidad; const cantPedir=parseInt(cantidad)||1; if (yaRegistrado+cantPedir>cantMax) return res.status(400).json({ success:false, error:`Solo quedan ${cantMax-yaRegistrado} unidades disponibles.` }); }
    const r=await pool.query(`INSERT INTO bitacora_salidas (permiso_id, tipo_item, item_id, cantidad, observaciones, registrado_por) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,[solicitud_id,tipo_item,parseInt(item_id),parseInt(cantidad)||1,observaciones||null,user.id]);
    return res.json({ success:true, data:r.rows[0] });
  } catch(e) { return res.status(500).json({ success:false, error:e.message }); }
});

// POST /:id/lote
router.post('/:id/lote', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.rol!=='contratista') return res.status(403).json({ success:false, error:'Solo el contratista puede registrar salidas.' });
  const solicitud_id = parseInt(req.params.id); const { items, observaciones, responsable_nombre } = req.body;
  if (!items||!Array.isArray(items)||items.length===0) return res.status(400).json({ success:false, error:'No hay items en el lote.' });
  if (!responsable_nombre||!responsable_nombre.trim()) return res.status(400).json({ success:false, error:'Debes seleccionar un responsable del retiro.' });
  if (process.env.OFFLINE_MODE !== 'false') { if (!global.lotesMemoria) global.lotesMemoria=[]; const lote={id:global.lotesMemoria.length+1, folio:`RET-${new Date().getFullYear()}-${String(global.lotesMemoria.length+1).padStart(4,'0')}`, solicitud_id, observaciones:observaciones||null, responsable_nombre:responsable_nombre.trim(), estado:'pendiente', registrado_por_username:user.username, registrado_en:new Date().toISOString(), items}; global.lotesMemoria.push(lote); return res.json({ success:true, data:lote }); }
  try {
    const rP=await pool.query('SELECT estado FROM permisos WHERE id=$1',[solicitud_id]); if (!rP.rows.length) return res.status(404).json({ success:false, error:'Solicitud no encontrada.' }); if (rP.rows[0].estado!=='activo') return res.status(400).json({ success:false, error:'Solo se pueden registrar salidas en solicitudes activos.' });
    for (const item of items) {
      if (item.tipo_item==='equipo') {
        const rEq=await pool.query('SELECT cantidad FROM permiso_equipos WHERE id=$1 AND permiso_id=$2',[item.item_id,solicitud_id]); if (!rEq.rows.length) return res.status(404).json({ success:false, error:`Equipo id=${item.item_id} no encontrado.` });
        const rSal=await pool.query(`SELECT COALESCE(SUM(bli.cantidad),0) AS total FROM bitacora_lote_items bli JOIN bitacora_lotes bl ON bl.id=bli.lote_id WHERE bl.permiso_id=$1 AND bl.estado='aprobado' AND bli.tipo_item='equipo' AND bli.item_id=$2`,[solicitud_id,item.item_id]);
        const yaRegistrado=parseInt(rSal.rows[0].total); const cantMax=rEq.rows[0].cantidad; const cantPedir=parseInt(item.cantidad)||1;
        if (yaRegistrado+cantPedir>cantMax) return res.status(400).json({ success:false, error:`Item id=${item.item_id}: solo quedan ${cantMax-yaRegistrado} unidades disponibles.` });
      }
    }
    const folio=await generarFolioRetiro(pool);
    const ip_registro = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const { firma_registro_ubicacion, firma_registro_ip_privada } = req.body;
    const usuario_registro = user.username || null;

    const rL = await pool.query(
      `INSERT INTO bitacora_lotes (permiso_id, registrado_por, observaciones, responsable_nombre, folio, estado,
        firma_registro_ip, firma_registro_ip_privada, firma_registro_ubicacion, firma_registro_usuario)
       VALUES ($1,$2,$3,$4,$5,'pendiente',$6,$7,$8,$9) RETURNING *`,
      [solicitud_id, user.id, observaciones||null, responsable_nombre.trim(), folio,
       ip_registro||null, firma_registro_ip_privada||null, firma_registro_ubicacion||null, usuario_registro]
    );
    const lote=rL.rows[0];
    for (const item of items) {
      const itemId = parseInt(item.item_id);
      if (isNaN(itemId)) continue;
      await pool.query(`INSERT INTO bitacora_lote_items (lote_id, tipo_item, item_id, cantidad) VALUES ($1,$2,$3,$4)`,[lote.id,item.tipo_item,itemId,parseInt(item.cantidad)||1]);
    }
    return res.json({ success:true, data:lote });
  } catch(e) { console.error('Error lote:', e.message); return res.status(500).json({ success:false, error:e.message }); }
});

// GET /:id/credenciales
router.get('/:id/credenciales', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const rSol=await pool.query('SELECT folio FROM permisos WHERE id=$1',[id]); if (!rSol.rows.length) return res.status(404).json({ error:'No encontrado' });
    const folio=rSol.rows[0].folio||String(id);
    const filePath=path.join(__dirname,'..','public','credenciales',`credenciales_${folio}.pdf`);
    await generarPDFCredenciales(pool, poolFacial, id);
    res.download(filePath);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// POST /:id/extender  — extiende directamente por permiso_id
router.post('/:id/extender', requireAuth, async (req, res) => {
  if (req.session.user.rol !== 'seguridad_fisica')
    return res.status(403).json({ success: false, error: 'Solo Seguridad Física puede extender permisos.' });

  const permiso_id = parseInt(req.params.id);
  const { dias } = req.body;

  if (!dias || dias < 1)
    return res.status(400).json({ error: 'Debes indicar al menos 1 día' });

  try {
    const rP = await pool.query('SELECT id, fecha_fin, estado, aprobado_por_seguridad FROM permisos WHERE id = $1', [permiso_id]);
    if (!rP.rows.length)
      return res.status(404).json({ error: 'Permiso no encontrado' });

    const { fecha_fin, estado, aprobado_por_seguridad } = rP.rows[0];

    if (!aprobado_por_seguridad)
      return res.status(400).json({ error: 'Este permiso nunca fue aprobado por Seguridad Física y no puede ser extendido.' });

    if (estado !== 'activo')
      return res.status(400).json({ error: 'Solo se pueden extender permisos con estado activo.' });

    const fechaFin = new Date(fecha_fin); fechaFin.setHours(0,0,0,0);
    const nuevaFechaFin = new Date(fechaFin);
    nuevaFechaFin.setDate(nuevaFechaFin.getDate() + parseInt(dias));
    const nuevaFechaStr = nuevaFechaFin.toISOString().split('T')[0];

    await pool.query(
      `UPDATE permisos SET fecha_fin = $1, actualizado_en = NOW() WHERE id = $2`,
      [nuevaFechaStr, permiso_id]
    );

    res.json({ success: true, fecha_fin_nueva: nuevaFechaStr });
  } catch(e) {
    console.error('Error extendiendo permiso:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /lote/:lote_id/extender
router.post('/lote/:lote_id/extender', requireAuth, async (req, res) => {
  if (req.session.user.rol !== 'seguridad_fisica')
    return res.status(403).json({ success: false, error: 'Solo Seguridad Física puede extender permisos.' });

  const { dias } = req.body;
  const lote_id = parseInt(req.params.lote_id);

  if (!dias || dias < 1)
    return res.status(400).json({ error: 'Debes indicar al menos 1 día' });

  try {
    // Buscar el permiso_id a través del lote
    const rLote = await pool.query(
      'SELECT bl.*, p.fecha_fin FROM bitacora_lotes bl JOIN permisos p ON p.id = bl.permiso_id WHERE bl.id = $1',
      [lote_id]
    );
    if (!rLote.rows.length)
      return res.status(404).json({ error: 'Lote no encontrado' });

    const lote = rLote.rows[0];
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const fechaFin = new Date(lote.fecha_fin); fechaFin.setHours(0,0,0,0);

    if (fechaFin >= hoy)
      return res.status(400).json({ error: 'El permiso aún no está vencido' });

    // Nueva fecha = fecha_fin actual + días
    const nuevaFechaFin = new Date(fechaFin);
    nuevaFechaFin.setDate(nuevaFechaFin.getDate() + parseInt(dias));
    const nuevaFechaStr = nuevaFechaFin.toISOString().split('T')[0];

    // Actualizar fecha_fin en permisos y reactivar
    await pool.query(
      `UPDATE permisos SET fecha_fin = $1, estado = 'activo' WHERE id = $2`,
      [nuevaFechaStr, lote.permiso_id]
    );

    res.json({ success: true, fecha_fin_nueva: nuevaFechaStr });

  } catch(e) {
    console.error('Error extendiendo permiso:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});



module.exports = router;