const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const PDFDocument = require('pdfkit');

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function getPool() {
  return require('../db/connection');
}

// ─── Generar folio retiro ─────────────────────────
async function generarFolioRetiro(pool) {
  const año = new Date().getFullYear();
  const r = await pool.query(
    `SELECT COUNT(*) as total FROM retiros_herramientas WHERE EXTRACT(YEAR FROM creado_en) = $1`,
    [año]
  );
  const n = parseInt(r.rows[0].total) + 1;
  return `RET-${año}-${String(n).padStart(4, '0')}`;
}

// =====================================================
// GET /retiros — listar retiros
// Contratista: solo los suyos (por empresa)
// Seguridad: todos
// =====================================================
router.get('/', requireAuth, async (req, res) => {
  const pool = getPool();
  const user = req.session.user;
  try {
    let query, params;
    if (user.rol === 'seguridad_fisica') {
      query = `
        SELECT r.*, p.folio AS permiso_folio, p.empresa,
               u.nombre_completo AS creado_por_nombre
        FROM retiros_herramientas r
        LEFT JOIN permisos p ON r.permiso_id = p.id
        LEFT JOIN usuarios u ON r.creado_por = u.id
        ORDER BY r.creado_en DESC`;
      params = [];
    } else if (user.rol === 'contratista') {
      query = `
        SELECT r.*, p.folio AS permiso_folio, p.empresa,
               u.nombre_completo AS creado_por_nombre
        FROM retiros_herramientas r
        LEFT JOIN permisos p ON r.permiso_id = p.id
        LEFT JOIN usuarios u ON r.creado_por = u.id
        WHERE r.creado_por = $1
        ORDER BY r.creado_en DESC`;
      params = [user.id];
    } else {
      return res.status(403).json({ success: false, error: 'Sin acceso' });
    }
    const r = await pool.query(query, params);
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// =====================================================
// GET /retiros/mis-permisos — permisos activos del contratista
// =====================================================
router.get('/mis-permisos', requireAuth, async (req, res) => {
  const pool = getPool();
  const user = req.session.user;
  if (user.rol !== 'contratista')
    return res.status(403).json({ success: false, error: 'Sin acceso' });
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const r = await pool.query(
      `SELECT p.id, p.folio, p.empresa, p.contrato, p.fecha_inicio, p.fecha_fin,
              p.responsable1, p.responsable2,
              p.responsable_contrato
       FROM permisos p
       WHERE p.creado_por = $1
         AND p.estado = 'activo'
         AND $2 BETWEEN p.fecha_inicio AND p.fecha_fin
       ORDER BY p.creado_en DESC`,
      [user.id, hoy]
    );
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// =====================================================
// GET /retiros/permiso/:id/responsables — responsables del permiso
// =====================================================
router.get('/permiso/:id/responsables', requireAuth, async (req, res) => {
  const pool = getPool();
  try {
    const r = await pool.query(
      `SELECT id, folio, empresa, responsable1, responsable2, responsable_contrato
       FROM permisos WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Permiso no encontrado' });
    const p = r.rows[0];
    // Devolver lista de responsables disponibles (los que no sean null)
    const responsables = [];
    if (p.responsable1) responsables.push(p.responsable1);
    if (p.responsable2) responsables.push(p.responsable2);
    if (p.responsable_contrato) responsables.push(p.responsable_contrato);
    res.json({ success: true, data: responsables, permiso: p });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// =====================================================
// GET /retiros/permiso/:id/equipos — equipos del permiso padre
// =====================================================
router.get('/permiso/:id/equipos', requireAuth, async (req, res) => {
  const pool = getPool();
  try {
    const r = await pool.query(
      `SELECT id, descripcion, marca, modelo, serie, cantidad
       FROM permiso_equipos WHERE permiso_id = $1 ORDER BY id`,
      [req.params.id]
    );
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// =====================================================
// POST /retiros — crear solicitud de retiro
// Solo contratista
// =====================================================
router.post('/', requireAuth, async (req, res) => {
  const pool = getPool();
  const user = req.session.user;
  if (user.rol !== 'contratista')
    return res.status(403).json({ success: false, error: 'Solo contratistas pueden crear solicitudes de retiro.' });

  const { permiso_id, nombre_retira, responsable_nombre, herramientas, observaciones } = req.body;

  if (!permiso_id || !nombre_retira || !herramientas || !herramientas.length)
    return res.status(400).json({ success: false, error: 'Faltan datos requeridos.' });

  try {
    // Validar que el permiso sea activo y del contratista
    const hoy = new Date().toISOString().split('T')[0];
    const rP = await pool.query(
      `SELECT id, folio, empresa FROM permisos
       WHERE id = $1 AND estado = 'activo' AND creado_por = $2
         AND $3 BETWEEN fecha_inicio AND fecha_fin`,
      [permiso_id, user.id, hoy]
    );
    if (!rP.rows.length)
      return res.status(400).json({ success: false, error: 'Permiso no válido o no vigente.' });

    const folio = await generarFolioRetiro(pool);

    const r = await pool.query(
      `INSERT INTO retiros_herramientas
        (folio, permiso_id, nombre_retira, responsable_nombre, herramientas, observaciones, estado, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,'pendiente',$7)
       RETURNING *`,
      [folio, permiso_id, nombre_retira, responsable_nombre || null,
       JSON.stringify(herramientas), observaciones || null, user.id]
    );

    res.json({ success: true, data: r.rows[0] });
  } catch(e) {
    console.error('Error creando retiro:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});


// =====================================================
// PUT /retiros/:id/aprobar — solo seguridad_fisica
// =====================================================
router.put('/:id/aprobar', requireAuth, async (req, res) => {
  const pool = getPool();
  const user = req.session.user;
  if (user.rol !== 'seguridad_fisica')
    return res.status(403).json({ success: false, error: 'Solo Seguridad Física puede aprobar.' });

  try {
    const r = await pool.query(
      `UPDATE retiros_herramientas
       SET estado = 'aprobado', aprobado_por = $1, fecha_aprobacion = NOW()
       WHERE id = $2 AND estado = 'pendiente'
       RETURNING *`,
      [user.id, req.params.id]
    );
    if (!r.rows.length)
      return res.status(404).json({ success: false, error: 'Retiro no encontrado o ya procesado.' });
    res.json({ success: true, data: r.rows[0] });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// =====================================================
// PUT /retiros/:id/rechazar — solo seguridad_fisica
// =====================================================
router.put('/:id/rechazar', requireAuth, async (req, res) => {
  const pool = getPool();
  const user = req.session.user;
  if (user.rol !== 'seguridad_fisica')
    return res.status(403).json({ success: false, error: 'Solo Seguridad Física puede rechazar.' });

  const { motivo } = req.body;
  try {
    const r = await pool.query(
      `UPDATE retiros_herramientas
       SET estado = 'rechazado', aprobado_por = $1, fecha_aprobacion = NOW(), motivo_rechazo = $2
       WHERE id = $3 AND estado = 'pendiente'
       RETURNING *`,
      [user.id, motivo || null, req.params.id]
    );
    if (!r.rows.length)
      return res.status(404).json({ success: false, error: 'Retiro no encontrado o ya procesado.' });
    res.json({ success: true, data: r.rows[0] });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// =====================================================
// GET /retiros/:id/pdf — generar PDF imprimible con firmas
// =====================================================






router.get('/:id/pdf', requireAuth, async (req, res) => {
  const pool = getPool();
  try {
    const r = await pool.query(
      `SELECT r.*, p.folio AS permiso_folio, p.empresa, p.contrato,
              p.fecha_inicio, p.fecha_fin,
              uc.nombre_completo AS creado_por_nombre,
              ua.nombre_completo AS aprobado_por_nombre
       FROM retiros_herramientas r
       LEFT JOIN permisos p  ON r.permiso_id = p.id
       LEFT JOIN usuarios uc ON r.creado_por  = uc.id
       LEFT JOIN usuarios ua ON r.aprobado_por = ua.id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    const retiro = r.rows[0];
    const herramientas = typeof retiro.herramientas === 'string'
      ? JSON.parse(retiro.herramientas) : retiro.herramientas;

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="retiro_${retiro.folio}.pdf"`);
    doc.pipe(res);

    // ── ENCABEZADO ────────────────────────────────────
    doc.rect(50, 40, 495, 50).fill('#1a1a1a');
    doc.fillColor('#c9a227').font('Helvetica-Bold').fontSize(16)
       .text('PROAGRO INDUSTRIA', 50, 50, { width: 495, align: 'center' });
    doc.fillColor('#ffffff').font('Helvetica').fontSize(10)
       .text('REGISTRO DE SALIDA DE HERRAMIENTAS', 50, 68, { width: 495, align: 'center' });

    // ── DATOS DEL RETIRO ──────────────────────────────
    doc.fillColor('#1a1a1a').font('Helvetica-Bold').fontSize(11)
       .text('DATOS DEL RETIRO', 50, 110);
    doc.moveTo(50, 123).lineTo(545, 123).lineWidth(1).stroke('#c9a227');

    const col1 = 50, col2 = 300;
    let y = 132;
    const campo = (label, valor, x, yPos) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#666')
         .text(label, x, yPos);
      doc.font('Helvetica').fontSize(10).fillColor('#000')
         .text(valor || '—', x, yPos + 11);
    };

    campo('FOLIO DE RETIRO', retiro.folio, col1, y);
    campo('PERMISO PADRE', retiro.permiso_folio, col2, y);
    y += 36;
    campo('EMPRESA', retiro.empresa, col1, y);
    campo('CONTRATO', retiro.contrato, col2, y);
    y += 36;
    campo('NOMBRE DE QUIEN RETIRA', retiro.nombre_retira, col1, y);
    campo('RESPONSABLE', retiro.responsable_nombre, col2, y);
    y += 36;

    const fechaCreado = new Date(retiro.creado_en).toLocaleString('es-MX');
    const fechaAprobado = retiro.fecha_aprobacion
      ? new Date(retiro.fecha_aprobacion).toLocaleString('es-MX') : '—';
    campo('FECHA DE SOLICITUD', fechaCreado, col1, y);
    campo('FECHA DE APROBACIÓN', fechaAprobado, col2, y);
    y += 36;

    // Estado
    const estadoColor = retiro.estado === 'aprobado' ? '#16a34a' : retiro.estado === 'rechazado' ? '#dc2626' : '#d97706';
    campo('ESTADO', '', col1, y);
    doc.rect(col1, y + 9, 80, 16).fill(estadoColor);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9)
       .text(retiro.estado.toUpperCase(), col1, y + 12, { width: 80, align: 'center' });
    y += 36;

    if (retiro.observaciones) {
      campo('OBSERVACIONES', retiro.observaciones, col1, y);
      y += 36;
    }

    // ── HERRAMIENTAS ──────────────────────────────────
    y += 8;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a1a')
       .text('HERRAMIENTAS / EQUIPOS', col1, y);
    doc.moveTo(50, y + 13).lineTo(545, y + 13).lineWidth(1).stroke('#c9a227');
    y += 22;

    // Encabezado tabla
    doc.rect(col1, y, 495, 18).fill('#1a1a1a');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
    doc.text('DESCRIPCIÓN', col1 + 5, y + 5);
    doc.text('MARCA/MODELO', col1 + 220, y + 5);
    doc.text('SERIE', col1 + 350, y + 5);
    doc.text('CANTIDAD', col1 + 440, y + 5);
    y += 18;

    herramientas.forEach((h, i) => {
      if (i % 2 === 0) doc.rect(col1, y, 495, 18).fill('#f9f9f9');
      doc.fillColor('#000').font('Helvetica').fontSize(8);
      doc.text(h.descripcion || '—', col1 + 5, y + 5, { width: 210 });
      doc.text((h.marca || '') + (h.modelo ? ' ' + h.modelo : ''), col1 + 220, y + 5, { width: 125 });
      doc.text(h.serie || '—', col1 + 350, y + 5, { width: 85 });
      doc.text(String(h.cantidad || 1), col1 + 440, y + 5, { width: 50, align: 'center' });
      doc.rect(col1, y, 495, 18).lineWidth(0.5).stroke('#ddd');
      y += 18;
    });

    // ── FIRMAS ────────────────────────────────────────
    y += 40;
    if (y > 680) { doc.addPage(); y = 50; }

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a1a')
       .text('FIRMAS DE CONFORMIDAD', col1, y);
    doc.moveTo(50, y + 13).lineTo(545, y + 13).lineWidth(1).stroke('#c9a227');
    y += 30;

    // Firma solicitante
    doc.moveTo(col1, y + 50).lineTo(col1 + 180, y + 50).lineWidth(1).stroke('#000');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000')
       .text('SOLICITANTE', col1, y + 55, { width: 180, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#555')
       .text(retiro.creado_por_nombre || '—', col1, y + 66, { width: 180, align: 'center' });

    // Firma responsable
    doc.moveTo(col1 + 155, y + 50).lineTo(col1 + 335, y + 50).lineWidth(1).stroke('#000');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000')
       .text('RESPONSABLE DE RETIRO', col1 + 155, y + 55, { width: 180, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#555')
       .text(retiro.responsable_nombre || '—', col1 + 155, y + 66, { width: 180, align: 'center' });

    // Firma seguridad
    doc.moveTo(col1 + 315, y + 50).lineTo(col1 + 495, y + 50).lineWidth(1).stroke('#000');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000')
       .text('AUTORIZA SEGURIDAD FÍSICA', col1 + 315, y + 55, { width: 180, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#555')
       .text(retiro.aprobado_por_nombre || '—', col1 + 315, y + 66, { width: 180, align: 'center' });

    // Pie
    y += 100;
    doc.font('Helvetica').fontSize(7).fillColor('#aaa')
       .text(`Documento generado el ${new Date().toLocaleString('es-MX')} — PROAGRO Industria`, 50, y, { width: 495, align: 'center' });

    doc.end();
  } catch(e) {
    console.error('Error PDF retiro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
