require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');


const authRoutes      = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const solicitudesRoutes  = require('./routes/permisos');
const { router: facialRoutes } = require('./routes/facial');
const documentosRoutes = require('./routes/documentos');
const retirosRoutes = require('./routes/retiros');


const app = express();
const PORT = process.env.PORT || 3010;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/models', express.static(path.join(__dirname, 'public', 'models')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'proagro_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.get('/retiros', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const rol = req.session.user.rol;
  if (rol !== 'contratista' && rol !== 'seguridad_fisica') return res.redirect('/dashboard');
  res.render('retiros', { user: req.session.user });
});

app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/solicitudes', solicitudesRoutes);
app.use('/facial', facialRoutes);
app.use('/documentos', documentosRoutes);
app.use('/retiros', retirosRoutes);


app.get('/personal', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const rol = req.session.user.rol;
  if (rol !== 'contratista' && rol !== 'seguridad_fisica') return res.redirect('/dashboard');
  res.render('personal', { user: req.session.user });
});


function requireAsistenciaAuth(req, res, next) {
  if (req.session.asistencia_user) return next();
  res.redirect('/login-asistencia');
}


app.get('/verificar', requireAsistenciaAuth, (req, res) => {
  res.render('verificar', { user: req.session.asistencia_user });
});


app.get('/historial', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.rol !== 'seguridad_fisica') return res.redirect('/dashboard');
  res.render('historial', { user: req.session.user });
});


const https = require('https');
const http  = require('http');


async function proxyN8N(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = JSON.stringify(body);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ ok: false, error: 'Parse error' }); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}


