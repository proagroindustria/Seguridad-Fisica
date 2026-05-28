// =====================================================
// NOTIFICACIONES — Seguridad Física
// Personas 4+ días sin checar con permiso activo
// Requiere: window.USER_ROL definido antes de cargar este script
// =====================================================

(function () {
  if (typeof USER_ROL === 'undefined' || USER_ROL !== 'seguridad_fisica') return;

  function escHtml(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let panelAbierto = false;

  async function cargarNotificaciones() {
    const badge   = document.getElementById('notifBadge');
    const lista   = document.getElementById('notifLista');
    const totalEl = document.getElementById('notifTotal');
    if (!badge) return;

    try {
      const r = await fetch('/facial/notificaciones-sin-checkin');
      const d = await r.json().catch(() => ({ success: false, data: [] }));
      const items = d.success ? (d.data || []) : [];

      if (items.length === 0) {
        badge.style.display = 'none';
        if (lista)   lista.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">✅ Sin alertas.</div>';
        if (totalEl) totalEl.textContent = '0 alertas';
        return;
      }

      const html = items.map(t => {
        const ultimoTxt = t.ultimo_acceso
          ? new Date(t.ultimo_acceso).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : 'Nunca ha checado';
        return `
          <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:5px;border-left:3px solid #ef4444">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-weight:700;color:var(--text);font-size:13px;font-family:'Barlow Condensed',sans-serif;letter-spacing:0.5px">${escHtml((t.nombre || '') + ' ' + (t.apellido || ''))}</span>
            </div>
            <span style="font-size:11px;color:#ef4444;font-family:'Barlow Condensed',sans-serif;font-weight:600;letter-spacing:0.5px">⚠ No ha registrado asistencia en ${t.dias_sin_checar} día${t.dias_sin_checar !== 1 ? 's' : ''}</span>
            <span style="font-size:11px;color:var(--text-2);font-family:'Share Tech Mono',monospace">Empresa: ${escHtml(t.empresa || '—')}</span>
            <span style="font-size:11px;color:var(--text-3);font-family:'Share Tech Mono',monospace">Último checado: ${ultimoTxt}</span>
          </div>`;
      }).join('');

      badge.style.display = 'flex';
      badge.textContent = items.length > 9 ? '9+' : items.length;
      if (totalEl) totalEl.textContent = items.length + ' alerta' + (items.length !== 1 ? 's' : '');
      if (lista)   lista.innerHTML = html;
    } catch (e) {
      console.warn('Error cargando notificaciones:', e.message);
    }
  }

  window.toggleNotificaciones = function () {
    const panel = document.getElementById('notifPanel');
    if (!panel) return;
    panelAbierto = !panelAbierto;
    panel.style.display = panelAbierto ? 'block' : 'none';
    if (panelAbierto) cargarNotificaciones();
  };

  document.addEventListener('click', e => {
    const wrapper = document.getElementById('notifWrapper');
    if (wrapper && !wrapper.contains(e.target)) {
      const panel = document.getElementById('notifPanel');
      if (panel) panel.style.display = 'none';
      panelAbierto = false;
    }
  });

  cargarNotificaciones();
  setInterval(cargarNotificaciones, 5 * 60 * 1000);
})();
