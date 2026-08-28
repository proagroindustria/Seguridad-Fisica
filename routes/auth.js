const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const multer   = require('multer');
const { PDFParse } = require('pdf-parse');
const pdfParse = PDFParse;
const nodemailer = require('nodemailer');
const axios = require('axios');

// Multer: guardar PDF en memoria (no en disco)
const upload = multer({ storage: multer.memoryStorage() });

// Códigos temporales en memoria { correo: { codigo, datos, expira } }
const codigosPendientes = {};



// Pool de bd_principal
const poolBDPrincipal = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.BD_PRINCIPAL_NAME || 'bd_principal',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Regenera el ID de sesión antes de autenticar. Sin esto, quien logre fijar una
// cookie en el navegador de la víctima conserva ese mismo ID después del login y
// hereda la sesión ya autenticada (session fixation).
const ERROR_SERVIDOR = 'Error del servidor. Intenta de nuevo.';

function regenerarSesion(req) {
  return new Promise(resolve => {
    req.session.regenerate(err => {
      if (err) console.error('[sesion] no se pudo regenerar la sesión:', err);
      resolve(!err);
    });
  });
}

// save() explícito: la respuesta no debe salir antes de persistir la sesión
function guardarSesion(req) {
  return new Promise(resolve => {
    req.session.save(err => {
      if (err) console.error('[sesion] no se pudo guardar la sesión:', err);
      resolve(!err);
    });
  });
}

async function iniciarSesion(req, res, clave, datos, destino, vistaError = 'login') {
  if (!(await regenerarSesion(req)))
    return res.render(vistaError, { error: ERROR_SERVIDOR });
  req.session[clave] = datos;
  if (!(await guardarSesion(req)))
    return res.render(vistaError, { error: ERROR_SERVIDOR });
  return res.redirect(destino);
}

// ─────────────────────────────────────────────────────────────────────────────
// Limitador de intentos en memoria (sin dependencias nuevas).
// No sustituye a un WAF, pero corta la fuerza bruta contra el login.
//
// Se cuenta por DOS claves a la vez:
//   - ip:<ip>      → frena a un atacante que prueba muchos usuarios desde un host
//   - user:<login> → frena el credential stuffing distribuido (muchas IPs, una cuenta)
// Basta con que una de las dos supere su umbral para bloquear.
//
// El bloqueo escala: cada vez que una clave vuelve a agotar sus intentos, el
// castigo siguiente es más largo. Así un ataque lento tampoco sale gratis.
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;  // ventana en la que se acumulan fallos
const ESCALADA_MS = [2, 5, 10, 20, 30].map(m => m * 60 * 1000);

// Umbral alto para la IP a propósito: en planta todos los empleados salen por la
// misma IP pública (NAT), así que un umbral bajo dejaría fuera a la caseta entera
// por unos cuantos dedazos. La defensa fina es el contador por usuario, que no se
// ve afectado por el NAT; el de IP es solo el freno contra un host que rocía
// muchos usuarios distintos.
const MAX_INTENTOS_IP     = 20;
const MAX_INTENTOS_USER   = 8;
const MAX_INTENTOS_CODIGO = 5;               // código de verificación de registro
const MAX_ENVIOS_CODIGO   = 5;               // reenvíos de código por IP

// Tope del castigo por tipo de clave. El de usuario se queda corto adrede: como
// cualquiera puede fallar el login de una cuenta ajena a propósito, una escalada
// larga aquí sería un modo fácil de dejar a alguien fuera del sistema. 10 min
// siguen limitando un ataque distribuido a ~50 intentos/hora contra esa cuenta.
const TOPE_BLOQUEO_USER   = 10 * 60 * 1000;
const TOPE_BLOQUEO_IP     = 30 * 60 * 1000;
const TOPE_BLOQUEO_CODIGO = 30 * 60 * 1000;

// clave -> { n, expira, castigos, bloqueadoHasta }
const intentos = new Map();

