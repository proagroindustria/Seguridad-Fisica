// ═══════════════════════════════════════════════════
// DOCUMENTOS.JS — Subida y gestión de documentos
// ═══════════════════════════════════════════════════

let docArchivosEnCola = [];
let docVistaActual    = 'empresas'; // 'empresas' | nombre de empresa

// ─── HELPERS ─────────────────────────────────────
function docEstadoBadge(estado) {
  const map = {
    pendiente:  { color: '#f59e0b', label: 'Pendiente' },
    aprobado:   { color: '#22c55e', label: 'Aprobado'  },
    rechazado:  { color: '#ef4444', label: 'Rechazado' },
  };
  const s = map[estado] || map.pendiente;
  return `<span style="font-size:11px;padding:2px 8px;border:1px solid ${s.color};color:${s.color};font-family:'Barlow Condensed',sans-serif;letter-spacing:1px">${s.label.toUpperCase()}</span>`;
}

function docTipoLabel(tipo) {
  return tipo || '';
}

function docFecha(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-MX', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

// ─── CONTRATISTA: Mis Documentos ─────────────────
async function abrirMisDocumentos() {
  document.getElementById('modalMisDocumentos').classList.add('open');
  document.body.style.overflow = 'hidden';
  docArchivosEnCola = [];
  document.getElementById('docColaUpload').style.display = 'none';
  document.getElementById('docProgreso').style.display   = 'none';
  await cargarMisDocumentos();
}

function cerrarMisDocumentos() {
  document.getElementById('modalMisDocumentos').classList.remove('open');
  document.body.style.overflow = '';
}

async function cargarMisDocumentos() {
  const lista = document.getElementById('docListaContratista');
  lista.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-3);font-size:13px">Cargando...</div>';
  try {
    const r = await fetch('/documentos/mis-documentos');
    const d = await r.json();
    if (!d.success) throw new Error(d.error);

    const docs = d.data.filter(doc => doc.doc_type !== 'IMSS');
    if (!docs.length) {
      lista.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3);font-size:13px">No has subido documentos aún.</div>';
      return;
    }

    lista.innerHTML = docs.map(doc => `
      <div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border);gap:16px">
        <div style="width:44px;height:44px;background:var(--dark-3);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:22px;height:22px;color:var(--accent)">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14,2 14,8 20,8"/>
          </svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:14px;color:var(--text);letter-spacing:0.5px">
            ${docTipoLabel(doc.doc_type)} &nbsp; ${docEstadoBadge(doc.estado_validacion)}
          </div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px;font-family:'Share Tech Mono',monospace">${docFecha(doc.created_at)}</div>
          ${doc.observaciones ? `<div style="font-size:11px;color:var(--warning);margin-top:3px">Obs: ${doc.observaciones}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button onclick="verDetalleDoc(${doc.id})"
            style="padding:6px 12px;background:transparent;border:1px solid var(--border);color:var(--text-2);font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer">
            VER
          </button>
          ${doc.estado_validacion !== 'aprobado' ? `
          <button onclick="resubirDoc(${doc.id})"
            style="padding:6px 12px;background:transparent;border:1px solid var(--warning);color:var(--warning);font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer">
            ACTUALIZAR
          </button>
          <button onclick="eliminarDoc(${doc.id})"
            style="padding:6px 12px;background:transparent;border:1px solid var(--danger);color:var(--danger);font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer">
            ELIMINAR
          </button>` : ''}
        </div>
      </div>
    `).join('');
  } catch(e) {
    lista.innerHTML = `<div style="color:var(--danger);padding:20px">Error: ${e.message}</div>`;
  }
}

// ─── DRAG & DROP ──────────────────────────────────

function docDragOver(e) {
  e.preventDefault();
  document.getElementById('docDropZone').style.borderColor = 'var(--accent)';
}

function docDragLeave() {
  document.getElementById('docDropZone').style.borderColor = 'var(--border)';
}

function docDrop(e) {
  e.preventDefault();
  docDragLeave();
  docProcesarArchivos(e.dataTransfer.files);
}

function docFilesSeleccionados(files) {
  docProcesarArchivos(files);
}

function docProcesarArchivos(files) {
  const MAX_MB = 10;
  for (const file of files) {
    if (file.size > MAX_MB * 1024 * 1024) {
      alert(`"${file.name}" supera los ${MAX_MB} MB.`);
      continue;
    }
    const allowed = ['image/jpeg','image/png','image/webp','application/pdf'];
    if (!allowed.includes(file.type)) {
      alert(`"${file.name}" no es un formato permitido.`);
      continue;
    }
    docArchivosEnCola.push({ file, tipo: 'DOC' });
  }
  docRenderCola();
}

function docRenderCola() {
  const zona  = document.getElementById('docColaUpload');
  const items = document.getElementById('docColaItems');
  if (!docArchivosEnCola.length) { zona.style.display = 'none'; return; }
  zona.style.display = 'block';
  items.innerHTML = docArchivosEnCola.map((item,i) => {
    const f = item.file || item;
    const esIMSS = item.tipo === 'IMSS';
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px;background:var(--dark-3);margin-bottom:4px">
      ${esIMSS ? '<span style="font-size:10px;padding:2px 6px;border:1px solid #3b82f6;color:#3b82f6;font-family:Barlow Condensed,sans-serif">IMSS</span>' : ''}
      <span style="font-family:'Share Tech Mono',monospace;font-size:12px;color:var(--text-2);flex:1">${f.name}</span>
      <span style="font-size:11px;color:var(--text-3)">${(f.size/1024/1024).toFixed(2)} MB</span>
      <button onclick="docQuitarArchivo(${i})" 
        style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;line-height:1">×</button>
    </div>`;
  }).join('');
}

