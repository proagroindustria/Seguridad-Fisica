const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const QRCode  = require('qrcode');

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

// Pool para bd_principal (proveedores)
const poolBDPrincipal = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.BD_PRINCIPAL_NAME || 'bd_principal',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function obtenerPadronPorEmpresas(empresas) {
  if (!empresas.length) return {};
  try {
    const r = await poolBDPrincipal.query(
      `SELECT LOWER(TRIM(nombre)) AS nombre_key, padron
       FROM proveedores
       WHERE LOWER(TRIM(nombre)) = ANY($1)`,
      [empresas.map(e => e.toLowerCase().trim())]
    );
    const map = {};
    r.rows.forEach(row => { map[row.nombre_key] = row.padron; });
    return map;
  } catch(e) {
    console.error('Error obteniendo padrones:', e.message);
    return {};
  }
}

// Migración: añade columnas es_invitado y qr_code si no existen
(async () => {
  try {
    await poolFacial.query(`
      ALTER TABLE trabajadores
        ADD COLUMN IF NOT EXISTS es_invitado BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS qr_code     TEXT
    `);
    console.log('[MIGRACIÓN] trabajadores: columnas es_invitado, qr_code OK');
  } catch(e) {
    console.error('[MIGRACIÓN] trabajadores:', e.message);
  }
})();

function requireAuth(req, res, next) {
  console.log('AUTH:', req.method, req.path, '| session keys:', Object.keys(req.session));
  if (!req.session?.user && !req.session?.asistencia_user)
    return res.status(401).json({ error: 'No autenticado' });
  next();
}

function requireSeguridad(req, res, next) {
  const rol = req.session?.user?.rol || req.session?.asistencia_user?.rol;
  if (rol !== 'seguridad_fisica')
    return res.status(403).json({ error: 'Solo Seguridad Física puede acceder' });
  next();
}

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

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Valida si un trabajador puede registrar checada
// ─────────────────────────────────────────────────────────────────────────────
async function validarAccesoTrabajador(trabajadorId) {
  const { rows } = await poolFacial.query(
    `SELECT id, nombre, apellido, estatus, activo, fecha_induccion
     FROM trabajadores WHERE id = $1`,
    [trabajadorId]
  );
  const t = rows[0];
  if (!t) return { permitido: false, razon: 'NO_ENCONTRADO', detalle: 'Trabajador no encontrado en el sistema.' };

  const nombreCompleto = `${t.nombre} ${t.apellido}`;

  if (t.estatus === 'vetado') return { permitido: false, razon: 'VETADO', detalle: `${nombreCompleto} se encuentra vetado y no puede registrar acceso. Contacta al área de Seguridad Física.` };
  if (t.estatus !== 'activo' || !t.activo) return { permitido: false, razon: 'INACTIVO', detalle: `${nombreCompleto} no tiene estatus activo en el sistema.` };
  if (!t.fecha_induccion) return { permitido: false, razon: 'SIN_INDUCCION', detalle: `${nombreCompleto} no tiene fecha de inducción registrada. Es necesario completar la inducción antes de ingresar.` };

  // PRUEBA: cambiar a  new Date()  cuando termines de verificar el fix
  const hoy = new Date('2026-05-21T19:00:00-06:00');
  const fechaInduccion = new Date(t.fecha_induccion);
  const limiteVigencia = new Date(fechaInduccion);
  limiteVigencia.setFullYear(limiteVigencia.getFullYear() + 1);
  if (hoy > limiteVigencia) {
    const fechaStr = fechaInduccion.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
    const vencioStr = limiteVigencia.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
    return { permitido: false, razon: 'INDUCCION_VENCIDA', detalle: `La inducción de ${nombreCompleto} venció el ${vencioStr}. Fue realizada el ${fechaStr} y solo tiene vigencia de 1 año. Se requiere renovación.` };
  }

  const hoyStr = new Intl.DateTimeFormat('sv', { timeZone: 'America/Mexico_City' }).format(hoy);
  const horaUTC    = hoy.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  const horaMx     = hoy.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', hour12: false });
  const fechaUTC   = hoy.toISOString().split('T')[0];
  console.log(`[FECHA-CHECK] Trabajador: ${nombreCompleto}`);
  console.log(`[FECHA-CHECK]   Hora UTC    : ${horaUTC}`);
  console.log(`[FECHA-CHECK]   Hora México : ${horaMx}`);
  console.log(`[FECHA-CHECK]   Fecha UTC   : ${fechaUTC}  ${fechaUTC !== hoyStr ? '⚠ DIFIERE (bug sin fix)' : '✓ igual'}`);
  console.log(`[FECHA-CHECK]   Fecha usada : ${hoyStr}  ← esta se compara contra el permiso`);
  const { rows: permisos } = await poolSolicitudes.query(
    `SELECT p.id, p.folio FROM permisos p
     INNER JOIN permiso_personal pp ON pp.permiso_id = p.id
     WHERE p.estado = 'activo' AND $1 BETWEEN p.fecha_inicio AND p.fecha_fin
       AND LOWER(pp.nombre) = LOWER($2) LIMIT 1`,
    [hoyStr, nombreCompleto]
  );
  if (!permisos.length) return { permitido: false, razon: 'SIN_PERMISO', detalle: `${nombreCompleto} no tiene un permiso de acceso activo y vigente para el día de hoy.` };

  return { permitido: true, trabajador: t };
}