// req.ip respeta `trust proxy` (server.js). A diferencia de leer
// req.headers['x-real-ip'] a mano, un cliente NO puede falsear esto: cuando
// trust proxy está activo Express descarta lo que el cliente antepuso en
// X-Forwarded-For y se queda con lo que añadió nginx; cuando está inactivo usa
// la IP del socket. Leer la cabecera cruda permitía rotarla en cada request y
// saltarse el limitador por completo.
let avisoProxyEmitido = false;
function ipCliente(req) {
  if (!avisoProxyEmitido && !req.app.get('trust proxy') && req.headers['x-forwarded-for']) {
    avisoProxyEmitido = true;
    console.warn('[seguridad] Llegan cabeceras X-Forwarded-For pero `trust proxy` está desactivado: ' +
                 'todas las peticiones se contarán bajo la IP del proxy y el limitador bloqueará a todos a la vez. ' +
                 'Activa COOKIE_SECURE=true si hay nginx delante.');
  }
  return req.ip || req.socket.remoteAddress || 'desconocida';
}

// Devuelve los ms que faltan para poder reintentar (0 si no está bloqueada).
function msBloqueo(clave) {
  const r = intentos.get(clave);
  if (!r || !r.bloqueadoHasta) return 0;
  const restante = r.bloqueadoHasta - Date.now();
  return restante > 0 ? restante : 0;
}

// Suma un fallo a la clave y aplica el bloqueo si alcanzó el máximo.
function sumarFallo(clave, max, tope) {
  const ahora = Date.now();
  const previo = intentos.get(clave);
  const vigente = previo && previo.expira > ahora;
  const r = vigente ? previo : { n: 0, castigos: 0, bloqueadoHasta: 0 };

  r.n += 1;
  r.expira = ahora + VENTANA_INTENTOS_MS;

  if (r.n >= max) {
    const castigo = Math.min(ESCALADA_MS[Math.min(r.castigos, ESCALADA_MS.length - 1)], tope);
    r.bloqueadoHasta = ahora + castigo;
    r.castigos += 1;
    r.n = 0;                                   // reinicia el conteo tras castigar
    r.expira = r.bloqueadoHasta + VENTANA_INTENTOS_MS; // recuerda la reincidencia
  }
  intentos.set(clave, r);
}

function clavesLogin(req, username) {
  const claves = [{ clave: `ip:${ipCliente(req)}`, max: MAX_INTENTOS_IP, tope: TOPE_BLOQUEO_IP }];
  const u = String(username || '').toLowerCase().trim();
  if (u) claves.push({ clave: `user:${u}`, max: MAX_INTENTOS_USER, tope: TOPE_BLOQUEO_USER });
  return claves;
}

// Mensaje listo para la vista, o null si puede intentar.
function mensajeBloqueo(req, username) {
  const espera = Math.max(...clavesLogin(req, username).map(({ clave }) => msBloqueo(clave)));
  if (espera <= 0) return null;
  const minutos = Math.ceil(espera / 60000);
  return `Demasiados intentos fallidos. Espera ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'} e intenta de nuevo.`;
}

function registrarFallo(req, username, etiqueta = 'login') {
  for (const { clave, max, tope } of clavesLogin(req, username)) sumarFallo(clave, max, tope);
  // Sin esta traza no hay forma de enterarse de que un ataque está en curso.
  console.warn(`[seguridad] intento fallido ${etiqueta} ip=${ipCliente(req)} usuario=${String(username || '').slice(0, 60)}`);
}

// Solo se borra la clave del usuario que acaba de autenticarse. Si también se
// borrara la de la IP, bastaría con tener una cuenta propia válida para
// reiniciar el contador entre ráfagas y dejar el límite por IP en nada.
function limpiarIntentos(req, username) {
  const u = String(username || '').toLowerCase().trim();
  if (u) intentos.delete(`user:${u}`);
}

// Limitador genérico por IP para endpoints que no son login (código de registro).
function bloqueoPorIp(req, sufijo) {
  return msBloqueo(`${sufijo}:${ipCliente(req)}`);
}
function falloPorIp(req, sufijo, max) {
  sumarFallo(`${sufijo}:${ipCliente(req)}`, max, TOPE_BLOQUEO_CODIGO);
}

// Purga periódica para que el Map no crezca sin límite
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, r] of intentos) {
    if (r.expira <= ahora && msBloqueo(clave) === 0) intentos.delete(clave);
  }
}, VENTANA_INTENTOS_MS).unref();

// ─────────────────────────────────────────────────────────────────────────────
// Normalización de campos del formulario.
// Con `extended: true`, repetir un nombre (username=a&username=b) o usar la
// sintaxis de objeto (username[x]=y) hace que req.body.username llegue como
// array u objeto. Así, username.toLowerCase() lanzaba TypeError -> 500, y el
// valor que se comparaba no era el mismo que contaba el limitador.
const MAX_LARGO_CAMPO = 256;
function campoTexto(valor) {
  return typeof valor === 'string' ? valor : '';
}