app.post('/api/procesar-seguro', async (req, res) => {
  try {
    const url = process.env.N8N_SEGURO_URL;
    if (!url) return res.json({ ok: false, error: 'N8N_SEGURO_URL no configurado' });
    res.json(await proxyN8N(url, req.body));
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.post('/api/procesar-licencia', async (req, res) => {
  try {
    const url = process.env.N8N_LICENCIA_URL;
    if (!url) return res.json({ ok: false, error: 'N8N_LICENCIA_URL no configurado' });
    res.json(await proxyN8N(url, req.body));
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.post('/api/procesar-tarjeta', async (req, res) => {
  try {
    const url = process.env.N8N_TARJETA_URL;
    if (!url) return res.json({ ok: false, error: 'N8N_TARJETA_URL no configurado' });
    const data = await proxyN8N(url, req.body);
    res.json(data);
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

const { Pool } = require('pg');
const poolFacialServer = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.FACIAL_DB_NAME || 'reconocimiento_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});


// ── Pool bd_principal ─────────────────────────────
const poolBDPrincipal = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.BD_PRINCIPAL_NAME || 'bd_principal',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});


app.get('/api/empleados-internos', (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: 'No autenticado' });
  next();
}, async (req, res) => {
  try {
    const r = await poolBDPrincipal.query(
      `SELECT id, nombre, apellido_paterno, apellido_materno 
       FROM empleados 
       WHERE activo = true 
       ORDER BY apellido_paterno, nombre`
    );
    res.json({ success: true, data: r.rows });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/login-asistencia', (req, res) => {
  if (req.session.asistencia_user) return res.redirect('/verificar');
  res.render('login-asistencia', { error: null });
});

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

app.use((req, res) => {
  if (req.accepts('json')) res.status(404).json({ error: 'Ruta no encontrada' });
  else res.status(404).redirect('/login');
});

// =====================================================
// AUTO-VENCIMIENTO DE PERMISOS
// Flujo:
//   1. Al arrancar → ejecuta inmediatamente (cubre caídas del servidor)
//   2. Cada día a la 1:00 AM → ejecuta automáticamente
//   3. Servidor arriba semanas → setInterval de 24h lo mantiene
// =====================================
// =====================================================
const poolCron = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME || 'seguridad_fisica',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const poolFacialCron = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.FACIAL_DB_NAME || 'reconocimiento_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// =============================================================================
// AVISO LEGAL — PROTECCIÓN DE DATOS PERSONALES
// =============================================================================
// Las funciones vencerPermisosExpirados() y limpiarTrabajadoresSinPermiso()
// implementan la política de supresión automática de datos personales conforme
// a lo establecido en la Ley Federal de Protección de Datos Personales en
// Posesión de los Particulares (LFPDPPP, México) y su Reglamento.
//
// DATOS QUE SE ELIMINAN al vencer la vigencia del permiso:
//   · Nombre completo del trabajador / visitante
//   · Descriptor biométrico facial (vector numérico)
//   · Imágenes de documentos de identidad (imagen en base64)
//   · Datos OCR extraídos del documento (JSON)
//   · Número de Seguro Social (NSS / IMSS)
//   · Información de empresa, área y cargo
//   · Código QR de acceso personal
//
// DATOS QUE SE CONSERVAN  (historial de accesos):
//   · Folio del permiso (sin identificador personal directo)
//   · Instantánea de nombre y área (campos *_snapshot) para trazabilidad
//     operativa, disociados del registro de identidad principal.
//
// MECANISMO DE BORRADO:
//   1. Diariamente a la 01:00 h (hora local del servidor) se ejecutan ambas
//      funciones de forma automática mediante programarVencimiento().
//   2. También se ejecutan al iniciar el servidor para cubrir el periodo en
//      que el servidor pudo haber estado inactivo.
//   3. El periodo de gracia para trabajadores sin permiso activo es de
//      DIAS_GRACIA_LIMPIEZA días (predeterminado: 7), configurable por
//      variable de entorno.
//
// BASE LEGAL: el titular del permiso otorgó consentimiento al momento de
// registrarse, siendo informado de que sus datos se tratarán exclusivamente
// durante la vigencia del permiso autorizado.
// =============================================================================

// Devuelve true si alguna persona del permiso tiene su último acceso como 'entrada' (sigue adentro)
async function algunoAdentro(permisoId) {
  try {
    const personal = await poolCron.query(
      `SELECT nombre, trabajador_id FROM permiso_personal WHERE permiso_id = $1`,
      [permisoId]
    );

    for (const p of personal.rows) {
      let empleadoId = p.trabajador_id || null;

      // Si no hay trabajador_id, buscar por nombre en reconocimiento_db
      if (!empleadoId && p.nombre) {
        const partes = p.nombre.trim().split(/\s+/);
        const nom = partes[0] || '';
        const ape = partes.slice(1).join(' ') || '';
        const tRes = await poolFacialCron.query(
          `SELECT id FROM trabajadores
           WHERE activo = true
             AND LOWER(TRIM(nombre))   = LOWER($1)
             AND LOWER(TRIM(apellido)) = LOWER($2)
           LIMIT 1`,
          [nom, ape]
        );
        if (tRes.rows.length > 0) empleadoId = tRes.rows[0].id;
      }

      if (!empleadoId) continue;

      // Revisar si el último acceso exitoso fue 'entrada'
      const ultimo = await poolFacialCron.query(
        `SELECT tipo_movimiento FROM accesos
         WHERE empleado_id = $1 AND resultado = 'exitoso'
         ORDER BY fecha_hora DESC LIMIT 1`,
        [empleadoId]
      );

      if (ultimo.rows.length > 0 && ultimo.rows[0].tipo_movimiento === 'entrada') {
        console.log(`⚠ ${p.nombre} sigue adentro (último acceso: entrada) — permiso ${permisoId} bloqueado`);
        return true;
      }
    }
    return false;
  } catch(e) {
    console.error(`❌ algunoAdentro(${permisoId}):`, e.message);
    return false; // En caso de error, permitir vencer para no bloquear indefinidamente
  }
}

async function vencerPermisosExpirados() {
  console.log('⏰ [v2-con-check-salidas] vencerPermisosExpirados iniciado');
  try {
    // Obtener candidatos uno a uno para poder verificar si hay gente adentro
    const candidatos = await poolCron.query(`
      SELECT id, folio, es_pase_visita
      FROM permisos
      WHERE estado NOT IN ('rechazado', 'vencido')
        AND fecha_fin < CURRENT_DATE
    `);

    if (candidatos.rowCount === 0) {
      console.log('⏰ Auto-vencimiento: sin permisos que vencer.');
      return;
    }
    console.log(`⏰ Candidatos a vencer: ${candidatos.rows.map(r => r.folio).join(', ')}`);

    const r = { rows: [], rowCount: 0 };

    for (const permiso of candidatos.rows) {
      const bloqueado = await algunoAdentro(permiso.id);
      if (bloqueado) {
        console.log(`⏳ Permiso ${permiso.folio} expiró pero hay personal aún adentro — se vencerá cuando todos salgan`);
        continue;
      }

      await poolCron.query(
        `UPDATE permisos SET estado = 'vencido', actualizado_en = NOW() WHERE id = $1`,
        [permiso.id]
      );
      r.rows.push(permiso);
      r.rowCount++;
    }

    if (r.rowCount > 0) {
      console.log(`⏰ Auto-vencimiento: ${r.rowCount} permiso(s) vencido(s):`, r.rows.map(x => x.folio).join(', '));

      // Liberar trabajadores/invitados al vencer
      for (const permiso of r.rows) {
        try {
          const tRes = await poolCron.query(
            'SELECT nombre FROM permiso_personal WHERE permiso_id = $1',
            [permiso.id]
          );

          // Pase de visita: borrar invitados directamente sin verificar otros permisos
          if (permiso.es_pase_visita) {
            for (const t of tRes.rows) {
              if (!t.nombre) continue;
              const partes = t.nombre.trim().split(/\s+/);
              const nom = partes[0] || '';
              const ape = partes.slice(1).join(' ') || '';
              const invRes = await poolFacialCron.query(
                `SELECT id, nombre, apellido, area, empresa FROM trabajadores
                 WHERE es_invitado = true
                   AND LOWER(TRIM(nombre)) = LOWER($1)
                   AND LOWER(TRIM(apellido)) = LOWER($2)`,
                [nom, ape]
              );
              for (const w of invRes.rows) {
                const nombreCompleto = `${w.nombre} ${w.apellido}`;
                await poolFacialCron.query(
                  `UPDATE accesos SET nombre_snapshot=$1, area_snapshot=$2, empresa_snapshot=$3
                   WHERE empleado_id=$4 AND nombre_snapshot IS NULL`,
                  [nombreCompleto, w.area, w.empresa, w.id]
                );
                await poolFacialCron.query(`UPDATE accesos SET empleado_id=NULL WHERE empleado_id=$1`, [w.id]);
                await poolFacialCron.query(`DELETE FROM documentos WHERE empleado_id=$1`, [w.id]);
                await poolFacialCron.query(`DELETE FROM trabajadores WHERE id=$1`, [w.id]);
                console.log(`🗑️  Invitado eliminado: ${nombreCompleto} (pase ${permiso.folio})`);
              }
            }
            continue;
          }

          // Permiso normal: liberar solo si no tiene otro permiso activo
          for (const t of tRes.rows) {
            if (!t.nombre) continue;

            const otrosRes = await poolCron.query(
              `SELECT COUNT(*) AS cnt FROM permiso_personal pp
               JOIN permisos p ON p.id = pp.permiso_id
               WHERE LOWER(TRIM(pp.nombre)) = LOWER(TRIM($1))
                 AND p.estado = 'activo'
                 AND pp.permiso_id != $2`,
              [t.nombre, permiso.id]
            );
            if (parseInt(otrosRes.rows[0].cnt) > 0) continue;

            const wRes = await poolFacialCron.query(
              `SELECT id, nombre, apellido, area, empresa FROM trabajadores
               WHERE es_invitado IS NOT TRUE
                 AND LOWER(TRIM(nombre) || ' ' || TRIM(apellido)) = LOWER(TRIM($1))`,
              [t.nombre]
            );
            for (const w of wRes.rows) {
              const nombreCompleto = `${w.nombre} ${w.apellido}`;
              await poolFacialCron.query(
                `UPDATE accesos SET nombre_snapshot=$1, area_snapshot=$2, empresa_snapshot=$3
                 WHERE empleado_id=$4 AND nombre_snapshot IS NULL`,
                [nombreCompleto, w.area, w.empresa, w.id]
              );
              await poolFacialCron.query(`UPDATE accesos SET empleado_id=NULL WHERE empleado_id=$1`, [w.id]);
              await poolFacialCron.query(`DELETE FROM documentos WHERE empleado_id=$1`, [w.id]);
              await poolFacialCron.query(`DELETE FROM trabajadores WHERE id=$1`, [w.id]);
              console.log(`🗑️  Trabajador liberado: ${nombreCompleto} (permiso ${permiso.folio})`);
            }
          }
        } catch(e) {
          console.error(`❌ Error liberando trabajadores de ${permiso.folio}:`, e.message);
        }
      }
    } else {
      console.log('⏰ Auto-vencimiento: sin permisos que vencer.');
    }
  } catch(e) {
    console.error('❌ Error en auto-vencimiento:', e.message);
  }
}

// -----------------------------------------------------------------------------
// AVISO LEGAL — Supresión complementaria de datos personales huérfanos
// Esta función elimina registros de trabajadores que, transcurrido el periodo
// de gracia (DIAS_GRACIA_LIMPIEZA días), no cuentan con ningún permiso activo
// o pendiente. Su propósito es garantizar el principio de LIMITACIÓN DEL PLAZO
// DE CONSERVACIÓN conforme al Art. 11 de la LFPDPPP: los datos no se
// conservarán más tiempo del necesario para la finalidad que justificó su
// tratamiento (control de acceso durante la vigencia del permiso).
// -----------------------------------------------------------------------------
async function limpiarTrabajadoresSinPermiso() {

  const DIAS_GRACIA = parseInt(process.env.DIAS_GRACIA_LIMPIEZA || '7', 10);
  try {
    // Nombres que tienen al menos un permiso que no esté rechazado ni vencido
    const permisosRes = await poolCron.query(`
      SELECT DISTINCT LOWER(TRIM(pp.nombre)) AS nombre
      FROM permiso_personal pp
      JOIN permisos p ON p.id = pp.permiso_id
      WHERE p.estado NOT IN ('rechazado', 'vencido')
    `);
    const conPermiso = new Set(permisosRes.rows.map(r => r.nombre));

    // Trabajadores (no invitados) activos registrados hace más de DIAS_GRACIA días
    const trabRes = await poolFacialCron.query(
      `SELECT id, nombre, apellido, area, empresa
       FROM trabajadores
       WHERE es_invitado IS NOT TRUE
         AND activo = true
         AND creado_en < NOW() - ($1 * INTERVAL '1 day')`,
      [DIAS_GRACIA]
    );

    let eliminados = 0;
    for (const t of trabRes.rows) {
      const nombreCompleto = `${t.nombre} ${t.apellido}`.toLowerCase().trim();
      if (conPermiso.has(nombreCompleto)) continue;

      await poolFacialCron.query(
        `UPDATE accesos SET nombre_snapshot=$1, area_snapshot=$2, empresa_snapshot=$3
         WHERE empleado_id=$4 AND nombre_snapshot IS NULL`,
        [`${t.nombre} ${t.apellido}`, t.area, t.empresa, t.id]
      );
      await poolFacialCron.query(`UPDATE accesos SET empleado_id=NULL WHERE empleado_id=$1`, [t.id]);
      await poolFacialCron.query(`DELETE FROM documentos WHERE empleado_id=$1`, [t.id]);
      await poolFacialCron.query(`DELETE FROM trabajadores WHERE id=$1`, [t.id]);
      console.log(`🧹 Sin permiso eliminado: ${t.nombre} ${t.apellido} (${t.empresa || '—'})`);
      eliminados++;
    }

    if (eliminados > 0) {
      console.log(`🧹 Limpieza: ${eliminados} trabajador(es) huérfano(s) eliminado(s) (>${DIAS_GRACIA} días sin permiso).`);
    } else {
      console.log(`🧹 Limpieza: sin trabajadores huérfanos (gracia: ${DIAS_GRACIA} días).`);
    }
  } catch(e) {
    console.error('❌ Error en limpieza de trabajadores sin permiso:', e.message);
  }
}


// -----------------------------------------------------------------------------
// Supresión de documentos de identidad de pases de visita vencidos.
// Solo borra la columna `documento` de permiso_personal cuando el permiso
// ya está en estado 'vencido' y es un pase de visita. No elimina la fila
// (se conserva el registro para trazabilidad) ni toca datos biométricos
// (los invitados no tienen rostro enrolado).
// -----------------------------------------------------------------------------
async function limpiarDocumentosVisitas() {
  try {
    const r = await poolCron.query(`
      UPDATE permiso_personal
      SET documento = NULL
      WHERE documento IS NOT NULL
        AND permiso_id IN (
          SELECT id FROM permisos
          WHERE es_pase_visita = true
            AND estado = 'vencido'
        )
      RETURNING permiso_id
    `);
    if (r.rowCount > 0) {
      console.log(`🗑️  Docs de visitas limpiados: ${r.rowCount} registro(s).`);
    } else {
      console.log(`🗑️  Docs de visitas: sin documentos que limpiar.`);
    }
  } catch(e) {
    console.error('❌ Error limpiando documentos de visitas:', e.message);
  }
}

function programarVencimiento() {
  const ahora = new Date();
  const proxima0002 = new Date();
  proxima0002.setHours(0, 2, 0, 0); // 00:02:00

  // Si ya pasó las 00:02 de hoy, programar para mañana
  if (ahora >= proxima0002) {
    proxima0002.setDate(proxima0002.getDate() + 1);
  }

  const msHasta0002 = proxima0002 - ahora;
  console.log(`⏰ Próximo auto-vencimiento programado: ${proxima0002.toLocaleString('es-MX')}`);

  setTimeout(async () => {
    await vencerPermisosExpirados();
    await limpiarTrabajadoresSinPermiso();
    await limpiarDocumentosVisitas();
    // Repetir cada 24h
    setInterval(async () => {
      await vencerPermisosExpirados();
      await limpiarTrabajadoresSinPermiso();
      await limpiarDocumentosVisitas();
    }, 24 * 60 * 60 * 1000);
  }, msHasta0002);

  // Check cada 15 minutos para permisos vencidos que tenían gente adentro
  setInterval(async () => {
    const hay = await poolCron.query(`
      SELECT COUNT(*) AS cnt FROM permisos
      WHERE estado NOT IN ('rechazado','vencido') AND fecha_fin < CURRENT_DATE
    `).catch(() => ({ rows: [{ cnt: 0 }] }));
    if (parseInt(hay.rows[0].cnt) > 0) {
      console.log('⏰ Check periódico: hay permisos vencidos pendientes — verificando salidas...');
      await vencerPermisosExpirados();
      await limpiarTrabajadoresSinPermiso();
      await limpiarDocumentosVisitas();
    }
  }, 15 * 60 * 1000); // cada 15 minutos
}

const poolMigration = require('./db/connection');
poolMigration.query(
  `ALTER TABLE permisos ADD COLUMN IF NOT EXISTS es_pase_visita BOOLEAN NOT NULL DEFAULT FALSE`
).then(() =>
  poolMigration.query(`
    CREATE OR REPLACE VIEW vista_permisos AS
    SELECT
      p.id, p.folio, p.empresa, p.contrato, p.responsable_contrato,
      p.responsable1, p.responsable2, p.responsable1_tel, p.responsable2_tel,
      p.fecha_inicio, p.fecha_fin,
      (p.fecha_fin - p.fecha_inicio) AS dias_duracion,
      p.estado,
      CASE p.estado
        WHEN 'borrador'            THEN 'Borrador'
        WHEN 'en_espera_area'      THEN 'En espera del Área'
        WHEN 'aprobado_area'       THEN 'Aprobado por Área'
        WHEN 'en_espera_seguridad' THEN 'En espera de Seguridad'
        WHEN 'activo'              THEN 'Activo'
        WHEN 'rechazado'           THEN 'Rechazado'
        WHEN 'vencido'             THEN 'Vencido'
      END AS estado_legible,
      p.es_pase_visita,
      uc.nombre_completo AS creado_por_nombre,
      ua.nombre_completo AS aprobado_area_nombre,
      us.nombre_completo AS aprobado_seg_nombre,
      ur.nombre_completo AS rechazado_por_nombre,
      p.motivo_rechazo, p.fecha_envio,
      p.fecha_aprobacion_area, p.fecha_aprobacion_seg,
      p.fecha_rechazo, p.creado_en, p.actualizado_en,
      p.firma_creacion_ip, p.firma_creacion_ip_privada,
      p.firma_creacion_ubicacion, p.firma_creacion_fecha, p.firma_creacion_usuario,
      p.firma_area_ip, p.firma_area_ip_privada,
      p.firma_area_ubicacion, p.firma_area_fecha, p.firma_area_usuario,
      p.firma_aprobacion_ip, p.firma_aprobacion_ip_privada,
      p.firma_aprobacion_ubicacion, p.firma_aprobacion_fecha, p.firma_aprobacion_usuario
    FROM permisos p
    LEFT JOIN usuarios uc ON p.creado_por             = uc.id
    LEFT JOIN usuarios ua ON p.aprobado_por_area      = ua.id
    LEFT JOIN usuarios us ON p.aprobado_por_seguridad = us.id
    LEFT JOIN usuarios ur ON p.rechazado_por          = ur.id
  `)
).catch(e => console.warn('[migration] vista_permisos:', e.message));

poolMigration.query(
  `ALTER TABLE permiso_personal ADD COLUMN IF NOT EXISTS nss VARCHAR(20)`
).catch(e => console.warn('[migration] permiso_personal.nss:', e.message));

poolMigration.query(
  `ALTER TABLE permiso_personal ADD COLUMN IF NOT EXISTS liberado BOOLEAN NOT NULL DEFAULT FALSE`
).catch(e => console.warn('[migration] permiso_personal.liberado:', e.message));

poolMigration.query(
  `ALTER TABLE permiso_personal ADD COLUMN IF NOT EXISTS trabajador_id INTEGER`
).catch(e => console.warn('[migration] permiso_personal.trabajador_id:', e.message));

app.listen(PORT, () => {
  console.log(`\n🌱 PROAGRO - Sistema de Permisos`);
  console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
  console.log(`📋 Modo: ${process.env.OFFLINE_MODE === 'true' ? 'SIN BASE DE DATOS (offline)' : 'PostgreSQL'}\n`);

  // AVISO LEGAL: ejecución inmediata de supresión de datos personales al
  // iniciar el servidor, para cubrir el periodo en que pudo estar inactivo.
  // Cumple con el principio de supresión oportuna (LFPDPPP Art. 11).
  vencerPermisosExpirados();
  limpiarTrabajadoresSinPermiso();
  limpiarDocumentosVisitas();

  // Programa la supresión automática diaria a las 01:00 h (hora del servidor).
  programarVencimiento();
});