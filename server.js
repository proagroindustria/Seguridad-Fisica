require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes      = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const solicitudesRoutes  = require('./routes/permisos');
const { router: facialRoutes } = require('./routes/facial');
const documentosRoutes = require('./routes/documentos');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware — limit aumentado para descriptores faciales
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/models', express.static(path.join(__dirname, 'public', 'models')));

// Sesión
app.use(session({
  secret: process.env.SESSION_SECRET || 'proagro_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 8 * 60 * 60 * 1000 // 8 horas
  }
}));

// Rutas
app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/solicitudes', solicitudesRoutes);
app.use('/facial', facialRoutes);
app.use('/documentos', documentosRoutes);

app.get('/personal', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const rol = req.session.user.rol;
  if (rol !== 'contratista' && rol !== 'seguridad_fisica') return res.redirect('/dashboard');
  res.render('personal', { user: req.session.user });
});


app.get('/verificar', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.rol !== 'seguridad_fisica') return res.redirect('/dashboard');
  res.render('verificar', { user: req.session.user });
});

app.get('/historial', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.rol !== 'seguridad_fisica') return res.redirect('/dashboard');
  res.render('historial', { user: req.session.user });
});


// Ruta raíz
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

// 404
app.use((req, res) => {
  if (req.accepts('json')) {
    res.status(404).json({ error: 'Ruta no encontrada' });
  } else {
    res.status(404).redirect('/login');
  }
});

app.listen(PORT, () => {
  console.log(`\n🌱 PROAGRO - Sistema de Permisos`);
  console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
  console.log(`📋 Modo: ${process.env.OFFLINE_MODE === 'true' ? 'SIN BASE DE DATOS (offline)' : 'PostgreSQL'}\n`);
});
