// ═══════════════════════════════════════════════════════════════
// PANEL DE DEPURACIÓN MÓVIL
// Activar:    abrir la página con  ?debug=1   (queda guardado)
// Desactivar: abrir la página con  ?debug=0
// Captura: errores JS, promesas rechazadas, console.error/warn
// y TODAS las peticiones fetch (tamaño enviado, duración, status HTTP).
// ═══════════════════════════════════════════════════════════════
(function () {
  // ── Activación por URL, persistida en localStorage ──
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('debug') === '1') localStorage.setItem('pa_debug', '1');
    if (qs.get('debug') === '0') localStorage.removeItem('pa_debug');
  } catch (e) { /* localStorage bloqueado: seguir sin persistencia */ }

  const ACTIVO = (function () {
    try { return localStorage.getItem('pa_debug') === '1'; }
    catch (e) { return /[?&]debug=1/.test(location.search); }
  })();

  const logs = [];
  let panelBody = null;

  function hora() {
    const d = new Date();
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function registrar(nivel, texto) {
    const entrada = { t: hora(), nivel, texto: String(texto) };
    logs.push(entrada);
    if (logs.length > 300) logs.shift();
    if (panelBody) pintarEntrada(entrada);
  }

  const COLORES = { error: '#ff6b6b', warn: '#fbbf24', net: '#60a5fa', ok: '#4ade80', info: '#d1d5db' };

  function pintarEntrada(e) {
    const div = document.createElement('div');
    div.style.cssText = 'padding:3px 0;border-bottom:1px solid #222;color:' + (COLORES[e.nivel] || '#ddd') + ';word-break:break-all;white-space:pre-wrap';
    div.textContent = '[' + e.t + '] ' + e.texto;
    panelBody.appendChild(div);
    panelBody.scrollTop = panelBody.scrollHeight;
  }

  // ── Hooks globales (instalar SIEMPRE que esté activo, antes que todo) ──
  if (!ACTIVO) return;

  window.addEventListener('error', function (ev) {
    registrar('error', 'JS: ' + ev.message + ' @ ' + (ev.filename || '?').split('/').pop() + ':' + ev.lineno);
  });

  window.addEventListener('unhandledrejection', function (ev) {
    const r = ev.reason;
    registrar('error', 'PROMESA: ' + (r && r.message ? r.message : String(r)));
  });

  const _cerror = console.error.bind(console);
  console.error = function () { registrar('error', Array.from(arguments).map(String).join(' ')); _cerror.apply(null, arguments); };
  const _cwarn = console.warn.bind(console);
  console.warn = function () { registrar('warn', Array.from(arguments).map(String).join(' ')); _cwarn.apply(null, arguments); };

  // ── Envolver fetch: la pieza clave para ver qué pasa con el servidor ──
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const metodo = (opts && opts.method) || 'GET';
    const cuerpo = opts && opts.body;
    const tamKB = cuerpo ? Math.round((typeof cuerpo === 'string' ? cuerpo.length : 0) / 1024) : 0;
    const urlCorta = String(url).replace(location.origin, '');
    const inicio = Date.now();
    registrar('net', '→ ' + metodo + ' ' + urlCorta + (tamKB ? ' | enviando ' + (tamKB > 1024 ? (tamKB / 1024).toFixed(1) + ' MB' : tamKB + ' KB') : ''));
    try {
      const res = await _fetch(url, opts);
      const ms = Date.now() - inicio;
      if (res.ok) {
        registrar('ok', '← ' + res.status + ' ' + urlCorta + ' (' + ms + ' ms)');
      } else {
        // Leer el cuerpo del error sin consumir el stream original
        let detalle = '';
        try { detalle = (await res.clone().text()).slice(0, 200); } catch (e) {}
        registrar('error', '← HTTP ' + res.status + ' ' + urlCorta + ' (' + ms + ' ms)' +
          (res.status === 413 ? ' — ARCHIVO/PAYLOAD DEMASIADO GRANDE (límite nginx client_max_body_size)' : '') +
          (res.status === 502 ? ' — nginx no pudo hablar con node (¿server.js caído?)' : '') +
          (res.status === 504 ? ' — TIMEOUT de nginx esperando a node (proxy_read_timeout)' : '') +
          (detalle ? '\n   cuerpo: ' + detalle : ''));
      }
      return res;
    } catch (err) {
      const ms = Date.now() - inicio;
      registrar('error', '✖ RED ' + metodo + ' ' + urlCorta + ' (' + ms + ' ms) — ' + err.message +
        (tamKB > 1024 * 8 ? '\n   ⚠ Enviabas ' + (tamKB / 1024).toFixed(1) + ' MB: si nginx tiene client_max_body_size menor, CORTA la conexión y el navegador lo reporta como error de red' : '') +
        '\n   (error de red = la petición nunca recibió respuesta HTTP: conexión cortada, timeout, wifi/datos, o CORS)');
      throw err;
    }
  };

  registrar('info', 'Panel de depuración activo. URL: ' + location.href);

  // ── UI del panel ──
  function crearUI() {
    // Botón flotante
    const btn = document.createElement('button');
    btn.textContent = '🐞';
    btn.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99999;width:46px;height:46px;border-radius:50%;border:2px solid #555;background:#111;font-size:20px;box-shadow:0 2px 10px rgba(0,0,0,.5);cursor:pointer';

    // Panel
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:45vh;z-index:99998;background:rgba(10,10,10,.96);border-top:2px solid #444;display:none;flex-direction:column;font-family:monospace;font-size:11px';

    const barra = document.createElement('div');
    barra.style.cssText = 'display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid #333;align-items:center';
    barra.innerHTML = '<strong style="color:#fff;flex:1">DEPURACIÓN (' + location.hostname + ')</strong>';

    const btnCopiar = document.createElement('button');
    btnCopiar.textContent = 'COPIAR';
    btnCopiar.style.cssText = 'padding:4px 10px;background:#333;color:#fff;border:1px solid #555;font-size:10px';
    btnCopiar.onclick = function () {
      const todo = logs.map(function (l) { return '[' + l.t + '][' + l.nivel + '] ' + l.texto; }).join('\n');
      if (navigator.clipboard) navigator.clipboard.writeText(todo).then(function () { btnCopiar.textContent = '✓ COPIADO'; setTimeout(function () { btnCopiar.textContent = 'COPIAR'; }, 1500); });
    };

    const btnLimpiar = document.createElement('button');
    btnLimpiar.textContent = 'LIMPIAR';
    btnLimpiar.style.cssText = btnCopiar.style.cssText;
    btnLimpiar.onclick = function () { logs.length = 0; panelBody.innerHTML = ''; };

    barra.appendChild(btnCopiar);
    barra.appendChild(btnLimpiar);

    panelBody = document.createElement('div');
    panelBody.style.cssText = 'flex:1;overflow-y:auto;padding:6px 10px;-webkit-overflow-scrolling:touch';
    logs.forEach(pintarEntrada);

    panel.appendChild(barra);
    panel.appendChild(panelBody);

    btn.onclick = function () {
      const abierto = panel.style.display === 'flex';
      panel.style.display = abierto ? 'none' : 'flex';
    };

    document.body.appendChild(btn);
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', crearUI);
  else crearUI();
})();
