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
function iniciarSesion(req, res, clave, datos, destino, vistaError = 'login') {
  return new Promise(resolve => {
    const fallar = (err, contexto) => {
      console.error(`[login] ${contexto}:`, err);
      res.render(vistaError, { error: 'Error del servidor. Intenta de nuevo.' });
      resolve();
    };
    req.session.regenerate(err => {
      if (err) return fallar(err, 'no se pudo regenerar la sesión');
      req.session[clave] = datos;
      // save() explícito: el redirect no debe salir antes de persistir la sesión
      req.session.save(err2 => {
        if (err2) return fallar(err2, 'no se pudo guardar la sesión');
        res.redirect(destino);
        resolve();
      });
    });
  });
}

// Limitador de intentos por IP+usuario, en memoria (sin dependencias nuevas).
// No sustituye a un WAF, pero corta el fuerza bruta contra contraseñas compartidas.
const MAX_INTENTOS_LOGIN = 8;
const VENTANA_LOGIN_MS   = 10 * 60 * 1000;
const intentosLogin      = new Map();

function claveIntento(req) {
  const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
             || req.socket.remoteAddress || 'desconocida';
  return `${ip}|${String(req.body?.username ?? '').toLowerCase().trim()}`;
}

function bloqueadoPorIntentos(req) {
  const registro = intentosLogin.get(claveIntento(req));
  return !!registro && registro.expira > Date.now() && registro.n >= MAX_INTENTOS_LOGIN;
}

function registrarFallo(req) {
  const clave = claveIntento(req);
  const previo = intentosLogin.get(clave);
  const vigente = previo && previo.expira > Date.now();
  intentosLogin.set(clave, {
    n: vigente ? previo.n + 1 : 1,
    expira: vigente ? previo.expira : Date.now() + VENTANA_LOGIN_MS,
  });
}

function limpiarIntentos(req) {
  intentosLogin.delete(claveIntento(req));
}

// Purga periódica para que el Map no crezca sin límite
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, registro] of intentosLogin) {
    if (registro.expira <= ahora) intentosLogin.delete(clave);
  }
}, VENTANA_LOGIN_MS).unref();

// GET /login
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

// POST /login
// POST /login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.render('login', { error: 'Por favor ingresa usuario y contraseña.' });

  if (bloqueadoPorIntentos(req))
    return res.render('login', { error: 'Demasiados intentos fallidos. Espera unos minutos.' });

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
      if (!usuario.rol)
        return res.render('login', { error: 'No tienes acceso a este sistema.' });

      let passwordOk = false;
      if (usuario.password_hash.startsWith('$2b$') || usuario.password_hash.startsWith('$2a$')) {
        passwordOk = await bcrypt.compare(password, usuario.password_hash);
      } else {
        const r = await poolBDPrincipal.query(
          `SELECT (password_hash = crypt($1, password_hash)) as ok FROM usuarios WHERE id = $2`,
          [password, usuario.id]
        );
        passwordOk = r.rows[0]?.ok;
      }

      if (!passwordOk) {
        registrarFallo(req);
        return res.render('login', { error: 'Usuario o contraseña incorrectos.' });
      }

      // Si es su primer acceso, exigir cambio de contraseña antes de entrar
      if (!usuario.primer_acceso) {
        req.session.cambioPasswordPendiente = {
          id:              usuario.id,
          username:        usuario.username,
          rol:             usuario.rol,
          nombre_completo: `${usuario.nombre} ${usuario.apellido_paterno} ${usuario.apellido_materno || ''}`.trim(),
        };
        return res.render('login', { error: null, cambioPassword: true, passwordError: null });
      }

      limpiarIntentos(req);
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
      registrarFallo(req);
      return res.render('login', { error: 'Usuario o contraseña incorrectos.' });
    }

    const proveedor = resultProv.rows[0];

    // Verificar contraseña con pgcrypto
    const rPwd = await poolBDPrincipal.query(
      `SELECT (contraseña = crypt($1, contraseña)) as ok FROM proveedores_usuarios WHERE id_proveedor = $2`,
      [password, proveedor.id_proveedor]
    );

    if (!rPwd.rows[0]?.ok) {
      registrarFallo(req);
      return res.render('login', { error: 'Usuario o contraseña incorrectos.' });
    }

    limpiarIntentos(req);
    return iniciarSesion(req, res, 'user', {
      id:              proveedor.id_proveedor,
      username:        proveedor.username,
      rol:             'contratista',
      nombre_completo: proveedor.nombre,
    }, '/dashboard');

  } catch(e) {
    console.error('Error login:', e);
    return res.render('login', { error: 'Error del servidor. Intenta de nuevo.' });
  }
});

// POST /cambiar-password — cambio obligatorio de contraseña en el primer acceso
router.post('/cambiar-password', async (req, res) => {
  const pendiente = req.session.cambioPasswordPendiente;
  if (!pendiente) return res.redirect('/login');

  const { nueva_password, confirmar_password } = req.body;

  const renderError = (msg) =>
    res.render('login', { error: null, cambioPassword: true, passwordError: msg });

  if (!nueva_password || !confirmar_password)
    return renderError('Completa ambos campos.');

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
    return renderError('Error del servidor. Intenta de nuevo.');
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
  const { username, password } = req.body;

  if (!ASISTENCIA_CONFIGURADA)
    return res.render('login-asistencia', { error: 'Módulo no configurado. Contacta al administrador.' });

  if (bloqueadoPorIntentos(req))
    return res.render('login-asistencia', { error: 'Demasiados intentos fallidos. Espera unos minutos.' });

  // Se evalúan ambas siempre, aunque la primera ya haya fallado: así el tiempo
  // de respuesta no delata si lo que estaba mal era el usuario o la contraseña
  const okUsuario = comparaSeguro(username, ASISTENCIA_USERNAME);
  const okPassword = comparaSeguro(password, ASISTENCIA_PASSWORD);

  if (okUsuario && okPassword) {
    limpiarIntentos(req);
    return iniciarSesion(req, res, 'asistencia_user', {
      id: 0, username: ASISTENCIA_USERNAME,
      rol: 'seguridad_fisica',
      nombre_completo: 'Administrador',
    }, '/verificar', 'login-asistencia');
  }

  registrarFallo(req);
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
  
  // DEBUG - borra esto después
  console.log('=== RUTA ALCANZADA ===');
  console.log('Body:', req.body);
  console.log('Archivo recibido:', req.file ? `SÍ - ${req.file.originalname} (${req.file.size} bytes)` : 'NO');
  
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

  // 3. Generar código de 6 dígitos
  const codigo = Math.floor(100000 + Math.random() * 900000).toString();
  const expira = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

  // 4. Guardar en memoria
  codigosPendientes[correo] = {
    codigo,
    expira,
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

  // 3. Verificar que el código sea correcto
  if (pendiente.codigo !== codigo.trim()) {
    return res.render('registro', {
      error: 'Código incorrecto. Intenta de nuevo.',
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
    const tempPassword = Math.random().toString(36).slice(2, 10).toUpperCase();
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



router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null, query: req.query });
});



module.exports = router;