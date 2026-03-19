const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');

// Pool para reconocimiento_db
const poolFacial = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.FACIAL_DB_NAME || 'reconocimiento_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Pool para solicitudes_db (seguridad_fisica)
const poolSolicitudes = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireSeguridad(req, res, next) {
  if (req.session?.user?.rol !== 'seguridad_fisica')
    return res.status(403).json({ error: 'Solo Seguridad Física puede acceder' });
  next();
}

// Solo contratista puede enrolar
function requireEnrolador(req, res, next) {
  const rol = req.session?.user?.rol;
  if (rol !== 'contratista')
    return res.status(403).json({ error: 'Solo el contratista puede enrolar personal' });
  next();
}

function calcularDistancia(desc1, desc2) {
  if (!desc1 || !desc2 || desc1.length !== desc2.length) return 999;
  let sum = 0;
  for (let i = 0; i < desc1.length; i++) sum += Math.pow(desc1[i] - desc2[i], 2);
  return Math.sqrt(sum);
}

// ─── POST /facial/verificar ────────────────────────
// Reconoce rostro, busca solicitud activo y determina entrada/salida automáticamente
router.post('/verificar', requireAuth, requireSeguridad, async (req, res) => {
  const { descriptor } = req.body;
  if (!descriptor || !Array.isArray(descriptor))
    return res.status(400).json({ error: 'Descriptor requerido' });

  try {
    const ip        = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    // 1. Reconocer rostro
    const empleados = await poolFacial.query(
      `SELECT id, nombre, apellido, area, cargo, empresa, face_descriptor
       FROM trabajadores WHERE activo = true AND face_descriptor IS NOT NULL`
    );

    let mejorMatch = null, mejorDistancia = 999;
    const UMBRAL = 0.5;

    for (const emp of empleados.rows) {
      try {
        const dist = calcularDistancia(descriptor, JSON.parse(emp.face_descriptor));
        if (dist < mejorDistancia) { mejorDistancia = dist; mejorMatch = emp; }
      } catch(e) { continue; }
    }

    if (!mejorMatch || mejorDistancia >= UMBRAL) {
      await poolFacial.query(
        `INSERT INTO accesos (resultado, ip_origen, user_agent, tipo_movimiento, fecha_hora)
         VALUES ($1,$2,$3,$4,NOW())`,
        ['fallido', ip, userAgent, 'entrada']
      );
      return res.status(401).json({ acceso: 'denegado', mensaje: 'Rostro no reconocido' });
    }

    const similitud = parseFloat((1 - mejorDistancia).toFixed(4));
    const nombreCompleto = `${mejorMatch.nombre} ${mejorMatch.apellido}`;

    // 2. Buscar solicitud activo hoy para esta persona
    const hoy = new Date().toISOString().split('T')[0];
    const solicitudResult = await poolSolicitudes.query(
      `SELECT p.id, p.folio, p.empresa, p.fecha_inicio, p.fecha_fin
       FROM permisos p
       INNER JOIN permiso_personal pp ON pp.permiso_id = p.id
       WHERE p.estado = 'activo'
         AND $1 BETWEEN p.fecha_inicio AND p.fecha_fin
         AND LOWER(pp.nombre) = LOWER($2)
       LIMIT 1`,
      [hoy, nombreCompleto]
    );

    const solicitud = solicitudResult.rows[0] || null;

    // 3. Determinar tipo de movimiento automáticamente
    // Buscar último registro de hoy para este empleado
    const ultimoAcceso = await poolFacial.query(
      `SELECT tipo_movimiento FROM accesos
       WHERE empleado_id = $1
         AND resultado = 'exitoso'
         AND DATE(fecha_hora) = CURRENT_DATE
       ORDER BY fecha_hora DESC
       LIMIT 1`,
      [mejorMatch.id]
    );

    let tipo_movimiento;
    if (ultimoAcceso.rows.length === 0 || ultimoAcceso.rows[0].tipo_movimiento === 'salida') {
      tipo_movimiento = 'entrada';
    } else {
      tipo_movimiento = 'salida';
    }

    // 4. Registrar acceso
    await poolFacial.query(
      `INSERT INTO accesos (empleado_id, resultado, similitud, ip_origen, user_agent, tipo_movimiento, permiso_id, fecha_hora)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [mejorMatch.id, 'exitoso', similitud, ip, userAgent, tipo_movimiento, solicitud?.id || null]
    );

    return res.json({
      acceso: 'permitido',
      tipo_movimiento,
      empleado: {
        id:       mejorMatch.id,
        nombre:   mejorMatch.nombre,
        apellido: mejorMatch.apellido,
        area:     mejorMatch.area,
        cargo:    mejorMatch.cargo,
        empresa:  mejorMatch.empresa,
      },
      solicitud: solicitud ? {
        id:     solicitud.id,
        folio:  solicitud.folio,
        empresa: solicitud.empresa,
        fecha_inicio: solicitud.fecha_inicio,
        fecha_fin:    solicitud.fecha_fin,
      } : null,
      similitud,
      hora: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
    });

  } catch(e) {
    console.error('Error verificar facial:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /facial/enrolar ──────────────────────────
router.post('/enrolar', requireAuth, requireEnrolador, async (req, res) => {
  const { nombre, apellido, email, documento, area, cargo, empresa, descriptor, estatus } = req.body;
  if (!nombre || !apellido || !descriptor)
    return res.status(400).json({ error: 'Nombre, apellido y descriptor son obligatorios' });

  try {
    if (email) {
      const existe = await poolFacial.query('SELECT id FROM trabajadores WHERE email=$1', [email]);
      if (existe.rows.length > 0)
        return res.status(409).json({ error: 'Ya existe un empleado con ese email' });
    }
    const result = await poolFacial.query(
      `INSERT INTO trabajadores (nombre, apellido, email, documento_identidad, area, cargo, empresa, face_descriptor, estatus, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, nombre, apellido`,
      [nombre, apellido, email||null, documento||null, area||'General', cargo||'Empleado',
       empresa||null, JSON.stringify(descriptor), estatus||'no_activo', false]
    );
    res.json({ success: true, empleado: result.rows[0] });
  } catch(e) {
    console.error('Error enrolar:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /facial/accesos ───────────────────────────
router.get('/accesos', requireAuth, requireSeguridad, async (req, res) => {
  try {
    const result = await poolFacial.query(
      `SELECT a.id, a.resultado, a.similitud, a.tipo_movimiento,
              a.permiso_id, a.fecha_hora,
              COALESCE(a.fecha_hora::text, a.timestamp::text) as tiempo,
              e.nombre, e.apellido, e.area, e.empresa
       FROM accesos a
       LEFT JOIN trabajadores e ON a.empleado_id = e.id
       ORDER BY COALESCE(a.fecha_hora, a.timestamp) DESC
       LIMIT 200`
    );
    res.json({ success: true, data: result.rows });
  } catch(e) {
    console.error('Error accesos:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /facial/empleados ─────────────────────────
router.get('/empleados', requireAuth, requireSeguridad, async (req, res) => {
  try {
    const result = await poolFacial.query(
      `SELECT id, nombre, apellido, email, area, cargo, empresa, activo, creado_en
       FROM trabajadores ORDER BY nombre ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /facial/mi-personal ── Lista personal del contratista
router.get('/mi-personal', requireAuth, async (req, res) => {
  if (req.session.user.rol !== 'contratista')
    return res.status(403).json({ error: 'Sin acceso' });
  const empresa = req.session.user.nombre_completo;
  try {
    const r = await poolFacial.query(
      `SELECT e.id, e.nombre, e.apellido, e.documento_identidad, e.area, e.cargo,
              e.empresa, e.estatus, e.activo, e.creado_en,
              e.imss_vigente, e.imss_estatus, e.imss_fecha_vigencia,
              (SELECT COUNT(*) FROM documentos d WHERE d.empleado_id = e.id) as total_docs
       FROM trabajadores e
       WHERE LOWER(e.empresa) = LOWER($1)
       ORDER BY e.creado_en DESC`,
      [empresa]
    );
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── GET /facial/todo-personal ── Lista todo el personal (seguridad física)
router.get('/todo-personal', requireAuth, requireSeguridad, async (req, res) => {
  try {
    const r = await poolFacial.query(
      `SELECT e.id, e.nombre, e.apellido, e.documento_identidad, e.area, e.cargo,
              e.empresa, e.estatus, e.activo, e.creado_en,
              e.imss_vigente, e.imss_estatus, e.imss_fecha_vigencia,
              (SELECT COUNT(*) FROM documentos d WHERE d.empleado_id = e.id) as total_docs
       FROM trabajadores e
       ORDER BY e.creado_en DESC`
    );
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── GET /facial/empleados-por-empresa ────────────
router.get('/empleados-por-empresa', requireAuth, async (req, res) => {
  const { empresa } = req.query;
  if (!empresa || empresa.trim().length < 1)
    return res.json({ success: true, data: [] });
  try {
    const result = await poolFacial.query(
      `SELECT id, nombre, apellido, area, cargo, documento_identidad, empresa
       FROM trabajadores
       WHERE activo = true AND estatus = 'activo' AND LOWER(empresa) = LOWER($1)
       ORDER BY nombre ASC`,
      [empresa.trim()]
    );
    res.json({ success: true, data: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /facial/empleados-pendientes ─────────────
// Empleados creados desde documentos, sin rostro aún
router.get('/empleados-pendientes', requireAuth, requireEnrolador, async (req, res) => {
  try {
    const result = await poolFacial.query(
      `SELECT id, nombre, apellido, documento_identidad, empresa, cargo
       FROM trabajadores
       WHERE activo = false AND (face_descriptor IS NULL OR face_descriptor = 'null')
       ORDER BY nombre ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /facial/empleados/:id/enrolar ────────────
// Actualiza empleado pendiente con descriptor facial y lo activa
router.put('/empleados/:id/enrolar', requireAuth, requireEnrolador, async (req, res) => {
  const { nombre, apellido, email, documento, area, cargo, empresa, descriptor } = req.body;
  if (!descriptor) return res.status(400).json({ error: 'Descriptor requerido' });
  try {
    const result = await poolFacial.query(
      `UPDATE trabajadores SET
        nombre = COALESCE($1, nombre),
        apellido = COALESCE($2, apellido),
        email = COALESCE(NULLIF($3,''), email),
        documento_identidad = COALESCE(NULLIF($4,''), documento_identidad),
        area = COALESCE(NULLIF($5,''), area),
        cargo = COALESCE(NULLIF($6,''), cargo),
        empresa = COALESCE(NULLIF($7,''), empresa),
        face_descriptor = $8,
        activo = true
      WHERE id = $9
      RETURNING id, nombre, apellido`,
      [nombre, apellido, email||null, documento||null, area||null, cargo||null, empresa||null,
       JSON.stringify(descriptor), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json({ success: true, empleado: result.rows[0] });
  } catch(e) {
    console.error('Error enrolar pendiente:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /facial/empleados/:id/estatus ── Solo Seguridad Física
router.put('/empleados/:id/estatus', requireAuth, requireSeguridad, async (req, res) => {
  const { estatus } = req.body;
  if (!['activo', 'vetado'].includes(estatus))
    return res.status(400).json({ error: 'Estatus inválido' });
  try {
    const activo = estatus === 'activo';
    await poolFacial.query(
      `UPDATE trabajadores SET estatus=$1, activo=$2 WHERE id=$3`,
      [estatus, activo, req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /facial/empleados/:id ─────────────────
router.delete('/empleados/:id', requireAuth, requireSeguridad, async (req, res) => {
  try {
    await poolFacial.query('UPDATE trabajadores SET activo=false WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, poolFacial };
