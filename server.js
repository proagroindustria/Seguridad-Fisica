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

// Sin SESSION_SECRET la app no arranca: antes caía a un valor por defecto que
// está en el código fuente, así que un .env que no cargara pasaba desapercibido.
// process.exit en vez de throw: en los logs de pm2 se lee el motivo, no un stack.
if (!process.env.SESSION_SECRET) {
  console.error('✖ Falta SESSION_SECRET en el .env. La app no arranca sin él.');
  process.exit(1);
}

const EN_PRODUCCION = process.env.NODE_ENV === 'production';

// Default seguro: en producción la cookie va con Secure salvo que se apague a
// propósito con COOKIE_SECURE=false. Antes, olvidar la variable la dejaba
// viajando sin el flag y nadie se enteraba. En local el default sigue siendo
// false, porque con Secure el navegador no manda la cookie por http://localhost.
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : EN_PRODUCCION;

if (EN_PRODUCCION && !COOKIE_SECURE) {
  console.warn('⚠ COOKIE_SECURE=false en producción: la cookie de sesión viajará sin flag Secure.');
}

// Solo detrás de nginx: hace que Express detecte HTTPS y mande la cookie secure.
// Condicionado a propósito: activarlo sin proxy delante haría que Express creyera
// el X-Forwarded-For que mande cualquier cliente, y esa IP se guarda como firma
// del permiso en routes/permisos.js.
if (COOKIE_SECURE) {
  app.set('trust proxy', 1);
}

// Sesión de 12 h con `rolling`: se renueva en cada request, así que solo cierra
// por inactividad real. Antes no tenía maxAge y en la caseta, donde el navegador
// no se cierra nunca, la sesión duraba indefinidamente.
const HORAS_SESION = parseInt(process.env.SESSION_HORAS || '12', 10);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,                          // no accesible desde JS
    sameSite: 'lax',                         // mitiga CSRF
    secure: COOKIE_SECURE,                   // Secure por defecto en producción
    maxAge: HORAS_SESION * 60 * 60 * 1000,
  }
}));

app.get('/retiros', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const rol = req.session.user.rol;
  if (rol !== 'contratista' && rol !== 'seguridad_fisica') return res.redirect('/dashboard');
  res.render('retiros', { user: req.session.user });
});

// ── Endpoint de diagnóstico (solo usuarios autenticados) ──────────────────────
app.get('/api/debug-config', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'No autenticado' });
  res.json({
    express_body_limit: '50 MB',
    nginx_max_body: process.env.NGINX_MAX_BODY || '(no configurado en .env — revisa nginx.conf)',
    node_version: process.version,
    entorno: process.env.NODE_ENV || 'development',
    puerto: process.env.PORT || 3010,
    iniciado_en: new Date(_startTime).toLocaleString('es-MX'),
    uptime_min: Math.floor((Date.now() - _startTime) / 60000),
  });
});
const _startTime = Date.now();

// ── Log de errores del cliente ────────────────────────────────────────────────
// El navegador es el único que ve por qué falló un adjunto (formato que no puede
// decodificar, memoria agotada, sesión caducada). Sin este endpoint el reporte
// depende de lo que el usuario alcance a contar, y el mensaje que él ve va
// truncado en la celda.
//
// No exige sesión a propósito: el caso más útil de registrar es justamente aquel
// en el que la sesión ya expiró. A cambio va acotado — campos truncados y tope
// por IP — para que no se convierta en un canal para inundar los logs.
const LOG_CLIENTE_MAX_POR_IP = 30;
const LOG_CLIENTE_VENTANA_MS = 10 * 60 * 1000;
const logsCliente = new Map();

setInterval(() => {
  const ahora = Date.now();
  for (const [ip, r] of logsCliente) if (r.expira <= ahora) logsCliente.delete(ip);
}, LOG_CLIENTE_VENTANA_MS).unref();

// Recorta y aplana: un salto de línea en el cuerpo permitiría inyectar entradas
// falsas en el log haciéndolas pasar por líneas propias del servidor.
const _cortaLog = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').slice(0, n);