// El MISMO texto para "no existe", "contraseña incorrecta" y "sin rol".
// Cualquier diferencia convierte el login en un oráculo para descubrir qué
// usuarios existen, que es el primer paso del credential stuffing.
const CREDENCIALES_INVALIDAS = 'Usuario o contraseña incorrectos.';

// Hash de descarte contra el que comparar cuando el usuario no existe.
// Sin esto la respuesta vuelve al instante (nunca se llama a bcrypt/crypt) y
// medir ese tiempo separa usuarios reales de inventados aunque el texto sea
// idéntico. La contraseña es aleatoria: nadie puede acertarla nunca.
const HASH_SENUELO = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
async function gastarTiempoBcrypt(password) {
  try { await bcrypt.compare(password, HASH_SENUELO); } catch (e) { /* irrelevante */ }
}

// Cuánto vive el estado "esta cuenta debe cambiar su contraseña".
const CAMBIO_PASSWORD_MS = 10 * 60 * 1000;

// GET /login
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

// POST /login
router.post('/login', async (req, res) => {
  const username = campoTexto(req.body.username);
  const password = campoTexto(req.body.password);

  if (!username || !password)
    return res.render('login', { error: 'Por favor ingresa usuario y contraseña.' });

  // Se corta antes de tocar la base o bcrypt: un campo de megabytes solo sirve
  // para hacer trabajar al servidor, ninguna credencial real mide tanto.
  if (username.length > MAX_LARGO_CAMPO || password.length > MAX_LARGO_CAMPO) {
    registrarFallo(req, username.slice(0, MAX_LARGO_CAMPO));
    return res.render('login', { error: CREDENCIALES_INVALIDAS });
  }

  const avisoBloqueo = mensajeBloqueo(req, username);
  if (avisoBloqueo)
    return res.render('login', { error: avisoBloqueo });

  try {
    // 1. Buscar en usuarios internos (empleados)
    const result = await poolBDPrincipal.query(
      `SELECT u.id, u.username, u.password_hash, u.activo, u.primer_acceso,
              e.nombre, e.apellido_paterno, e.apellido_materno,
              r.nombre as rol
       FROM usuarios u
       LEFT JOIN empleados e ON u.empleado_id = e.id
       LEFT JOIN usuarios_roles ur ON u.id = ur.usuario_id AND ur.rol_id IN (6, 7, 8)
       LEFT JOIN roles r ON ur.rol_id = r.id
       WHERE u.username = $1 AND u.activo = true`,
      [username.toLowerCase().trim()]
    );

    if (result.rows.length > 0) {
      const usuario = result.rows[0];

      // Antes respondía "No tienes acceso a este sistema." ANTES de comprobar la
      // contraseña y sin contar el intento: confirmaba que el usuario existe y
      // se podía sondear la lista completa de empleados sin límite alguno.
      if (!usuario.rol) {
        await gastarTiempoBcrypt(password);
        registrarFallo(req, username);
        return res.render('login', { error: CREDENCIALES_INVALIDAS });
      }

      // password_hash puede venir NULL (alta a medias). Sin esta guarda,
      // .startsWith() lanzaba TypeError y el catch de abajo devolvía "Error del
      // servidor": otro mensaje distinto que delataba que la cuenta existe.
      const hashGuardado = typeof usuario.password_hash === 'string' ? usuario.password_hash : '';
      let passwordOk = false;

      if (hashGuardado.startsWith('$2b$') || hashGuardado.startsWith('$2a$')) {
        passwordOk = await bcrypt.compare(password, hashGuardado);
      } else if (hashGuardado) {
        const r = await poolBDPrincipal.query(
          `SELECT (password_hash = crypt($1, password_hash)) as ok FROM usuarios WHERE id = $2`,
          [password, usuario.id]
        );
        passwordOk = r.rows[0]?.ok === true;
      } else {
        await gastarTiempoBcrypt(password);
      }

      if (!passwordOk) {
        registrarFallo(req, username);
        return res.render('login', { error: CREDENCIALES_INVALIDAS });
      }

      // Si es su primer acceso, exigir cambio de contraseña antes de entrar
      if (!usuario.primer_acceso) {
        limpiarIntentos(req, username);

        // Regenerar TAMBIÉN aquí. El estado "esta sesión puede cambiar la
        // contraseña de esta cuenta" vale tanto como estar dentro: si se guarda
        // en el ID de sesión que ya traía el navegador, quien haya fijado esa
        // cookie puede llamar a /cambiar-password, poner la contraseña que
        // quiera y quedarse la cuenta. Es la misma fijación de sesión que
        // iniciarSesion() evita en el camino normal.
        if (!(await regenerarSesion(req)))
          return res.render('login', { error: ERROR_SERVIDOR });

        req.session.cambioPasswordPendiente = {
          id:              usuario.id,
          username:        usuario.username,
          rol:             usuario.rol,
          nombre_completo: `${usuario.nombre} ${usuario.apellido_paterno} ${usuario.apellido_materno || ''}`.trim(),
          expira:          Date.now() + CAMBIO_PASSWORD_MS,
        };

        if (!(await guardarSesion(req)))
          return res.render('login', { error: ERROR_SERVIDOR });

        return res.render('login', { error: null, cambioPassword: true, passwordError: null });
      }

      limpiarIntentos(req, username);
      return iniciarSesion(req, res, 'user', {
        id:              usuario.id,
        username:        usuario.username,
        rol:             usuario.rol,
        nombre_completo: `${usuario.nombre} ${usuario.apellido_paterno} ${usuario.apellido_materno || ''}`.trim(),
      }, '/dashboard');
    }

    // 2. Buscar en proveedores (contratistas)
    const resultProv = await poolBDPrincipal.query(
      `SELECT p.id_proveedor, p.nombre, pu.usuarios as username, pu.contraseña as password_hash
       FROM proveedores p
       JOIN proveedores_usuarios pu ON pu.id_proveedor = p.id_proveedor
       WHERE pu.usuarios = $1 AND p.visibilidad = true`,
      [username.toLowerCase().trim()]
    );

    if (!resultProv.rows.length) {
      // El usuario no está en ninguna de las dos tablas: sin esto se responde
      // sin haber ejecutado ni bcrypt ni crypt, y ese hueco de tiempo distingue
      // un usuario inexistente de uno real con la contraseña equivocada.
      await gastarTiempoBcrypt(password);
      registrarFallo(req, username);
      return res.render('login', { error: CREDENCIALES_INVALIDAS });
    }

    const proveedor = resultProv.rows[0];

    // Verificar contraseña con pgcrypto
    const rPwd = await poolBDPrincipal.query(
      `SELECT (contraseña = crypt($1, contraseña)) as ok FROM proveedores_usuarios WHERE id_proveedor = $2`,
      [password, proveedor.id_proveedor]
    );

    if (rPwd.rows[0]?.ok !== true) {
      registrarFallo(req, username);
      return res.render('login', { error: CREDENCIALES_INVALIDAS });
    }

    limpiarIntentos(req, username);
    return iniciarSesion(req, res, 'user', {
      id:              proveedor.id_proveedor,
      username:        proveedor.username,
      rol:             'contratista',
      nombre_completo: proveedor.nombre,
    }, '/dashboard');

  } catch(e) {
    console.error('Error login:', e);
    return res.render('login', { error: ERROR_SERVIDOR });
  }
});

