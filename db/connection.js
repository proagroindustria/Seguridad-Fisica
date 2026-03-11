require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'permisos_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'P4*DSM25',
});

pool.on('error', (err) => {
  console.error('Error inesperado en el cliente de PostgreSQL', err);
});

module.exports = pool;