app.post('/api/log-cliente', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'desconocida';
  const ahora = Date.now();
  const previo = logsCliente.get(ip);
  const reg = (previo && previo.expira > ahora) ? previo : { n: 0, expira: ahora + LOG_CLIENTE_VENTANA_MS };
  reg.n += 1;
  logsCliente.set(ip, reg);
  if (reg.n > LOG_CLIENTE_MAX_POR_IP) return res.status(429).json({ ok: false });

  const b = req.body || {};
  console.error(
    `[CLIENTE] ${_cortaLog(b.contexto, 40) || 'sin-contexto'}` +
    ` | usuario=${_cortaLog(req.session?.user?.username, 40) || 'anonimo'}` +
    ` | ip=${ip}` +
    ` | error="${_cortaLog(b.error, 300)}"` +
    ` | archivo=${_cortaLog(b.archivo, 120) || '—'}` +
    ` | mime=${_cortaLog(b.mime, 60) || '—'}` +
    ` | tam=${_cortaLog(b.tamano, 20) || '—'}` +
    ` | ua=${_cortaLog(req.headers['user-agent'], 180)}`
  );
  res.json({ ok: true });
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


// Si el cliente manda { token } en vez de base64File, recuperar el archivo
// del stash temporal (documentos_temp en reconocimiento_db)
async function resolverBodyN8N(body) {
  if (!body.token) return body;
  const r = await poolFacialServer.query('SELECT base64, mime FROM documentos_temp WHERE token=$1', [body.token]);
  if (!r.rows.length) throw new Error('El documento expiró en el servidor — vuelve a adjuntarlo');
  const { token, ...resto } = body;
  return { ...resto, base64File: r.rows[0].base64, mimeType: r.rows[0].mime || 'image/jpeg' };
}

app.post('/api/procesar-seguro', async (req, res) => {
  try {
    const url = process.env.N8N_SEGURO_URL;
    if (!url) return res.json({ ok: false, error: 'N8N_SEGURO_URL no configurado' });
    res.json(await proxyN8N(url, await resolverBodyN8N(req.body)));
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.post('/api/procesar-licencia', async (req, res) => {
  try {
    const url = process.env.N8N_LICENCIA_URL;
    if (!url) return res.json({ ok: false, error: 'N8N_LICENCIA_URL no configurado' });
    res.json(await proxyN8N(url, await resolverBodyN8N(req.body)));
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.post('/api/procesar-tarjeta', async (req, res) => {
  try {
    const url = process.env.N8N_TARJETA_URL;
    if (!url) return res.json({ ok: false, error: 'N8N_TARJETA_URL no configurado' });
    const data = await proxyN8N(url, await resolverBodyN8N(req.body));
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

// Horas de gracia que el sistema espera, contadas desde el final del último día
// de vigencia del permiso, antes de vencerlo aunque queden entradas sin salida
// registrada. Al agotarse se vence igual y se deja constancia de quién no salió.
const HORAS_GRACIA_SIN_SALIDA = parseInt(process.env.HORAS_GRACIA_SIN_SALIDA || '48', 10);

// Devuelve las personas del permiso cuyo último acceso ligado a ese permiso es
// una 'entrada' — las que el sistema considera que siguen adentro.
// Array vacío = nadie pendiente, el permiso puede vencer sin más.
async function personasSinSalida(permisoId) {
  const pendientes = [];
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

      // Verificar si entró usando ESTE permiso y no ha salido
      const entroConEstePermiso = await poolFacialCron.query(
        `SELECT id, tipo_movimiento, fecha_hora, nombre_snapshot, area_snapshot, empresa_snapshot
         FROM accesos
         WHERE empleado_id = $1 AND permiso_id = $2 AND resultado = 'exitoso'
         ORDER BY fecha_hora DESC LIMIT 1`,
        [empleadoId, permisoId]
      );

      const ultimo = entroConEstePermiso.rows[0];
      if (ultimo && ultimo.tipo_movimiento === 'entrada') {
        console.log(`⚠ ${p.nombre} sigue adentro con permiso ${permisoId}`);
        pendientes.push({
          nombre:          p.nombre,
          empleadoId,
          fechaEntrada:    ultimo.fecha_hora,
          nombreSnapshot:  ultimo.nombre_snapshot,
          areaSnapshot:    ultimo.area_snapshot,
          empresaSnapshot: ultimo.empresa_snapshot,
        });
      }
    }
    return pendientes;
  } catch(e) {
    console.error(`❌ personasSinSalida(${permisoId}):`, e.message);
    return []; // En caso de error, permitir vencer para no bloquear indefinidamente
  }
}

// Cierra por sistema las entradas que quedaron abiertas. Sin esto la persona
// queda "adentro" para siempre en reconocimiento_db: su siguiente escaneo en la
// caseta se leería como SALIDA y se saltaría la validación de permiso vigente
// (facial.js sólo valida el permiso cuando cree que la persona va entrando).
// La fila queda marcada en 'observaciones' para no confundirla con una salida real.
async function cerrarEntradasAbiertas(permiso, pendientes) {
  const finVigencia = new Date(permiso.fecha_fin).toLocaleDateString('es-MX');
  const nota = `Salida registrada automáticamente por el sistema: el permiso ${permiso.folio} ` +
               `venció el ${finVigencia} y pasaron más de ${HORAS_GRACIA_SIN_SALIDA} h sin que se registrara la salida.`;

  for (const p of pendientes) {
    try {
      await poolFacialCron.query(
        `INSERT INTO accesos (empleado_id, resultado, ip_origen, user_agent, tipo_movimiento,
                              permiso_id, fecha_hora, nombre_snapshot, area_snapshot, empresa_snapshot, observaciones)
         VALUES ($1, 'exitoso', NULL, 'sistema/auto-vencimiento', 'salida', $2, NOW(), $3, $4, $5, $6)`,
        [p.empleadoId, permiso.id, p.nombreSnapshot || p.nombre, p.areaSnapshot, p.empresaSnapshot, nota]
      );
      console.log(`🔒 Salida automática registrada para ${p.nombre} (permiso ${permiso.folio})`);
    } catch(e) {
      console.error(`❌ No se pudo cerrar la entrada de ${p.nombre}:`, e.message);
    }
  }
}

async function vencerPermisosExpirados() {
  console.log('⏰ [v3-con-cierre-forzado] vencerPermisosExpirados iniciado');
  try {
    // Obtener candidatos uno a uno para poder verificar si hay gente adentro.
    // 'gracia_agotada' se calcula en la base para no depender de la zona horaria
    // de Node: el permiso vale hasta el final de fecha_fin (fecha_fin + 1 día),
    // y a partir de ahí corren las HORAS_GRACIA_SIN_SALIDA.
    const candidatos = await poolCron.query(`
      SELECT id, folio, estado, es_pase_visita, fecha_fin,
             NOW() > (fecha_fin + INTERVAL '1 day' + ($1 || ' hours')::interval) AS gracia_agotada
      FROM permisos
      WHERE estado NOT IN ('rechazado', 'vencido')
        AND fecha_fin < CURRENT_DATE
    `, [String(HORAS_GRACIA_SIN_SALIDA)]);

    if (candidatos.rowCount === 0) {
      console.log('⏰ Auto-vencimiento: sin permisos que vencer.');
      return;
    }
    console.log(`⏰ Candidatos a vencer: ${candidatos.rows.map(r => r.folio).join(', ')}`);

    const r = { rows: [], rowCount: 0 };

    for (const permiso of candidatos.rows) {
      const pendientes = await personasSinSalida(permiso.id);
      let detalleCierre = null;   // null = venció limpio, todos registraron salida

      if (pendientes.length > 0) {
        // Dentro del periodo de gracia se sigue esperando, como hasta ahora.
        if (!permiso.gracia_agotada) {
          console.log(`⏳ Permiso ${permiso.folio} expiró pero hay personal aún adentro — se vencerá cuando salgan o al agotarse las ${HORAS_GRACIA_SIN_SALIDA} h de gracia`);
          continue;
        }

        // Gracia agotada: se vence igual y queda constancia de quién no salió.
        detalleCierre = pendientes
          .map(p => `${p.nombre} — entrada ${new Date(p.fechaEntrada).toLocaleString('es-MX')}, sin salida registrada`)
          .join(' | ');
        console.log(`🚨 Permiso ${permiso.folio}: ${HORAS_GRACIA_SIN_SALIDA} h de gracia agotadas — se vence con ${pendientes.length} persona(s) sin salida`);
        await cerrarEntradasAbiertas(permiso, pendientes);
      }

      await poolCron.query(
        `UPDATE permisos
            SET estado = 'vencido',
                cerrado_sin_salida = $2,
                cerrado_sin_salida_detalle = $3,
                actualizado_en = NOW()
          WHERE id = $1`,
        [permiso.id, detalleCierre !== null, detalleCierre]
      );

      // Constancia en el historial del permiso (cambiado_por = NULL → el sistema)
      await poolCron.query(
        `INSERT INTO permiso_historial (permiso_id, estado_anterior, estado_nuevo, cambiado_por, comentario)
         VALUES ($1, $2, 'vencido', NULL, $3)`,
        [permiso.id, permiso.estado,
         detalleCierre
           ? `Vencido por el sistema tras ${HORAS_GRACIA_SIN_SALIDA} h sin registro de salida. Personal sin salida: ${detalleCierre}`
           : 'Vencido automáticamente al terminar la vigencia.']
      ).catch(e => console.error(`❌ historial de ${permiso.folio}:`, e.message));

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

          // Permiso normal: liberar solo si no tiene otro permiso activo o en trámite.
          // Un permiso en aprobación (renovación ya capturada) protege al trabajador:
          // borrarlo obligaría a re-enrolar rostro y documentos al autorizarse.
          for (const t of tRes.rows) {
            if (!t.nombre) continue;

            const otrosRes = await poolCron.query(
              `SELECT COUNT(*) AS cnt FROM permiso_personal pp
               JOIN permisos p ON p.id = pp.permiso_id
               WHERE LOWER(TRIM(pp.nombre)) = LOWER(TRIM($1))
                 AND p.estado IN ('en_espera_area','aprobado_area','en_espera_seguridad','activo')
                 AND p.fecha_fin >= CURRENT_DATE
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

// Constancia de vencimiento con entradas abiertas: se marca cuando el permiso se
// venció porque se agotaron las horas de gracia, no porque todos hayan salido.
const migracionesPermisos = poolMigration.query(
  `ALTER TABLE permisos ADD COLUMN IF NOT EXISTS es_pase_visita BOOLEAN NOT NULL DEFAULT FALSE`
).then(() =>
  poolMigration.query(`ALTER TABLE permisos ADD COLUMN IF NOT EXISTS cerrado_sin_salida BOOLEAN NOT NULL DEFAULT FALSE`)
).then(() =>
  poolMigration.query(`ALTER TABLE permisos ADD COLUMN IF NOT EXISTS cerrado_sin_salida_detalle TEXT`)
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
      p.firma_aprobacion_ubicacion, p.firma_aprobacion_fecha, p.firma_aprobacion_usuario,
      p.cerrado_sin_salida, p.cerrado_sin_salida_detalle
    FROM permisos p
    LEFT JOIN usuarios uc ON p.creado_por             = uc.id
    LEFT JOIN usuarios ua ON p.aprobado_por_area      = ua.id
    LEFT JOIN usuarios us ON p.aprobado_por_seguridad = us.id
    LEFT JOIN usuarios ur ON p.rechazado_por          = ur.id
  `)
).catch(e => console.warn('[migration] vista_permisos:', e.message));

// Marca las salidas que registró el auto-vencimiento, para no confundirlas con
// una salida real de la caseta.
poolFacialCron.query(
  `ALTER TABLE accesos ADD COLUMN IF NOT EXISTS observaciones TEXT`
).catch(e => console.warn('[migration] accesos.observaciones:', e.message));

poolMigration.query(
  `ALTER TABLE permiso_personal ADD COLUMN IF NOT EXISTS nss VARCHAR(20)`
).catch(e => console.warn('[migration] permiso_personal.nss:', e.message));

poolMigration.query(
  `ALTER TABLE permiso_personal ADD COLUMN IF NOT EXISTS liberado BOOLEAN NOT NULL DEFAULT FALSE`
).catch(e => console.warn('[migration] permiso_personal.liberado:', e.message));

poolMigration.query(
  `ALTER TABLE permiso_personal ADD COLUMN IF NOT EXISTS trabajador_id INTEGER`
).catch(e => console.warn('[migration] permiso_personal.trabajador_id:', e.message));

// Foto del vehículo (base64, igual que seguro/licencia/tarjeta).
// Se deja NULL-able: los permisos ya existentes no la tienen. La obligatoriedad
// se impone en la app (cliente + POST /solicitudes), no en el esquema.
poolMigration.query(
  `ALTER TABLE permiso_vehiculos ADD COLUMN IF NOT EXISTS foto TEXT`
).catch(e => console.warn('[migration] permiso_vehiculos.foto:', e.message));

app.listen(PORT, () => {
  console.log(`\n🌱 PROAGRO - Sistema de Permisos`);
  console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
  console.log(`📋 Modo: ${process.env.OFFLINE_MODE === 'true' ? 'SIN BASE DE DATOS (offline)' : 'PostgreSQL'}\n`);

  // AVISO LEGAL: ejecución inmediata de supresión de datos personales al
  // iniciar el servidor, para cubrir el periodo en que pudo estar inactivo.
  // Cumple con el principio de supresión oportuna (LFPDPPP Art. 11).
  // vencerPermisosExpirados() escribe en cerrado_sin_salida, así que se espera a
  // que las migraciones de esas columnas hayan terminado.
  migracionesPermisos.finally(() => {
    vencerPermisosExpirados();
    limpiarTrabajadoresSinPermiso();
    limpiarDocumentosVisitas();

    // Programa la supresión automática diaria a las 01:00 h (hora del servidor).
    programarVencimiento();
  });
});