// ─── POST /facial/verificar ────────────────────────────────────────────────
router.post('/verificar', requireAuth, requireSeguridad, async (req, res) => {
  const { descriptor } = req.body;
  if (!descriptor || !Array.isArray(descriptor))
    return res.status(400).json({ error: 'Descriptor requerido' });

  try {
    console.log('HEADERS IP:', req.headers['x-real-ip'], '| body ip:', req.body.ip_cliente, '| socket:', req.socket.remoteAddress);
    const raw = req.body.ip_cliente || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
    const ip = raw.replace('::ffff:', '').split(',')[0].trim();
    const userAgent = req.headers['user-agent'];

    const empleados = await poolFacial.query(
      `SELECT id, nombre, apellido, area, cargo, empresa, face_descriptor
       FROM trabajadores WHERE face_descriptor IS NOT NULL`
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
        `INSERT INTO accesos (resultado, ip_origen, user_agent, tipo_movimiento, fecha_hora) VALUES ($1,$2,$3,$4,NOW())`,
        ['fallido', ip, userAgent, 'entrada']
      );
      return res.status(401).json({ acceso: 'denegado', mensaje: 'Rostro no reconocido' });
    }

    const similitud = parseFloat((1 - mejorDistancia).toFixed(4));
    const validacion = await validarAccesoTrabajador(mejorMatch.id);

    if (!validacion.permitido) {
      await poolFacial.query(
        `INSERT INTO accesos (empleado_id, resultado, similitud, ip_origen, user_agent, tipo_movimiento, fecha_hora, nombre_snapshot, area_snapshot, empresa_snapshot) VALUES ($1,'fallido',$2,$3,$4,'entrada',NOW(),$5,$6,$7)`,
        [mejorMatch.id, similitud, ip, userAgent, `${mejorMatch.nombre} ${mejorMatch.apellido}`, mejorMatch.area, mejorMatch.empresa]
      );
      return res.json({ acceso: 'denegado', acceso_denegado: true, razon: validacion.razon, detalle: validacion.detalle, nombre: `${mejorMatch.nombre} ${mejorMatch.apellido}` });
    }

    const nombreCompleto = `${mejorMatch.nombre} ${mejorMatch.apellido}`;
    const hoy = new Intl.DateTimeFormat('sv', { timeZone: 'America/Mexico_City' }).format(new Date());
    const solicitudResult = await poolSolicitudes.query(
      `SELECT p.id, p.folio, p.empresa, p.fecha_inicio, p.fecha_fin FROM permisos p
       INNER JOIN permiso_personal pp ON pp.permiso_id = p.id
       WHERE p.estado = 'activo' AND $1 BETWEEN p.fecha_inicio AND p.fecha_fin AND LOWER(pp.nombre) = LOWER($2) LIMIT 1`,
      [hoy, nombreCompleto]
    );
    const solicitud = solicitudResult.rows[0] || null;

    const ultimoAcceso = await poolFacial.query(
      `SELECT tipo_movimiento FROM accesos WHERE empleado_id=$1 AND resultado='exitoso' AND DATE(fecha_hora)=CURRENT_DATE ORDER BY fecha_hora DESC LIMIT 1`,
      [mejorMatch.id]
    );
    const tipo_movimiento = (ultimoAcceso.rows.length === 0 || ultimoAcceso.rows[0].tipo_movimiento === 'salida') ? 'entrada' : 'salida';

    await poolFacial.query(
      `INSERT INTO accesos (empleado_id, resultado, similitud, ip_origen, user_agent, tipo_movimiento, permiso_id, fecha_hora, nombre_snapshot, area_snapshot, empresa_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10)`,
      [mejorMatch.id, 'exitoso', similitud, ip, userAgent, tipo_movimiento, solicitud?.id || null, `${mejorMatch.nombre} ${mejorMatch.apellido}`, mejorMatch.area, mejorMatch.empresa]
    );

    return res.json({
      acceso: 'permitido', tipo_movimiento,
      empleado: { id: mejorMatch.id, nombre: mejorMatch.nombre, apellido: mejorMatch.apellido, area: mejorMatch.area, cargo: mejorMatch.cargo, empresa: mejorMatch.empresa },
      solicitud: solicitud ? { id: solicitud.id, folio: solicitud.folio, empresa: solicitud.empresa, fecha_inicio: solicitud.fecha_inicio, fecha_fin: solicitud.fecha_fin } : null,
      similitud,
      hora: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
    });
  } catch(e) {
    console.error('Error verificar facial:', e);
    res.status(500).json({ error: e.message });
  }
});









