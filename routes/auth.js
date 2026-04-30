const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
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

  try {
    // 1. Buscar en usuarios internos (empleados)
    const result = await poolBDPrincipal.query(
      `SELECT u.id, u.username, u.password_hash, u.activo,
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

      if (!passwordOk)
        return res.render('login', { error: 'Usuario o contraseña incorrectos.' });

      req.session.user = {
        id:              usuario.id,
        username:        usuario.username,
        rol:             usuario.rol,
        nombre_completo: `${usuario.nombre} ${usuario.apellido_paterno} ${usuario.apellido_materno || ''}`.trim(),
      };
      return res.redirect('/dashboard');
    }

    // 2. Buscar en proveedores (contratistas)
    const resultProv = await poolBDPrincipal.query(
      `SELECT p.id_proveedor, p.nombre, pu.usuarios as username, pu.contraseña as password_hash
       FROM proveedores p
       JOIN proveedores_usuarios pu ON pu.id_proveedor = p.id_proveedor
       WHERE pu.usuarios = $1 AND p.visibilidad = true`,
      [username.toLowerCase().trim()]
    );

    if (!resultProv.rows.length)
      return res.render('login', { error: 'Usuario o contraseña incorrectos.' });

    const proveedor = resultProv.rows[0];

    // Verificar contraseña con pgcrypto
    const rPwd = await poolBDPrincipal.query(
      `SELECT (contraseña = crypt($1, contraseña)) as ok FROM proveedores_usuarios WHERE id_proveedor = $2`,
      [password, proveedor.id_proveedor]
    );

    if (!rPwd.rows[0]?.ok)
      return res.render('login', { error: 'Usuario o contraseña incorrectos.' });

    req.session.user = {
      id:              proveedor.id_proveedor,
      username:        proveedor.username,
      rol:             'contratista',
      nombre_completo: proveedor.nombre,
    };
    return res.redirect('/dashboard');

  } catch(e) {
    console.error('Error login:', e);
    return res.render('login', { error: 'Error del servidor. Intenta de nuevo.' });
  }
});

// GET /logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ─── MÓDULO ASISTENCIA ─────────────────────────────────
router.get('/login-asistencia', (req, res) => {
  if (req.session.asistencia_user) return res.redirect('/verificar');
  res.render('login-asistencia', { error: null });
});

router.post('/login-asistencia', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === '123') {
    req.session.asistencia_user = {
      id: 0, username: 'admin',
      rol: 'seguridad_fisica',
      nombre_completo: 'Administrador',
    };
    return res.redirect('/verificar');
  }
  return res.render('login-asistencia', { error: 'Usuario o contraseña incorrectos.' });
});

router.get('/logout-asistencia', (req, res) => {
  req.session.asistencia_user = null;
  res.redirect('/login-asistencia');
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