// POST /cambiar-password — cambio obligatorio de contraseña en el primer acceso
router.post('/cambiar-password', async (req, res) => {
  const pendiente = req.session.cambioPasswordPendiente;
  if (!pendiente) return res.redirect('/login');

  // El permiso para cambiar la contraseña caduca solo. Sin esto vivía las 12 h
  // de la cookie: en un equipo compartido, cualquiera que llegara después con
  // esa pestaña abierta podía fijar la contraseña de la cuenta ajena.
  if (!pendiente.expira || Date.now() > pendiente.expira) {
    delete req.session.cambioPasswordPendiente;
    return res.render('login', { error: 'La sesión expiró. Vuelve a iniciar sesión.' });
  }

  const nueva_password    = campoTexto(req.body.nueva_password);
  const confirmar_password = campoTexto(req.body.confirmar_password);

  const renderError = (msg) =>
    res.render('login', { error: null, cambioPassword: true, passwordError: msg });

  if (!nueva_password || !confirmar_password)
    return renderError('Completa ambos campos.');

  if (nueva_password.length > MAX_LARGO_CAMPO)
    return renderError(`La contraseña no puede pasar de ${MAX_LARGO_CAMPO} caracteres.`);

  if (nueva_password !== confirmar_password)
    return renderError('Las contraseñas no coinciden.');

  // Contraseña fuerte: mínimo 8 caracteres, mayúscula, minúscula, número y carácter especial
  const esFuerte = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(nueva_password);
  if (!esFuerte)
    return renderError('La contraseña debe tener mínimo 8 caracteres e incluir mayúscula, minúscula, número y un carácter especial.');

  try {
    const hash = await bcrypt.hash(nueva_password, 10);
    await poolBDPrincipal.query(
      `UPDATE usuarios SET password_hash = $1, primer_acceso = true WHERE id = $2`,
      [hash, pendiente.id]
    );

    // Contraseña actualizada: iniciar sesión normalmente.
    // `pendiente` ya está en una variable local, así que regenerar la sesión
    // (que borra cambioPasswordPendiente) no pierde nada.
    return iniciarSesion(req, res, 'user', {
      id:              pendiente.id,
      username:        pendiente.username,
      rol:             pendiente.rol,
      nombre_completo: pendiente.nombre_completo,
    }, '/dashboard');

  } catch(e) {
    console.error('Error cambiando contraseña:', e);
    return renderError(ERROR_SERVIDOR);
  }
});

