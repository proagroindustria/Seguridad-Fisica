
const express = require('express');
const router = express.Router();

// Middleware de autenticación
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// GET /dashboard
router.get('/', requireAuth, (req, res) => {
  res.render('dashboard', {
    user: req.session.user
  });
});

// GET /personal
router.get('/personal', requireAuth, (req, res) => {
  const rol = req.session.user.rol;
  if (rol !== 'contratista' && rol !== 'seguridad_fisica')
    return res.redirect('/dashboard');
  res.render('personal', { user: req.session.user });
});

module.exports = router;

