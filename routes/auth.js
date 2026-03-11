const express = require('express');
const router  = express.Router();
const pool    = require('../db/connection');

// GET /login
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

// POST /login — autenticación contra PostgreSQL
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('login', { error: 'Por favor ingresa usuario y contraseña.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, password, rol, nombre_completo, activo
       FROM usuarios
       WHERE username = $1 AND activo = true`,
      [username.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.render('login', { error: 'Usuario o contraseña incorrectos.' });
    }

    const usuario = result.rows[0];

    // Comparación directa (texto plano)
    // TODO: migrar a bcrypt cuando se hasheen las contraseñas
    if (usuario.password !== password) {
      return res.render('login', { error: 'Usuario o contraseña incorrectos.' });
    }

    req.session.user = {
      id:             usuario.id,
      username:       usuario.username,
      rol:            usuario.rol,
      nombre_completo: usuario.nombre_completo,
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

module.exports = router;