function docQuitarArchivo(i) {
  docArchivosEnCola.splice(i, 1);
  docRenderCola();
}

// ─── IMSS FILE HANDLER ───────────────────────────
function docImssSeleccionado(files) {
  if (!files[0]) return;
  const file = files[0];
  if (file.size > 10 * 1024 * 1024) { alert('Archivo demasiado grande (máx 10 MB)'); return; }
  // Agregar con tipo IMSS
  docArchivosEnCola.push({ file, tipo: 'IMSS' });
  docRenderCola();
}

// ─── SUBIR DOCUMENTOS ────────────────────────────
async function subirDocumentos() {
  if (!docArchivosEnCola.length) return;
  const progreso = document.getElementById('docProgreso');
  progreso.style.display = 'block';
  progreso.textContent   = 'Procesando archivos...';

  const archivosData = [];
  for (const item of docArchivosEnCola) {
    const file = item.file || item;
    const tipo = item.tipo || 'DOC';
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    archivosData.push({ nombre: file.name, mime: file.type, base64, tipo });
  }

  progreso.textContent = `Subiendo ${archivosData.length} archivo(s)...`;

  try {
    const resp = await fetch('/documentos/subir', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ archivos: archivosData }),
    });
    const data = await resp.json();

    const ok  = data.data.filter(d => d.ok).length;
    const err = data.data.filter(d => !d.ok).length;
    progreso.textContent = `✅ ${ok} subido(s)${err ? ` — ⚠️ ${err} error(es)` : ''}. La IA procesará los documentos automáticamente.`;

    docArchivosEnCola = [];
    docRenderCola();
    document.getElementById('docFileInput').value = '';
    await cargarMisDocumentos();
  } catch(e) {
    progreso.textContent = '❌ Error al subir: ' + e.message;
  }
}