// GET /logout
router.get('/logout', (req, res) => {
  // El redirect va dentro del callback: sin él la respuesta puede salir antes
  // de que el store haya borrado la sesión.
  req.session.destroy(err => {
    if (err) console.error('[logout] error cerrando sesión:', err);
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

// ─── MÓDULO ASISTENCIA ─────────────────────────────────

// Credenciales del módulo de asistencia: salen del .env, nunca del código.
// Si no están configuradas, el login queda deshabilitado (no hay usuario por defecto).
const ASISTENCIA_USERNAME = process.env.ASISTENCIA_USERNAME;
const ASISTENCIA_PASSWORD = process.env.ASISTENCIA_PASSWORD;
const ASISTENCIA_CONFIGURADA = !!(ASISTENCIA_USERNAME && ASISTENCIA_PASSWORD);

// Se avisa una sola vez al cargar el módulo, no en cada intento: si no, cualquiera
// puede inflar el log a voluntad golpeando el endpoint.
if (!ASISTENCIA_CONFIGURADA) {
  console.error('[asistencia] Falta ASISTENCIA_USERNAME o ASISTENCIA_PASSWORD en .env: login deshabilitado.');
}

// Comparación en tiempo constante: evita filtrar el valor midiendo cuánto tarda.
// Se hashea antes de comparar porque sha256 siempre da 32 bytes: así timingSafeEqual
// nunca ve longitudes distintas y no se filtra ni siquiera el largo del secreto
// (comparar los buffers crudos obliga a un `return false` temprano cuando no coinciden).
function comparaSeguro(recibido, esperado) {
  const a = crypto.createHash('sha256').update(String(recibido ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(esperado ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

router.get('/login-asistencia', (req, res) => {
  if (req.session.asistencia_user) return res.redirect('/verificar');
  res.render('login-asistencia', { error: null });
});

router.post('/login-asistencia', (req, res) => {
  // Mismo saneado que el login principal: si username llega como array,
  // mensajeBloqueo() y registrarFallo() cuentan bajo una clave distinta de la
  // que se compara, y el limitador deja de contar los intentos reales.
  const username = campoTexto(req.body.username).slice(0, MAX_LARGO_CAMPO);
  const password = campoTexto(req.body.password).slice(0, MAX_LARGO_CAMPO);

  if (!ASISTENCIA_CONFIGURADA)
    return res.render('login-asistencia', { error: 'Módulo no configurado. Contacta al administrador.' });

  const avisoBloqueoAsistencia = mensajeBloqueo(req, username);
  if (avisoBloqueoAsistencia)
    return res.render('login-asistencia', { error: avisoBloqueoAsistencia });

  // Se evalúan ambas siempre, aunque la primera ya haya fallado: así el tiempo
  // de respuesta no delata si lo que estaba mal era el usuario o la contraseña
  const okUsuario = comparaSeguro(username, ASISTENCIA_USERNAME);
  const okPassword = comparaSeguro(password, ASISTENCIA_PASSWORD);

  if (okUsuario && okPassword) {
    limpiarIntentos(req, username);
    return iniciarSesion(req, res, 'asistencia_user', {
      id: 0, username: ASISTENCIA_USERNAME,
      rol: 'seguridad_fisica',
      nombre_completo: 'Administrador',
    }, '/verificar', 'login-asistencia');
  }

  registrarFallo(req, username, 'login-asistencia');
  return res.render('login-asistencia', { error: 'Usuario o contraseña incorrectos.' });
});

router.get('/logout-asistencia', (req, res) => {
  // destroy() en vez de `= null`: el equipo de la caseta es compartido, así que
  // el ID de sesión no puede sobrevivir al logout para que el siguiente turno
  // (o alguien con la cookie anotada) lo reutilice.
  req.session.destroy(err => {
    if (err) console.error('[asistencia] error cerrando sesión:', err);
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});


// GET /registro — muestra el formulario de registro
router.get('/registro', (req, res) => {
  res.render('registro', { error: null, paso: 'formulario' });
});

// GET /registro/verificar-rfc — valida que el RFC no esté ya registrado
router.get('/registro/verificar-rfc', async (req, res) => {
  const { rfc } = req.query;
  if (!rfc) return res.json({ existe: false });
  try {
    const r = await poolBDPrincipal.query(
      `SELECT 1 FROM proveedores WHERE rfc = $1`, [rfc]
    );
    res.json({ existe: r.rows.length > 0 });
  } catch(e) {
    res.json({ existe: false });
  }
});

// GET /registro/verificar-padron — valida que el Registro Patronal no esté ya registrado
router.get('/registro/verificar-padron', async (req, res) => {
  const { padron } = req.query;
  if (!padron) return res.json({ existe: false });
  try {
    const r = await poolBDPrincipal.query(
      `SELECT 1 FROM proveedores WHERE LOWER(TRIM(padron)) = LOWER(TRIM($1))`, [padron]
    );
    res.json({ existe: r.rows.length > 0 });
  } catch(e) {
    res.json({ existe: false });
  }
});

// POST /registro/extraer-pdf — extrae RFC y Razón Social del PDF
router.post('/registro/extraer-pdf', upload.single('constancia'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: 'No se recibió archivo' });
  try {
    let texto = '';
    try {
      const data = await pdfParse(req.file.buffer);
      texto = data?.text || data?.content || '';
    } catch(e1) {
      // Si PDFParse es clase, intentar instanciarla
      const instance = new PDFParse();
      const data = await (instance.parse || instance.parseBuffer || instance.getDocument).call(instance, req.file.buffer);
      texto = data?.text || data?.content || '';
    }

    const matchRfc   = texto.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}/);
    const matchRazon = texto.match(/Denominaci[oó]n\s*\/?\s*Raz[oó]n\s*Social[:\s]*(.+?)\s*R[eé]gimen\s*Capital/i);

    const rfc         = matchRfc   ? matchRfc[0]           : null;
    const razon_social = matchRazon ? matchRazon[1].trim()  : null;

    return res.json({ success: true, rfc, razon_social });
  } catch(e) {
    return res.json({ success: false, error: 'Error al leer el PDF: ' + e.message });
  }
});



// POST /registro/enviar-codigo
router.post('/registro/enviar-codigo', upload.single('constancia'), async (req, res) => {

  // Sin tope, este endpoint permite pedir códigos en bucle: cada llamada dispara
  // un correo vía N8N (spam al destinatario y coste) y regenera el código, lo que
  // además serviría para reiniciar el contador de fallos de verificar-codigo.
  const esperaEnvio = bloqueoPorIp(req, 'envio-codigo');
  if (esperaEnvio > 0) {
    return res.render('registro', {
      error: `Demasiadas solicitudes de código. Espera ${Math.ceil(esperaEnvio / 60000)} minutos e intenta de nuevo.`,
      paso: 'formulario'
    });
  }
  falloPorIp(req, 'envio-codigo', MAX_ENVIOS_CODIGO);

  const { rfc, razon_social, correo, telefono, representante, padron } = req.body;
  
  // 1. Leer texto del PDF
  let rfcExtraido = rfc;
  let razonExtraida = razon_social;

  if (req.file) {
  try {
    const data = await pdfParse(req.file.buffer);
    const texto = data.text;

    // ← AGREGA ESTO TEMPORALMENTE
    console.log('=== TEXTO DEL PDF ===');
    console.log(texto.substring(0, 1000)); // primeros 1000 caracteres
    console.log('====================');

    const matchRfc = texto.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}/);
    if (matchRfc) rfcExtraido = matchRfc[0];

    const matchRazon = texto.match(/Denominaci[oó]n\s*\/?\s*Raz[oó]n\s*Social[:\s]*(.+?)\s*R[eé]gimen\s*Capital/i);
    if (matchRazon) razonExtraida = matchRazon[1].trim();

  } catch(e) {
    console.error('Error leyendo PDF:', e.message);
  }
}


  // 2. Validar que el RFC no esté ya registrado
  if (rfcExtraido) {
    const existe = await poolBDPrincipal.query(
      `SELECT 1 FROM proveedores WHERE rfc = $1`,
      [rfcExtraido]
    );
    if (existe.rows.length > 0) {
      return res.render('registro', {
        error: 'Empresa ya registrada en el sistema. Contacta al administrador si necesitas acceso.',
        paso: 'formulario'
      });
    }
  }

  // 2b. Validar que el Registro Patronal no esté ya registrado
  if (padron) {
    const existePadron = await poolBDPrincipal.query(
      `SELECT 1 FROM proveedores WHERE LOWER(TRIM(padron)) = LOWER(TRIM($1))`,
      [padron]
    );
    if (existePadron.rows.length > 0) {
      return res.render('registro', {
        error: 'El Registro Patronal ya está dado de alta en el sistema. Contacta al administrador.',
        paso: 'formulario'
      });
    }
  }

  // 3. Generar código de 6 dígitos.
  // crypto.randomInt y no Math.random(): Math.random() no es criptográfico y su
  // salida se puede predecir observando valores previos.
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expira = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

  // 4. Guardar en memoria (`fallos` limita el fuerza bruta contra el código)
  codigosPendientes[correo] = {
    codigo,
    expira,
    fallos: 0,
    datos: { razon_social: razonExtraida, rfc: rfcExtraido, correo, telefono, representante, padron: padron || null }
  };

  // 4. Enviar correo
 // 4. Enviar código via N8N
try {
  await axios.post(process.env.N8N_WEBHOOK_VERIFICACION, {
    correo:      correo,
    codigo:      codigo,
    razon_social: razonExtraida
  }, { timeout: 10000 });

} catch(e) {
  console.error('Error llamando N8N:', e.message);
  return res.render('registro', {
    error: 'No se pudo enviar el código. Intenta de nuevo.',
    paso: 'formulario'
  });
}


  // 5. Mostrar pantalla de verificación
  res.render('registro', { error: null, paso: 'verificacion', correo });

});





// POST /registro/verificar-codigo
router.post('/registro/verificar-codigo', async (req, res) => {
  const { correo, codigo } = req.body;

  // 0. Un código de 6 dígitos son solo 1,000,000 de combinaciones: sin límite de
  //    intentos se agota por fuerza bruta en horas. Se frena por IP y, más abajo,
  //    invalidando el código tras MAX_INTENTOS_CODIGO fallos.
  const esperaCodigo = bloqueoPorIp(req, 'codigo');
  if (esperaCodigo > 0) {
    return res.render('registro', {
      error: `Demasiados intentos fallidos. Espera ${Math.ceil(esperaCodigo / 60000)} minutos e intenta de nuevo.`,
      paso: 'verificacion',
      correo
    });
  }

  // 1. Buscar el registro pendiente
  const pendiente = codigosPendientes[correo];

  if (!pendiente) {
    return res.render('registro', {
      error: 'No hay un registro pendiente para ese correo. Vuelve a intentarlo.',
      paso: 'formulario'
    });
  }

  // 2. Verificar que no haya expirado
  if (new Date() > pendiente.expira) {
    delete codigosPendientes[correo];
    return res.render('registro', {
      error: 'El código expiró. Vuelve a registrarte.',
      paso: 'formulario'
    });
  }

  // 3. Verificar que el código sea correcto.
  //    timingSafeEqual para no filtrar cuántos dígitos coinciden por el tiempo
  //    de respuesta; los buffers se igualan en longitud primero.
  const enviado  = Buffer.from(String(codigo || '').trim());
  const esperado = Buffer.from(pendiente.codigo);
  const codigoOk = enviado.length === esperado.length && crypto.timingSafeEqual(enviado, esperado);

  if (!codigoOk) {
    pendiente.fallos = (pendiente.fallos || 0) + 1;
    falloPorIp(req, 'codigo', MAX_INTENTOS_CODIGO);
    console.warn(`[seguridad] código de registro incorrecto ip=${ipCliente(req)} correo=${String(correo || '').slice(0, 80)}`);

    // Quemado el código tras varios fallos: obliga a pedir uno nuevo, así no se
    // puede seguir probando contra el mismo valor durante los 15 min de vigencia.
    if (pendiente.fallos >= MAX_INTENTOS_CODIGO) {
      delete codigosPendientes[correo];
      return res.render('registro', {
        error: 'Demasiados intentos incorrectos. El código se canceló, vuelve a registrarte para recibir uno nuevo.',
        paso: 'formulario'
      });
    }

    return res.render('registro', {
      error: `Código incorrecto. Te quedan ${MAX_INTENTOS_CODIGO - pendiente.fallos} intentos.`,
      paso: 'verificacion',
      correo
    });
  }

  // 4. Insertar en proveedores
  try {
    const { razon_social, rfc, telefono, representante, padron } = pendiente.datos;

    // Verificar de nuevo que el RFC no se haya registrado mientras esperaba el código
    const existeDoble = await poolBDPrincipal.query(
      `SELECT 1 FROM proveedores WHERE rfc = $1`, [rfc]
    );
    if (existeDoble.rows.length > 0) {
      delete codigosPendientes[correo];
      return res.render('registro', {
        error: 'Empresa ya registrada en el sistema. Contacta al administrador si necesitas acceso.',
        paso: 'formulario'
      });
    }

    // Verificar de nuevo que el Registro Patronal no se haya registrado mientras esperaba el código
    if (padron) {
      const existePadronDoble = await poolBDPrincipal.query(
        `SELECT 1 FROM proveedores WHERE LOWER(TRIM(padron)) = LOWER(TRIM($1))`, [padron]
      );
      if (existePadronDoble.rows.length > 0) {
        delete codigosPendientes[correo];
        return res.render('registro', {
          error: 'El Registro Patronal ya está dado de alta en el sistema. Contacta al administrador.',
          paso: 'formulario'
        });
      }
    }

    // Generar contraseña temporal de 8 caracteres
    // Alfabeto sin 0/O ni 1/I/L: la contraseña se dicta por teléfono o se copia
    // de un correo, y esos pares se confunden al leerlos. 10 chars sobre 32
    // símbolos ~ 50 bits, suficiente para que no se adivine antes del cambio.
    const ALFABETO_TEMP = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const tempPassword = Array.from({ length: 10 },
      () => ALFABETO_TEMP[crypto.randomInt(0, ALFABETO_TEMP.length)]).join('');
    // Usar RFC como usuario (en minúsculas para consistencia con el login)
    const usuario = rfc.toLowerCase();

    await poolBDPrincipal.query('BEGIN');
    try {
      const rProv = await poolBDPrincipal.query(
        `INSERT INTO proveedores (nombre, correo, rfc, visibilidad, padron)
         VALUES ($1, $2, $3, true, $4)
         RETURNING id_proveedor`,
        [razon_social, correo, rfc, padron || null]
      );
      const newId = rProv.rows[0].id_proveedor;
      await poolBDPrincipal.query(
        `INSERT INTO proveedores_usuarios (id_proveedor, usuarios, contraseña, representante, telefono)
         VALUES ($1, $2, crypt($3, gen_salt('bf')), $4, $5)`,
        [newId, usuario, tempPassword, representante, telefono]
      );
      await poolBDPrincipal.query('COMMIT');
    } catch(eInsert) {
      await poolBDPrincipal.query('ROLLBACK');
      throw eInsert;
    }

    delete codigosPendientes[correo];

    res.render('registro', {
      error: null,
      paso: 'exito',
      usuario,
      tempPassword,
      correo
    });

  } catch(e) {
    console.error('Error creando cuenta:', e.message);
    return res.render('registro', {
      error: 'Error al crear la cuenta: ' + e.message,
      paso: 'verificacion',
      correo
    });
  }
});



module.exports = router;