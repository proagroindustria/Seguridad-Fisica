#!/usr/bin/env node
/**
 * DIAGNÓSTICO — ¿por qué este permiso no vence?
 * ---------------------------------------------------------------------------
 * Un permiso vencido de fecha no pasa a estado 'vencido' mientras personasSinSalida()
 * (server.js) encuentre gente adentro. Esa función solo mira las filas de
 * `accesos` que traen el permiso_id del permiso, así que no distingue entre:
 *
 *   CASO A → la persona realmente nunca registró salida.
 *   CASO B → sí registró salida, pero la fila se guardó con permiso_id = NULL
 *            (sale fuera de vigencia, o sale por QR de invitado) y quedó huérfana.
 *
 * Este script mira TODOS los accesos de cada persona, sin filtrar por permiso_id,
 * y dice cuál de los dos casos es. Es de solo lectura: no modifica nada.
 *
 * Uso:  node scripts/diagnostico-accesos.js SOL-2026-0142
 */
require('dotenv').config();
const { Pool } = require('pg');

const folio = process.argv[2];
if (!folio) {
  console.error('Uso: node scripts/diagnostico-accesos.js <FOLIO>');
  console.error('Ejemplo: node scripts/diagnostico-accesos.js SOL-2026-0142');
  process.exit(1);
}

const poolPermisos = require('../db/connection');
const poolFacial = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.FACIAL_DB_NAME || 'reconocimiento_db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const fmt = (d) => d ? new Date(d).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const horas = (desde) => ((Date.now() - new Date(desde).getTime()) / 36e5);

(async () => {
  // ── 1. El permiso ────────────────────────────────────────────────────────
  const rP = await poolPermisos.query(
    `SELECT id, folio, empresa, estado, fecha_inicio, fecha_fin, es_pase_visita
     FROM permisos WHERE UPPER(folio) = UPPER($1)`, [folio]
  );
  if (!rP.rows.length) { console.log(`No existe el permiso ${folio}`); process.exit(0); }
  const p = rP.rows[0];

  console.log('═'.repeat(70));
  console.log(`PERMISO ${p.folio}  (id interno: ${p.id})`);
  console.log(`  Empresa   : ${p.empresa}`);
  console.log(`  Estado    : ${p.estado}${p.es_pase_visita ? '   [PASE DE VISITA]' : ''}`);
  console.log(`  Vigencia  : ${fmt(p.fecha_inicio).split(',')[0]} → ${fmt(p.fecha_fin).split(',')[0]}`);
  console.log('═'.repeat(70));

  // ── 2. Cada persona del permiso ──────────────────────────────────────────
  const rPer = await poolPermisos.query(
    `SELECT nombre, trabajador_id FROM permiso_personal WHERE permiso_id = $1 ORDER BY nombre`, [p.id]
  );

  let bloquean = 0;
  for (const per of rPer.rows) {
    console.log(`\n▸ ${per.nombre}`);

    // Resolver el empleado_id igual que lo hace algunoAdentro() en server.js
    let empleadoId = per.trabajador_id || null;
    if (!empleadoId && per.nombre) {
      const partes = per.nombre.trim().split(/\s+/);
      const t = await poolFacial.query(
        `SELECT id FROM trabajadores
         WHERE activo = true AND LOWER(TRIM(nombre)) = LOWER($1) AND LOWER(TRIM(apellido)) = LOWER($2)
         LIMIT 1`,
        [partes[0] || '', partes.slice(1).join(' ') || '']
      );
      if (t.rows.length) empleadoId = t.rows[0].id;
    }
    if (!empleadoId) {
      console.log('   · No se pudo resolver en reconocimiento_db (no bloquea el vencimiento).');
      continue;
    }
    console.log(`   · empleado_id = ${empleadoId}`);

    // Último movimiento CON este permiso_id → es lo único que mira el cron hoy
    const rUlt = await poolFacial.query(
      `SELECT id, tipo_movimiento, fecha_hora FROM accesos
       WHERE empleado_id = $1 AND permiso_id = $2 AND resultado = 'exitoso'
       ORDER BY fecha_hora DESC LIMIT 1`,
      [empleadoId, p.id]
    );
    if (!rUlt.rows.length) {
      console.log('   · Sin accesos ligados a este permiso — no bloquea.');
      continue;
    }
    const ult = rUlt.rows[0];
    console.log(`   · Último movimiento con permiso_id=${p.id}: ${ult.tipo_movimiento.toUpperCase()} el ${fmt(ult.fecha_hora)}`);
    if (ult.tipo_movimiento !== 'entrada') { console.log('   ✓ Cerrado correctamente — no bloquea.'); continue; }

    bloquean++;

    // LA PREGUNTA CLAVE: ¿hubo algún movimiento después, con cualquier permiso_id?
    const rPost = await poolFacial.query(
      `SELECT id, tipo_movimiento, permiso_id, fecha_hora FROM accesos
       WHERE resultado = 'exitoso' AND fecha_hora > $1
         AND (empleado_id = $2 OR nombre_snapshot ILIKE $3)
       ORDER BY fecha_hora ASC`,
      [ult.fecha_hora, empleadoId, `%${per.nombre.trim()}%`]
    );

    if (!rPost.rows.length) {
      console.log(`   ⇒ CASO A: no hay NINGÚN movimiento posterior. Nunca registró salida.`);
      console.log(`             Lleva ${horas(ult.fecha_hora).toFixed(1)} h con la entrada abierta.`);
    } else {
      console.log('   · Movimientos posteriores (sin filtrar por permiso):');
      for (const a of rPost.rows) {
        console.log(`       ${fmt(a.fecha_hora)}  ${a.tipo_movimiento.toUpperCase().padEnd(7)}  permiso_id=${a.permiso_id === null ? 'NULL  ← huérfana' : a.permiso_id}`);
      }
      const salidaHuerfana = rPost.rows.find(a => a.tipo_movimiento === 'salida' && a.permiso_id === null);
      if (salidaHuerfana) {
        console.log(`   ⇒ CASO B: SÍ salió el ${fmt(salidaHuerfana.fecha_hora)}, pero la fila quedó con permiso_id NULL.`);
        console.log(`             El cron no la ve y por eso el permiso sigue trabado.`);
      } else if (rPost.rows.some(a => a.tipo_movimiento === 'salida')) {
        console.log(`   ⇒ CASO B (variante): salió, pero la fila se ligó a otro permiso.`);
      } else {
        console.log(`   ⇒ CASO A: hubo movimientos posteriores pero ninguna salida. Sigue adentro.`);
      }
    }
  }

  // ── 3. Veredicto ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  const vencido = new Date(p.fecha_fin) < new Date(new Date().toDateString());
  console.log(`Fecha fin vencida : ${vencido ? 'sí' : 'no'}`);
  console.log(`Personas que bloquean el vencimiento: ${bloquean}`);
  console.log(bloquean > 0 && vencido
    ? 'El cron seguirá saltando este permiso mientras no se cierren esas entradas.'
    : 'Este permiso no debería estar trabado por entradas abiertas.');
  console.log('═'.repeat(70));

  await poolFacial.end();
  await poolPermisos.end();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