// ─── ELIMINAR DOC ─────────────────────────────────
async function eliminarDoc(id) {
  if (!confirm('¿Eliminar este documento? Esta acción no se puede deshacer.')) return;
  try {
    const r = await fetch(`/documentos/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    await cargarMisDocumentos();
  } catch(e) {
    alert('Error: ' + e.message);
  }
}

// ─── RESUBIR DOC ─────────────────────────────────
function resubirDoc(id) {
  const input = document.createElement('input');
  input.type    = 'file';
  input.accept  = '.jpg,.jpeg,.png,.webp,.pdf';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('Archivo demasiado grande (máx 10 MB)'); return; }
    const base64 = await new Promise((res,rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    try {
      const resp = await fetch(`/documentos/${id}/resubir`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ base64, mime: file.type, nombre: file.name }),
      });
      const d = await resp.json();
      if (!d.success) throw new Error(d.error);
      alert('Documento actualizado. La IA lo procesará nuevamente.');
      await cargarMisDocumentos();
    } catch(e) {
      alert('Error: ' + e.message);
    }
  };
  input.click();
}

// ─── VER DETALLE DOC ─────────────────────────────
async function verDetalleDoc(id) {
  document.getElementById('modalDetalleDoc').classList.add('open');
  document.getElementById('detalleDocBody').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3)">Cargando...</div>';

  try {
    const r = await fetch(`/documentos/${id}`);
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    const doc = d.data;

    document.getElementById('detalleDocTitulo').textContent = doc.doc_type || 'Documento';

    const campos = doc.extracted_json
      ? Object.entries(doc.extracted_json)
          .filter(([k]) => k !== 'tipo_documento')
          .map(([k, v]) => {
            const val = typeof v === 'object' ? JSON.stringify(v) : (v ?? '—');
            return `<tr>
              <td style="color:var(--text-3);padding:6px 12px 6px 0;font-size:12px;font-family:'Barlow Condensed',sans-serif;letter-spacing:0.5px;white-space:nowrap">${k.replace(/_/g,' ').toUpperCase()}</td>
              <td style="color:var(--text);padding:6px 0;font-size:13px">${val}</td>
            </tr>`;
          }).join('')
      : '<tr><td colspan="2" style="color:var(--text-3);padding:12px 0">La IA aún no ha procesado este documento.</td></tr>';

    const etapasHtml = doc.etapas?.map(e => `
      <div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:10px;padding:2px 6px;border:1px solid ${e.status==='ok'?'var(--success)':'var(--danger)'};color:${e.status==='ok'?'var(--success)':'var(--danger)'}">
          ${e.status.toUpperCase()}
        </span>
        <span style="font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;color:var(--text-2)">${e.etapa.toUpperCase()}</span>
        <span style="font-size:11px;color:var(--text-3);flex:1">${e.detalle||''}</span>
        <span style="font-size:10px;color:var(--text-3);font-family:'Share Tech Mono',monospace">${docFecha(e.created_at)}</span>
      </div>`).join('') || '<div style="color:var(--text-3);font-size:12px">Sin etapas registradas.</div>';

    document.getElementById('detalleDocBody').innerHTML = `
      ${doc.image_base64 ? `
      <div style="margin-bottom:20px;text-align:center">
        <img src="data:${doc.image_mime};base64,${doc.image_base64}"
          style="max-width:100%;max-height:280px;border:1px solid var(--border);object-fit:contain">
      </div>` : ''}

      <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
        ${docEstadoBadge(doc.estado_validacion)}
        <span style="font-size:11px;color:var(--text-3);font-family:'Share Tech Mono',monospace">${docFecha(doc.created_at)}</span>
        ${doc.validado_por ? `<span style="font-size:11px;color:var(--text-3)">Validado por: ${doc.validado_por}</span>` : ''}
      </div>

      ${doc.observaciones ? `
      <div style="padding:10px;border-left:3px solid var(--warning);background:rgba(245,158,11,0.08);margin-bottom:16px;font-size:12px;color:var(--warning)">
        ${doc.observaciones}
      </div>` : ''}

      <div style="margin-bottom:20px">
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;color:var(--text-3);margin-bottom:8px">DATOS EXTRAÍDOS</div>
        <table style="width:100%;border-collapse:collapse">${campos}</table>
      </div>

      <div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;color:var(--text-3);margin-bottom:8px">TRAZABILIDAD</div>
        ${etapasHtml}
      </div>

      ${window._userRol === 'seguridad_fisica' ? `
      <div id="docValidarPanel" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;color:var(--text-3);margin-bottom:8px">VALIDACIÓN</div>
        <textarea id="docObsInput" placeholder="Observaciones (requerido si rechaza)..."
          style="width:100%;min-height:60px;background:var(--dark-3);border:1px solid var(--border);color:var(--text);padding:10px;font-size:13px;margin-bottom:10px;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:10px">
          <button onclick="validarDocumento(${doc.id},'aprobado')"
            style="flex:1;padding:10px;background:var(--success);color:#000;border:none;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;letter-spacing:1px;cursor:pointer">
            ✓ APROBAR
          </button>
          <button onclick="validarDocumento(${doc.id},'rechazado')"
            style="flex:1;padding:10px;background:var(--danger);color:#fff;border:none;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;letter-spacing:1px;cursor:pointer">
            ✗ RECHAZAR
          </button>
        </div>
      </div>` : ''}
    `;
  } catch(e) {
    document.getElementById('detalleDocBody').innerHTML = `<div style="color:var(--danger);padding:20px">Error: ${e.message}</div>`;
  }
}

function cerrarDetalleDoc() {
  document.getElementById('modalDetalleDoc').classList.remove('open');
  document.body.style.overflow = '';
}

// ─── SEGURIDAD FÍSICA: Documentos por empresa ────
async function abrirDocumentosEmpresa() {
  docVistaActual = 'empresas';
  document.getElementById('modalDocumentosEmpresa').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('docEmpresaTitulo').textContent = 'Documentos por Empresa';
  await cargarListaEmpresas();
}

function cerrarDocumentosEmpresa() {
  cerrarDocumentosEmpresaBtn();
}
function cerrarDocumentosEmpresaBtn() {
  document.getElementById('modalDocumentosEmpresa').classList.remove('open');
  document.body.style.overflow = '';
}

async function cargarListaEmpresas() {
  const body = document.getElementById('docEmpresaBody');
  body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3)">Cargando empresas...</div>';
  try {
    const r = await fetch('/documentos/empresas/lista');
    const d = await r.json();
    if (!d.success) throw new Error(d.error);

    if (!d.data.length) {
      body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3)">No hay empresas con documentos.</div>';
      return;
    }

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">
        ${d.data.map(emp => `
          <div onclick="verDocumentosDeEmpresa('${encodeURIComponent(emp.empresa)}')"
            style="padding:16px;border:1px solid var(--border);cursor:pointer;transition:border-color 0.15s"
            onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
            <div style="font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700;color:var(--text);margin-bottom:10px">
              ${emp.empresa}
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <span style="font-size:11px;color:var(--text-3)">${emp.total} total</span>
              ${emp.pendientes > 0 ? `<span style="font-size:11px;color:var(--warning)">${emp.pendientes} pendiente(s)</span>` : ''}
              ${emp.aprobados > 0  ? `<span style="font-size:11px;color:var(--success)">${emp.aprobados} aprobado(s)</span>` : ''}
              ${emp.rechazados > 0 ? `<span style="font-size:11px;color:var(--danger)">${emp.rechazados} rechazado(s)</span>` : ''}
            </div>
            <div style="font-size:10px;color:var(--text-3);margin-top:8px;font-family:'Share Tech Mono',monospace">
              Último: ${docFecha(emp.ultimo_doc)}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch(e) {
    body.innerHTML = `<div style="color:var(--danger);padding:20px">Error: ${e.message}</div>`;
  }
}

async function verDocumentosDeEmpresa(empresaEncoded) {
  const empresa = decodeURIComponent(empresaEncoded);
  docVistaActual = empresa;
  document.getElementById('docEmpresaTitulo').textContent = empresa;
  const body = document.getElementById('docEmpresaBody');
  body.innerHTML = `
    <button onclick="cargarListaEmpresas();document.getElementById('docEmpresaTitulo').textContent='Documentos por Empresa'"
      style="background:none;border:none;color:var(--accent);font-family:'Barlow Condensed',sans-serif;font-size:13px;letter-spacing:1px;cursor:pointer;margin-bottom:16px;padding:0">
      ← VOLVER A EMPRESAS
    </button>
    <div id="docEmpresaDocList"><div style="text-align:center;padding:30px;color:var(--text-3)">Cargando...</div></div>
  `;
  try {
    const r = await fetch(`/documentos/empresa/${empresaEncoded}`);
    const d = await r.json();
    if (!d.success) throw new Error(d.error);

    const lista = document.getElementById('docEmpresaDocList');
    if (!d.data.length) {
      lista.innerHTML = '<div style="color:var(--text-3);padding:20px">Esta empresa no tiene documentos.</div>';
      return;
    }

    lista.innerHTML = d.data.map(doc => `
      <div style="display:flex;align-items:center;gap:14px;padding:12px;border-bottom:1px solid var(--border)">
        <div style="width:44px;height:44px;background:var(--dark-3);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:22px;height:22px;color:var(--accent)">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14,2 14,8 20,8"/>
          </svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:14px;color:var(--text)">
            ${docTipoLabel(doc.doc_type)} &nbsp; ${docEstadoBadge(doc.estado_validacion)}
          </div>
          <div style="font-size:11px;color:var(--text-3);font-family:'Share Tech Mono',monospace">${docFecha(doc.created_at)}</div>
        </div>
        <button onclick="verDetalleDoc(${doc.id})"
          style="padding:6px 14px;background:transparent;border:1px solid var(--border);color:var(--text-2);font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer;flex-shrink:0">
          VER / VALIDAR
        </button>
      </div>
    `).join('');
  } catch(e) {
    document.getElementById('docEmpresaDocList').innerHTML = `<div style="color:var(--danger)">${e.message}</div>`;
  }
}

// ─── VALIDAR DOCUMENTO (Seguridad Física) ─────────
async function validarDocumento(id, estado) {
  const obs = document.getElementById('docObsInput')?.value || '';
  if (estado === 'rechazado' && !obs.trim()) {
    alert('Por favor agrega una observación al rechazar el documento.');
    return;
  }
  try {
    const r = await fetch(`/documentos/${id}/validar`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ estado, observaciones: obs }),
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    document.getElementById('modalDetalleDoc').classList.remove('open');
    if (docVistaActual !== 'empresas') {
      await verDocumentosDeEmpresa(encodeURIComponent(docVistaActual));
    }
  } catch(e) {
    alert('Error: ' + e.message);
  }
}


// ═══════════════════════════════════════════════════
// PESTAÑAS
// ═══════════════════════════════════════════════════
function docCambiarTab(tab) {
  const panelDocs = document.getElementById('panel-docs');
  const panelImss = document.getElementById('panel-imss');
  const tabDocs   = document.getElementById('tab-docs');
  const tabImss   = document.getElementById('tab-imss');

  if (tab === 'docs') {
    panelDocs.style.display = 'flex';
    panelImss.style.display = 'none';
    tabDocs.style.borderBottomColor = 'var(--accent)';
    tabDocs.style.color = 'var(--accent)';
    tabImss.style.borderBottomColor = 'transparent';
    tabImss.style.color = 'var(--text-3)';
  } else {
    panelDocs.style.display = 'none';
    panelImss.style.display = 'flex';
    tabImss.style.borderBottomColor = '#3b82f6';
    tabImss.style.color = '#3b82f6';
    tabDocs.style.borderBottomColor = 'transparent';
    tabDocs.style.color = 'var(--text-3)';
    cargarListaIMSS();
  }
}

// ═══════════════════════════════════════════════════
// IMSS — Subida y lista
// ═══════════════════════════════════════════════════
let imssArchivosEnCola = [];

function imssDragOver(e) {
  e.preventDefault();
  document.getElementById('imssDropZone').style.borderColor = '#60a5fa';
}
function imssDragLeave() {
  document.getElementById('imssDropZone').style.borderColor = '#3b82f6';
}
function imssDrop(e) {
  e.preventDefault();
  imssDragLeave();
  docImssSeleccionado(e.dataTransfer.files);
}

function docImssSeleccionado(files) {
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) { alert(`"${file.name}" supera 10 MB`); continue; }
    imssArchivosEnCola.push(file);
  }
  imssRenderCola();
}