router.post('/verificar-duplicado', requireAuth, requireEnrolador, async (req, res) => {
  const { nss, empresa } = req.body;  // ya no necesitas nombre ni apellido

  if (!nss) return res.json({ duplicado: false });

  try {
    const nssOtraEmpresa = await poolFacial.query(
      `SELECT id FROM trabajadores
       WHERE imss_nss = $1 AND activo = true AND LOWER(empresa) != LOWER($2)`,
      [nss, empresa || '']
    );
    if (nssOtraEmpresa.rows.length > 0) {
      return res.json({ duplicado: true, mensaje: 'Este trabajador ya está registrado en el sistema.' });
    }

    const nssMismaEmpresa = await poolFacial.query(
      `SELECT id, activo FROM trabajadores
       WHERE imss_nss = $1 AND LOWER(empresa) = LOWER($2)`,
      [nss, empresa || '']
    );
    if (nssMismaEmpresa.rows.length > 0) {
      const estado = nssMismaEmpresa.rows[0].activo ? 'activo' : 'inactivo';
      return res.json({ duplicado: true, mensaje: `Este trabajador ya está registrado en el sistema.` });
    }

    res.json({ duplicado: false });

  } catch(e) {
    res.status(500).json({ error: 'Error en verificación' });
  }
});








// ─── POST /facial/enrolar ──────────────────────────
router.post('/enrolar', requireAuth, requireEnrolador, async (req, res) => {
  
  const {
    nombre, apellido, email, documento, area, cargo, empresa, descriptor, estatus,
    imss_vigente, imss_estatus, imss_fecha_vigencia, imss_nss, registro_patronal
  } = req.body;

  // Validaciones obligatorias
  if (!nombre || !apellido || !descriptor) {
    return res.status(400).json({ 
      error: 'Nombre, apellido y descriptor son obligatorios' 
    });
  }

  // Validar formato del descriptor (ejemplo básico)
  if (typeof descriptor !== 'object' || !descriptor.length) {
    return res.status(400).json({ 
      error: 'El descriptor facial debe ser un array válido' 
    });
  }

  try {
    // 1. Validar email duplicado
    if (email) {
      const existe = await poolFacial.query(
        'SELECT id FROM trabajadores WHERE email = $1 AND activo = true',
        [email]
      );
      if (existe.rows.length > 0) {
        return res.status(409).json({ 
          error: 'Ya existe un empleado activo con ese email' 
        });
      }
    }

    // 2. Validar NSS (unificado)
    if (imss_nss) {
      // Verificar si existe activo en OTRA empresa
      const nssOtraEmpresa = await poolFacial.query(
        `SELECT id, nombre, apellido, empresa
         FROM trabajadores
         WHERE imss_nss = $1 
           AND activo = true 
           AND LOWER(empresa) != LOWER($2)`,
        [imss_nss, empresa || '']
      );
      
      if (nssOtraEmpresa.rows.length > 0) {
        const t = nssOtraEmpresa.rows[0];
        return res.status(409).json({
          error: `Un trabajador no puede estar dado de alta en dos empresas al mismo tiempo.`
        });
      }

      // Verificar si existe en la MISMA empresa (activo o inactivo)
      const nssMismaEmpresa = await poolFacial.query(
        `SELECT id, activo FROM trabajadores
         WHERE imss_nss = $1 AND LOWER(empresa) = LOWER($2)`,
        [imss_nss, empresa || '']
      );
      
      if (nssMismaEmpresa.rows.length > 0) {
        const estado = nssMismaEmpresa.rows[0].activo ? 'activo' : 'inactivo';
        return res.status(409).json({
          error: `Este trabajador ya está dado de alta en tu empresa (${estado}).`
        });
      }
    }

    
    // 4. Insertar nuevo trabajador
    const result = await poolFacial.query(
      `INSERT INTO trabajadores
        (nombre, apellido, email, documento_identidad, area, cargo, empresa,
         face_descriptor, estatus, activo,
         imss_vigente, imss_estatus, imss_fecha_vigencia, imss_nss, registro_patronal)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id, nombre, apellido, email, empresa`,
      [
        nombre, 
        apellido, 
        email || null, 
        documento || null, 
        area || 'General', 
        cargo || 'Empleado',
        empresa || null, 
        JSON.stringify(descriptor), 
        estatus || 'activo',  // Cambiado a 'activo' por defecto
        true,  // Cambiado a true (activo al enrolarse)
        imss_vigente !== undefined ? imss_vigente : null,
        imss_estatus || null, 
        imss_fecha_vigencia || null, 
        imss_nss || null, 
        registro_patronal || null
      ]
    );
    
    res.json({ 
      success: true, 
      empleado: result.rows[0] 
    });
    
  } catch(e) {
    console.error('Error en enrolamiento:', e);
    res.status(500).json({ 
      error: 'Error interno al enrolar trabajador',
      detalle: process.env.NODE_ENV === 'development' ? e.message : undefined
    });
  }
});
























