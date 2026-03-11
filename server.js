require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes      = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const permisosRoutes  = require('./routes/permisos');
const { router: facialRoutes } = require('./routes/facial');

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
app.use('/permisos', permisosRoutes);
app.use('/facial', facialRoutes);

// Ruta raíz
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

// 404
app.use((req, res) => {
  res.status(404).redirect('/login');
});

app.listen(PORT, () => {
  console.log(`\n🌱 PROAGRO - Sistema de Permisos`);
  console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
  console.log(`📋 Modo: ${process.env.OFFLINE_MODE === 'true' ? 'SIN BASE DE DATOS (offline)' : 'PostgreSQL'}\n`);
});

