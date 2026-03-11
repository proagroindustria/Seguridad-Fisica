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

module.exports = router;