// ─── GET /facial/accesos ───────────────────────────
router.get('/accesos', requireAuth, requireSeguridad, async (req, res) => {
  try {
    const result = await poolFacial.query(
      `SELECT a.id, a.resultado, a.similitud, a.tipo_movimiento,
              a.permiso_id, a.fecha_hora, a.ip_origen,
              COALESCE(a.fecha_hora::text, a.timestamp::text) as tiempo,
              COALESCE(e.nombre || ' ' || e.apellido, a.nombre_snapshot) as nombre_completo,
              COALESCE(e.area,    a.area_snapshot)    as area,
              COALESCE(e.empresa, a.empresa_snapshot) as empresa
       FROM accesos a
       LEFT JOIN trabajadores e ON a.empleado_id = e.id
       ORDER BY COALESCE(a.fecha_hora, a.timestamp) DESC`
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

// ─── GET /facial/mi-personal ──────────────────────
router.get('/mi-personal', requireAuth, async (req, res) => {
  if (req.session.user.rol !== 'contratista')
    return res.status(403).json({ error: 'Sin acceso' });
  const empresa = req.session.user.nombre_completo;
  try {
    const r = await poolFacial.query(
      `SELECT e.id, e.nombre, e.apellido, e.documento_identidad, e.area, e.cargo,
              e.empresa, e.estatus, e.activo, e.creado_en,
              e.imss_vigente, e.imss_estatus, e.imss_fecha_vigencia, e.fecha_induccion,
              e.imss_nss,
              (SELECT COUNT(*) FROM documentos d WHERE d.empleado_id = e.id) as total_docs
       FROM trabajadores e
       WHERE LOWER(e.empresa) = LOWER($1) AND e.activo = true
       ORDER BY e.creado_en DESC`,
      [empresa]
    );
    const padronMap = await obtenerPadronPorEmpresas(
      [...new Set(r.rows.map(e => (e.empresa||'').toLowerCase().trim()).filter(Boolean))]
    );
    const data = r.rows.map(e => ({ ...e, padron: padronMap[(e.empresa||'').toLowerCase().trim()] || null }));
    res.json({ success: true, data });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── GET /facial/todo-personal ────────────────────
router.get('/todo-personal', requireAuth, requireSeguridad, async (req, res) => {
  try {
    const r = await poolFacial.query(
      `SELECT e.id, e.nombre, e.apellido, e.documento_identidad, e.area, e.cargo,
              e.empresa, e.estatus, e.activo, e.creado_en,
              e.imss_vigente, e.imss_estatus, e.imss_fecha_vigencia, e.fecha_induccion,
              e.imss_nss,
              (SELECT COUNT(*) FROM documentos d WHERE d.empleado_id = e.id) as total_docs
       FROM trabajadores e
       WHERE e.activo = true
       ORDER BY e.creado_en DESC`
    );
    const padronMap = await obtenerPadronPorEmpresas(
      [...new Set(r.rows.map(e => (e.empresa||'').toLowerCase().trim()).filter(Boolean))]
    );
    const data = r.rows.map(e => ({ ...e, padron: padronMap[(e.empresa||'').toLowerCase().trim()] || null }));
    res.json({ success: true, data });
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
      `SELECT id, nombre, apellido, area, cargo, documento_identidad, empresa, imss_nss
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

// ─── PUT /facial/empleados/:id/estatus ────────────
router.put('/empleados/:id/estatus', requireAuth, requireSeguridad, async (req, res) => {
  const { estatus } = req.body;
  if (!['activo', 'vetado', 'no_activo'].includes(estatus))
    return res.status(400).json({ error: 'Estatus inválido' });
  try {
    const activo = estatus === 'activo';
    await poolFacial.query(`UPDATE trabajadores SET estatus=$1, activo=$2 WHERE id=$3`, [estatus, activo, req.params.id]);
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

// ─── GET /facial/empleados/:id/accesos ────────────
router.get('/empleados/:id/accesos', requireAuth, async (req, res) => {
  try {
    const r = await poolFacial.query(
      `SELECT id, tipo_movimiento, resultado, similitud, fecha_hora
       FROM accesos WHERE empleado_id=$1 AND resultado='exitoso'
       ORDER BY fecha_hora DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ success: true, data: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── PUT /facial/empleados/:id/fecha-induccion ────
router.put('/empleados/:id/fecha-induccion', requireAuth, requireSeguridad, async (req, res) => {
  const { fecha_induccion } = req.body;
  try {
    await poolFacial.query(`UPDATE trabajadores SET fecha_induccion=$1 WHERE id=$2`, [fecha_induccion || null, req.params.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── GET /facial/notificaciones-sin-checkin ───────
router.get('/notificaciones-sin-checkin', requireAuth, async (req, res) => {
  const empresa = req.session.user?.nombre_completo;
  if (!empresa) return res.status(403).json({ error: 'Sin acceso' });
  try {
    const trabajadores = await poolFacial.query(`
      SELECT DISTINCT t.id, t.nombre, t.apellido, t.empresa,
        COALESCE((SELECT MAX(a.fecha_hora) FROM accesos a WHERE a.empleado_id=t.id AND a.resultado='exitoso'), NULL) as ultimo_acceso
      FROM trabajadores t
      WHERE LOWER(t.empresa) = LOWER($1) AND t.activo = true
    `, [empresa]);

    const hoy = new Date();
    const sinCheckin = trabajadores.rows.filter(t => {
      if (!t.ultimo_acceso) return true;
      const diffDias = Math.floor((hoy - new Date(t.ultimo_acceso)) / (1000*60*60*24));
      return diffDias >= 4;
    });
    res.json({ success: true, data: sinCheckin, total: sinCheckin.length });
  } catch(e) {
    console.error('Error notificaciones:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── POST /facial/registrar-invitado ─────────────────────────────────────
// Llamado por N8N. No requiere sesión de usuario (es un webhook interno).
router.post('/registrar-invitado', async (req, res) => {
  const { nombre, apellido, empresa, permiso_id, nss } = req.body;
  if (!nombre || !apellido) {
    return res.status(400).json({ success: false, error: 'nombre y apellido son requeridos' });
  }

  try {
    const nombreTrim   = nombre.trim();
    const apellidoTrim = apellido.trim();
    const empresaTrim  = (empresa || '').trim();
    const nssTrim      = (nss || '').trim();

    // Buscar trabajador regular existente:
    // Si viene NSS → comparar por NSS (único, sin ambigüedad)
    // Si no viene NSS → comparar por nombre + apellido + empresa (fallback)
    let yaExiste;
    if (nssTrim) {
      yaExiste = await poolFacial.query(
        `SELECT id, qr_code FROM trabajadores
         WHERE es_invitado IS NOT TRUE
           AND imss_nss = $1
           AND activo = true
         LIMIT 1`,
        [nssTrim]
      );
    } else {
      yaExiste = await poolFacial.query(
        `SELECT id, qr_code FROM trabajadores
         WHERE es_invitado IS NOT TRUE
           AND LOWER(TRIM(nombre))   = LOWER($1)
           AND LOWER(TRIM(apellido)) = LOWER($2)
           AND LOWER(TRIM(empresa))  = LOWER($3)
           AND activo = true
         LIMIT 1`,
        [nombreTrim, apellidoTrim, empresaTrim]
      );
    }

    if (yaExiste.rows.length > 0) {
      const trabajador = yaExiste.rows[0];
      const qrData = JSON.stringify({
        nombre:      `${nombreTrim} ${apellidoTrim}`,
        empresa:     empresaTrim,
        es_invitado: false,
        id:          trabajador.id
      });
      const qrBuffer = await QRCode.toBuffer(qrData, { width: 300, margin: 2 });
      const qrBase64 = qrBuffer.toString('base64');
      console.log(`[INVITADO] Ya enrolado, reutilizando id=${trabajador.id} nombre="${nombreTrim} ${apellidoTrim}"`);
      return res.json({
        success:      true,
        invitado_id:  trabajador.id,
        ya_enrolado:  true,
        qr_data:      qrData,
        qr_base64:    `data:image/png;base64,${qrBase64}`
      });
    }

    const insertResult = await poolFacial.query(
      `INSERT INTO trabajadores (nombre, apellido, empresa, estatus, activo, es_invitado)
       VALUES ($1, $2, $3, 'activo', true, true)
       RETURNING id`,
      [nombreTrim, apellidoTrim, empresaTrim]
    );
    const invitadoId = insertResult.rows[0].id;

    const qrData = JSON.stringify({
      nombre:      `${nombreTrim} ${apellidoTrim}`,
      empresa:     empresaTrim,
      es_invitado: true,
      id:          invitadoId
    });

    const qrBuffer = await QRCode.toBuffer(qrData, { width: 300, margin: 2 });
    const qrBase64 = qrBuffer.toString('base64');

    await poolFacial.query(
      `UPDATE trabajadores SET qr_code = $1 WHERE id = $2`,
      [qrData, invitadoId]
    );

    console.log(`[INVITADO] Registrado id=${invitadoId} nombre="${nombreTrim} ${apellidoTrim}"`);
    return res.json({
      success:     true,
      invitado_id: invitadoId,
      qr_data:     qrData,
      qr_base64:   `data:image/png;base64,${qrBase64}`
    });
  } catch(e) {
    console.error('Error registrar-invitado:', e);
    return res.json({ success: false, error: e.message });
  }
});

// ─── POST /facial/verificar-qr ────────────────────────────────────────────
router.post('/verificar-qr', requireAuth, requireSeguridad, async (req, res) => {
  const { qr_data } = req.body;
  if (!qr_data) return res.status(400).json({ error: 'QR data requerido' });

  try {
    const raw = req.body.ip_cliente || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
    const ip = raw.replace('::ffff:', '').split(',')[0].trim();
    const userAgent = req.headers['user-agent'];

    let qrObj;
    try { qrObj = typeof qr_data === 'string' ? JSON.parse(qr_data) : qr_data; }
    catch(e) {
      console.error('[verificar-qr] JSON inválido, qr_data recibido:', JSON.stringify(qr_data));
      return res.status(400).json({ error: 'QR inválido' });
    }

    console.log('[verificar-qr] qrObj parseado:', JSON.stringify(qrObj));

    // Normalizar nombre y empresa (quitar espacios extra, trim)
    const nombre  = typeof qrObj.nombre  === 'string' ? qrObj.nombre.trim().replace(/\s+/g, ' ')  : '';
    const empresa = typeof qrObj.empresa === 'string' ? qrObj.empresa.trim().replace(/\s+/g, ' ') : '';
    if (!nombre || !empresa) return res.status(400).json({ error: 'QR incompleto' });

    // ── Flujo para invitados ──────────────────────────────────────────────
    if (qrObj.es_invitado) {
      const invResult = await poolFacial.query(
        `SELECT id, nombre, apellido, area, cargo, empresa, activo, es_invitado
         FROM trabajadores
         WHERE id = $1 AND es_invitado = true AND activo = true LIMIT 1`,
        [qrObj.id]
      );
      if (!invResult.rows.length) {
        return res.status(401).json({ acceso: 'denegado', mensaje: 'Invitado no encontrado o inactivo' });
      }

      const inv = invResult.rows[0];
      const nombreCompleto = `${inv.nombre} ${inv.apellido}`;

      const ultimoAccesoInv = await poolFacial.query(
        `SELECT tipo_movimiento FROM accesos WHERE empleado_id=$1 AND resultado='exitoso' AND DATE(fecha_hora)=CURRENT_DATE ORDER BY fecha_hora DESC LIMIT 1`,
        [inv.id]
      );
      const tipo_movimiento = (ultimoAccesoInv.rows.length === 0 || ultimoAccesoInv.rows[0].tipo_movimiento === 'salida') ? 'entrada' : 'salida';

      await poolFacial.query(
        `INSERT INTO accesos (empleado_id, resultado, similitud, ip_origen, user_agent, tipo_movimiento, fecha_hora, nombre_snapshot, area_snapshot, empresa_snapshot)
         VALUES ($1,'exitoso',1.0,$2,$3,$4,NOW(),$5,$6,$7)`,
        [inv.id, ip, userAgent, tipo_movimiento, nombreCompleto, inv.area || 'Invitado', inv.empresa]
      );

      return res.json({
        acceso: 'permitido', tipo_movimiento, es_invitado: true,
        empleado: { id: inv.id, nombre: inv.nombre, apellido: inv.apellido, area: inv.area || 'Invitado', cargo: inv.cargo || 'Visita', empresa: inv.empresa },
        solicitud: null,
        hora: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
      });
    }

    // ── Flujo normal (trabajadores regulares) ─────────────────────────────
    // Buscar por ID directo si el QR lo trae (más confiable que por nombre)
    let empResult;
    if (qrObj.trabajador_id && Number.isInteger(Number(qrObj.trabajador_id))) {
      empResult = await poolFacial.query(
        `SELECT id, nombre, apellido, area, cargo, empresa, estatus
         FROM trabajadores WHERE id = $1 AND activo = true LIMIT 1`,
        [Number(qrObj.trabajador_id)]
      );
    }
    // Fallback: buscar por nombre completo + empresa
    if (!empResult || !empResult.rows.length) {
      empResult = await poolFacial.query(
        `SELECT id, nombre, apellido, area, cargo, empresa, estatus
         FROM trabajadores
         WHERE LOWER(CONCAT(nombre, ' ', apellido)) = LOWER($1)
           AND LOWER(empresa) = LOWER($2)
           AND activo = true LIMIT 1`,
        [nombre, empresa]
      );
    }
    if (!empResult.rows.length) {
      console.warn('[verificar-qr] Trabajador no encontrado. nombre=%s empresa=%s', nombre, empresa);
      return res.status(401).json({ acceso: 'denegado', mensaje: 'Trabajador no encontrado o inactivo' });
    }

    const trabajador = empResult.rows[0];
    const validacion = await validarAccesoTrabajador(trabajador.id);

    if (!validacion.permitido) {
      await poolFacial.query(
        `INSERT INTO accesos (empleado_id, resultado, similitud, ip_origen, user_agent, tipo_movimiento, fecha_hora, nombre_snapshot, area_snapshot, empresa_snapshot) VALUES ($1,'fallido',1.0,$2,$3,'entrada',NOW(),$4,$5,$6)`,
        [trabajador.id, ip, userAgent, `${trabajador.nombre} ${trabajador.apellido}`, trabajador.area, trabajador.empresa]
      );
      return res.json({ acceso: 'denegado', acceso_denegado: true, razon: validacion.razon, detalle: validacion.detalle, nombre: `${trabajador.nombre} ${trabajador.apellido}` });
    }

    const hoy = new Intl.DateTimeFormat('sv', { timeZone: 'America/Mexico_City' }).format(new Date());
    const solicitudResult = await poolSolicitudes.query(
      `SELECT p.id, p.folio, p.empresa, p.fecha_inicio, p.fecha_fin FROM permisos p
       INNER JOIN permiso_personal pp ON pp.permiso_id=p.id
       WHERE p.estado='activo' AND $1 BETWEEN p.fecha_inicio AND p.fecha_fin AND LOWER(pp.nombre)=LOWER($2) LIMIT 1`,
      [hoy, nombre]
    );
    const solicitud = solicitudResult.rows[0] || null;

    const ultimoAcceso = await poolFacial.query(
      `SELECT tipo_movimiento FROM accesos WHERE empleado_id=$1 AND resultado='exitoso' AND DATE(fecha_hora)=CURRENT_DATE ORDER BY fecha_hora DESC LIMIT 1`,
      [trabajador.id]
    );
    const tipo_movimiento = (ultimoAcceso.rows.length===0 || ultimoAcceso.rows[0].tipo_movimiento==='salida') ? 'entrada' : 'salida';

    await poolFacial.query(
      `INSERT INTO accesos (empleado_id, resultado, similitud, ip_origen, user_agent, tipo_movimiento, permiso_id, fecha_hora, nombre_snapshot, area_snapshot, empresa_snapshot) VALUES ($1,'exitoso',1.0,$2,$3,$4,$5,NOW(),$6,$7,$8)`,
      [trabajador.id, ip, userAgent, tipo_movimiento, solicitud?.id || null, `${trabajador.nombre} ${trabajador.apellido}`, trabajador.area, trabajador.empresa]
    );

    return res.json({
      acceso: 'permitido', tipo_movimiento,
      empleado: { id: trabajador.id, nombre: trabajador.nombre, apellido: trabajador.apellido, area: trabajador.area, cargo: trabajador.cargo, empresa: trabajador.empresa },
      solicitud: solicitud ? { id: solicitud.id, folio: solicitud.folio, empresa: solicitud.empresa } : null,
      hora: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
    });
  } catch(e) {
    console.error('Error verificar QR:', e);
    res.status(500).json({ error: e.message });
  }
});



router.put('/empleados/:id/liberar', requireAuth, async (req, res) => {
  if (req.session.user.rol !== 'seguridad_fisica')
    return res.status(403).json({ success: false, error: 'Solo Seguridad Física puede liberar trabajadores.' });

  try {
    const r = await poolFacial.query(
      `SELECT id, nombre, apellido, area, empresa, imss_nss FROM trabajadores WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length)
      return res.status(404).json({ success: false, error: 'Trabajador no encontrado' });

    const t = r.rows[0];
    const nombreCompleto = `${t.nombre} ${t.apellido}`;

    // Marcar registros de permiso_personal como liberados (por NSS si existe, sino por nombre)
    try {
      const nssWorker = (t.imss_nss || '').trim();
      if (nssWorker) {
        await poolSolicitudes.query(
          `UPDATE permiso_personal SET liberado = TRUE WHERE nss = $1`,
          [nssWorker]
        );
      } else {
        await poolSolicitudes.query(
          `UPDATE permiso_personal SET liberado = TRUE
           WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1))
             AND EXISTS (
               SELECT 1 FROM permisos p
               WHERE p.id = permiso_id
                 AND p.estado IN ('en_espera_area','aprobado_area','en_espera_seguridad','activo')
             )`,
          [nombreCompleto]
        );
      }
    } catch(eLiberado) {
      console.warn('[liberar] No se pudo marcar permiso_personal:', eLiberado.message);
    }

    // Guardar snapshot en accesos que aún no lo tienen
    await poolFacial.query(
      `UPDATE accesos
       SET nombre_snapshot  = $1,
           area_snapshot    = $2,
           empresa_snapshot = $3
       WHERE empleado_id = $4 AND nombre_snapshot IS NULL`,
      [nombreCompleto, t.area, t.empresa, t.id]
    );

    // Desvincular accesos del trabajador (preserva el historial via snapshot)
    await poolFacial.query(
      `UPDATE accesos SET empleado_id = NULL WHERE empleado_id = $1`,
      [t.id]
    );

    // Eliminar el trabajador (documentos se eliminan en cascada si hay FK ON DELETE CASCADE,
    // de lo contrario borrarlos primero)
    await poolFacial.query(`DELETE FROM documentos WHERE empleado_id = $1`, [t.id]);
    await poolFacial.query(`DELETE FROM trabajadores WHERE id = $1`, [t.id]);

    res.json({ success: true, data: { id: t.id, nombre: t.nombre, apellido: t.apellido, empresa: t.empresa } });
  } catch(e) {
    console.error('Error liberando trabajador:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = { router, poolFacial };