function imssRenderCola() {
  const zona  = document.getElementById('imssColaUpload');
  const items = document.getElementById('imssColaItems');
  if (!imssArchivosEnCola.length) { zona.style.display = 'none'; return; }
  zona.style.display = 'block';
  items.innerHTML = imssArchivosEnCola.map((f, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px;background:var(--dark-3);margin-bottom:4px">
      <span style="font-family:'Share Tech Mono',monospace;font-size:12px;color:var(--text-2);flex:1">${f.name}</span>
      <span style="font-size:11px;color:var(--text-3)">${(f.size/1024/1024).toFixed(2)} MB</span>
      <button onclick="imssQuitarArchivo(${i})" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px">×</button>
    </div>
  `).join('');
}

function imssQuitarArchivo(i) {
  imssArchivosEnCola.splice(i, 1);
  imssRenderCola();
}

async function subirIMSS() {
  if (!imssArchivosEnCola.length) return;
  const progreso = document.getElementById('imssProgreso');
  progreso.style.display = 'block';
  progreso.textContent = 'Procesando vigencia IMSS...';

  const archivosData = [];
  for (const file of imssArchivosEnCola) {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    archivosData.push({ nombre: file.name, mime: file.type, base64, tipo: 'IMSS' });
  }

  progreso.textContent = `Subiendo ${archivosData.length} documento(s) de vigencia...`;

  try {
    const resp = await fetch('/documentos/subir', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ archivos: archivosData }),
    });
    const data = await resp.json();
    const ok  = data.data.filter(d => d.ok).length;
    const err = data.data.filter(d => !d.ok).length;
    progreso.textContent = `✅ ${ok} subido(s)${err ? ` — ⚠️ ${err} error(es)` : ''}`;
    imssArchivosEnCola = [];
    imssRenderCola();
    document.getElementById('docImssInput').value = '';
    await cargarListaIMSS();
  } catch(e) {
    progreso.textContent = '❌ Error: ' + e.message;
  }
}

async function cargarListaIMSS() {
  const lista = document.getElementById('imssListaContratista');
  lista.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-3)">Cargando...</div>';
  try {
    const r = await fetch('/documentos/mis-documentos');
    const d = await r.json();
    if (!d.success) throw new Error(d.error);

    const imss = d.data.filter(doc => doc.doc_type === 'IMSS');
    if (!imss.length) {
      lista.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-3);font-size:13px">No has subido documentos de vigencia IMSS.</div>';
      return;
    }

    lista.innerHTML = imss.map(doc => {
      const vigente  = doc.extracted_json?.vigente;
      const estatus  = doc.extracted_json?.estatus || '';
      const nombre   = doc.extracted_json?.nombre_asegurado || '';
      const fechaVig = doc.extracted_json?.fecha_vigencia || '';
      const nss      = doc.extracted_json?.nss || '';

      const badge = vigente === true
        ? '<span style="font-size:11px;padding:2px 8px;border:1px solid var(--success);color:var(--success)">✓ VIGENTE</span>'
        : vigente === false
        ? '<span style="font-size:11px;padding:2px 8px;border:1px solid var(--danger);color:var(--danger)">✗ NO VIGENTE</span>'
        : '<span style="font-size:11px;padding:2px 8px;border:1px solid var(--warning);color:var(--warning)">Procesando...</span>';

      return `
      <div style="padding:14px;border-bottom:1px solid var(--border);display:flex;gap:14px;align-items:center">
        <div style="width:40px;height:40px;background:#1e3a5f;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">🏥</div>
        <div style="flex:1">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
            ${badge}
            ${nombre ? `<span style="font-family:'Barlow Condensed',sans-serif;font-size:14px;color:var(--text)">${nombre}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--text-3);font-family:'Share Tech Mono',monospace">
            ${nss ? `NSS: ${nss}` : ''} ${fechaVig ? `· Vigencia: ${fechaVig}` : ''} · ${docFecha(doc.created_at)}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button onclick="verDetalleDoc(${doc.id})"
            style="padding:6px 12px;background:transparent;border:1px solid var(--border);color:var(--text-2);font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer">
            VER
          </button>
          <button onclick="eliminarDoc(${doc.id})"
            style="padding:6px 12px;background:transparent;border:1px solid var(--danger);color:var(--danger);font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer">
            ELIMINAR
          </button>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    lista.innerHTML = `<div style="color:var(--danger);padding:20px">Error: ${e.message}</div>`;
  }
}


// ═══════════════════════════════════════════════════
// PERSONAL — Mi Personal (Contratista) y Todo Personal (Seguridad)
// ═══════════════════════════════════════════════════

function personalEstatusBadge(estatus, activo) {
  if (activo) return '<span style="font-size:11px;padding:2px 8px;border:1px solid var(--success);color:var(--success)">ACTIVO</span>';
  const map = {
    no_activo: { color: 'var(--text-3)', label: 'NO ACTIVO' },
    documentos_pendientes: { color: 'var(--warning)', label: 'DOCS PENDIENTES' },
    documentos_validados:  { color: 'var(--info)',    label: 'DOCS VALIDADOS'  },
    rechazado:             { color: 'var(--danger)',  label: 'RECHAZADO'        },
  };
  const s = map[estatus] || map.no_activo;
  return `<span style="font-size:11px;padding:2px 8px;border:1px solid ${s.color};color:${s.color}">${s.label}</span>`;
}

function renderTablaPersonal(data, containerId) {
  const body = document.getElementById(containerId);
  if (!data.length) {
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3)">No hay personal registrado.</div>';
    return;
  }

  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:var(--black);border-bottom:2px solid var(--accent)">
          <th style="padding:10px 14px;text-align:left;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;color:#aaa">#</th>
          <th style="padding:10px 14px;text-align:left;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;color:#aaa">NOMBRE</th>
          <th style="padding:10px 14px;text-align:left;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;color:#aaa">EMPRESA</th>
          <th style="padding:10px 14px;text-align:left;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;color:#aaa">CARGO</th>
          <th style="padding:10px 14px;text-align:left;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;color:#aaa">IMSS</th>
          <th style="padding:10px 14px;text-align:left;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;color:#aaa">ESTATUS</th>
          <th style="padding:10px 14px;text-align:left;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;color:#aaa">DOCS</th>
          <th style="padding:10px 14px;text-align:left;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;color:#aaa">REGISTRO</th>
          <th style="padding:10px 14px;text-align:left;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;color:#aaa"></th>
        </tr>
      </thead>
      <tbody>
        ${data.map((e, i) => {
          const imss = e.imss_vigente === true
            ? '<span style="color:var(--success);font-size:11px">✓ VIGENTE</span>'
            : e.imss_vigente === false
            ? '<span style="color:var(--danger);font-size:11px">✗ NO VIGENTE</span>'
            : '<span style="color:var(--text-3);font-size:11px">—</span>';
          const fecha = e.creado_en ? new Date(e.creado_en).toLocaleDateString('es-MX') : '—';
          return `<tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--bg-3)'" onmouseout="this.style.background=''">
            <td style="padding:10px 14px;color:var(--text-3);font-family:'Share Tech Mono',monospace">${i+1}</td>
            <td style="padding:10px 14px;font-weight:500;color:var(--text)">${e.nombre} ${e.apellido}</td>
            <td style="padding:10px 14px;color:var(--text-2)">${e.empresa || '—'}</td>
            <td style="padding:10px 14px;color:var(--text-2)">${e.cargo || '—'}</td>
            <td style="padding:10px 14px">${imss}</td>
            <td style="padding:10px 14px">${personalEstatusBadge(e.estatus, e.activo)}</td>
            <td style="padding:10px 14px;color:var(--text-3);font-family:'Share Tech Mono',monospace">${e.total_docs || 0}</td>
            <td style="padding:10px 14px;color:var(--text-3);font-size:11px;font-family:'Share Tech Mono',monospace">${fecha}</td>
            <td style="padding:10px 14px">
              <button onclick="verDocsEmpleado(${e.id},'${e.nombre} ${e.apellido}')"
                style="padding:5px 12px;background:transparent;border:1px solid var(--accent);color:var(--accent);font-family:'Barlow Condensed',sans-serif;font-size:11px;letter-spacing:1px;cursor:pointer">
                VER
              </button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ─── Ver documentos de un empleado ───────────────
async function verDocsEmpleado(empleadoId, nombreEmpleado) {
  // Crear modal dinámico
  let modal = document.getElementById('modalDocsEmpleado');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modalDocsEmpleado';
    modal.className = 'modal-overlay';
    modal.style.zIndex = '9999';
    document.body.appendChild(modal);
  }
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:700px;max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-header">
        <div>
          <p class="modal-eyebrow">DOCUMENTOS</p>
          <h2 class="modal-title">${nombreEmpleado}</h2>
        </div>
        <button class="modal-close" onclick="document.getElementById('modalDocsEmpleado').classList.remove('open');document.body.style.overflow=''">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:20px 28px 28px" id="docsEmpleadoBody">
        <div style="text-align:center;padding:30px;color:var(--text-3)">Cargando...</div>
      </div>
    </div>`;

  try {
    const r = await fetch(`/documentos/por-empleado/${empleadoId}`);
    const d = await r.json();
    if (!d.success) throw new Error(d.error);

    const body = document.getElementById('docsEmpleadoBody');
    if (!d.data.length) {
      body.innerHTML = '<div style="color:var(--text-3);padding:20px;text-align:center">Sin documentos registrados.</div>';
      return;
    }

    body.innerHTML = d.data.map(doc => {
      const esIMSS = doc.doc_type === 'IMSS';
      const vigente = doc.extracted_json?.vigente;
      const nombre_asegurado = doc.extracted_json?.nombre_asegurado || '';
      const nombre_doc = doc.extracted_json?.nombre || '';
      const fecha_vig = doc.extracted_json?.fecha_vigencia || '';
      const curp = doc.extracted_json?.curp || '';

      let info = '';
      if (esIMSS) {
        info = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-top:6px">
            <div><span style="color:var(--text-3);font-size:10px">NOMBRE ASEGURADO</span><br><span style="color:var(--text)">${doc.extracted_json?.nombre_asegurado || '—'}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">NSS</span><br><span style="color:var(--text)">${doc.extracted_json?.nss || '—'}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">ESTATUS</span><br><span style="color:${vigente ? 'var(--success)' : 'var(--danger)'}">${doc.extracted_json?.estatus || '—'}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">VIGENCIA HASTA</span><br><span style="color:var(--text)">${fecha_vig || '—'}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">CLÍNICA</span><br><span style="color:var(--text)">${doc.extracted_json?.clinica || '—'}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">DELEGACIÓN</span><br><span style="color:var(--text)">${doc.extracted_json?.delegacion || '—'}</span></div>
          </div>`;
      } else {
        const ext = doc.extracted_json || {};
        info = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-top:6px">
            <div><span style="color:var(--text-3);font-size:10px">NOMBRE</span><br><span style="color:var(--text)">${ext.nombre || '—'} ${ext.apellido_paterno || ''} ${ext.apellido_materno || ''}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">CURP</span><br><span style="color:var(--text);font-family:'Share Tech Mono',monospace;font-size:11px">${ext.curp || '—'}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">FECHA NACIMIENTO</span><br><span style="color:var(--text)">${ext.fecha_nacimiento || '—'}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">SEXO</span><br><span style="color:var(--text)">${ext.sexo || '—'}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">CLAVE ELECTOR</span><br><span style="color:var(--text);font-family:'Share Tech Mono',monospace;font-size:11px">${ext.clave_elector || '—'}</span></div>
            <div><span style="color:var(--text-3);font-size:10px">VIGENCIA</span><br><span style="color:var(--text)">${ext.vigencia || '—'}</span></div>
            <div style="grid-column:1/-1"><span style="color:var(--text-3);font-size:10px">DOMICILIO</span><br><span style="color:var(--text)">${ext.domicilio ? Object.values(ext.domicilio).filter(Boolean).join(', ') : (ext.dom_calle ? [ext.dom_calle, ext.dom_numero, ext.dom_colonia, ext.dom_municipio, ext.dom_estado, ext.dom_cp].filter(Boolean).join(', ') : '—')}</span></div>
          </div>`;
      }

      const badgeColor = doc.estado_validacion === 'aprobado' ? 'var(--success)' : doc.estado_validacion === 'rechazado' ? 'var(--danger)' : 'var(--warning)';

      return `
      <div style="padding:14px;border:1px solid var(--border);margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="display:flex;gap:8px;align-items:center">
            <span style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;color:var(--text)">${doc.doc_type || ''}</span>
            <span style="font-size:11px;padding:2px 8px;border:1px solid ${badgeColor};color:${badgeColor}">${doc.estado_validacion?.toUpperCase()}</span>
          </div>
          <span style="font-size:11px;color:var(--text-3);font-family:'Share Tech Mono',monospace">${docFecha(doc.created_at)}</span>
        </div>
        ${info}
        ${doc.image_base64 ? `
        <img src="data:${doc.image_mime};base64,${doc.image_base64}"
          style="max-width:100%;max-height:180px;object-fit:contain;border:1px solid var(--border);display:block;margin-bottom:10px">` : ''}
        ${doc.estado_validacion !== 'aprobado' ? `
        <div style="display:flex;gap:8px">
          <button onclick="reemplazarDocEmpleado(${doc.id},'${esIMSS ? 'imss' : 'cred'}',${empleadoId},'${nombreEmpleado}')"
            style="padding:6px 14px;background:transparent;border:1px solid var(--warning);color:var(--warning);font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;cursor:pointer">
            ↺ REEMPLAZAR
          </button>
        </div>` : ''}
      </div>`;
    }).join('');
  } catch(e) {
    document.getElementById('docsEmpleadoBody').innerHTML = `<div style="color:var(--danger)">${e.message}</div>`;
  }
}

// ─── Reemplazar documento de empleado ────────────
function reemplazarDocEmpleado(docId, tipo, empleadoId, nombreEmpleado) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.jpg,.jpeg,.png,.webp,.pdf';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const body = document.getElementById('docsEmpleadoBody');
    const statusDiv = document.createElement('div');
    statusDiv.style.cssText = 'padding:10px;background:var(--bg-3);border:1px solid var(--border);margin-bottom:10px;font-family:Share Tech Mono,monospace;font-size:12px;color:var(--accent)';
    statusDiv.textContent = '⏳ Procesando con IA...';
    body.prepend(statusDiv);

    try {
      const base64 = await fileToBase64(file);
      const endpoint = tipo === 'imss' ? '/documentos/procesar-imss' : '/documentos/procesar-doc';
      const rProc = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mime: file.type, nombre: file.name })
      }).then(r => r.json());

      if (!rProc.success) throw new Error(rProc.error);
      statusDiv.textContent = '⏳ Guardando...';

      const rSave = await fetch(`/documentos/${docId}/resubir`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mime: file.type, nombre: file.name })
      }).then(r => r.json());

      if (!rSave.success) throw new Error(rSave.error);
      statusDiv.textContent = '✅ Documento actualizado';
      statusDiv.style.color = 'var(--success)';
      setTimeout(() => verDocsEmpleado(empleadoId, nombreEmpleado), 1200);
    } catch(e) {
      statusDiv.textContent = '❌ Error: ' + e.message;
      statusDiv.style.color = 'var(--danger)';
    }
  };
  input.click();
}

async function abrirMiPersonal() {
  document.getElementById('modalMiPersonal').classList.add('open');
  document.body.style.overflow = 'hidden';
  const body = document.getElementById('miPersonalBody');
  body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3)">Cargando...</div>';
  try {
    const r = await fetch('/facial/mi-personal');
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    renderTablaPersonal(d.data, 'miPersonalBody');
  } catch(e) {
    body.innerHTML = `<div style="color:var(--danger);padding:20px">Error: ${e.message}</div>`;
  }
}

async function abrirTodoPersonal(empresaFiltro = '') {
  document.getElementById('modalTodoPersonal').classList.add('open');
  document.body.style.overflow = 'hidden';
  const body = document.getElementById('todoPersonalBody');
  body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3)">Cargando...</div>';
  try {
    const r = await fetch('/facial/todo-personal');
    const d = await r.json();
    if (!d.success) throw new Error(d.error);

    // Obtener empresas únicas
    const empresas = [...new Set(d.data.map(e => e.empresa).filter(Boolean))];

    // Filtro por empresa
    const filtroHTML = empresas.length > 1 ? `
      <div style="margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--text-3);font-family:'Share Tech Mono',monospace;letter-spacing:1px">FILTRAR POR EMPRESA:</span>
        <button onclick="filtrarPersonal('')" id="filtro-todas"
          style="padding:4px 12px;font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;border:1px solid var(--accent);background:var(--accent-dim);color:var(--accent);cursor:pointer">
          TODAS
        </button>
        ${empresas.map(emp => `
          <button onclick="filtrarPersonal('${emp}')"
            style="padding:4px 12px;font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;border:1px solid var(--border);background:transparent;color:var(--text-2);cursor:pointer">
            ${emp}
          </button>`).join('')}
      </div>` : '';

    window._todoPersonalData = d.data;
    body.innerHTML = filtroHTML + '<div id="todoPersonalTabla"></div>';
    renderTablaPersonal(d.data, 'todoPersonalTabla');
  } catch(e) {
    body.innerHTML = `<div style="color:var(--danger);padding:20px">Error: ${e.message}</div>`;
  }
}

function filtrarPersonal(empresa) {
  const data = empresa
    ? window._todoPersonalData.filter(e => e.empresa === empresa)
    : window._todoPersonalData;
  renderTablaPersonal(data, 'todoPersonalTabla');
}

function verImgDoc(src) {
  const prev = document.getElementById('imgDocOverlay');
  if (prev) prev.remove();
  const overlay = document.createElement('div');
  overlay.id = 'imgDocOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center';
  const btn = document.createElement('button');
  btn.textContent = '✕';
  btn.style.cssText = 'position:fixed;top:20px;right:20px;width:36px;height:36px;background:#f5a623;color:#000;border:none;border-radius:50%;font-size:18px;font-weight:700;cursor:pointer;z-index:99999;display:flex;align-items:center;justify-content:center';
  btn.onclick = () => overlay.remove();
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:90%;max-height:90vh;object-fit:contain;border:2px solid #f5a623;display:block;cursor:zoom-out';
  img.onclick = () => overlay.remove();
  overlay.appendChild(btn);
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  if (window._imgEscHandler) document.removeEventListener('keydown', window._imgEscHandler);
  function escHandler(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
  }
  window._imgEscHandler = escHandler;
  document.addEventListener('keydown', escHandler);
}