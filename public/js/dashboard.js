
/* 
  =====================================================
        PROAGRO - Dashboard JS
  =====================================================
*/



/* 
  =====================================================
        PROAGRO - Dashboard JS PRUEBA DE CAMBIOS REFELJADOS
  =====================================================
*/


/* 
  =====================================================
        PROAGRO - Dashboard JS PRUEBA DE CAMBIOS REFELJADOS
  tercera prueba de cambios reflejados
        =====================================================
*/

/* 
  =====================================================
        PROAGRO - Dashboard JS PRUEBA DE CAMBIOS REFELJADOS
  cuarta prueba de cambio
        =====================================================
*/


/* 
  =====================================================
        PROAGRO - Dashboard JS PRUEBA DE CAMBIOS REFELJADOS
  quinta prueba de cambio
        =====================================================
*/


let todosSolicitudes = [];
let responsablesCache = [];
let filtroActual = 'todos';
let seccionesAgregadas = {};
let docValidacionesPersonal = {};
let dragType = null;

// ===== PASE DE VISITA =====
let _pvModalActive = false;

function isPaseVisitaActive() { return _pvModalActive; }

function onModalPaseVisitaToggle(checked) {
  _pvModalActive = checked;
  if (seccionesAgregadas['personal'] !== undefined) {
    removerSeccion('personal');
    agregarSeccion('personal');
  }
  actualizarModoPaseVisita();
}

function _pvSubmitLabel(active) {
  const svg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px"><polyline points="20,6 9,17 4,12"/></svg>`;
  return active ? `${svg} CREAR SOLICITUD` : `${svg} CREAR SOLICITUD`;
}

function actualizarModoPaseVisita() {
  const active = isPaseVisitaActive();

  const toggle = document.getElementById('togglePaseVisitaModal');
  if (toggle) toggle.checked = active;

  const modalTitle = document.querySelector('#modalSolicitud .modal-title');
  if (modalTitle) modalTitle.textContent = active ? 'Pase de Visita' : 'Nueva Solicitud de Acceso';

  const modalEyebrow = document.querySelector('#modalSolicitud .modal-eyebrow');
  if (modalEyebrow) modalEyebrow.textContent = active ? 'PASE DE VISITA' : 'CONTRATISTA';

  const btnSubmit = document.getElementById('btnSubmit');
  if (btnSubmit && !btnSubmit.disabled) btnSubmit.innerHTML = _pvSubmitLabel(active);

  // Alternar entre autocomplete y texto libre para responsable 1
  const resp1AutoGrupo = document.getElementById('resp1-autocomplete-grupo');
  const pvResp1Grupo = document.getElementById('pv-resp1-grupo');
  if (resp1AutoGrupo) resp1AutoGrupo.style.display = active ? 'none' : '';
  if (pvResp1Grupo) pvResp1Grupo.style.display = active ? '' : 'none';

  // En modo PV el teléfono es siempre visible y obligatorio
  const tel1Grupo = document.getElementById('tel1-grupo');
  if (tel1Grupo) {
    if (active) {
      tel1Grupo.style.display = 'block';
    } else {
      const resp1 = document.getElementById('responsable1')?.value || '';
      if (!resp1) tel1Grupo.style.display = 'none';
    }
  }

  // Contrato: obligatorio solo en flujo normal
  const contratoInput = document.getElementById('contrato');
  if (contratoInput) contratoInput.required = !active;
  const contratoStar = document.getElementById('contrato-required-star');
  if (contratoStar) contratoStar.style.display = active ? 'none' : '';

  // num_credencial en las filas ya existentes: obligatorio solo en flujo normal
  document.querySelectorAll('#tbody-personal .cell-input').forEach(inp => {
    if (inp.placeholder && inp.placeholder.includes('CRED')) inp.required = !active;
  });

  // Período de acceso: ocultar en PV y auto-establecer fechas
  const seccionFechas = document.getElementById('seccion-fechas');
  const pvFechaInfo = document.getElementById('pv-fecha-info');
  if (seccionFechas) seccionFechas.style.display = active ? 'none' : '';
  if (pvFechaInfo) pvFechaInfo.style.display = active ? '' : 'none';

  if (active) {
    const hoy = new Date().toISOString().split('T')[0];
    const sel = document.getElementById('pv-fecha-selector');
    if (sel) {
      sel.min = hoy;
      if (!sel.value || sel.value < hoy) sel.value = hoy;
    }
    const fi = document.getElementById('fecha_inicio');
    const ff = document.getElementById('fecha_fin');
    const fecha = sel ? sel.value : hoy;
    if (fi) fi.value = fecha;
    if (ff) ff.value = fecha;
    validateFechas();
  } else {
    const fi = document.getElementById('fecha_inicio');
    const ff = document.getElementById('fecha_fin');
    if (fi) fi.value = '';
    if (ff) ff.value = '';
    const formDias = document.getElementById('formDias');
    if (formDias) formDias.style.display = 'none';
  }
}

function onPvFechaChange(value) {
  const hoy = new Date().toISOString().split('T')[0];
  if (!value || value < hoy) {
    const sel = document.getElementById('pv-fecha-selector');
    if (sel) sel.value = hoy;
    value = hoy;
  }
  const fi = document.getElementById('fecha_inicio');
  const ff = document.getElementById('fecha_fin');
  if (fi) fi.value = value;
  if (ff) ff.value = value;
  validateFechas();
  verificarBotonSubmit();
}

function onPvResp1Input(value) {
  document.getElementById('responsable1').value = value.trim();
  verificarBotonSubmit();
}

// Contadores de filas por sección
const rowCounters = { personal: 0, vehiculo: 0, equipo: 0 };
let empleadosCache = []; // Cache de empleados enrolados
const vehicValidaciones = {};


const _personalTimeouts = {};

async function verificarPersonalOcupado(rowId, nombre) {
  if (!nombre || nombre.trim().length < 3) return;
  clearTimeout(_personalTimeouts[rowId]);
  _personalTimeouts[rowId] = setTimeout(async () => {
    try {
      const filaActual = (seccionesAgregadas['personal'] || []).find(f => f._id === rowId);
      const nss = filaActual?._nss || '';
      const credInput = document.getElementById(`inp-${rowId}-num_credencial`);
      const numCred = credInput ? credInput.value.trim() : '';
      const params = new URLSearchParams({ nombre: nombre.trim() });
      if (nss) params.append('nss', nss);
      if (numCred) params.append('num_credencial', numCred);
      const resp = await fetch(`/solicitudes/verificar-personal?${params}`);
      const data = await resp.json();
      const rowEl = document.getElementById(`row-${rowId}`);
      if (!rowEl) return;

      let avisoEl = document.getElementById(`aviso-personal-${rowId}`);
      if (!avisoEl) {
        const td = rowEl.cells[2];
        avisoEl = document.createElement('div');
        avisoEl.id = `aviso-personal-${rowId}`;
        avisoEl.style.cssText = 'font-size:11px;margin-top:3px;font-family:"Share Tech Mono",monospace';
        td.appendChild(avisoEl);
      }

      if (data.ocupado) {
        const inp = document.getElementById(`inp-${rowId}-nombre`);
        const filas = seccionesAgregadas['personal'] || [];
        const fila = filas.find(f => f._id === rowId);
        if (isPaseVisitaActive() || data.solo_nombre) {
          // Sin identificador confirmado: solo advertir, no bloquear
          avisoEl.style.color = 'var(--warning)';
          avisoEl.textContent = data.solo_nombre
            ? `⚠ Hay una persona con este nombre en ${data.folio} — selecciona del autocomplete para confirmar`
            : `⚠ Hay un ${data.folio} activo con este nombre — confirma que es otra persona`;
          if (inp) { inp.style.borderColor = 'var(--warning)'; inp.style.background = 'rgba(245,158,11,0.05)'; }
          if (fila) fila._bloqueado = false;
        } else {
          // Identificador (NSS o credencial) confirma que es la misma persona → bloquear
          avisoEl.style.color = 'var(--danger)';
          avisoEl.textContent = `⛔ Ya está en ${data.folio} (${data.estado}) · vence ${formatFecha(data.fecha_fin)}`;
          if (inp) { inp.style.borderColor = 'var(--danger)'; inp.style.background = 'rgba(239,68,68,0.05)'; }
          if (fila) fila._bloqueado = true;
        }
        verificarBotonSubmit();
      } else {
        avisoEl.textContent = '';
        const inp = document.getElementById(`inp-${rowId}-nombre`);
        if (inp) { inp.style.borderColor = ''; inp.style.background = ''; }
        const filas = seccionesAgregadas['personal'] || [];
        const fila = filas.find(f => f._id === rowId);
        if (fila) fila._bloqueado = false;
        verificarBotonSubmit();
      }
    } catch(e) {
      console.warn('Error verificando personal:', e);
    }
  }, 600);
}





function _parsearFechaDoc(str) {
  if (!str) return null;
  const partes = String(str).split('/');
  if (partes.length === 3) {
    const f = new Date(`${partes[2]}-${partes[1].padStart(2,'0')}-${partes[0].padStart(2,'0')}T00:00:00`);
    return isNaN(f.getTime()) ? null : f;
  }
  const f = new Date(str + 'T00:00:00');
  return isNaN(f.getTime()) ? null : f;
}

async function validarDocPersonal(rowId, empleadoId) {
  if (!empleadoId) return;

  // En solicitud normal los empleados ya están enrolados — no se requiere validar documento
  if (!isPaseVisitaActive()) {
    const warnEl = document.getElementById(`doc-warn-${rowId}`);
    if (warnEl) { warnEl.textContent = ''; warnEl.style.color = ''; }
    const fila = (seccionesAgregadas['personal'] || []).find(f => f._id === rowId);
    if (fila) fila._docVencido = false;
    verificarBotonSubmit();
    return;
  }

  const fechaFin = document.getElementById('fecha_fin')?.value;
  const rowEl = document.getElementById(`row-${rowId}`);
  if (!rowEl) return;

  let warnEl = document.getElementById(`doc-warn-${rowId}`);
  if (!warnEl) {
    warnEl = document.createElement('div');
    warnEl.id = `doc-warn-${rowId}`;
    warnEl.style.cssText = 'font-size:11px;margin-top:3px;font-family:"Share Tech Mono",monospace';
    rowEl.cells[2].appendChild(warnEl);
  }

  const setDocEstado = (bloqueado, msg, color) => {
    warnEl.textContent = msg;
    warnEl.style.color = color;
    const fila = (seccionesAgregadas['personal'] || []).find(f => f._id === rowId);
    if (fila) fila._docVencido = bloqueado;
    verificarBotonSubmit();
  };

  if (!fechaFin) { setDocEstado(false, '', ''); return; }

  try {
    const r = await fetch(`/documentos/por-empleado/${empleadoId}`);
    const d = await r.json();
    if (!d.success || !d.data.length) {
      // En PV, los visitantes no están en la BD — no bloquear, la validación inline es suficiente
      if (isPaseVisitaActive()) { setDocEstado(false, '', ''); return; }
      setDocEstado(true, '⚠ Sin documento de identidad — sube INE, Pasaporte o Licencia', 'var(--warning)');
      return;
    }

    const credDoc = d.data.find(doc => ['INE','PASAPORTE','LICENCIA'].includes((doc.doc_type||'').toUpperCase()));
    if (!credDoc) {
      // En PV, si el empleado no tiene credencial en BD tampoco bloqueamos
      if (isPaseVisitaActive()) { setDocEstado(false, '', ''); return; }
      setDocEstado(true, '⚠ Sin documento de identidad registrado (INE/Pasaporte/Licencia)', 'var(--warning)');
      return;
    }

    const ext = credDoc.extracted_json || {};
    const docType = (credDoc.doc_type || '').toUpperCase();
    const fechaFinDate = new Date(fechaFin + 'T00:00:00');

    if (docType === 'INE') {
      const anio = parseInt(String(ext.vigencia || '').replace(/\D/g,'').slice(-4));
      if (!anio) { setDocEstado(false, `✅ INE válida`, 'var(--success)'); return; }
      const vigFin = new Date(anio, 11, 31);
      if (vigFin < fechaFinDate) {
        setDocEstado(true, `❌ INE vence en ${anio} — permiso requiere vigencia hasta ${formatFecha(fechaFin)}`, 'var(--danger)');
      } else {
        setDocEstado(false, `✅ INE vigente hasta ${anio}`, 'var(--success)');
      }
    } else {
      const fechaVenc = _parsearFechaDoc(ext.fecha_vencimiento);
      const venceStr = ext.fecha_vencimiento || '—';
      if (!fechaVenc) {
        setDocEstado(false, `✅ ${docType} válido`, 'var(--success)');
        return;
      }
      if (fechaVenc < fechaFinDate) {
        setDocEstado(true, `❌ ${docType} vence ${venceStr} — permiso requiere vigencia hasta ${formatFecha(fechaFin)}`, 'var(--danger)');
      } else {
        setDocEstado(false, `✅ ${docType} vigente hasta ${venceStr}`, 'var(--success)');
      }
    }
  } catch(e) {
    console.warn('Error validando doc personal:', e);
  }
}

function revalidarDocsPersonal() {
  (seccionesAgregadas['personal'] || []).forEach(fila => {
    if (fila._empleadoId) validarDocPersonal(fila._id, fila._empleadoId);
  });
}

// ── Comparar nombre extraído del documento vs nombre escrito ──
function _compararNombres(extraido, tipado) {
  if (!extraido || !tipado) return false;
  const normalizar = s => (s || '').toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // ← esta línea es la que cambia
    .replace(/[^A-Z\s]/g, '')
    .trim();
  const palabrasDoc  = normalizar(extraido).split(/\s+/).filter(p => p.length > 1);
  const palabrasForm = normalizar(tipado).split(/\s+/).filter(p => p.length > 1);
  if (!palabrasDoc.length || !palabrasForm.length) return false;
  const coincidencias = palabrasDoc.filter(pd =>
    palabrasForm.some(pf =>
      pf === pd ||
      (pf.length >= 4 && pd.length >= 4 && pf.startsWith(pd)) ||
      (pf.length >= 4 && pd.length >= 4 && pd.startsWith(pf))
    )
  );
  return coincidencias.length >= Math.min(2, palabrasDoc.length);
}


// ── Validar documento subido en sección personal (INE / PASAPORTE / LICENCIA) ──
async function validarDocumentoPersonal(tipo, rowId, base64, mime) {
  const valCell = document.getElementById(`val-personal-${rowId}`);
  const msgEl   = document.getElementById(`doc-msg-${rowId}`);

  const setEstado = (ok, msg, color) => {
    if (msgEl)   { msgEl.textContent = msg; msgEl.style.color = color; }
    if (valCell) {
      if (ok === true)  { valCell.textContent = '✅ VÁLIDO';  valCell.style.color = 'var(--success)'; }
      else if (ok === false) { valCell.textContent = '❌ NO VÁLIDO'; valCell.style.color = 'var(--danger)'; }
      else              { valCell.textContent = '⚠ REVISAR'; valCell.style.color = 'var(--warning)'; }
    }
    const rows = seccionesAgregadas[tipo] || [];
    const row  = rows.find(r => r._id === rowId);
    if (row) row._docInlineValidado = ok === true;
    verificarBotonSubmit();
  };

  try {
    if (msgEl)   { msgEl.textContent = '🔍 Validando con IA...'; msgEl.style.color = 'var(--text-muted)'; }
    if (valCell) { valCell.textContent = '⏳ validando...'; valCell.style.color = 'var(--text-muted)'; }

    const resp = await fetch('/documentos/procesar-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, mime, docType: 'AUTO' })
    });
    const data = await resp.json();

    if (!data.success) {
      if (data.n8n_no_disponible) {
        setEstado(false, '❌ Servicio de validación no disponible — intenta de nuevo más tarde', 'var(--danger)');
      } else {
        setEstado(false, '❌ No se pudo leer el documento — intenta con una imagen más clara', 'var(--danger)');
      }
      return;
    }
    if (!data.extracted) {
      setEstado(false, '❌ No se pudieron leer los datos del documento — intenta con una imagen más clara', 'var(--danger)');
      return;
    }

    const ext = data.extracted;

    // ── 1. Detectar tipo de documento ──
    let tipoDoc = (ext.tipo_documento || '').toUpperCase();
    if (!tipoDoc) {
      if (ext.clave_elector)                                                   tipoDoc = 'INE';
      else if (ext.numero_pasaporte)                                           tipoDoc = 'PASAPORTE';
      else if (ext.numero_licencia || ext.nombre_conductor || ext.tipo_licencia) tipoDoc = 'LICENCIA';
      else                                                                     tipoDoc = 'INE';
    }

    // ── 2. Validar vigencia PRIMERO ──
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);

    if (tipoDoc === 'INE') {
      if (ext.vigencia) {
        const anio = parseInt(String(ext.vigencia).replace(/\D/g, '').slice(-4));
        if (anio && anio < hoy.getFullYear()) {
          setEstado(false, `❌ INE VENCIDA — Vigencia declarada: ${ext.vigencia}. Presenta una INE vigente.`, 'var(--danger)');
          return;
        }
      }
    } else {
      if (ext.fecha_vencimiento) {
        const p = String(ext.fecha_vencimiento).split('/');
        const fechaVenc = p.length === 3 ? new Date(`${p[2]}-${p[1]}-${p[0]}`) : null;
        if (fechaVenc && !isNaN(fechaVenc) && fechaVenc < hoy) {
          setEstado(false, `❌ ${tipoDoc} VENCIDO — Venció el ${ext.fecha_vencimiento}. Presenta un documento vigente.`, 'var(--danger)');
          return;
        }
      }
    }

    // ── 3. Extraer nombre según tipo ──
    let nombreExtraido = '';
    if (tipoDoc === 'LICENCIA' && ext.nombre_conductor) {
      nombreExtraido = ext.nombre_conductor.trim();
    } else {
      nombreExtraido = [ext.nombre, ext.apellido_paterno || ext.apellido, ext.apellido_materno]
        .filter(Boolean).join(' ');
    }

    const vencInfo = tipoDoc === 'INE'
      ? (ext.vigencia ? ` — Vigencia: ${ext.vigencia}` : '')
      : (ext.fecha_vencimiento ? ` — Vence: ${ext.fecha_vencimiento}` : '');

    const rows = seccionesAgregadas[tipo] || [];
    const row  = rows.find(r => r._id === rowId);
    if (row) {
      row._nombreExtraido = nombreExtraido;
      row._docTipo        = tipoDoc;
      row._docVencInfo    = vencInfo;
    }

    // ── 4. Comparar con nombre escrito ──
    const inpNombre = document.getElementById(`inp-${rowId}-nombre`);
    const nombreTipado = inpNombre?.value?.trim() || '';

    if (!nombreTipado) {
      setEstado(null, `⚠ ${tipoDoc} leído: "${nombreExtraido || '—'}"${vencInfo} — Escribe el nombre para comparar`, 'var(--warning)');
      return;
    }

    const coincide = _compararNombres(nombreExtraido, nombreTipado);
    if (coincide) {
      setEstado(true, `✅ ${nombreExtraido || '—'}${vencInfo}`, 'var(--success)');
    } else {
      setEstado(false, `❌ El nombre no coincide — el documento dice: "${nombreExtraido || '—'}" · Verifica que sea el documento correcto`, 'var(--danger)');
    }
  } catch(e) {
    setEstado(false, '❌ Error al validar el documento — intenta de nuevo', 'var(--danger)');
    console.warn('[validarDocumentoPersonal]', e);
  }
}


// Cargar empleados filtrados por empresa
async function cargarEmpleadosPorEmpresa(empresa) {
  if (!empresa || empresa.trim().length < 2) { empleadosCache = []; return; }
  try {
    const r = await fetch(`/facial/empleados-por-empresa?empresa=${encodeURIComponent(empresa.trim())}`);
    const data = await r.json();
    if (data.success) {
      empleadosCache = data.data;
      console.log(`✅ ${empleadosCache.length} empleados de "${empresa}"`);
    }
  } catch(e) {
    console.warn('No se pudo cargar empleados:', e.message);
  }
}



// Obtener ubicación del navegador al cargar
let _ubicacionActual = null;
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    pos => { _ubicacionActual = `${pos.coords.latitude.toFixed(6)},${pos.coords.longitude.toFixed(6)}`; },
    () => { _ubicacionActual = 'No disponible'; }
  );
}


// Obtener IP privada de la PC
async function obtenerIPPrivada() {
  return new Promise(resolve => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      pc.createOffer().then(o => pc.setLocalDescription(o));
      pc.onicecandidate = e => {
        if (!e || !e.candidate) return;
        const match = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
        if (match) { resolve(match[1]); pc.close(); }
      };
      setTimeout(() => resolve('No disponible'), 3000);
    } catch(e) { resolve('No disponible'); }
  });
}



const ICON_SVG = {
  personal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  vehiculo:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
  equipo:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`
};



function getPersonalCols() {
  const cols = [
    { id: 'num_credencial', label: 'NO. CREDENCIAL', placeholder: 'Ej. CRED-001',   type: 'text', required: !isPaseVisitaActive() },
    { id: 'nombre',         label: 'NOMBRE',         placeholder: 'Nombre completo', type: 'text', required: true },
    { id: 'categoria',      label: 'CATEGORÍA',      placeholder: 'Ej. Operador',    type: 'text', required: true },
    { id: 'observaciones',  label: 'OBSERVACIONES',  placeholder: 'Notas...',        type: 'text'                 },
  ];
  if (_pvModalActive) {
    cols.push({ id: 'documento_ine', label: 'INE / PASAPORTE / LICENCIA', type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.webp', showMsg: true });
  }
  return cols;
}

const SECTION_COLS = {
  get personal() { return getPersonalCols(); },
  
  vehiculo: [
    { id: 'marca',    label: 'MARCA',    placeholder: 'Ej. Toyota',    type: 'text', required: true },
    { id: 'modelo',   label: 'MODELO',   placeholder: 'Ej. Hilux',     type: 'text', required: true },
    { id: 'placas',   label: 'PLACAS',   placeholder: 'Ej. ABC-123-D', type: 'text', required: true },
    { id: 'seguro',   label: 'SEGURO',   placeholder: '', type: 'file', accept: '.pdf,.jpg,.jpeg,.png' },
    { id: 'tarjeta_circulacion', label: 'TARJETA CIRC.', placeholder: '', type: 'file', accept: '.pdf,.jpg,.jpeg,.png' },
    { id: 'licencia', label: 'LICENCIA', placeholder: '', type: 'file', accept: '.pdf,.jpg,.jpeg,.png' }
  ],

  equipo: [
    { id: 'cantidad',     label: 'CANT.',        placeholder: '1',               type: 'number', required: true },
    { id: 'descripcion',  label: 'DESCRIPCIÓN',  placeholder: 'Nombre/desc.',    type: 'text',   required: true },
    { id: 'marca',        label: 'MARCA',        placeholder: 'Ej. Bosch',       type: 'text',   required: true },
    { id: 'modelo',       label: 'MODELO',       placeholder: 'Modelo',          type: 'text'                   },
    { id: 'serie',        label: 'SERIE',        placeholder: 'Serie',           type: 'text'                   },
    { id: 'observaciones',label: 'OBSERVACIONES',placeholder: 'Notas...',        type: 'text'                   }
  ]
};



const SECTION_LABELS = {
  personal: { title: 'Personal', desc: 'Registra al personal que participará', iconClass: 'dnd-icon-personal' },
  vehiculo:  { title: 'Vehículos', desc: 'Registra los vehículos que ingresarán', iconClass: 'dnd-icon-vehiculo' },
  equipo:    { title: 'Equipo / Herramientas', desc: 'Registra los equipos y herramientas', iconClass: 'dnd-icon-equipo' }
};



// ===================== SIDEBAR =====================
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}



function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ===================== MODAL =====================
async function openModalSolicitud() {
  empleadosCache = [];
  setTimeout(async () => {
    const empInput = document.getElementById('empresa');
    if (empInput && empInput.value) await cargarEmpleadosPorEmpresa(empInput.value);
    if (empInput && !empInput._listenerAdded) {
      empInput._listenerAdded = true;
      empInput.addEventListener('input',  () => cargarEmpleadosPorEmpresa(empInput.value));
      empInput.addEventListener('change', () => cargarEmpleadosPorEmpresa(empInput.value));
    }
    console.log('empleadosCache cargado:', empleadosCache.length);
  }, 300);
  const modal = document.getElementById('modalSolicitud');
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  const hoy = new Date().toISOString().split('T')[0];
  document.getElementById('fecha_inicio').min = hoy;
  document.getElementById('fecha_fin').min = hoy;
  try {
    const r = await fetch('/api/empleados-internos');
    const d = await r.json();
    if (d.success) responsablesCache = d.data;
  } catch(e) {
    console.warn('No se pudo cargar responsables:', e.message);
  }
}

function closeModal() {
  const modal = document.getElementById('modalSolicitud');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
  document.getElementById('formSolicitud').reset();

  // Resetear estado pase de visita
  _pvModalActive = false;
  const togglePV = document.getElementById('togglePaseVisitaModal');
  if (togglePV) togglePV.checked = false;
  const pvNombre = document.getElementById('pv_resp1_nombre');
  if (pvNombre) pvNombre.value = '';
  const resp1AutoGrupo = document.getElementById('resp1-autocomplete-grupo');
  if (resp1AutoGrupo) resp1AutoGrupo.style.display = '';
  const pvResp1Grupo = document.getElementById('pv-resp1-grupo');
  if (pvResp1Grupo) pvResp1Grupo.style.display = 'none';
  const seccionFechas = document.getElementById('seccion-fechas');
  if (seccionFechas) seccionFechas.style.display = '';
  const pvFechaInfo = document.getElementById('pv-fecha-info');
  if (pvFechaInfo) pvFechaInfo.style.display = 'none';

  document.getElementById('responsable1_tel').value = '';
  document.getElementById('responsable2_tel').value = '';
  document.getElementById('tel1-grupo').style.display = 'none';
  document.getElementById('tel2-grupo').style.display = 'none';
  const t1hint = document.getElementById('responsable1_tel_hint'); if(t1hint) t1hint.style.display = 'none';
  const t2hint = document.getElementById('responsable2_tel_hint'); if(t2hint) t2hint.style.display = 'none';

  document.getElementById('responsable1_input').value = '';
  document.getElementById('responsable1').value = '';
  const h1 = document.getElementById('responsable1_hint');
  if (h1) { h1.textContent = ''; h1.style.color = ''; }

  document.getElementById('responsable_input').value = '';
  document.getElementById('responsable_contrato').value = '';
  const hint = document.getElementById('responsable_hint');
  if (hint) { hint.textContent = 'Escribe el nombre del responsable.'; hint.style.color = ''; }
  document.getElementById('formDias').style.display = 'none';
  document.getElementById('modalAlert').style.display = 'none';
  document.getElementById('fechaHint').style.color = '';
  document.getElementById('fechaHint').textContent = 'Máximo 30 días desde la fecha de inicio.';

  // Restablecer título del modal
  const modalTitle = document.querySelector('#modalSolicitud .modal-title');
  if (modalTitle) modalTitle.textContent = 'Nueva Solicitud de Acceso';
  const modalEyebrow = document.querySelector('#modalSolicitud .modal-eyebrow');
  if (modalEyebrow) modalEyebrow.textContent = 'CONTRATISTA';
  const btnSubmit = document.getElementById('btnSubmit');
  if (btnSubmit) btnSubmit.innerHTML = _pvSubmitLabel(false);

  seccionesAgregadas = {};
  rowCounters.personal = 0; rowCounters.vehiculo = 0; rowCounters.equipo = 0;
  const dropZone = document.getElementById('dndDropZone');
  dropZone.innerHTML = `<div class="dnd-drop-placeholder" id="dndPlaceholder">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 5v14M5 12h14"/></svg>
    <span>Arrastra las secciones aquí</span>
  </div>`;
  document.querySelectorAll('.dnd-card-source').forEach(c => c.classList.remove('used'));
}



function closeModalOutside(e) {
  if (e.target === e.currentTarget) closeModal();
}



// ===================== FECHAS =====================
function validateFechas() {
  const inicio = document.getElementById('fecha_inicio').value;
  const fin = document.getElementById('fecha_fin').value;
  const diasEl = document.getElementById('formDias');
  const hint = document.getElementById('fechaHint');
  const finInput = document.getElementById('fecha_fin');
  if (!inicio) return;
  finInput.min = inicio;
  const fechaInicio = new Date(inicio + 'T00:00:00');
  const maxFin = new Date(fechaInicio);
  maxFin.setDate(maxFin.getDate() + 30);
  finInput.max = maxFin.toISOString().split('T')[0];
  if (fin) {
    const diffDays = Math.ceil((new Date(fin + 'T00:00:00') - fechaInicio) / (1000*60*60*24));
    if (diffDays > 30) {
      hint.textContent = `⚠ Excede los 30 días (${diffDays} días).`;
      hint.style.color = '#ef4444'; diasEl.style.display = 'none';
    } else if (diffDays < 0) {
      hint.textContent = '⚠ La fecha fin debe ser posterior al inicio.';
      hint.style.color = '#ef4444'; diasEl.style.display = 'none';
    } else {
      hint.textContent = `Máximo 30 días. (Max: ${finInput.max})`;
      hint.style.color = ''; diasEl.style.display = 'flex';
      const diasMostrar = diffDays === 0 ? 1 : diffDays;
    document.getElementById('diasTexto').textContent = `${diasMostrar} día${diasMostrar!==1?'s':''} de duración`;
    }
  } else {
    hint.textContent = `Máximo 30 días. (Max: ${finInput.max})`;
    hint.style.color = ''; diasEl.style.display = 'none';
  }
  revalidarDocsPersonal();
  verificarBotonSubmit();
}


function verificarBotonSubmit() {
  const btn = document.getElementById('btnSubmit');
  if (!btn) return;

  const empresa   = document.getElementById('empresa')?.value?.trim() || '';
  const contrato  = document.getElementById('contrato')?.value?.trim() || '';
  const responsable = document.getElementById('responsable_contrato')?.value?.trim() || '';
  const fechaInicio = document.getElementById('fecha_inicio')?.value || '';
  const fechaFin    = document.getElementById('fecha_fin')?.value || '';

  // Validación de teléfonos: obligatorio si hay responsable, y en PV siempre
  const resp1Val = isPaseVisitaActive()
    ? (document.getElementById('pv_resp1_nombre')?.value?.trim() || '')
    : (document.getElementById('responsable1')?.value?.trim() || '');
  const resp2Val = document.getElementById('responsable2')?.value?.trim() || '';
  const tel1Val  = document.getElementById('responsable1_tel')?.value?.trim() || '';
  const tel2Val  = document.getElementById('responsable2_tel')?.value?.trim() || '';
  const tel1Req  = isPaseVisitaActive() || !!resp1Val;
  const tel1Ok   = !tel1Req || tel1Val.length > 1;
  const tel2Ok   = !resp2Val || tel2Val.length > 1;





  // Validar fechas
  let fechasValidas = false;
  if (fechaInicio && fechaFin) {
    const fi = new Date(fechaInicio + 'T00:00:00');
    const ff = new Date(fechaFin + 'T00:00:00');
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const diff = Math.ceil((ff - fi) / (1000*60*60*24));
    fechasValidas = fi >= hoy && ff >= fi && diff <= 30;
  }

  // Validar vehículos si hay sección
  const filas = seccionesAgregadas['vehiculo'] || [];
  const vehiculosValidos = filas.length === 0 || filas.every(fila => fila.validacion_ok === true);

  const personalBloqueado   = (seccionesAgregadas['personal'] || []).some(f => f._bloqueado === true);
  const personalDocVencido  = isPaseVisitaActive() && (seccionesAgregadas['personal'] || []).some(f => f._docVencido === true);
  // En pase de visita, bloquear si hay filas de personal cuyo documento inline no está validado
  const filasPersonal = seccionesAgregadas['personal'] || [];
  const personalDocNoValidado = isPaseVisitaActive() && filasPersonal.length > 0 &&
    filasPersonal.some(f => f._docInlineValidado !== true);

  const contratoOk = isPaseVisitaActive() || !!contrato;
  const listo = empresa && contratoOk && responsable && resp1Val && fechaInicio && fechaFin && fechasValidas && vehiculosValidos && !personalBloqueado && !personalDocVencido && !personalDocNoValidado && tel1Ok && tel2Ok;

  btn.disabled = !listo;
  btn.style.opacity = listo ? '1' : '0.4';
  btn.style.cursor = listo ? 'pointer' : 'not-allowed';
  btn.style.background = listo ? '' : 'var(--text-3)';
}





// ===================== DRAG & DROP =====================
function onDragStart(e) {
  dragType = e.currentTarget.dataset.type;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}


function onDragEnd(e) { e.currentTarget.classList.remove('dragging'); }
function onDragOver(e) {
  e.preventDefault();
  document.getElementById('dndDropZone').classList.add('drag-over');
}


function onDragLeave(e) { document.getElementById('dndDropZone').classList.remove('drag-over'); }
function onDrop(e) {
  e.preventDefault();
  document.getElementById('dndDropZone').classList.remove('drag-over');
  if (!dragType || seccionesAgregadas[dragType] !== undefined) return;
  agregarSeccion(dragType);
  dragType = null;
}



// ===================== RENDER SECCIÓN CON TABLA =====================
function buildTableHTML(tipo) {
  const cols = SECTION_COLS[tipo];
  const info = SECTION_LABELS[tipo];
  const headers = `<tr>
    <th class="col-num">#</th>
    ${cols.map(c => `<th>${c.label}${c.required ? ' <span style="color:#ef4444">*</span>' : ''}</th>`).join('')}

   ${(tipo === 'vehiculo' || (tipo === 'personal' && isPaseVisitaActive())) ? '<th style="font-size:10px;min-width:130px">VALIDACIÓN DOC.</th>' : ''}

    <th class="col-del"></th>
  </tr>`;
  const excelBtn = tipo === 'equipo' ? `
    <button type="button" class="btn-excel btn-add-row" onclick="importarExcel()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
        <line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
      </svg>
      CARGA MASIVA EXCEL
    </button>` : '';
  return `
    <div class="sec-table-header">
      <div class="sec-table-header-left">
        <div class="dnd-expanded-icon ${info.iconClass}">${ICON_SVG[tipo]}</div>
        <div>
          <span class="sec-table-title">${info.title}</span>
          <span class="sec-table-desc">${info.desc}</span>
        </div>
      </div>
      <div class="sec-table-header-right">
        <span class="dnd-expanded-badge" id="badge-${tipo}">0 REGISTROS</span>
        <button type="button" class="dnd-btn-remove" onclick="removerSeccion('${tipo}')" title="Quitar sección">✕</button>
      </div>
    </div>
    <div class="sec-table-wrap">
      <table class="sec-table" id="table-${tipo}">
        <thead>${headers}</thead>
        <tbody id="tbody-${tipo}"></tbody>
      </table>
    </div>
    <div class="sec-table-footer">
      <button type="button" class="btn-add-row" onclick="addRow('${tipo}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        AÑADIR ${tipo === 'personal' ? 'PERSONA' : tipo === 'vehiculo' ? 'VEHÍCULO' : 'EQUIPO'}
      </button>
      ${excelBtn}
      <span class="sec-row-count" id="count-${tipo}">0 registros</span>
    </div>`;
}



function buildRowHTML(tipo, rowId, rowNum) {
  const cols = SECTION_COLS[tipo];
  const cells = cols.map(c => {
    if (c.type === 'file') {
      return `<td class="cell-file">
        <div style="display:flex;align-items:center;gap:4px">
          <label class="dnd-file-btn compact" style="flex:1;min-width:0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span class="file-label-text" id="fl-${rowId}-${c.id}">Adjuntar</span>
            <input type="file" accept="${c.accept||'*'}" id="finput-${rowId}-${c.id}" onchange="onFileChange('${tipo}','${rowId}','${c.id}',this)">
          </label>
          <button type="button" id="fbtn-clear-${rowId}-${c.id}" onclick="clearDocumento('${tipo}','${rowId}','${c.id}')"
            title="Quitar documento"
            style="display:none;flex-shrink:0;background:none;border:1px solid var(--danger);color:var(--danger);cursor:pointer;padding:3px 6px;font-size:13px;line-height:1">×</button>
        </div>
        ${c.showMsg ? `<div id="doc-msg-${rowId}" style="font-size:11px;margin-top:5px;font-family:'Share Tech Mono',monospace;line-height:1.4;"></div>` : ''}
      </td>`;
    }
    if (tipo === 'personal' && c.id === 'nombre') {
      return `<td style="position:relative">
        <input type="text" class="cell-input" placeholder="${c.placeholder||''}"
          ${c.required ? 'required' : ''}
          id="inp-${rowId}-nombre"
          autocomplete="off"
          oninput="onNombreInput('${rowId}',this.value)"
          onkeydown="onNombreKeydown(event,'${rowId}')"
          onblur="setTimeout(()=>cerrarSugerencias('${rowId}'),300)">
          
        <div id="sug-${rowId}" class="empleado-suggestions" style="display:none"></div>
      </td>`;
    }
    return `<td>
      <input type="${c.type}" class="cell-input" placeholder="${c.placeholder||''}"
        ${c.required ? 'required' : ''}
        oninput="onCellChange('${tipo}','${rowId}','${c.id}',this.value)">
    </td>`;
  });
  const valCell = tipo === 'vehiculo'
    ? `<td id="val-${rowId}" style="text-align:center;font-size:11px;white-space:nowrap;color:var(--text-muted)">—</td>`
    : (tipo === 'personal' && isPaseVisitaActive())
    ? `<td id="val-personal-${rowId}" style="text-align:center;font-size:11px;white-space:nowrap;color:var(--text-muted)">— pendiente</td>`
    : '';
  return `<tr id="row-${rowId}" class="sec-row">
    <td class="col-num">${rowNum}</td>
    ${cells.join('')}
    ${valCell}
    <td class="col-del">
      <button type="button" class="btn-del-row" onclick="deleteRow('${tipo}','${rowId}')" title="Eliminar fila">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14a2,2,0,0,1-2,2H8a2,2,0,0,1-2-2L5,6"/>
          <path d="M10,11v6"/><path d="M14,11v6"/><path d="M9,6V4h6v2"/>
        </svg>
      </button>
    </td>
  </tr>`;
}



function agregarSeccion(tipo) {
  seccionesAgregadas[tipo] = [];
  const ph = document.getElementById('dndPlaceholder');
  if (ph) ph.style.display = 'none';
  document.querySelector(`.dnd-card-source[data-type="${tipo}"]`)?.classList.add('used');
  const card = document.createElement('div');
  card.className = 'dnd-expanded-card';
  card.id = `expanded-${tipo}`;
  card.innerHTML = buildTableHTML(tipo);
  document.getElementById('dndDropZone').appendChild(card);
  addRow(tipo);
  if (tipo === 'vehiculo') actualizarAlertaVehiculos();
}



// ── Autocomplete empleados ───────────────────────
function mostrarSugerencias(rowId) {
  const sugEl = document.getElementById(`sug-${rowId}`);
  if (!sugEl) return;
  const inpNombre = document.getElementById(`inp-${rowId}-nombre`);
  const value = inpNombre ? inpNombre.value : '';
  const query = value.toLowerCase();
  const matches = empleadosCache.filter(e =>
    `${e.nombre} ${e.apellido}`.toLowerCase().includes(query) ||
    (e.documento_identidad||'').toLowerCase().includes(query)
  ).slice(0, 6);
  if (!matches.length) { sugEl.style.display = 'none'; return; }
  sugEl.innerHTML = matches.map((e, i) => {
    const idx = empleadosCache.indexOf(e);
    return `<div class="empleado-sug-item" data-idx="${idx}" onclick="seleccionarEmpleadoIdx('${rowId}',${idx})">
      <span class="sug-nombre">${e.nombre} ${e.apellido}</span>
      <span class="sug-meta">${e.area||''} · ${e.cargo||''}</span>
    </div>`;
  }).join('');
  sugEl.style.display = 'block';
}



/**
 * Función auxiliar para normalizar cadenas (quita acentos, mayúsculas y espacios dobles)
 */
function _normalizarTexto(str) {
    if (!str) return '';
    return str.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Elimina acentos
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' '); // Elimina espacios múltiples
}

/**
 * Función de comparación corregida para igualdad absoluta
 */
function _compararNombres(nombreDoc, nombreInput) {
    const doc = _normalizarTexto(nombreDoc);
    const input = _normalizarTexto(nombreInput);
    
    if (!doc || !input) return false;
    
    // IMPORTANTE: Cambiamos de .includes() o .startsWith() a comparación total (===)
    return doc === input;
}

function onNombreInput(rowId, value) {
    onCellChange('personal', rowId, 'nombre', value);

    // Buscamos la fila en el objeto de secciones
    const fila = (seccionesAgregadas['personal'] || []).find(f => f._id === rowId);

    // En PV, al escribir manualmente desvincular cualquier empleado enrolado previo
    // para que validarDocPersonal no consulte la BD con un ID obsoleto
    if (isPaseVisitaActive() && fila) {
        fila._empleadoId = null;
        if (fila._docVencido) {
            fila._docVencido = false;
            const warnEl = document.getElementById(`doc-warn-${rowId}`);
            if (warnEl) { warnEl.textContent = ''; warnEl.style.color = ''; }
        }
    }
    
    if (fila && fila._nombreExtraido) {
        const valCell = document.getElementById(`val-personal-${rowId}`);
        const msgEl   = document.getElementById(`doc-msg-${rowId}`);
        const tipado  = (value || '').trim();
        const vencInfo = fila._docVencInfo || '';

        if (!tipado) {
            fila._docInlineValidado = false;
            if (valCell) { 
                valCell.textContent = '⚠ Escribe el nombre'; 
                valCell.style.color = 'var(--warning)'; 
            }
            if (msgEl) { 
                msgEl.textContent = `⚠ ${fila._docTipo || 'DOC'} leído: "${fila._nombreExtraido}"${vencInfo} — Escribe el nombre completo`; 
                msgEl.style.color = 'var(--warning)'; 
            }
        } else {
            // Realizamos la comparación estricta
            const ok = _compararNombres(fila._nombreExtraido, tipado);
            fila._docInlineValidado = ok;

            if (valCell) {
                // Ahora solo dirá VÁLIDO si la cadena es exactamente igual
                valCell.textContent = ok ? `✅ VÁLIDO` : `❌ INCOMPLETO / NO COINCIDE`;
                valCell.style.color = ok ? 'var(--success)' : 'var(--danger)';
            }

            if (msgEl) {
                if (ok) {
                    msgEl.textContent = `✅ ${fila._docTipo || 'DOC'} válido · ${fila._nombreExtraido}${vencInfo}`;
                    msgEl.style.color = 'var(--success)';
                } else {
                    // Si el usuario ya terminó de escribir (mismo largo o más), avisar que hay error
                    const instruccion = tipado.length >= fila._nombreExtraido.length 
                        ? 'Verifica errores de dedo o apellidos' 
                        : 'Sigue escribiendo el nombre completo...';
                    
                    msgEl.textContent = `❌ El nombre no coincide — el documento dice: "${fila._nombreExtraido}" · ${instruccion}`;
                    msgEl.style.color = 'var(--danger)';
                }
            }
        }
        verificarBotonSubmit();
    }

    // Lógica de sugerencias (Autocomplete)
    if (!value || value.length < 1) {
        const sugEl = document.getElementById(`sug-${rowId}`);
        if (sugEl) sugEl.style.display = 'none';
        return;
    }
    
    mostrarSugerencias(rowId);
    verificarPersonalOcupado(rowId, value);
}



function seleccionarEmpleadoIdx(rowId, idx) {
  const e = empleadosCache[idx];
  if (!e) return;
  seleccionarEmpleado(rowId, e);
}



function seleccionarEmpleado(rowId, e) {
  if (typeof e === 'string') e = JSON.parse(e);
  const inpNombre = document.getElementById(`inp-${rowId}-nombre`);
  if (inpNombre) { inpNombre.value = `${e.nombre} ${e.apellido}`; }
  onCellChange('personal', rowId, 'nombre', `${e.nombre} ${e.apellido}`);
  const tr = document.getElementById(`row-${rowId}`);
  if (tr) {
    const inputs = tr.querySelectorAll('.cell-input');
    inputs.forEach(inp => {
      if (inp.placeholder && inp.placeholder.includes('CRED')) {
        inp.value = e.documento_identidad || '';
        onCellChange('personal', rowId, 'num_credencial', e.documento_identidad || '');
      }
      if (inp.placeholder && inp.placeholder.toLowerCase().includes('operador')) {
        inp.value = e.cargo || '';
        onCellChange('personal', rowId, 'categoria', e.cargo || '');
      }
    });
  }
  const fila = (seccionesAgregadas['personal'] || []).find(f => f._id === rowId);
  if (fila && e.id) fila._empleadoId = e.id;
  if (fila) fila._nss = e.imss_nss || null;

  cerrarSugerencias(rowId);
  verificarPersonalOcupado(rowId, `${e.nombre} ${e.apellido}`);
  if (e.id) validarDocPersonal(rowId, e.id);
}


function cerrarSugerencias(rowId) {
  const sugEl = document.getElementById(`sug-${rowId}`);
  if (sugEl) sugEl.style.display = 'none';
}



function onNombreKeydown(event, rowId) {
  const sugEl = document.getElementById(`sug-${rowId}`);
  if (!sugEl || sugEl.style.display === 'none') return;
  const items = sugEl.querySelectorAll('.empleado-sug-item');
  const active = sugEl.querySelector('.empleado-sug-item.active');
  let idx = Array.from(items).indexOf(active);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (active) active.classList.remove('active');
    idx = (idx + 1) % items.length;
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (active) active.classList.remove('active');
    idx = (idx - 1 + items.length) % items.length;
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const target = active || items[0];
    if (target) { const idx = parseInt(target.dataset.idx); seleccionarEmpleadoIdx(rowId, idx); cerrarSugerencias(rowId); }
  } else if (event.key === 'Escape') {
    cerrarSugerencias(rowId);
  }
}



function addRow(tipo) {
  rowCounters[tipo]++;
  const rowId = `${tipo}-${rowCounters[tipo]}`;
  const tbody = document.getElementById(`tbody-${tipo}`);
  const rowNum = tbody.rows.length + 1;
  tbody.insertAdjacentHTML('beforeend', buildRowHTML(tipo, rowId, rowNum));
  if (!Array.isArray(seccionesAgregadas[tipo])) seccionesAgregadas[tipo] = [];
  seccionesAgregadas[tipo].push({ _id: rowId });
  updateRowCount(tipo);
}






function deleteRow(tipo, rowId) {
  const row = document.getElementById(`row-${rowId}`);
  if (row) row.remove();
  seccionesAgregadas[tipo] = (seccionesAgregadas[tipo] || []).filter(r => r._id !== rowId);
  const tbody = document.getElementById(`tbody-${tipo}`);
  if (tbody) Array.from(tbody.rows).forEach((r, i) => { if(r.cells[0]) r.cells[0].textContent = i + 1; });
  updateRowCount(tipo);
}



function removerSeccion(tipo) {
  delete seccionesAgregadas[tipo];
  document.getElementById(`expanded-${tipo}`)?.remove();
  document.querySelector(`.dnd-card-source[data-type="${tipo}"]`)?.classList.remove('used');
  if (tipo === 'vehiculo') {
    Object.keys(vehicValidaciones).forEach(k => delete vehicValidaciones[k]);
    actualizarAlertaVehiculos();
  }
  if (Object.keys(seccionesAgregadas).length === 0) {
    const ph = document.getElementById('dndPlaceholder');
    if (ph) ph.style.display = 'flex';
  }
}



function actualizarAlertaVehiculos() {
  const alertEl = document.getElementById('modalAlert');
  const btnSubmit = document.getElementById('btnSubmit');
  if (!alertEl || !btnSubmit) return;

  const filas = seccionesAgregadas['vehiculo'] || [];
  if (!filas.length) {
    alertEl.style.display = 'none';
    btnSubmit.disabled = false;
    btnSubmit.style.opacity = '1';
    btnSubmit.style.cursor = 'pointer';
    btnSubmit.style.background = '';
    return;
  }



  const problemas = [];
  filas.forEach((fila, idx) => {
    const num = idx + 1;
    if (!fila.seguro || !fila.licencia || !fila.tarjeta_circulacion) return;
    if (fila.validacion_series_coinciden === false) problemas.push(`Fila ${num}: SERIES NO COINCIDEN`);
    if (fila.validacion_seguro_vigente   === false) problemas.push(`Fila ${num}: SEGURO VENCIDO`);
    if (fila.validacion_licencia_vigente === false) problemas.push(`Fila ${num}: LICENCIA VENCIDA`);
  });

  const todosValidos = filas.every(fila => fila.validacion_ok === true);

  if (problemas.length > 0) {
    alertEl.style.display = 'block';
    alertEl.style.color = '#ef4444';
    alertEl.style.background = 'rgba(239,68,68,0.06)';
    alertEl.style.border = '1px solid #ef4444';
    alertEl.style.padding = '10px 14px';
    alertEl.innerHTML = '❌ No puedes crear la solicitud: ' + problemas.map(p => `• ${p}`).join(' ');
    btnSubmit.disabled = true;
    btnSubmit.style.opacity = '0.4';
    btnSubmit.style.cursor = 'not-allowed';
    btnSubmit.style.background = 'var(--text-3)';
  } else if (!todosValidos) {
    alertEl.style.display = 'block';
    alertEl.style.color = '#f59e0b';
    alertEl.style.background = 'rgba(245,158,11,0.06)';
    alertEl.style.border = '1px solid #f59e0b';
    alertEl.style.padding = '10px 14px';
    alertEl.innerHTML = '⏳ Sube y valida seguro, tarjeta de circulación y licencia de cada vehículo.';
    btnSubmit.disabled = true;
    btnSubmit.style.opacity = '0.4';
    btnSubmit.style.cursor = 'not-allowed';
    btnSubmit.style.background = 'var(--text-3)';
  } else {
    alertEl.style.display = 'block';
    alertEl.style.color = '#16a34a';
    alertEl.style.background = 'rgba(22,163,74,0.06)';
    alertEl.style.border = '1px solid #16a34a';
    alertEl.style.padding = '10px 14px';
    alertEl.innerHTML = '✅ Todos los documentos de vehículos son válidos.';
    btnSubmit.disabled = false;
    btnSubmit.style.opacity = '1';
    btnSubmit.style.cursor = 'pointer';
    btnSubmit.style.background = '';
  }
}



function revalidarTarjeta(rowId, data, row) {
  const label = vehicValidaciones[rowId] ? vehicValidaciones[rowId]._tarjetaLabel : null;
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'').trim();
  const tr = document.getElementById(`row-${rowId}`);
  const inputs = tr ? tr.querySelectorAll('.cell-input') : [];
  let marcaDOM = '', modeloDOM = '', placasDOM = '';
  inputs.forEach(inp => {
    if (inp.placeholder === 'Ej. Toyota')    marcaDOM  = inp.value;
    if (inp.placeholder === 'Ej. Hilux')     modeloDOM = inp.value;
    if (inp.placeholder === 'Ej. ABC-123-D') placasDOM = inp.value;
  });
  const placasDoc = norm(data.placas || '');
  const marcaDoc  = norm(data.marca  || '');
  const modeloDoc = norm(data.modelo || '');
  const errores = [];
  if (placasDoc && norm(placasDOM) !== placasDoc) errores.push(`Placas: "${placasDOM||'—'}" vs tarjeta "${data.placas}"`);
  //if (marcaDoc  && norm(marcaDOM)  !== marcaDoc)  errores.push(`Marca: "${marcaDOM||'—'}" vs tarjeta "${data.marca}"`);
  //if (modeloDoc && norm(modeloDOM) !== modeloDoc) errores.push(`Modelo: "${modeloDOM||'—'}" vs tarjeta "${data.modelo}"`);
  const vigenteTarjeta = data.vigencia_fin ? validarVigenciaPorFecha(data.vigencia_fin) : true;
  if (errores.length > 0) {
    vehicValidaciones[rowId].tarjeta_circulacion = false;
    vehicValidaciones[rowId].tarjeta_error = 'DATOS NO COINCIDEN CON TARJETA';
    if (label) label.textContent = `⚠️ Datos no coinciden: ${errores.join(' · ')}`;
  } else if (!vigenteTarjeta) {
    vehicValidaciones[rowId].tarjeta_circulacion = false;
    vehicValidaciones[rowId].tarjeta_error = 'TARJETA VENCIDA';
    if (label) label.textContent = `⚠️ Tarjeta NO VIGENTE · Vence: ${data.vigencia_fin || '—'}`;
  } else {
    vehicValidaciones[rowId].tarjeta_circulacion = true;
    vehicValidaciones[rowId].tarjeta_error = null;
    if (label) label.textContent = `✅ Tarjeta vigente · ${data.marca||'—'} ${data.modelo||'—'} · Placa: ${data.placas||'—'} · Vence: ${data.vigencia_fin||'—'}`;
  }
  actualizarAlertaVehiculos();
}




function onCellChange(tipo, rowId, fieldId, value) {
  const rows = seccionesAgregadas[tipo] || [];
  const row = rows.find(r => r._id === rowId);
  if (row) row[fieldId] = value;
  updateRowCount(tipo);


  // Re-validar tarjeta si cambian marca/modelo/placas
  if (tipo === 'vehiculo' && ['marca','modelo','placas'].includes(fieldId)) {
    const v = vehicValidaciones[rowId];
    if (v && v._tarjetaData) {
      revalidarTarjeta(rowId, v._tarjetaData, row);
    }
  }
}

/*
  if (tipo == 'vehiculo' && ['marca','modelo','placas'].includes(fieldId)){
    const v = vehi
  }*/




function clearDocumento(tipo, rowId, fieldId) {
  // Reset input
  const input = document.getElementById(`finput-${rowId}-${fieldId}`);
  if (input) input.value = '';

  // Reset label
  const label = document.getElementById(`fl-${rowId}-${fieldId}`);
  if (label) label.textContent = 'Adjuntar';

  // Ocultar botón X
  const clearBtn = document.getElementById(`fbtn-clear-${rowId}-${fieldId}`);
  if (clearBtn) clearBtn.style.display = 'none';

  // Limpiar mensaje de validación
  const msgEl = document.getElementById(`doc-msg-${rowId}`);
  if (msgEl) { msgEl.textContent = ''; msgEl.style.color = ''; }

  // Limpiar celda de estado
  const valCell = document.getElementById(`val-personal-${rowId}`) || document.getElementById(`val-${rowId}`);
  if (valCell) { valCell.textContent = tipo === 'vehiculo' ? '⏳ Falta doc.' : ''; valCell.style.color = ''; }

  // Limpiar datos en seccionesAgregadas
  const rows = seccionesAgregadas[tipo] || [];
  const row  = rows.find(r => r._id === rowId);
  if (row) {
    delete row[fieldId];
    delete row[`${fieldId}_mime`];
    delete row[`${fieldId}_nombre`];
    row._docInlineValidado = false;
    delete row._nombreExtraido;
    delete row._docTipo;
    delete row._docVencInfo;
  }

  verificarBotonSubmit();
}

async function onFileChange(tipo, rowId, fieldId, input) {
  const file = input.files[0];
  const label = document.getElementById(`fl-${rowId}-${fieldId}`);
  if (!file) return;
  if (label) label.textContent = '⏳ Procesando...';

  try {
    let base64, mimeFinal = file.type;

    if (file.type === 'application/pdf') {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      mimeFinal = 'image/jpeg';    
    } else {
      base64 = await comprimirImagenVehiculo(file);
    }

    const rows = seccionesAgregadas[tipo] || [];
    const row  = rows.find(r => r._id === rowId);
    if (row) { row[fieldId] = base64; row[`${fieldId}_mime`] = mimeFinal; row[`${fieldId}_nombre`] = file.name; }

    if (label) label.textContent = '🔍 Analizando con IA...';

    // ── Determinar endpoint ──
    let webhookUrl = null;
    if (fieldId === 'seguro')   webhookUrl = '/api/procesar-seguro';
    if (fieldId === 'licencia') webhookUrl = '/api/procesar-licencia';
    if (fieldId === 'tarjeta_circulacion') webhookUrl = '/api/procesar-tarjeta';

    // ── Documentos de identificación de personal (INE / PASAPORTE / LICENCIA) ──
    if (tipo === 'personal' && (fieldId === 'documento_ine' || fieldId === 'documento')) {
      if (label) label.textContent = file.name.length > 22 ? file.name.slice(0, 20) + '…' : file.name;
      const clearBtn = document.getElementById(`fbtn-clear-${rowId}-${fieldId}`);
      if (clearBtn) clearBtn.style.display = 'inline-block';
      await validarDocumentoPersonal(tipo, rowId, base64, mimeFinal);
      updateRowCount(tipo);
      return;
    }

    if (webhookUrl) {
      try {
        const resp = await fetch(webhookUrl, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ base64File: base64, mimeType: mimeFinal, requestId: `${rowId}-${fieldId}-${Date.now()}` }) 
        });
        const data = await resp.json();
        if (row) row[`${fieldId}_extracted`] = data;

        if (!vehicValidaciones[rowId]) vehicValidaciones[rowId] = {};

        if (fieldId === 'seguro') {
          vehicValidaciones[rowId].seguro = data.vigente === true;
          const serie = data.serie_vehiculo || '—';
          const txt = data.vigente
            ? `✅ ${data.aseguradora || 'Seguro'} · Serie: ${serie} · Vence: ${data.vigencia_fin || '—'}`
            : `⚠️ Seguro NO VIGENTE · Vence: ${data.vigencia_fin || '—'}`;
          if (label) label.textContent = txt;
        } else if (fieldId === 'licencia') {
          vehicValidaciones[rowId].licencia = data.vigente === true;
          const txt = data.vigente 
            ? `✅ ${data.nombre_conductor || '—'} · Lic: ${data.numero_licencia || '—'} · Tipo: ${data.tipo_licencia || '—'}` 
            : `⚠️ Licencia NO VIGENTE · ${data.nombre_conductor || '—'}`;
          if (label) label.textContent = txt;          
        } else if (fieldId === 'tarjeta_circulacion') {
          const serie = data.numero_serie || '';
          if (label) label.textContent = serie ? `✅ Serie: ${serie}` : `⚠️ No se pudo leer la serie`;
        }


        if (tipo === 'vehiculo') verificarDocumentosVehiculo(tipo, rowId);
        actualizarAlertaVehiculos();

      } catch(e) {
        console.warn('Error analizando con IA:', e.message);
        const nombre = file.name;
        if (label) label.textContent = '✅ ' + (nombre.length > 12 ? nombre.substring(0,12)+'…' : nombre);
      }
      const cb = document.getElementById(`fbtn-clear-${rowId}-${fieldId}`);
      if (cb) cb.style.display = 'inline-block';
    } else {
      const nombre = file.name;
      if (label) label.textContent = '✅ ' + (nombre.length > 12 ? nombre.substring(0,12)+'…' : nombre);
      const cb = document.getElementById(`fbtn-clear-${rowId}-${fieldId}`);
      if (cb) cb.style.display = 'inline-block';
    }

    updateRowCount(tipo);
  } catch(e) {
    console.error('Error procesando archivo:', e);
    if (label) label.textContent = '❌ Error: ' + e.message;
  }
}









async function comprimirImagenVehiculo(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        const MAX = 1200;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else       { w = Math.round(w * MAX / h); h = MAX; }
        }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.7).split(',')[1]);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}



function parseFecha(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str + 'T12:00:00');
  const partes = String(str).split('/');
  if (partes.length === 3) {
    if (parseInt(partes[0]) > 12) return new Date(`${partes[2]}-${partes[1]}-${partes[0]}T12:00:00`);
    return new Date(`${partes[2]}-${partes[0]}-${partes[1]}T12:00:00`);
  }
  return new Date(str);
}

function verificarDocumentosVehiculo(tipo, rowId) {
  const row = (seccionesAgregadas[tipo] || []).find(r => r._id === rowId);
  if (!row) return;

  const segExt = row.seguro_extracted              || {};
  const licExt = row.licencia_extracted            || {};
  const tarExt = row.tarjeta_circulacion_extracted || {};

  const hoy = new Date(); hoy.setHours(0,0,0,0);

  const serieSeguro  = (segExt.serie_vehiculo || '').trim().toUpperCase();
  const serieTarjeta = (tarExt.numero_serie   || '').trim().toUpperCase();
  const seriesCoinciden = !!(serieSeguro && serieTarjeta && serieSeguro === serieTarjeta);


  //aqui valido las vigencias
  const fechaSeg = parseFecha(segExt.vigencia_fin);
  const segVigente = fechaSeg ? fechaSeg >= hoy : (segExt.vigente === true);

  const fechaLic = parseFecha(licExt.vigencia_fin);
  const licVigente = fechaLic ? fechaLic >= hoy : (licExt.vigente === true);

  row.validacion_series_coinciden = seriesCoinciden;
  row.validacion_seguro_vigente   = segVigente;
  row.validacion_licencia_vigente = licVigente;
  row.validacion_ok = seriesCoinciden && segVigente && licVigente;

  const valEl = document.getElementById(`val-${rowId}`);
  if (!valEl) return;

  if (!row.seguro || !row.licencia || !row.tarjeta_circulacion) {
    valEl.textContent = '⏳ Falta doc.';
    valEl.style.color = 'var(--text-muted)';
    return;
  }

  const lineas = [
    seriesCoinciden ? '✅ Series OK'        : `❌ Series no coinciden (Seg: ${serieSeguro||'—'} / Tar: ${serieTarjeta||'—'})`,
    segVigente      ? '✅ Seguro vigente'   : `❌ Seguro vencido (${segExt.vigencia_fin||'—'})`,
    licVigente      ? '✅ Licencia vigente' : `❌ Licencia vencida (${licExt.vigencia_fin||'—'})`
  ];
  valEl.innerHTML = lineas.join('<br>');
  valEl.style.color = row.validacion_ok ? 'var(--success)' : '#ef4444';
}






// Helper: validar vigencia por fecha (DD/MM/YYYY o YYYY-MM-DD)
function validarVigenciaPorFecha(fechaStr) {
  if (!fechaStr) return false;
  const s = String(fechaStr).trim();
  let fecha = null;
  const partes = s.split('/');
  if (partes.length === 3) {
    // DD/MM/YYYY
    fecha = new Date(`${partes[2]}-${partes[1].padStart(2,'0')}-${partes[0].padStart(2,'0')}`);
  } else {
    fecha = new Date(s);
  }
  if (!fecha || isNaN(fecha.getTime())) return false;
  return fecha > new Date();
}

function updateRowCount(tipo) {
  const total = document.getElementById(`tbody-${tipo}`)?.rows.length || 0;
  const countEl = document.getElementById(`count-${tipo}`);
  if (countEl) countEl.textContent = `${total} registro${total !== 1 ? 's' : ''}`;
  const badge = document.getElementById(`badge-${tipo}`);
  if (badge) { badge.textContent = `${total} REGISTRO${total !== 1 ? 'S' : ''}`; badge.className = 'dnd-expanded-badge' + (total > 0 ? ' filled' : ''); }
}

function importarExcel() { alert('Función de importar Excel próximamente disponible.'); }

// ===================== FORM SUBMIT =====================

document.addEventListener('DOMContentLoaded', () => {
  actualizarModoPaseVisita();

  const form = document.getElementById('formSolicitud');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btnSubmit');
      const alertEl = document.getElementById('modalAlert');
      btn.disabled = true;
      btn.innerHTML = '<div class="loading-spinner" style="width:14px;height:14px;border-width:2px;margin:0"></div> CREANDO...';
      alertEl.style.display = 'none';

      const ipPrivada = await obtenerIPPrivada();

      // En modo PV, resp1 viene del campo libre; en modo normal, del hidden input
      const resp1 = isPaseVisitaActive()
        ? (document.getElementById('pv_resp1_nombre')?.value?.trim() || '')
        : document.getElementById('responsable1').value;
      const resp2 = document.getElementById('responsable2').value;
      const tel1 = document.getElementById('responsable1_tel')?.value?.trim() || '';
      const tel2 = document.getElementById('responsable2_tel')?.value?.trim() || '';

      // En modo PV el teléfono es siempre obligatorio
      if (isPaseVisitaActive() && tel1.length <= 1) {
        document.getElementById('responsable1_tel_hint').style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = _pvSubmitLabel(true);
        return;
      }
      if (!isPaseVisitaActive() && resp1 && tel1.length <= 1) {
        document.getElementById('responsable1_tel_hint').style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = _pvSubmitLabel(false);
        return;
      }
      if (resp2 && tel2.length <= 1) {
        document.getElementById('responsable2_tel_hint').style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = _pvSubmitLabel(isPaseVisitaActive());
        return;
      }

      // ── VALIDACIÓN VEHÍCULOS ──────────────────────────────
      const btnHtml = _pvSubmitLabel(isPaseVisitaActive());
      for (const v of (seccionesAgregadas.vehiculo || [])) {
        const placa = v.placas || v.marca || 'vehículo';
        if (!v.seguro || !v.licencia || !v.tarjeta_circulacion) {
          alertEl.innerHTML = `❌ <strong>Vehículo "${placa}"</strong>: debe adjuntar seguro, licencia y tarjeta de circulación.`;
          alertEl.style.display = 'block';
          btn.disabled = false; btn.innerHTML = btnHtml; return;
        }
        if (!v.validacion_ok) {
          const ser = v.validacion_series_coinciden === false ? ' · Series no coinciden' : '';
          const seg = v.validacion_seguro_vigente   === false ? ' · Seguro vencido'      : '';
          const lic = v.validacion_licencia_vigente === false ? ' · Licencia vencida'    : '';
          alertEl.innerHTML = `❌ <strong>Vehículo "${placa}"</strong>: documentos no válidos${ser}${seg}${lic}.`;
          alertEl.style.display = 'block';
          btn.disabled = false; btn.innerHTML = btnHtml; return;
        }
      }
      // ── FIN VALIDACIÓN VEHÍCULOS ─────────────────────────

      const data = {
        empresa: document.getElementById('empresa').value,
        contrato: document.getElementById('contrato').value,
        responsable_contrato: document.getElementById('responsable_contrato').value
          || document.getElementById('responsable_input').value
          || '',
        responsable1: resp1,
        responsable2: resp2,
        responsable1_tel: tel1 || null,
        responsable2_tel: tel2 || null,
        fecha_inicio: document.getElementById('fecha_inicio').value,
        fecha_fin: document.getElementById('fecha_fin').value,
        secciones: seccionesAgregadas,
        firma_creacion_ubicacion: _ubicacionActual || 'No disponible',
        firma_creacion_ip_privada: ipPrivada,
        es_pase_visita: isPaseVisitaActive()
      };

      try {
        const res = await fetch('/solicitudes', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
        const result = await res.json();
        if (!result.success) { alertEl.textContent = result.error || 'Error.'; alertEl.style.display = 'block'; }
        else { closeModal(); cargarSolicitudes(); }
      } catch(err) {
        alertEl.textContent = 'Error de conexión.'; alertEl.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.innerHTML = _pvSubmitLabel(isPaseVisitaActive());
      }
    });
  }
  cargarSolicitudes();
});


// ===================== TABLA SOLICITUDES =====================
async function cargarSolicitudes() {
  const loading = document.getElementById('tableLoading');
  const table = document.getElementById('dataTable');
  const empty = document.getElementById('emptyState');
  loading.style.display = 'flex'; table.style.display = 'none'; empty.style.display = 'none';
  try {
    const res = await fetch('/solicitudes');
    const result = await res.json();
    if (result.success) { todosSolicitudes = result.data; renderTabla(todosSolicitudes); actualizarStats(todosSolicitudes); }
  } catch(err) { console.error(err); }
  finally { loading.style.display = 'none'; }
}

const ESTADO_INFO = {
  borrador:             { label: 'Borrador',               cls: 'status-vencido'   },
  en_espera_area:       { label: 'En espera del Área',     cls: 'status-pendiente' },
  aprobado_area:        { label: 'Aprobado por Área',      cls: 'status-aprobado_area' },
  en_espera_seguridad:  { label: 'En espera de Seguridad', cls: 'status-pendiente' },
  activo:               { label: 'Activo',                 cls: 'status-aprobado'  },
  rechazado:            { label: 'Rechazado',              cls: 'status-rechazado' },
  vencido:              { label: 'Vencido',                cls: 'status-vencido'   }
};

function puedeAprobar(estado) {
  if (USER_ROL === 'area'             && estado === 'en_espera_area')      return true;
  if (USER_ROL === 'seguridad_fisica' && estado === 'en_espera_seguridad') return true;
  return false;
}

/*
function renderTabla(solicitudes) {
  const tbody = document.getElementById('tableBody');
  const table = document.getElementById('dataTable');
  const empty = document.getElementById('emptyState');
  if (!solicitudes.length) { table.style.display='none'; empty.style.display='flex'; return; }
  table.style.display = 'table'; empty.style.display = 'none';
  tbody.innerHTML = solicitudes.map(p => {
    const dias = Math.ceil((new Date(p.fecha_fin) - new Date(p.fecha_inicio)) / (1000*60*60*24));
    const info  = ESTADO_INFO[p.estado] || { label: p.estado, cls: 'status-pendiente' };
    const badge = `<span class="status-badge ${info.cls}"><span class="status-dot-sm"></span>${info.label}</span>`;
    const verBtn = `<button class="action-btn ver-btn" onclick="verDetalle(${p.id})">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;vertical-align:middle;margin-right:3px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Ver
    </button>`;
    const acc = `<td style="white-space:nowrap">${verBtn}</td>`;
    return `<tr><td class="td-folio">${p.folio}</td><td class="td-empresa">${escapeHtml(p.empresa)}</td>
      <td>${escapeHtml(p.contrato)}</td><td class="td-responsable">${escapeHtml(p.responsable_contrato)}</td>
      <td>${formatFecha(p.fecha_inicio)}</td><td>${formatFecha(p.fecha_fin)}</td>
      <td><span class="duration-chip">${dias}d</span></td><td>${badge}</td>${acc}</tr>`;
  }).join('');
}
*/


// ===================== PAGINACIÓN =====================
let paginaActual = 1;
const REGISTROS_POR_PAGINA = 10;
let solicitudesFiltradas = [];

function renderTabla(solicitudes) {
  const tbody = document.getElementById('tableBody');
  const table = document.getElementById('dataTable');
  const empty = document.getElementById('emptyState');

  solicitudesFiltradas = solicitudes;
  paginaActual = 1;
  renderPagina();

  if (!solicitudes.length) { table.style.display='none'; empty.style.display='flex'; return; }
  table.style.display = 'table'; empty.style.display = 'none';
}

function renderPagina() {
  const tbody = document.getElementById('tableBody');
  const table = document.getElementById('dataTable');
  const empty = document.getElementById('emptyState');

  if (!solicitudesFiltradas.length) {
    table.style.display='none'; empty.style.display='flex';
    renderPaginador(0); return;
  }
  table.style.display = 'table'; empty.style.display = 'none';

  const total = solicitudesFiltradas.length;
  const totalPaginas = Math.ceil(total / REGISTROS_POR_PAGINA);
  if (paginaActual > totalPaginas) paginaActual = totalPaginas;

  const inicio = (paginaActual - 1) * REGISTROS_POR_PAGINA;
  const fin    = Math.min(inicio + REGISTROS_POR_PAGINA, total);
  const pagina = solicitudesFiltradas.slice(inicio, fin);

  tbody.innerHTML = pagina.map(p => {
    const dias = Math.ceil((new Date(p.fecha_fin) - new Date(p.fecha_inicio)) / (1000*60*60*24));
    const info  = ESTADO_INFO[p.estado] || { label: p.estado, cls: 'status-pendiente' };
    const badge = `<span class="status-badge ${info.cls}"><span class="status-dot-sm"></span>${info.label}</span>`;
    const verBtn = `<button class="action-btn ver-btn" onclick="verDetalle(${p.id})">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;vertical-align:middle;margin-right:3px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Ver
    </button>`;
    const pvBadge = p.es_pase_visita ? `<span style="display:inline-block;font-family:'Share Tech Mono',monospace;font-size:9px;background:var(--accent);color:#000;padding:1px 6px;letter-spacing:0.08em;font-weight:700;vertical-align:middle;margin-left:6px">PV</span>` : '';
    return `<tr><td class="td-folio">${p.folio}${pvBadge}</td><td class="td-empresa">${escapeHtml(p.empresa)}</td>
      <td>${escapeHtml(p.contrato)}</td><td class="td-responsable">${escapeHtml(p.responsable_contrato)}</td>
      <td>${formatFecha(p.fecha_inicio)}</td><td>${formatFecha(p.fecha_fin)}</td>
      <td><span class="duration-chip">${dias}d</span></td><td>${badge}</td>
      <td style="white-space:nowrap">${verBtn}</td></tr>`;
  }).join('');

  renderPaginador(total);
}

function renderPaginador(total) {
  // Eliminar paginador anterior si existe
  let prev = document.getElementById('tablePaginador');
  if (prev) prev.remove();

  if (total === 0) return;

  const totalPaginas = Math.ceil(total / REGISTROS_POR_PAGINA);
  const inicio = Math.min((paginaActual - 1) * REGISTROS_POR_PAGINA + 1, total);
  const fin    = Math.min(paginaActual * REGISTROS_POR_PAGINA, total);

  const div = document.createElement('div');
  div.id = 'tablePaginador';
  div.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--border);font-family:"Barlow",sans-serif;font-size:13px;color:var(--text-3);flex-wrap:wrap;gap:8px';

  // Info de registros
  const info = document.createElement('span');
  info.textContent = `Mostrando ${inicio}–${fin} de ${total} registros`;
  div.appendChild(info);

  // Botones de página
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:4px;align-items:center';

  const btnStyle = (activo) => `padding:4px 10px;border:1px solid var(--border);background:${activo ? 'var(--accent)' : 'var(--bg-2)'};color:${activo ? '#000' : 'var(--text-2)'};font-family:"Share Tech Mono",monospace;font-size:12px;cursor:pointer;font-weight:${activo?'700':'400'}`;

  // Anterior
  const btnPrev = document.createElement('button');
  btnPrev.textContent = '←';
  btnPrev.style.cssText = btnStyle(false);
  btnPrev.disabled = paginaActual === 1;
  btnPrev.style.opacity = paginaActual === 1 ? '0.4' : '1';
  btnPrev.onclick = () => { paginaActual--; renderPagina(); };
  btns.appendChild(btnPrev);

  // Páginas numeradas (máx 5 visibles)
  let startP = Math.max(1, paginaActual - 2);
  let endP   = Math.min(totalPaginas, startP + 4);
  if (endP - startP < 4) startP = Math.max(1, endP - 4);

  for (let i = startP; i <= endP; i++) {
    const btn = document.createElement('button');
    btn.textContent = i;
    btn.style.cssText = btnStyle(i === paginaActual);
    const pg = i;
    btn.onclick = () => { paginaActual = pg; renderPagina(); };
    btns.appendChild(btn);
  }

  // Siguiente
  const btnNext = document.createElement('button');
  btnNext.textContent = '→';
  btnNext.style.cssText = btnStyle(false);
  btnNext.disabled = paginaActual === totalPaginas;
  btnNext.style.opacity = paginaActual === totalPaginas ? '0.4' : '1';
  btnNext.onclick = () => { paginaActual++; renderPagina(); };
  btns.appendChild(btnNext);

  div.appendChild(btns);

  // Insertar después de la tabla
  const table = document.getElementById('dataTable');
  table.parentNode.insertBefore(div, table.nextSibling);
}


function actualizarStats(p) {
  document.getElementById('numTotal').textContent = p.length;
  document.getElementById('numPendiente').textContent = p.filter(x => x.estado === 'en_espera_area' || x.estado === 'en_espera_seguridad').length;
  document.getElementById('numAprobado').textContent  = p.filter(x => x.estado === 'activo').length;
}

function setFilter(filtro, btn) {
  filtroActual = filtro;
  document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
  btn.classList.add('active'); aplicarFiltros();
}
function filterTable() { aplicarFiltros(); }
function aplicarFiltros() {
  const s = (document.getElementById('searchInput').value||'').toLowerCase();
  let f = todosSolicitudes;
  if (filtroActual !== 'todos') f = f.filter(p=>p.estado===filtroActual);
  if (s) f = f.filter(p=>p.empresa.toLowerCase().includes(s)||p.contrato.toLowerCase().includes(s)||p.folio.toLowerCase().includes(s));
  solicitudesFiltradas = f;
paginaActual = 1;
renderPagina();
const table = document.getElementById('dataTable');
const empty = document.getElementById('emptyState');
if (!f.length) { table.style.display='none'; empty.style.display='flex'; } else { table.style.display='table'; empty.style.display='none'; }
}

async function aprobarSolicitud(id) {
  try {
    const res = await fetch(`/solicitudes/${id}/aprobar`, { method:'PUT', headers:{'Content-Type':'application/json'} });
    const r = await res.json();
    if (r.success) cargarSolicitudes();
    else alert(r.error || 'Error al aprobar.');
  } catch(e) { console.error(e); }
}

function abrirRechazo(id) {
  const motivo = prompt('Motivo de rechazo (opcional):');
  if (motivo === null) return;
  rechazarSolicitud(id, motivo);
}



async function rechazarSolicitud(id, motivo, ipPrivada, ubicacion) {
  try {
    const res = await fetch(`/solicitudes/${id}/rechazar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        motivo,
        firma_ubicacion: ubicacion || 'No disponible',
        firma_ip_privada: ipPrivada || null
      })
    });
    const r = await res.json();
    if (r.success) cargarSolicitudes();
    else alert(r.error || 'Error al rechazar.');
  } catch(e) { console.error(e); }
}





function formatFecha(f) {
  if (!f) return '—';
  const s = String(f).substring(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return '—';
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return `${d} ${meses[parseInt(m,10)-1]} ${y}`;
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
document.addEventListener('keydown', e => {
  if (e.key==='Escape') {
    if (document.getElementById('imgDocOverlay')) return;
    closeSidebar();
    closeModal();
  }
});

// =====================================================
// MODAL DETALLE
// =====================================================
let detalleSolicitudId = null;

async function verDetalle(id) {
  detalleSolicitudId = id;
  const modal    = document.getElementById('modalDetalle');
  const body     = document.getElementById('detalleBody');
  const folioEl  = document.getElementById('detalleFolio');
  const eyebrow  = document.getElementById('detalleEyebrow');
  const acciones = document.getElementById('detalleBtnAcciones');

  body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-3);font-size:13px;">Cargando datos...</div>`;
  acciones.innerHTML = '';
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  try {
    const [res, resLotes, resAccesos] = await Promise.all([
      fetch(`/solicitudes/${id}`),
      fetch(`/solicitudes/${id}/lotes`),
      fetch(`/solicitudes/${id}/accesos`)
    ]);
    if (!res.ok) { body.innerHTML = `<p style="padding:40px;color:var(--danger)">Error del servidor: ${res.status}</p>`; return; }
    const result        = await res.json();
    const lotesResult   = resLotes.ok   ? await resLotes.json()   : { success: false, data: [] };
    const accesosResult = resAccesos.ok ? await resAccesos.json() : { success: false, data: [] };
    if (!result.success) { body.innerHTML = `<p style="padding:40px;color:var(--danger)">${result.error}</p>`; return; }

    const { solicitud, personal, vehiculos, equipos } = result.data;
    const lotes = lotesResult.success ? lotesResult.data : [];

    // ── puedeRegistrar: SOLO contratista en solicitudes activas ──
    const puedeRegistrar = USER_ROL === 'contratista' && solicitud.estado === 'activo';

  
    // Calcular totales ya registrados por equipo
    // Solo contar lotes APROBADOS para el cálculo de disponibles
const salidasPorEquipo = {};
lotes.forEach(lote => {
  if (lote.estado !== 'aprobado') return; // ignorar pendientes y rechazados
  (lote.items || []).forEach(item => {
    if (item.tipo_item === 'equipo') {
      salidasPorEquipo[item.item_id] = (salidasPorEquipo[item.item_id] || 0) + parseInt(item.cantidad || 1);
    }
  });
});




    const info = ESTADO_INFO[solicitud.estado] || { label: solicitud.estado, cls: 'status-pendiente' };
    folioEl.textContent = solicitud.folio;
    eyebrow.innerHTML = `SOLICITUD &nbsp;/&nbsp; <span class="status-badge ${info.cls}" style="font-size:10px;padding:2px 10px"><span class="status-dot-sm"></span>${info.label}</span>`;

    if (puedeAprobar(solicitud.estado)) {
      acciones.innerHTML = `
        <button class="btn-aprobar" onclick="aprobarDesdeDetalle()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:15px;height:15px"><polyline points="20,6 9,17 4,12"/></svg>
          APROBAR
        </button>
        <button class="btn-danger" onclick="abrirRechazoDetalle()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:15px;height:15px"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          RECHAZAR
        </button>`;
    }

    if (solicitud.estado === 'activo') {
      acciones.innerHTML += `<a href="/solicitudes/${solicitud.id}/credenciales" target="_blank" class="btn-qr" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px">📄 DESCARGAR PASE EN PDF</a>`;
    }

    // Mostrar botón extender si está activo
    if (solicitud.estado === 'activo' && USER_ROL === 'seguridad_fisica' && !solicitud.es_pase_visita) {
      acciones.innerHTML += `
        <div style="display:flex;align-items:center;gap:8px">
          <input type="number" id="input-dias-ext" min="1" placeholder="Días" 
            style="width:80px;padding:8px 10px;background:var(--bg-2);border:1px solid var(--warning);color:var(--text);font-family:'Barlow',sans-serif;font-size:13px">
          <button onclick="extenderPermiso(${solicitud.id})" style="
            padding:8px 14px;background:var(--warning);color:#000;border:none;
            font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;
            letter-spacing:1px;cursor:pointer">
            + EXTENDER DÍAS
          </button>
          <span id="ext-status" style="font-size:12px;font-family:'Share Tech Mono',monospace"></span>
        </div>`;
    }


    body.innerHTML = `

    
      <!-- DATOS GENERALES -->
      <div class="detalle-section">
        <div class="detalle-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
          Datos Generales
        </div>

        <div class="detalle-grid">
        <div class="detalle-field"><div class="detalle-field-label">FOLIO</div><div class="detalle-field-value mono">${solicitud.folio}</div></div>
        <div class="detalle-field"><div class="detalle-field-label">EMPRESA</div><div class="detalle-field-value">${escapeHtml(solicitud.empresa)}</div></div>
        <div class="detalle-field"><div class="detalle-field-label">CONTRATO</div><div class="detalle-field-value">${escapeHtml(solicitud.contrato)}</div></div>
        <div class="detalle-field"><div class="detalle-field-label">RESPONSABLE DEL CONTRATO PROAGROINDUSTRIA</div><div class="detalle-field-value">${escapeHtml(solicitud.responsable_contrato)}</div></div>
        <div class="detalle-field"><div class="detalle-field-label">RESPONSABLE CONTRATISTA 1</div><div class="detalle-field-value">${escapeHtml(solicitud.responsable1||'—')}</div></div>
        ${solicitud.responsable1_tel ? `<div class="detalle-field"><div class="detalle-field-label">TEL. RESPONSABLE 1</div><div class="detalle-field-value mono">${escapeHtml(solicitud.responsable1_tel)}</div></div>` : ''}
        <div class="detalle-field"><div class="detalle-field-label">RESPONSABLE CONTRATISTA 2</div><div class="detalle-field-value">${escapeHtml(solicitud.responsable2||'—')}</div></div>
        ${solicitud.responsable2_tel ? `<div class="detalle-field"><div class="detalle-field-label">TEL. RESPONSABLE 2</div><div class="detalle-field-value mono">${escapeHtml(solicitud.responsable2_tel)}</div></div>` : ''}
        <div class="detalle-field"><div class="detalle-field-label">FECHA INICIO</div><div class="detalle-field-value">${formatFecha(solicitud.fecha_inicio)}</div></div>
        <div class="detalle-field"><div class="detalle-field-label">FECHA FIN</div><div class="detalle-field-value">${formatFecha(solicitud.fecha_fin)}</div></div>
       
        <div class="detalle-field"><div class="detalle-field-label">FECHA CREACIÓN</div><div class="detalle-field-value">${formatFecha(solicitud.creado_en)}</div></div>
        ${solicitud.motivo_rechazo ? `<div class="detalle-field" style="grid-column:span 3"><div class="detalle-field-label" style="color:#ef4444">MOTIVO DE RECHAZO</div><div class="detalle-field-value" style="color:#ef4444">${escapeHtml(solicitud.motivo_rechazo)}</div></div>` : ''}
      </div>

      </div>

      <!-- FLUJO DE APROBACIÓN -->
      <div class="detalle-section">
        <div class="detalle-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/></svg>
          Flujo de Aprobación
        </div>
        <div class="detalle-timeline">${buildTimeline(solicitud)}</div>
      </div>

      <!-- PERSONAL — solo vista, sin checkboxes ni estado salida -->
      ${personal.length > 0 ? `
      <div class="detalle-section">
        <div class="detalle-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          Personal (${personal.length} registros)
        </div>
        <table class="detalle-table">
          <thead><tr>
            <th>#</th><th>NO. CREDENCIAL</th><th>NOMBRE</th><th>CATEGORÍA</th><th>CREDENCIAL</th>
          </tr></thead>
          <tbody>${personal.map((pers,i) => `<tr>
            <td style="color:var(--text-3);font-family:'Share Tech Mono',monospace">${i+1}</td>
            <td style="font-family:'Share Tech Mono',monospace;color:var(--accent)">${escapeHtml(pers.num_credencial||'—')}</td>
            <td style="color:var(--text);font-weight:500">
              ${escapeHtml(pers.nombre||'—')}
            </td>
            <td>${escapeHtml(pers.categoria||'—')}</td>
            <td>${pers.cred_base64 ? `<img src="data:${pers.cred_mime};base64,${pers.cred_base64}" onclick="verImgDoc(this.src)" style="height:36px;cursor:pointer;border:1px solid var(--border);object-fit:cover" title="Ver credencial">` : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}

      <!-- VEHÍCULOS — solo vista, sin checkboxes ni estado salida -->
      ${vehiculos.length > 0 ? `
      <div class="detalle-section">
        <div class="detalle-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
          Vehículos (${vehiculos.length} registros)
        </div>
        <table class="detalle-table">
          <thead><tr>
             <th>#</th><th>MARCA</th><th>MODELO</th><th>PLACAS</th><th>SEGURO</th><th>TARJETA CIRC.</th><th>LICENCIA</th>
          </tr></thead>
          <tbody>${vehiculos.map((v,i) => `<tr>
            <td style="color:var(--text-3);font-family:'Share Tech Mono',monospace">${i+1}</td>
            <td style="color:var(--text);font-weight:500">${escapeHtml(v.marca||'—')}</td>
            <td>${escapeHtml(v.modelo||'—')}</td>
            <td style="font-family:'Share Tech Mono',monospace;color:var(--accent)">${escapeHtml(v.placas||'—')}</td>
            <td>${v.seguro && (v.seguro.startsWith('/9j') || v.seguro.startsWith('iVB') || v.seguro.startsWith('data:')) ?
              `<img src="${v.seguro.startsWith('data:') ? v.seguro : 'data:image/jpeg;base64,' + v.seguro}" onclick="verImgDoc(this.src)" style="height:36px;cursor:pointer;border:1px solid var(--border);object-fit:cover" title="Ver seguro">`
              : (v.seguro ? '✅' : '—')}</td>
            
            <td>${v.tarjeta && (v.tarjeta.startsWith('/9j') || v.tarjeta.startsWith('iVB') || v.tarjeta.startsWith('data:')) ?
              `<img src="${v.tarjeta.startsWith('data:') ? v.tarjeta : 'data:image/jpeg;base64,' + v.tarjeta}" onclick="verImgDoc(this.src)" style="height:36px;cursor:pointer;border:1px solid var(--border);object-fit:cover" title="Ver tarjeta de circulación">`
              : (v.tarjeta ? '✅' : '—')}</td>
            <td>${v.licencia && (v.licencia.startsWith('/9j') || v.licencia.startsWith('iVB') || v.licencia.startsWith('data:')) ?
              `<img src="${v.licencia.startsWith('data:') ? v.licencia : 'data:image/jpeg;base64,' + v.licencia}" onclick="verImgDoc(this.src)" style="height:36px;cursor:pointer;border:1px solid var(--border);object-fit:cover" title="Ver licencia">`
              : (v.licencia ? '✅' : '—')}</td>


          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}

      <!-- EQUIPOS — con checkboxes y cantidad a sacar solo para contratista -->
      ${equipos.length > 0 ? `
      <div class="detalle-section">
        <div class="detalle-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          Equipo / Herramientas (${equipos.length} registros)
          ${puedeRegistrar ? '<span class="sec-hint">— indica cantidad a sacar</span>' : ''}
        </div>
        <table class="detalle-table">
          <thead><tr>
            ${puedeRegistrar ? '<th style="width:40px"></th>' : ''}
            <th>#</th><th>DESCRIPCIÓN</th><th>MARCA</th><th>MODELO</th><th>AUTORIZADOS</th><th>YA SALIERON</th><th>DISPONIBLES</th>
            ${puedeRegistrar ? '<th>CANT. A SACAR</th>' : ''}
          </tr></thead>
          <tbody>${equipos.map((e,i) => {
            const totalSalido = salidasPorEquipo[e.id] || 0;
            const disponible  = (e.cantidad||1) - totalSalido;
            const agotado     = disponible <= 0;
            return `<tr>
              ${puedeRegistrar ? `<td style="text-align:center">${agotado ? '' : `<input type="checkbox" class="chk-item" data-tipo="equipo" data-id="${e.id}" onchange="toggleRegistrarSalida()">`}</td>` : ''}
              <td style="color:var(--text-3);font-family:'Share Tech Mono',monospace">${i+1}</td>
              <td style="color:var(--text);font-weight:500">${escapeHtml(e.descripcion||'—')}</td>
              <td>${escapeHtml(e.marca||'—')}</td>
              <td>${escapeHtml(e.modelo||'—')}</td>
              <td style="font-family:'Share Tech Mono',monospace;text-align:center;color:var(--accent)">${e.cantidad||1}</td>
              <td style="font-family:'Share Tech Mono',monospace;text-align:center;color:${totalSalido>0?'var(--warning)':'var(--text-3)'}">${totalSalido}</td>
              <td style="font-family:'Share Tech Mono',monospace;text-align:center;font-weight:700;color:${agotado?'var(--danger)':'var(--success)'}">${disponible}</td>
              ${puedeRegistrar ? `<td>${agotado
                ? '<span class="salida-badge salida-agotado">Agotado</span>'
                : `<input type="number" class="salida-qty-input qty-equipo" id="qty-${e.id}" data-id="${e.id}" min="1" max="${disponible}" value="1">`
              }</td>` : ''}
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>` : ''}

      <!-- BOTÓN REGISTRAR LOTE (solo contratista en activo, solo si hay equipos) -->
      ${puedeRegistrar && equipos.length > 0 ? `
      <div id="registrar-lote-section" class="detalle-section" style="display:none;background:rgba(245,158,11,0.04);border-top:2px solid rgba(245,158,11,0.2)">
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <div style="flex:1;display:flex;flex-direction:column;gap:10px">
            <div>
              <div class="detalle-field-label" style="margin-bottom:5px">RESPONSABLE DEL RETIRO *</div>
              <select id="lote-responsable" style="width:100%;max-width:340px;padding:8px 10px;border:1px solid var(--accent);background:var(--bg-2);color:var(--text);font-family:'Barlow',sans-serif;font-size:13px">
                <option value="">— Selecciona responsable —</option>
                ${solicitud.responsable1 ? `<option value="${escapeHtml(solicitud.responsable1)}">${escapeHtml(solicitud.responsable1)}</option>` : ''}
                ${solicitud.responsable2 ? `<option value="${escapeHtml(solicitud.responsable2)}">${escapeHtml(solicitud.responsable2)}</option>` : ''}
              </select>
            </div>
            <div>
              <div class="detalle-field-label" style="margin-bottom:5px">OBSERVACIONES (opcional)</div>
              <input type="text" id="lote-obs" class="form-input" placeholder="Ej: Salida para trabajo en bodega norte..." style="width:100%;max-width:500px">
            </div>
          </div>
          <button class="btn-registrar-lote" id="btnRegistrarLote" onclick="registrarLote(${solicitud.id})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px"><polyline points="9,11 12,14 22,4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            REGISTRAR SALIDA
          </button>
        </div>
        <div id="lote-feedback" style="margin-top:10px;font-size:13px;display:none"></div>
      </div>` : ''}

      <!-- HISTORIAL DE LOTES -->
      ${lotes.length > 0 ? `
      <div class="detalle-section">
        <div class="detalle-section-title" style="color:var(--warning)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          Bitácora de Salidas (${lotes.length} lote${lotes.length!==1?'s':''})
        </div>
        <div class="lotes-lista">
          ${lotes.map((lote, li) => `
          <div class="lote-card">

           
          <div class="lote-header" onclick="toggleLote(${lote.id})">
            <div class="lote-header-left">
              <span class="lote-num">LOTE #${lotes.length - li}</span>
              <!-- ✅ FOLIO DEL LOTE -->
            
              <span class="lote-fecha">${formatHora(lote.registrado_en)}</span>
              <span class="lote-quien">por ${escapeHtml(lote.registrado_por_nombre||'—')}</span>
              <!-- ✅ RESPONSABLE DEL RETIRO -->
              <span class="lote-resp" style="font-size:11px;color:var(--text-2)">resp: ${escapeHtml(lote.responsable_nombre||'—')}</span>
              ${lote.observaciones ? `<span class="lote-obs-preview">"${escapeHtml(lote.observaciones)}"</span>` : ''}
            </div>
            <div class="lote-header-right">
              <!-- ✅ BADGE DE ESTADO -->
              <span style="padding:2px 8px;font-family:'Share Tech Mono',monospace;font-size:10px;font-weight:700;border-radius:2px;
                
              background:${lote.estado==='aprobado'?'#dcfce7':lote.estado==='rechazado'||lote.estado==='rechazado_area'?'#fee2e2':lote.estado==='aprobado_area'?'#dbeafe':'#fef3c7'};
              color:${lote.estado==='aprobado'?'#166534':lote.estado==='rechazado'||lote.estado==='rechazado_area'?'#991b1b':lote.estado==='aprobado_area'?'#1e40af':'#92400e'}">
              ${(lote.estado||'pendiente').toUpperCase()}
              </span>
            
              
              <!-- ✅ BOTONES PARA SEGURIDAD FÍSICA -->
              ${USER_ROL === 'area' && lote.estado === 'pendiente' ? `
                <button onclick="event.stopPropagation();aprobarLoteAreaBtn(${lote.id},this)" style="padding:3px 10px;background:#dcfce7;color:#166534;border:1px solid #22c55e;font-family:'Share Tech Mono',monospace;font-size:10px;cursor:pointer">✓ APROBAR</button>
                <button onclick="event.stopPropagation();abrirRechazoLoteArea(${lote.id})" style="padding:3px 10px;background:#fee2e2;color:#991b1b;border:1px solid #ef4444;font-family:'Share Tech Mono',monospace;font-size:10px;cursor:pointer">✗ RECHAZAR</button>
              ` : ''}
              ${USER_ROL === 'seguridad_fisica' && lote.estado === 'aprobado_area' ? `
                <button onclick="event.stopPropagation();aprobarLoteSeguridad(${lote.id},this)" style="padding:3px 10px;background:#dcfce7;color:#166534;border:1px solid #22c55e;font-family:'Share Tech Mono',monospace;font-size:10px;cursor:pointer">✓ APROBAR</button>
                <button onclick="event.stopPropagation();abrirRechazoLote(${lote.id})" style="padding:3px 10px;background:#fee2e2;color:#991b1b;border:1px solid #ef4444;font-family:'Share Tech Mono',monospace;font-size:10px;cursor:pointer">✗ RECHAZAR</button>
              ` : ''}


              <!-- ✅ BOTÓN PDF SIEMPRE VISIBLE -->
              <a href="/solicitudes/lote/${lote.id}/pdf" target="_blank" onclick="event.stopPropagation()" style="padding:3px 10px;background:transparent;color:var(--text-2);border:1px solid var(--border);font-family:'Share Tech Mono',monospace;font-size:10px;text-decoration:none">Formato PDF</a>
              <svg class="lote-chevron" id="chev-${lote.id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;transition:transform 0.2s"><polyline points="6,9 12,15 18,9"/></svg>
            </div>
          </div>







            
            
            <div class="lote-detalle" id="lote-${lote.id}">
              <table class="detalle-table" style="margin-top:8px">
                
                <thead><tr><th>CANT.</th><th>DESCRIPCIÓN</th><th>MARCA</th><th>MODELO</th></tr></thead>
                <tbody>
                  ${(lote.items || []).map(item => {
                    // PASO A: Definimos valores por defecto (guiones)



                    let marca = '—';
                    let modelo = '—';

                    // PASO B: Si el item es un equipo, buscamos sus datos reales
                    if (item.tipo_item === 'equipo') {
                      // 'equipos' es la variable que ya tienes cargada arriba en tu función
                      const eq = equipos.find(e => e.id == item.item_id);
                      if (eq) {
                        marca = escapeHtml(eq.marca || '—');
                        modelo = escapeHtml(eq.modelo || '—');
                      }
                    }

                    // PASO C: Dibujamos la fila con las 5 columnas (ahora sí coinciden con el encabezado)
                    return `
<tr>
  <td style="font-family:'Share Tech Mono',monospace;text-align:center;color:var(--warning);font-weight:700">${item.cantidad || 1}</td>
  <td style="color:var(--text);font-weight:500">${escapeHtml(item.descripcion || String(item.item_id))}</td>
  <td style="font-size:11px;color:var(--text-2)">${marca}</td>
  <td style="font-size:11px;color:var(--text-2)">${modelo}</td>
</tr>`;
                     
                         
                     
                        }).join('')}
                </tbody>
              </table>
                      




                ${lote.firma_registro_ip_privada ? `
                <div style="margin-top:8px;padding:6px 12px;background:rgba(201,162,39,0.06);border:1px solid rgba(201,162,39,0.2);font-size:11px;font-family:'Share Tech Mono',monospace">
                  <span style="color:var(--accent);font-weight:700">Solicitud:</span>
                  <span style="color:var(--text-3);margin-left:6px">${escapeHtml(lote.firma_registro_usuario||'—')} / ${escapeHtml(lote.firma_registro_ip_privada||'—')} / ${escapeHtml(lote.firma_registro_ubicacion||'—')} / ${lote.registrado_en ? formatHora(lote.registrado_en) : '—'}</span>
                </div>` : ''}
                ${lote.firma_area_ip_privada ? `
                <div style="margin-top:4px;padding:6px 12px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.2);font-size:11px;font-family:'Share Tech Mono',monospace">
                  <span style="color:#3b82f6;font-weight:700">Área:</span>
                  <span style="color:var(--text-3);margin-left:6px">${escapeHtml(lote.firma_area_usuario||'—')} / ${escapeHtml(lote.firma_area_ip_privada||'—')} / ${escapeHtml(lote.firma_area_ubicacion||'—')} / ${lote.fecha_aprobacion_area ? formatHora(lote.fecha_aprobacion_area) : '—'}</span>
                </div>` : ''}
                ${(lote.firma_aprobacion_ip || lote.firma_aprobacion_ip_privada) ? `
                <div style="margin-top:4px;padding:6px 12px;background:rgba(22,163,74,0.06);border:1px solid rgba(22,163,74,0.2);font-size:11px;font-family:'Share Tech Mono',monospace">
                  <span style="color:var(--success);font-weight:700">Autorización:</span>
                  <span style="color:var(--text-3);margin-left:6px">${escapeHtml(lote.firma_aprobacion_usuario||'—')} / ${escapeHtml(lote.firma_aprobacion_ip_privada||'—')} / ${escapeHtml(lote.firma_aprobacion_ubicacion||'—')} / ${lote.fecha_aprobacion ? formatHora(lote.fecha_aprobacion) : '—'}</span>
                </div>` : ''}






            </div>
          </div>`).join('')}
        </div>
      </div>` : ''}
    `;

  } catch(e) {
    body.innerHTML = `<p style="padding:40px;color:var(--danger)">Error al cargar los datos: ${e.message}</p>`;
    console.error(e);
  }
}

function toggleAll(tipo, checked) {
  document.querySelectorAll(`.chk-item[data-tipo="${tipo}"]`).forEach(c => c.checked = checked);
  toggleRegistrarSalida();
}

function toggleRegistrarSalida() {
  const haySeleccionado = document.querySelectorAll('.chk-item:checked').length > 0;
  const seccion = document.getElementById('registrar-lote-section');
  if (seccion) seccion.style.display = haySeleccionado ? '' : 'none';
}

function toggleLote(id) {
  const el   = document.getElementById(`lote-${id}`);
  const chev = document.getElementById(`chev-${id}`);
  const open = el.classList.toggle('open');
  if (chev) chev.style.transform = open ? 'rotate(180deg)' : '';
}






async function registrarLote(solicitud_id) {
  const items = [];
  document.querySelectorAll('.chk-item:checked').forEach(chk => {
    const tipo  = chk.dataset.tipo;
    const id    = parseInt(chk.dataset.id);
    if (isNaN(id)) return;
    let cantidad = 1;
    if (tipo === 'equipo') {
      const qInput = document.getElementById(`qty-${id}`);
      cantidad = qInput ? parseInt(qInput.value) || 1 : 1;
    }
    items.push({ tipo_item: tipo, item_id: id, cantidad });
  });
  if (items.length === 0) { mostrarFeedback('Selecciona al menos un item para registrar.', 'error'); return; }
  
  // ✅ NUEVO: Validar responsable
  const responsable = document.getElementById('lote-responsable')?.value;
  if (!responsable) { 
    mostrarFeedback('Selecciona un responsable del retiro.', 'error'); 
    return; 
  }

  const obs = document.getElementById('lote-obs')?.value?.trim() || null;
  const btn = document.getElementById('btnRegistrarLote');
  if (btn) { btn.disabled = true; btn.textContent = 'Registrando...'; }
  try {
    const ipPrivadaLote = await obtenerIPPrivada();
    const res = await fetch(`/solicitudes/${solicitud_id}/lote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        items, 
        observaciones: obs, 
        responsable_nombre: responsable,
        firma_registro_ubicacion: _ubicacionActual || 'No disponible',
        firma_registro_ip_privada: ipPrivadaLote
      })
    });
    const r = await res.json();
    if (r.success) {
      verDetalle(solicitud_id);
    } else {
      if (btn) { btn.disabled = false; btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px"><polyline points="9,11 12,14 22,4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> REGISTRAR SALIDA`; }
      mostrarFeedback(r.error || 'Error al registrar.', 'error');
    }
  } catch(e) {
    console.error(e);
    if (btn) { btn.disabled = false; }
    mostrarFeedback('Error de conexión.', 'error');
  }
}











function mostrarFeedback(msg, tipo) {
  const el = document.getElementById('lote-feedback');
  if (!el) return;
  el.style.display = 'block';
  el.style.color = tipo === 'error' ? 'var(--danger)' : 'var(--success)';
  el.textContent = msg;
}

function buildTimeline(solicitud) {
   const areaAprobó = !!solicitud.firma_area_ip;
  const pasos = [
    {
      label: 'Creado por Contratista',
      meta: solicitud.creado_por_nombre,
      fecha: solicitud.creado_en,
      firma_ip: solicitud.firma_creacion_ip_privada,
      firma_ub: solicitud.firma_creacion_ubicacion,
      firma_fecha: solicitud.firma_creacion_fecha
    },
    {
      label: 'Revisión del Área',
      meta: solicitud.aprobado_area_nombre || solicitud.rechazado_por_nombre,
      fecha: solicitud.fecha_aprobacion_area || solicitud.fecha_rechazo,
      firma_ip: solicitud.firma_area_ip_privada || (!areaAprobó ? solicitud.firma_rechazo_ip_privada : null),
      firma_ub: solicitud.firma_area_ubicacion || (!areaAprobó ? solicitud.firma_rechazo_ubicacion : null),
      firma_fecha: solicitud.firma_area_fecha || (!areaAprobó ? solicitud.firma_rechazo_fecha : null)
    },
    {
      label: 'Validación de Seguridad',
      meta: solicitud.aprobado_seg_nombre || (areaAprobó ? solicitud.rechazado_por_nombre : null),
      fecha: solicitud.fecha_aprobacion_seg || (areaAprobó ? solicitud.fecha_rechazo : null),
      firma_ip: solicitud.firma_aprobacion_ip_privada || (areaAprobó ? solicitud.firma_rechazo_ip_privada : null),
      firma_ub: solicitud.firma_aprobacion_ubicacion || (areaAprobó ? solicitud.firma_rechazo_ubicacion : null),
      firma_fecha: solicitud.firma_aprobacion_fecha || (areaAprobó ? solicitud.firma_rechazo_fecha : null)
    },
  ];
 

  return pasos.map((paso, i) => {
    let dotClass = '', icono = '○';

    if (solicitud.estado === 'rechazado') {
      const pasoRechazo = areaAprobó ? 2 : 1;
      if (i === 0) { dotClass = 'done'; icono = '✓'; }
      else if (i < pasoRechazo) { dotClass = 'done'; icono = '✓'; }
      else if (i === pasoRechazo) { dotClass = 'rejected'; icono = '✕'; }
      else { dotClass = ''; icono = '○'; }
    } else if (solicitud.estado === 'vencido') {
      const segAprobó = !!(solicitud.aprobado_seg_nombre || solicitud.firma_aprobacion_ip_privada);
      if (i === 0) { dotClass = 'done'; icono = '✓'; }
      else if (i === 1 && areaAprobó) { dotClass = 'done'; icono = '✓'; }
      else if (i === 2 && segAprobó) { dotClass = 'done'; icono = '✓'; }
    } else {
      const orden = ['en_espera_area','aprobado_area','en_espera_seguridad','activo'];
      const idxActual = orden.indexOf(solicitud.estado);
      if (i === 0) { dotClass = 'done'; icono = '✓'; }
      else if (i < idxActual || solicitud.estado === 'activo') { dotClass = 'done'; icono = '✓'; }
      else if (i === idxActual) { dotClass = 'active'; icono = '●'; }
    }

    const tienefirma = dotClass === 'done' || dotClass === 'rejected';
    const tooltipId = `tooltip-firma-${i}`;
    const tooltipHtml = tienefirma ? `
      <div id="${tooltipId}" style="display:none;position:absolute;left:34px;top:-6px;z-index:999;
        background:#f5f5f5;border:1px solid #ddd;padding:8px 12px;
        font-family:'Share Tech Mono',monospace;font-size:11px;color:#1a1a1a;white-space:nowrap;
        box-shadow:0 2px 8px rgba(0,0,0,0.12)">
        <div style="color:#c9a227;font-size:9px;font-weight:700;margin-bottom:3px;letter-spacing:0.5px">✍ FIRMA DIGITAL</div>
        <div style="color:#333">${escapeHtml(paso.firma_usuario||paso.meta||'—')} / ${escapeHtml(paso.firma_ip||'—')} / ${escapeHtml(paso.firma_ub||'—')} / ${paso.firma_fecha ? formatHora(paso.firma_fecha) : '—'}</div>
      </div>` : '';

    return `<div class="timeline-step" style="position:relative">
      <div class="timeline-dot ${dotClass}"
        ${tienefirma ? `
          onmouseenter="document.getElementById('${tooltipId}').style.display='block'"
          onmouseleave="document.getElementById('${tooltipId}').style.display='none'"
          style="cursor:pointer"` : ''}
      >${icono}</div>
      ${tooltipHtml}
      <div class="timeline-info">
        <div class="timeline-label">${paso.label}</div>
        <div class="timeline-meta">${paso.meta ? escapeHtml(paso.meta) : '—'}${paso.fecha ? ' · ' + formatFecha(paso.fecha) : ''}</div>
      </div>
    </div>`;
  }).join('');
}










function closeDetalle(e) {}
function closeDetalleBtn() {
  document.getElementById('modalDetalle').classList.remove('open');
  document.body.style.overflow = '';
  detalleSolicitudId = null;
}

async function aprobarDesdeDetalle() {
  if (!detalleSolicitudId) return;
  const id = detalleSolicitudId;
  try {
    const ipPrivada = await obtenerIPPrivada();
    const res = await fetch(`/solicitudes/${id}/aprobar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firma_ubicacion: _ubicacionActual || 'No disponible',
        firma_ip_privada: ipPrivada
      })
    });
    const r = await res.json();
    if (!r.success) { alert(r.error || 'Error al aprobar.'); return; }
    cargarSolicitudes();
    closeDetalleBtn();
  } catch(e) { console.error(e); alert('Error de conexión.'); }
}

function abrirRechazoDetalle() {
  document.getElementById('motivoTexto').value = '';
  document.getElementById('modalMotivo').classList.add('open');
}
function closeMotivo() { document.getElementById('modalMotivo').classList.remove('open'); }






// Mantener compatibilidad
function abrirRechazo(id) { detalleSolicitudId = id; abrirRechazoDetalle(); }

// =====================================================
// BITÁCORA DE SALIDAS
// =====================================================
async function registrarSalida(solicitud_id, tipo_item, item_id, cantidad) {
  try {
    const res = await fetch(`/solicitudes/${solicitud_id}/salida`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo_item, item_id, cantidad: cantidad || 1, observaciones: null })
    });
    const r = await res.json();
    if (r.success) { verDetalle(solicitud_id); }
    else { alert(r.error || 'Error al registrar salida.'); }
  } catch(e) { console.error(e); alert('Error de conexión.'); }
}

async function registrarSalidaEquipo(solicitud_id, item_id, disponible) {
  const input = document.getElementById(`qty-${item_id}`);
  const cantidad = parseInt(input ? input.value : 1) || 1;
  if (cantidad < 1) { alert('La cantidad debe ser al menos 1.'); return; }
  if (cantidad > disponible) { alert(`Solo hay ${disponible} unidades disponibles.`); return; }
  await registrarSalida(solicitud_id, 'equipo', item_id, cantidad);
}

function formatHora(f) {
  if (!f) return '—';
  const d = new Date(f);
  if (isNaN(d)) return '—';
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const fecha = `${String(d.getDate()).padStart(2,'0')} ${meses[d.getMonth()]} ${d.getFullYear()}`;
  const hora  = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return `${fecha} ${hora}`;
}

// =====================================================
// QR
// =====================================================
let qrInstance = null;

function buildQRText(data) {
  const { solicitud } = data;
  return ['PROAGRO - SOLICITUD ACTIVO', `FOLIO: ${solicitud.folio}`, `EMPRESA: ${solicitud.empresa.substring(0,40)}`, `INICIO: ${formatFecha(solicitud.fecha_inicio)}`, `FIN: ${formatFecha(solicitud.fecha_fin)}`, `AUTORIZADO: ${(solicitud.aprobado_seg_nombre||'').substring(0,30)}`].join('\n');
}

function buildTextoCompleto(data) {
  const { solicitud, personal, vehiculos, equipos } = data;
  const lineas = [];
  lineas.push('===== SOLICITUD DE ACCESO PROAGRO =====');
  lineas.push(`FOLIO:        ${solicitud.folio}`);
  lineas.push(`EMPRESA:      ${solicitud.empresa}`);
  lineas.push(`CONTRATO:     ${solicitud.contrato}`);
  lineas.push(`RESPONSABLE:  ${solicitud.responsable_contrato}`);
  lineas.push(`INICIO:       ${formatFecha(solicitud.fecha_inicio)}`);
  lineas.push(`FIN:          ${formatFecha(solicitud.fecha_fin)}`);
  lineas.push(`ESTADO:       ACTIVO`);
  lineas.push(`AUTORIZADO:   ${solicitud.aprobado_seg_nombre || '—'}`);
  lineas.push('');
  if (personal && personal.length > 0) { lineas.push(`----- PERSONAL (${personal.length}) -----`); personal.forEach((p,i) => lineas.push(`${i+1}. ${p.nombre} | Cred: ${p.num_credencial||'—'} | ${p.categoria||'—'}`)); lineas.push(''); }
  if (vehiculos && vehiculos.length > 0) { lineas.push(`----- VEHÍCULOS (${vehiculos.length}) -----`); vehiculos.forEach((v,i) => lineas.push(`${i+1}. ${v.marca} ${v.modelo} | Placas: ${v.placas}`)); lineas.push(''); }
  if (equipos && equipos.length > 0) { lineas.push(`----- EQUIPO/HERRAMIENTAS (${equipos.length}) -----`); equipos.forEach((e,i) => lineas.push(`${i+1}. ${e.descripcion} | Cant: ${e.cantidad} | ${e.marca||'—'}`)); }
  lineas.push(''); lineas.push(`Generado: ${new Date().toLocaleString('es-MX')}`);
  return lineas.join('\n');
}

function mostrarQR(data) {
  const { solicitud } = data;
  document.getElementById('qrFolio').textContent = solicitud.folio;
  document.getElementById('qrInfo').textContent = buildTextoCompleto(data);
  const canvas = document.getElementById('qrCanvas');
  canvas.innerHTML = ''; qrInstance = null;
  qrInstance = new QRCode(canvas, { text: buildQRText(data), width: 240, height: 240, colorDark: '#0f0f0f', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.L });
  document.getElementById('modalQR').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeQR(e) {}
function closeQRBtn() { document.getElementById('modalQR').classList.remove('open'); document.body.style.overflow = ''; }

function descargarQR() {
  const canvas = document.querySelector('#qrCanvas canvas') || document.querySelector('#qrCanvas img');
  if (!canvas) return;
  const folio = document.getElementById('qrFolio').textContent || 'solicitud';
  const link = document.createElement('a');
  link.download = `QR-${folio}.png`;
  link.href = canvas.tagName === 'CANVAS' ? canvas.toDataURL('image/png') : canvas.src;
  link.click();
}

async function verQRSolicitud(id) {
  try {
    const res = await fetch(`/solicitudes/${id}`);
    const r = await res.json();
    if (r.success) mostrarQR(r.data);
    else alert('Error al cargar datos de la solicitud.');
  } catch(e) { console.error(e); }
}

// =====================================================
// RECONOCIMIENTO FACIAL
// =====================================================
let facialDescriptorEnrol = null;
let facialModelos = false;
let tipoMovimiento = 'entrada';

function setTipoMovimiento(tipo) {
  tipoMovimiento = tipo;
  const btnEntrada = document.getElementById('btn-entrada');
  const btnSalida  = document.getElementById('btn-salida');
  if (!btnEntrada || !btnSalida) return;
  if (tipo === 'entrada') { btnEntrada.style.background = 'var(--accent)'; btnEntrada.style.color = '#000'; btnSalida.style.background = 'var(--dark-4)'; btnSalida.style.color = 'var(--text-2)'; }
  else { btnSalida.style.background = '#ef4444'; btnSalida.style.color = '#fff'; btnEntrada.style.background = 'var(--dark-4)'; btnEntrada.style.color = 'var(--text-2)'; }
}

if (typeof USER_ROL !== 'undefined' && USER_ROL === 'seguridad_fisica') {
  Facial.cargarModelos().then(ok => { facialModelos = ok; });
}

async function abrirFacialVerificar() {
  document.getElementById('modalVerificar').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('verif-result').className = 'facial-result';
  document.getElementById('verif-result').textContent = '';
  document.getElementById('btn-verif-capturar').disabled = true;
  const statusEl = document.getElementById('verif-status');
  statusEl.className = 'facial-status'; statusEl.textContent = '⏳ Iniciando cámara...';
  if (!facialModelos) { statusEl.className = 'facial-status warn'; statusEl.textContent = '⏳ Cargando modelos faciales...'; facialModelos = await Facial.cargarModelos(); }
  const ok = await Facial.iniciarCamara('verif-video', 'verif-canvas');
  if (!ok) { statusEl.className = 'facial-status error'; statusEl.textContent = '❌ No se pudo acceder a la cámara'; return; }
  
  Facial.iniciarDeteccion(
  () => { statusEl.className = 'facial-status ok'; statusEl.textContent = '✅ Rostro detectado — listo para verificar'; const b = document.getElementById('btn-verif-capturar'); if(b) b.disabled = false; },
  () => { statusEl.className = 'facial-status error'; statusEl.textContent = '❌ Sin rostro — colócate frente a la cámara'; const b = document.getElementById('btn-verif-capturar'); if(b) b.disabled = true; }

  );
}

async function verificarRostro() {
  const btn = document.getElementById('btn-verif-capturar');
  const resultEl = document.getElementById('verif-result');
  btn.disabled = true; btn.textContent = '⏳ Verificando...';
  const descriptor = Facial.ultimoDescriptor || await Facial.obtenerDescriptor();
  if (!descriptor) { resultEl.className = 'facial-result denegado'; resultEl.textContent = '❌ No se detectó rostro'; btn.disabled = false; btn.textContent = 'VERIFICAR'; return; }
  const r = await Facial.verificar(descriptor, tipoMovimiento);
  if (r.acceso === 'permitido') {
    const icono = r.tipo_movimiento === 'salida' ? '↑' : '↓';
    const mov   = r.tipo_movimiento === 'salida' ? 'SALIDA' : 'ENTRADA';
    const permInfo = r.solicitud ? `<div style="font-size:12px;margin-top:6px;opacity:0.8">Solicitud: ${r.solicitud.folio} · ${r.solicitud.empresa}</div>` : `<div style="font-size:12px;margin-top:6px;color:#f59e0b">⚠️ Sin solicitud activo hoy</div>`;
    resultEl.className = 'facial-result permitido';
    resultEl.innerHTML = `${icono} ${mov} — ${r.empleado.nombre} ${r.empleado.apellido}<br><span style="font-size:13px">${r.empleado.area||''} · ${r.hora||''}</span>${permInfo}`;
  } else {
    resultEl.className = 'facial-result denegado'; resultEl.textContent = '❌ Rostro no reconocido';
  }
  btn.disabled = false; btn.textContent = 'VERIFICAR';
}

function cerrarFacialVerificar() { Facial.detenerCamara(); document.getElementById('modalVerificar').classList.remove('open'); document.body.style.overflow = ''; }

async function abrirFacialEnrolar() {
  document.getElementById('modalEnrolar').classList.add('open');
  document.body.style.overflow = 'hidden';
  facialDescriptorEnrol = null;
  ['enrol-nombre','enrol-apellido','enrol-registro-patronal','enrol-documento','enrol-nss','enrol-empresa','enrol-area','enrol-cargo'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('enrol-pendiente-id').textContent = '';
  if (window._userRol === 'contratista' && window._userEmpresa) { document.getElementById('enrol-empresa').value = window._userEmpresa; }
  const statusEl = document.getElementById('enrol-status');
  


  const capEl = document.getElementById('enrol-cap-status');
statusEl.className = 'facial-status'; statusEl.textContent = '⏳ Iniciando cámara...';
if (capEl) { capEl.className = 'facial-status error'; capEl.textContent = '❌ Rostro no capturado'; }

 

const btnCapturar = document.getElementById('btn-enrol-capturar');
const btnGuardar = document.getElementById('btn-enrol-guardar');
if (btnCapturar) btnCapturar.disabled = true;
if (btnGuardar) btnGuardar.disabled = true;

  if (!facialModelos) { facialModelos = await Facial.cargarModelos(); }
  const ok = await Facial.iniciarCamara('enrol-video', 'enrol-canvas');
  if (!ok) { statusEl.className = 'facial-status error'; statusEl.textContent = '❌ No se pudo acceder a la cámara'; return; }
 Facial.iniciarDeteccion(
  () => { statusEl.className = 'facial-status ok'; statusEl.textContent = '✅ Rostro detectado — listo para verificar'; const b = document.getElementById('btn-verif-capturar'); if(b) b.disabled = false; },
  () => { statusEl.className = 'facial-status error'; statusEl.textContent = '❌ Sin rostro — colócate frente a la cámara'; const b = document.getElementById('btn-verif-capturar'); if(b) b.disabled = true; }
);
}

async function capturarRostroEnrol() {
  const capEl = document.getElementById('enrol-cap-status');
  capEl.className = 'facial-status'; capEl.textContent = '⏳ Capturando...';
  const descriptor = Facial.ultimoDescriptor || await Facial.obtenerDescriptor();
  if (descriptor) {
    facialDescriptorEnrol = descriptor;
    capEl.className = 'facial-status ok'; capEl.textContent = `✅ Rostro capturado (${descriptor.length} valores)`;
    const wf = document.getElementById('warn-foto'); if(wf) wf.style.display='none';
    verificarBotonGuardar();
  } else {
    capEl.className = 'facial-status error'; capEl.textContent = '❌ No se detectó rostro — intenta de nuevo';
  }
}

// ── Archivos de enrolamiento ──────────────────────
let enrolCredFile = null, enrolImssFile = null;
let enrolCredProcesado = false, enrolImssProcesado = false;
let enrolCredData = null, enrolImssData = null;

function enrolArchivoSeleccionado(input, tipo) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Archivo demasiado grande (máx 10 MB)'); return; }
  if (tipo === 'cred') {
    enrolCredFile = file; enrolCredProcesado = false; enrolCredData = null;
    document.getElementById('enrol-cred-label').textContent = '⏳ ' + file.name;
    const cc = document.getElementById('enrol-cred-clear'); if (cc) cc.style.display = 'inline-block';
  } else {
    enrolImssFile = file; enrolImssProcesado = false; enrolImssData = null;
    document.getElementById('enrol-imss-label').textContent = '⏳ ' + file.name;
  }
  verificarBotonGuardar();
  procesarDocEnrol(file, tipo);
}

function enrolDropFile(event, tipo) {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const input = document.getElementById(`enrol-${tipo}-input`);
  const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
  enrolArchivoSeleccionado(input, tipo);
}

function enrolLimpiarDoc(tipo) {
  if (tipo === 'cred') {
    enrolCredFile = null; enrolCredProcesado = false; enrolCredData = null;
    document.getElementById('enrol-cred-proceso').style.display = 'none';
    document.getElementById('enrol-cred-retry').style.display = 'none';
    document.getElementById('enrol-cred-clear').style.display = 'none';
    document.getElementById('enrol-cred-label').textContent = 'Arrastra o haz clic — INE, Pasaporte o Licencia de conducir';
    document.getElementById('enrol-cred-drop').style.borderColor = 'var(--border)';
    document.getElementById('enrol-cred-input').value = '';
  }
  verificarBotonGuardar();
}

function enrolReintentarDoc(tipo) {
  if (tipo === 'cred') {
    enrolCredFile = null; enrolCredProcesado = false; enrolCredData = null;
    document.getElementById('enrol-cred-proceso').style.display = 'none';
    document.getElementById('enrol-cred-retry').style.display = 'none';
    const cc = document.getElementById('enrol-cred-clear'); if (cc) cc.style.display = 'none';
    document.getElementById('enrol-cred-label').textContent = 'Arrastra o haz clic para subir credencial';
    document.getElementById('enrol-cred-drop').style.borderColor = 'var(--border)';
    document.getElementById('enrol-cred-input').value = '';
    document.getElementById('enrol-cred-input').click();
  } else {
    enrolImssFile = null; enrolImssProcesado = false; enrolImssData = null;
    document.getElementById('enrol-imss-proceso').style.display = 'none';
    document.getElementById('enrol-imss-retry').style.display = 'none';
    document.getElementById('enrol-imss-label').textContent = 'Arrastra o haz clic para subir vigencia IMSS';
    document.getElementById('enrol-imss-drop').style.borderColor = '#3b82f6';
    document.getElementById('enrol-imss-input').value = '';
    document.getElementById('enrol-imss-input').click();
  }
  verificarBotonGuardar();
}





async function procesarDocEnrol(file, tipo) {
  const procesoEl = document.getElementById(`enrol-${tipo}-proceso`);
  const retryEl   = document.getElementById(`enrol-${tipo}-retry`);
  const dropEl    = document.getElementById(`enrol-${tipo}-drop`);
  const labelEl   = document.getElementById(`enrol-${tipo}-label`);
  const warnEl    = document.getElementById(`warn-${tipo}`);

  procesoEl.style.display = 'block';
  procesoEl.style.color = 'var(--text-2)';
  procesoEl.innerHTML = '⏳ Comprimiendo imagen...';
  retryEl.style.display = 'none';

  try {
    let base64; let mimeFinal = file.type;

    if (file.type === 'application/pdf') {
      procesoEl.innerHTML = '⏳ Convirtiendo PDF a imagen...';
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      mimeFinal = 'image/jpeg';
    } else {
      base64 = await fileToBase64(file);
    }

    procesoEl.innerHTML = '⏳ Enviando a procesamiento con IA...';

    const endpoint = tipo === 'imss' ? '/documentos/procesar-imss' : '/documentos/procesar-doc';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, mime: mimeFinal, nombre: file.name })
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || 'Error de procesamiento');

    if (tipo === 'cred') {
      const ext = data.extracted || {};

      // ── Detectar tipo de documento ──
      let docType = (ext.tipo_documento || '').toUpperCase();
      if (!docType) {
        if (ext.clave_elector)                                          docType = 'INE';
        else if (ext.numero_pasaporte)                                  docType = 'PASAPORTE';
        else if (ext.numero_licencia || ext.nombre_conductor)           docType = 'LICENCIA';
        else                                                            docType = 'INE';
      }

      // ── Extraer nombre y apellido según tipo ──
      let nombreDoc   = '';
      let apellidoDoc = '';

      if (docType === 'LICENCIA') {
        // n8n devuelve nombre_conductor con el nombre completo
        const nc = (ext.nombre_conductor || '').trim();
        if (nc) {
          const partes = nc.split(' ').filter(Boolean);
          nombreDoc   = partes[0] || '';
          apellidoDoc = partes.slice(1).join(' ');
        } else {
          // fallback
          nombreDoc   = (ext.nombre || '').trim();
          apellidoDoc = (ext.apellido_paterno || '').trim();
        }
      } else {
        nombreDoc   = (ext.nombre || '').trim();
        apellidoDoc = (ext.apellido_paterno || ext.apellido || '').trim();
      }

      // ── Validar vigencia INE ──
      if (docType === 'INE' && ext.vigencia) {
        const vigenciaAño = parseInt(String(ext.vigencia).replace(/\D/g, '').slice(-4));
        const añoActual   = new Date().getFullYear();
        if (vigenciaAño && vigenciaAño < añoActual) {
          procesoEl.innerHTML = `❌ INE VENCIDA — Vigencia: ${ext.vigencia}`;
          procesoEl.style.color = 'var(--danger)';
          dropEl.style.borderColor = 'var(--danger)';
          retryEl.style.display = 'block';
          enrolCredFile = null; enrolCredProcesado = false;
          verificarBotonGuardar(); return;
        }
      }

      // ── Validar vigencia LICENCIA ──
      if (docType === 'LICENCIA' && ext.fecha_vencimiento) {
        const partesFecha = String(ext.fecha_vencimiento).split('/');
        let fechaVenc = null;
        if (partesFecha.length === 3) {
          // DD/MM/YYYY
          fechaVenc = new Date(`${partesFecha[2]}-${partesFecha[1]}-${partesFecha[0]}`);
        } else {
          fechaVenc = new Date(ext.fecha_vencimiento);
        }
        if (fechaVenc && fechaVenc < new Date()) {
          procesoEl.innerHTML = `❌ LICENCIA VENCIDA — Vencimiento: ${ext.fecha_vencimiento}`;
          procesoEl.style.color = 'var(--danger)';
          dropEl.style.borderColor = 'var(--danger)';
          retryEl.style.display = 'block';
          enrolCredFile = null; enrolCredProcesado = false;
          verificarBotonGuardar(); return;
        }
      }

      // ── Validar vigencia PASAPORTE ──
      if (docType === 'PASAPORTE' && ext.fecha_vencimiento) {
        const partesFecha = String(ext.fecha_vencimiento).split('/');
        let fechaVenc = null;
        if (partesFecha.length === 3) {
          fechaVenc = new Date(`${partesFecha[2]}-${partesFecha[1]}-${partesFecha[0]}`);
        } else {
          fechaVenc = new Date(ext.fecha_vencimiento);
        }
        if (fechaVenc && fechaVenc < new Date()) {
          procesoEl.innerHTML = `❌ PASAPORTE VENCIDO — Vencimiento: ${ext.fecha_vencimiento}`;
          procesoEl.style.color = 'var(--danger)';
          dropEl.style.borderColor = 'var(--danger)';
          retryEl.style.display = 'block';
          enrolCredFile = null; enrolCredProcesado = false;
          verificarBotonGuardar(); return;
        }
      }

     
      // ── Validar coincidencia de nombre ──
      const nombreForm   = normalizar(document.getElementById('enrol-nombre')?.value?.trim() || '');
      const apellidoForm = normalizar(document.getElementById('enrol-apellido')?.value?.trim() || '');



      

      // Del doc: nombre completo = nombre + apellido_paterno + apellido_materno
      const nombreDocCompleto   = normalizar(nombreDoc);
      const apellidoDocCompleto = normalizar([
        ext.apellido_paterno || '',
        ext.apellido_materno || ''
      ].filter(Boolean).join(' '));

      if (nombreForm && apellidoForm && (nombreDocCompleto || apellidoDocCompleto)) {
        const coincideNombre   = nombreDocCompleto === nombreForm;
        const coincideApellido = apellidoDocCompleto === apellidoForm;

        if (!coincideNombre || !coincideApellido) {
          const nombreEnDoc  = normalizar([nombreDoc, ext.apellido_paterno, ext.apellido_materno].filter(Boolean).join(' '));
          const nombreEnForm = `${nombreForm} ${apellidoForm}`.trim();

          let motivo = '';
          if (!coincideNombre)   motivo += `• Nombre: doc tiene "<strong>${escapeHtml(nombreDocCompleto)}</strong>" — formulario tiene "<strong>${escapeHtml(nombreForm)}</strong>"<br>`;
          if (!coincideApellido) motivo += `• Apellidos: doc tiene "<strong>${escapeHtml(apellidoDocCompleto)}</strong>" — formulario tiene "<strong>${escapeHtml(apellidoForm)}</strong>"<br>`;

          procesoEl.innerHTML = `
            ❌ <strong>El nombre no coincide con el documento</strong><br>
            <span style="font-size:11px;line-height:2">
              ${motivo}
              <span style="color:var(--text-3)">Escribe exactamente como aparece en el documento.</span>
            </span>`;
          procesoEl.style.color = 'var(--danger)';
          dropEl.style.borderColor = 'var(--danger)';
          retryEl.style.display = 'block';
          enrolCredFile = null; enrolCredProcesado = false;
          verificarBotonGuardar(); return;
        }
      }

      // ── Todo OK — construir resumen ──
      let resumen = '';
      if (docType === 'INE') {
        resumen = `${ext.nombre || ''} ${ext.apellido_paterno || ''} ${ext.apellido_materno || ''} — Vigencia: ${ext.vigencia || '—'}`;
      } else if (docType === 'PASAPORTE') {
        resumen = `${ext.nombre || ''} ${ext.apellido_paterno || ''} — Pasaporte: ${ext.numero_pasaporte || '—'} — Vence: ${ext.fecha_vencimiento || '—'}`;
      } else if (docType === 'LICENCIA') {
        resumen = `${ext.nombre_conductor || nombreDoc} — Lic: ${ext.numero_licencia || '—'} — Tipo: ${ext.tipo_licencia || '—'} — Vence: ${ext.fecha_vencimiento || '—'}`;
      } else {
        resumen = `${nombreDoc} ${apellidoDoc}`.trim();
      }

      enrolCredProcesado = true;
      enrolCredData = { base64, mime: mimeFinal, nombre: file.name, extracted: ext, docType };

      procesoEl.innerHTML = `✅ ${docType} válido — ${escapeHtml(resumen.trim())}`;
      procesoEl.style.color = 'var(--success)';
      dropEl.style.borderColor = 'var(--success)';
      labelEl.textContent = '✅ ' + file.name;
      if (warnEl) warnEl.style.display = 'none';

    } else {
      // ── IMSS ──
      enrolImssProcesado = true;
      enrolImssData = { base64, mime: mimeFinal, nombre: file.name, extracted: data.extracted };
      const vigente = data.extracted?.vigente;
      const nombre  = data.extracted?.nombre_asegurado || '';
      const fecha   = data.extracted?.fecha_vigencia || '';
      procesoEl.innerHTML = vigente
        ? `✅ VIGENTE — ${escapeHtml(nombre)} — Hasta: ${fecha}`
        : `⚠️ NO VIGENTE — ${escapeHtml(nombre)}`;
      procesoEl.style.color = vigente ? 'var(--success)' : 'var(--warning)';
      dropEl.style.borderColor = vigente ? 'var(--success)' : 'var(--warning)';
      labelEl.textContent = '✅ ' + file.name;
      if (warnEl) warnEl.style.display = 'none';
    }

  } catch(e) {
    procesoEl.innerHTML = `❌ Error: ${escapeHtml(e.message)}`;
    procesoEl.style.color = 'var(--danger)';
    dropEl.style.borderColor = 'var(--danger)';
    retryEl.style.display = 'block';
    if (tipo === 'cred') { enrolCredFile = null; enrolCredProcesado = false; }
    else { enrolImssFile = null; enrolImssProcesado = false; }
  }

  verificarBotonGuardar();
}

// Helper: normalizar texto para comparación sin acentos ni mayúsculas
function normalizar(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

// Helper: normalizar texto para comparación sin acentos ni mayúsculas
function normalizar(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}


// ── Helper: normalizar texto para comparación ──
function normalizar(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .replace(/[^a-z0-9\s]/g, '')     // solo letras y números
    .trim();
}






function verificarBotonGuardar() {
  const tieneFoto = facialDescriptorEnrol !== null;
  const tieneCred = enrolCredProcesado;
  const fotoWarn = document.getElementById('warn-foto');
  const credWarn = document.getElementById('warn-cred');
  if (fotoWarn) fotoWarn.style.display = tieneFoto ? 'none' : 'flex';
  if (credWarn) credWarn.style.display = (enrolCredFile || tieneCred) ? 'none' : 'flex';

  // Validar nombre vs documento en tiempo real
  let nombreCoincide = true;
  if (enrolCredData) {
    const ext = enrolCredData.extracted || {};
    const docType = enrolCredData.docType || '';
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,'').trim();
    let nombreDoc = '', apellidoDoc = '';
    if (docType === 'LICENCIA') {
      const nc = (ext.nombre_conductor || '').trim();
      const partes = nc.split(' ').filter(Boolean);
      nombreDoc = partes[0] || '';
      apellidoDoc = partes.slice(1).join(' ');
    } else {
      nombreDoc = (ext.nombre || '').trim();
      apellidoDoc = [ext.apellido_paterno||'', ext.apellido_materno||''].filter(Boolean).join(' ');
    }
    const nombreForm   = norm(document.getElementById('enrol-nombre')?.value?.trim() || '');
    const apellidoForm = norm(document.getElementById('enrol-apellido')?.value?.trim() || '');
    const nombreDocN   = norm(nombreDoc);
    const apellidoDocN = norm(apellidoDoc);

    const procesoEl = document.getElementById('enrol-cred-proceso');
    if (nombreForm && apellidoForm) {
      if (nombreDocN !== nombreForm || apellidoDocN !== apellidoForm) {
        nombreCoincide = false;
        if (procesoEl) {
          procesoEl.style.display = 'block';
          procesoEl.style.color = 'var(--danger)';
          procesoEl.innerHTML = `❌ El nombre no coincide — Documento: "<strong>${escapeHtml(nombreDocN)} ${escapeHtml(apellidoDocN)}</strong>" vs Formulario: "<strong>${escapeHtml(nombreForm)} ${escapeHtml(apellidoForm)}</strong>"`;
        }
      } else {
        nombreCoincide = true;
        if (procesoEl && procesoEl.innerHTML.includes('no coincide')) {
          // Restaurar el resumen del documento
          const docTypeFinal = enrolCredData.docType || '';
          procesoEl.style.color = 'var(--success)';
          procesoEl.innerHTML = `✅ ${docTypeFinal} válido — ${escapeHtml(nombreDoc)} ${escapeHtml(apellidoDoc)}`;
        }
      }
    }
  }

  const btn = document.getElementById('btn-enrol-guardar');
  if (!btn) return;
  const listo = tieneFoto && tieneCred && nombreCoincide;
  btn.disabled = !listo;
  btn.style.opacity = '1';
  btn.style.background = listo ? 'var(--success)' : 'var(--text-3)';
  btn.style.color = listo ? '#fff' : '#999';
  btn.style.cursor = listo ? 'pointer' : 'not-allowed';
}





async function fileToBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
}


async function guardarEnrolamiento() {
  const nombre   = document.getElementById('enrol-nombre').value.trim();
  const apellido = document.getElementById('enrol-apellido').value.trim();
  const email = null;
  const registro_patronal = document.getElementById('enrol-registro-patronal')?.value?.trim() || null;
  const documento = document.getElementById('enrol-documento').value.trim();
  const area     = document.getElementById('enrol-area').value.trim();
  const cargo    = document.getElementById('enrol-cargo').value.trim();
  const empresa  = document.getElementById('enrol-empresa')?.value.trim() || '';
  const nss = document.getElementById('enrol-nss')?.value?.trim() || null;
  const warnDatos = document.getElementById('warn-datos');



    // DEBUG — esto debe aparecer siempre al presionar el botón
  console.log('=== GUARDAR ENROLAMIENTO LLAMADO ===');
  console.log('nombre:', nombre);
  console.log('apellido:', apellido);
  console.log('enrolCredData:', enrolCredData);
  console.log('enrolCredProcesado:', enrolCredProcesado);
  console.log('====================================');

  // Validaciones básicas
  if (!nombre || !apellido) { 
    if (warnDatos) { warnDatos.style.display = 'flex'; warnDatos.textContent = '⚠ Nombre y apellido son obligatorios'; } 
    return; 
  }

  if (!nss) { 
    if (warnDatos) { warnDatos.style.display = 'flex'; warnDatos.textContent = '⚠ El NSS es obligatorio'; } 
    return; 
  }

  if (!empresa) { 
    if (warnDatos) { warnDatos.style.display = 'flex'; warnDatos.textContent = '⚠ La empresa es obligatoria'; } 
    return; 
  }

  // ── VALIDACIÓN NOMBRE VS DOCUMENTO ──────────────────
  if (enrolCredData) {
    const ext     = enrolCredData.extracted || {};
    const docType = enrolCredData.docType   || '';

    let nombreDoc   = '';
    let apellidoDoc = '';

    if (docType === 'LICENCIA') {
      const nc     = (ext.nombre_conductor || '').trim();
      const partes = nc.split(' ').filter(Boolean);
      nombreDoc    = partes[0] || '';
      apellidoDoc  = partes.slice(1).join(' ');
    } else {
      nombreDoc   = (ext.nombre || '').trim();
      apellidoDoc = [ext.apellido_paterno || '', ext.apellido_materno || ''].filter(Boolean).join(' ');
    }

    // Función auxiliar para normalizar textos
    const normalizar = (texto) => {
      return (texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, '')
        .trim();
    };

    const nombreForm   = normalizar(nombre);
    const apellidoForm = normalizar(apellido);
    const nombreDocN   = normalizar(nombreDoc);
    const apellidoDocN = normalizar(apellidoDoc);

    const coincideNombre   = nombreDocN === nombreForm;
    const coincideApellido = apellidoDocN === apellidoForm;

    if (!coincideNombre || !coincideApellido) {
      let motivo = '';
      if (!coincideNombre)   motivo += `\n• Nombre: doc="${nombreDocN}" | formulario="${nombreForm}"`;
      if (!coincideApellido) motivo += `\n• Apellidos: doc="${apellidoDocN}" | formulario="${apellidoForm}"`;

      // Mostrar en el proceso element para que sea visible
      const procesoEl = document.getElementById('enrol-cred-proceso');
      const dropEl    = document.getElementById('enrol-cred-drop');
      const retryEl   = document.getElementById('enrol-cred-retry');

      if (procesoEl) {
        procesoEl.style.display = 'block';
        procesoEl.innerHTML = `
          ❌ <strong>El nombre no coincide con el documento</strong><br>
          <span style="font-size:11px;line-height:2">
            📄 Documento: <strong style="color:var(--danger)">${escapeHtml(nombreDocN)}</strong><br>
            📝 Formulario: <strong style="color:var(--accent)">${escapeHtml(nombreForm + ' ' + apellidoForm)}</strong><br>
            <span style="color:var(--text-3)">Corrige el nombre o sube el documento correcto.</span>
          </span>`;
        procesoEl.style.color = 'var(--danger)';
      }
      if (dropEl)  dropEl.style.borderColor = 'var(--danger)';
      if (retryEl) retryEl.style.display = 'block';

      // Scroll hacia el problema
      procesoEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });

      if (warnDatos) { 
        warnDatos.style.display = 'flex'; 
        warnDatos.textContent = '⚠ El nombre no coincide con el documento — revisa el Paso 3'; 
      }
      return;
    }
  }
  // ── FIN VALIDACIÓN ───────────────────────────────────

  if (warnDatos) warnDatos.style.display = 'none';
  
  verificarBotonGuardar();
  
  if (!facialDescriptorEnrol || !enrolCredFile) return;
  
  const btn = document.getElementById('btn-enrol-guardar');
  const statusEl = document.getElementById('enrol-save-status');
  btn.disabled = true; 
  btn.textContent = '⏳ Procesando...'; 
  statusEl.style.display = 'block'; 
  statusEl.textContent = 'Convirtiendo documentos...';
  
  try {
    statusEl.textContent = 'Registrando empleado...';
    const imssExtracted = enrolImssData?.extracted || {};
    const rEmp = await Facial.enrolar({ 
      nombre, 
      apellido, 
      email, 
      documento, 
      area, 
      cargo, 
      empresa, 
      descriptor: facialDescriptorEnrol, 
      estatus: 'no_activo', 
      imss_vigente: imssExtracted.vigente ?? null, 
      imss_estatus: imssExtracted.estatus || null, 
      imss_fecha_vigencia: imssExtracted.fecha_vigencia || null, 
      imss_nss: nss || imssExtracted.nss || null, 
      registro_patronal 
    });
    
    if (!rEmp.success) throw new Error(rEmp.error || 'Error al registrar empleado');
    
    const empleadoId = rEmp.empleado.id;
    statusEl.textContent = 'Guardando credencial...';
    await fetch('/documentos/subir', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ 
        archivos: [{ 
          nombre: enrolCredData.nombre, 
          mime: enrolCredData.mime, 
          base64: enrolCredData.base64, 
          tipo: 'DOC' 
        }], 
        empleado_id: empleadoId 
      }) 
    }).then(r => r.json());
    
    statusEl.textContent = 'Guardando vigencia IMSS...';
    await fetch('/documentos/subir', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ 
        archivos: [{ 
          nombre: enrolImssData.nombre, 
          mime: enrolImssData.mime, 
          base64: enrolImssData.base64, 
          tipo: 'IMSS' 
        }], 
        empleado_id: empleadoId 
      }) 
    }).then(r => r.json());
    
    statusEl.textContent = '✅ Personal registrado con estatus NO ACTIVO'; 
    statusEl.style.color = 'var(--success)';
    setTimeout(() => { cerrarFacialEnrolar(); }, 1500);
  } catch(e) {
    statusEl.textContent = '❌ Error: ' + e.message; 
    statusEl.style.color = 'var(--danger)'; 
    btn.disabled = false; 
    btn.textContent = 'REGISTRAR PERSONAL';
  }
}

// Función auxiliar de escape HTML (si no la tienes ya definida)
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function cargarEmpleadoPendiente(id) {
  if (!id) return;
  const sel = document.getElementById('enrol-pendientes');
  const opt = sel.querySelector(`option[value="${id}"]`);
  if (!opt) return;
  const e = JSON.parse(opt.dataset.emp);
  document.getElementById('enrol-nombre').value    = e.nombre || '';
  document.getElementById('enrol-apellido').value  = e.apellido || '';
  document.getElementById('enrol-documento').value = e.documento_identidad || '';
  document.getElementById('enrol-empresa').value   = e.empresa || '';
  document.getElementById('enrol-cargo').value     = e.cargo && e.cargo !== 'Pendiente' ? e.cargo : '';
  document.getElementById('enrol-pendiente-id').textContent = id;
}

function cerrarFacialEnrolar() {
  enrolCredFile = null; enrolImssFile = null; enrolCredProcesado = false; enrolImssProcesado = false; enrolCredData = null; enrolImssData = null;
  const cc = document.getElementById('enrol-cred-clear'); if (cc) cc.style.display = 'none';
  Facial.detenerCamara();
  document.getElementById('modalEnrolar').classList.remove('open');
  document.body.style.overflow = '';
  ['enrol-nombre','enrol-apellido','enrol-registro-patronal','enrol-documento','enrol-nss','enrol-area','enrol-cargo','enrol-empresa'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  facialDescriptorEnrol = null;
}

async function abrirFacialHistorial() {
  document.getElementById('modalHistorial').classList.add('open');
  document.body.style.overflow = 'hidden';
  const loading = document.getElementById('historial-loading');
  const table = document.getElementById('historial-table');
  const tbody = document.getElementById('historial-body');
  loading.style.display = 'block'; loading.className = 'facial-status'; loading.textContent = '⏳ Cargando historial...'; table.style.display = 'none';
  const r = await Facial.obtenerAccesos();
  if (!r.success || !r.data) { loading.className = 'facial-status error'; loading.textContent = '❌ Error al cargar historial'; return; }
  loading.style.display = 'none';
  if (r.data.length === 0) { loading.style.display = 'block'; loading.className = 'facial-status'; loading.textContent = 'Sin registros de acceso'; return; }
  tbody.innerHTML = r.data.map(a => {
    const fecha = a.timestamp ? new Date(a.timestamp).toLocaleString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
    const nombre = a.nombre ? `${a.nombre} ${a.apellido}` : 'Desconocido';
    const similitud = a.similitud ? (parseFloat(a.similitud)*100).toFixed(1)+'%' : '—';
    const badgeClass = a.resultado === 'exitoso' ? 'badge-exitoso' : 'badge-fallido';
    const badgeIcon  = a.resultado === 'exitoso' ? '✅' : '❌';
    const movIcon    = a.tipo_movimiento === 'salida' ? '↑' : '↓';
    const movColor   = a.tipo_movimiento === 'salida' ? '#ef4444' : 'var(--accent)';
    const movLabel   = a.tipo_movimiento === 'salida' ? 'SALIDA' : 'ENTRADA';
    return `<tr><td>${fecha}</td><td style="color:${movColor};font-weight:bold;font-family:'Barlow Condensed',sans-serif">${movIcon} ${movLabel}</td><td class="${badgeClass}">${badgeIcon} ${a.resultado}</td><td>${nombre}</td><td>${a.area||'—'}</td><td>${similitud}</td></tr>`;
  }).join('');
  table.style.display = 'table';
}

function cerrarFacialHistorial() { document.getElementById('modalHistorial').classList.remove('open'); document.body.style.overflow = ''; }

function exportarAccesosExcel() {
  const tbody = document.getElementById('historial-body');
  if (!tbody || !tbody.rows.length) { alert('No hay datos para exportar'); return; }
  const headers = ['Fecha / Hora', 'Resultado', 'Empleado', 'Area', 'Similitud'];
  const rows = Array.from(tbody.rows).map(row => Array.from(row.cells).map(cell => cell.textContent.trim().replace(/^[✅❌]\s*/, '')));
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [{wch:22},{wch:12},{wch:30},{wch:15},{wch:12}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Accesos Faciales');
  const fecha = new Date().toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric'}).replace(/\//g,'-');
  XLSX.writeFile(wb, 'PROAGRO_Accesos_Faciales_' + fecha + '.xlsx');
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
  overlay.appendChild(btn); overlay.appendChild(img); document.body.appendChild(overlay);
  if (window._imgEscHandler) document.removeEventListener('keydown', window._imgEscHandler);
  function escHandler(e) { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); } }
  window._imgEscHandler = escHandler;
  document.addEventListener('keydown', escHandler);
}

// ===================== RESPONSABLES =====================
function filtrarResponsable1(query) {
  const sug = document.getElementById('responsable1_sugerencias');
  // Guardar lo que escribe el usuario aunque no seleccione del dropdown
  document.getElementById('responsable1').value = query.trim();
  verificarBotonSubmit();
  if (!query || query.length < 1) {
    sug.style.display = 'none';
    if (!isPaseVisitaActive()) document.getElementById('tel1-grupo').style.display = 'none';
    const tel1 = document.getElementById('responsable1_tel');
    if (tel1) tel1.value = '';
    const h1 = document.getElementById('responsable1_hint');
    if (h1) { h1.textContent = ''; h1.style.color = ''; }
    return;
  }
  // Mostrar teléfono en cuanto haya texto (sin necesidad de seleccionar)
  document.getElementById('tel1-grupo').style.display = 'block';
  const q = query.toLowerCase();
  const matches = empleadosCache.filter(e => `${e.nombre} ${e.apellido}`.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) { sug.style.display = 'none'; return; }
  sug.innerHTML = matches.map(e => { const nombre = `${e.nombre} ${e.apellido}`.trim(); return `<div class="resp-sug-item" data-nombre="${nombre}" onmousedown="event.preventDefault();seleccionarResponsable1('${nombre}')" onmouseenter="this.style.background='var(--accent-dim)'" onmouseleave="this.style.background=''" style="padding:10px 14px;cursor:pointer;font-family:'Barlow',sans-serif;font-size:13px;color:var(--text);border-bottom:1px solid var(--border)">${nombre} <span style="font-size:11px;color:var(--text-3)">${e.cargo||''}</span></div>`; }).join('');
  sug.style.display = 'block';
}


  




function seleccionarResponsable1(nombre) {
  document.getElementById('responsable1_input').value = nombre;
  document.getElementById('responsable1').value = nombre;
  document.getElementById('responsable1_sugerencias').style.display = 'none';
  const h1 = document.getElementById('responsable1_hint');
  if (h1) { h1.textContent = '✓ Responsable 1 seleccionado'; h1.style.color = 'var(--success)'; }
  document.getElementById('tel1-grupo').style.display = 'block';
  verificarBotonSubmit();
}


function cerrarResponsable1() { document.getElementById('responsable1_sugerencias').style.display = 'none'; }

function responsable1Keydown(event) {
  const sug = document.getElementById('responsable1_sugerencias');
  if (sug.style.display === 'none') return;
  const items = sug.querySelectorAll('.resp-sug-item'); const active = sug.querySelector('.resp-sug-item.active'); let idx = Array.from(items).indexOf(active);
  if (event.key === 'ArrowDown') { event.preventDefault(); if (active) { active.classList.remove('active'); active.style.background = ''; } idx = (idx + 1) % items.length; items[idx].classList.add('active'); items[idx].style.background = 'var(--accent-dim)'; items[idx].scrollIntoView({ block: 'nearest' }); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); if (active) { active.classList.remove('active'); active.style.background = ''; } idx = (idx - 1 + items.length) % items.length; items[idx].classList.add('active'); items[idx].style.background = 'var(--accent-dim)'; items[idx].scrollIntoView({ block: 'nearest' }); }
  else if (event.key === 'Enter') { event.preventDefault(); const target = active || items[0]; if (target) seleccionarResponsable1(target.dataset.nombre); }
  else if (event.key === 'Escape') { cerrarResponsable1(); }
}

function filtrarResponsable2(query) {
  const sug = document.getElementById('responsable2_sugerencias');
  if (!sug) return;
  const hiddenInput = document.getElementById('responsable2');
  // Guardar lo que escribe el usuario aunque no seleccione del dropdown
  if (hiddenInput) hiddenInput.value = query.trim();
  if (!query || query.length < 1) {
    sug.style.display = 'none';
    const tel2grupo = document.getElementById('tel2-grupo');
    if (tel2grupo) tel2grupo.style.display = 'none';
    const tel2 = document.getElementById('responsable2_tel');
    if (tel2) tel2.value = '';
    const h2 = document.getElementById('responsable2_hint');
    if (h2) { h2.textContent = ''; h2.style.color = ''; }
    return;
  }
  // Mostrar teléfono en cuanto haya texto (sin necesidad de seleccionar)
  const tel2grupo = document.getElementById('tel2-grupo');
  if (tel2grupo) tel2grupo.style.display = 'block';
  const q = query.toLowerCase();
  const matches = empleadosCache.filter(e => `${e.nombre} ${e.apellido}`.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) { sug.style.display = 'none'; return; }
  sug.innerHTML = matches.map(e => {
    const nombre = `${e.nombre} ${e.apellido}`.trim();
    return `<div class="resp-sug-item" data-nombre="${nombre}"
      onmousedown="event.preventDefault();seleccionarResponsable2('${nombre}')"
      onmouseenter="this.style.background='var(--accent-dim)'"
      onmouseleave="this.style.background=''"
      style="padding:10px 14px;cursor:pointer;font-family:'Barlow',sans-serif;font-size:13px;color:var(--text);border-bottom:1px solid var(--border)">
      ${nombre} <span style="font-size:11px;color:var(--text-3)">${e.cargo||''}</span>
    </div>`;
  }).join('');
  sug.style.display = 'block';
}

function cerrarResponsable2() {
  const sug = document.getElementById('responsable2_sugerencias');
  if (sug) sug.style.display = 'none';
}

function responsable2Keydown(event) {
  const sug = document.getElementById('responsable2_sugerencias');
  if (!sug || sug.style.display === 'none') return;
  const items  = sug.querySelectorAll('.resp-sug-item');
  const active = sug.querySelector('.resp-sug-item.active');
  let idx = Array.from(items).indexOf(active);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (active) { active.classList.remove('active'); active.style.background = ''; }
    idx = (idx + 1) % items.length;
    items[idx].classList.add('active'); items[idx].style.background = 'var(--accent-dim)';
    items[idx].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (active) { active.classList.remove('active'); active.style.background = ''; }
    idx = (idx - 1 + items.length) % items.length;
    items[idx].classList.add('active'); items[idx].style.background = 'var(--accent-dim)';
    items[idx].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const target = active || items[0];
    if (target) seleccionarResponsable2(target.dataset.nombre);
  } else if (event.key === 'Escape') {
    cerrarResponsable2();
  }
}




function seleccionarResponsable2(nombre) {
  document.getElementById('responsable2_input').value = nombre;
  document.getElementById('responsable2').value = nombre;
  document.getElementById('responsable2_sugerencias').style.display = 'none';
  document.getElementById('responsable2_hint').textContent = '✓ Responsable 2 seleccionado';
  document.getElementById('responsable2_hint').style.color = 'var(--success)';
  document.getElementById('tel2-grupo').style.display = 'block';
}

function cerrarResponsable2() { document.getElementById('responsable2_sugerencias').style.display = 'none'; }

function responsable2Keydown(event) {
  const sug = document.getElementById('responsable2_sugerencias');
  if (sug.style.display === 'none') return;
  const items = sug.querySelectorAll('.resp-sug-item'); const active = sug.querySelector('.resp-sug-item.active'); let idx = Array.from(items).indexOf(active);
  if (event.key === 'ArrowDown') { event.preventDefault(); if (active) { active.classList.remove('active'); active.style.background = ''; } idx = (idx + 1) % items.length; items[idx].classList.add('active'); items[idx].style.background = 'var(--accent-dim)'; items[idx].scrollIntoView({ block: 'nearest' }); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); if (active) { active.classList.remove('active'); active.style.background = ''; } idx = (idx - 1 + items.length) % items.length; items[idx].classList.add('active'); items[idx].style.background = 'var(--accent-dim)'; items[idx].scrollIntoView({ block: 'nearest' }); }
  else if (event.key === 'Enter') { event.preventDefault(); const target = active || items[0]; if (target) seleccionarResponsable2(target.dataset.nombre); }
  else if (event.key === 'Escape') { cerrarResponsable2(); }
}

function filtrarResponsables(query) {
  const sug = document.getElementById('responsable_sugerencias');
  document.getElementById('responsable_contrato').value = '';
  if (!query || query.length < 1) { sug.style.display = 'none'; return; }
  const q = query.toLowerCase();
  const matches = responsablesCache.filter(e => `${e.nombre} ${e.apellido_paterno} ${e.apellido_materno||''}`.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) { sug.style.display = 'none'; return; }
  sug.innerHTML = matches.map(e => { const nombre = `${e.nombre} ${e.apellido_paterno}${e.apellido_materno ? ' ' + e.apellido_materno : ''}`.trim(); return `<div class="resp-sug-item" data-nombre="${nombre}" onmousedown="event.preventDefault();seleccionarResponsable('${nombre}')" onmouseenter="resaltarResponsable(this)" style="padding:10px 14px;cursor:pointer;font-family:'Barlow',sans-serif;font-size:13px;color:var(--text);border-bottom:1px solid var(--border)">${nombre}</div>`; }).join('');
  sug.style.display = 'block';
}

function seleccionarResponsable(nombre) {
  document.getElementById('responsable_input').value = nombre;
  document.getElementById('responsable_contrato').value = nombre;
  document.getElementById('responsable_sugerencias').style.display = 'none';
  const h = document.getElementById('responsable_hint');
  if (h) { h.textContent = '✓ Responsable seleccionado'; h.style.color = 'var(--success)'; }
  verificarBotonSubmit();
}
function cerrarResponsables() { document.getElementById('responsable_sugerencias').style.display = 'none'; }
function resaltarResponsable(el) { document.querySelectorAll('.resp-sug-item').forEach(i => i.style.background = ''); el.style.background = 'var(--accent-dim)'; }

function responsableKeydown(event) {
  const sug = document.getElementById('responsable_sugerencias');
  if (sug.style.display === 'none') return;
  const items = sug.querySelectorAll('.resp-sug-item'); const active = sug.querySelector('.resp-sug-item.active'); let idx = Array.from(items).indexOf(active);
  if (event.key === 'ArrowDown') { event.preventDefault(); if (active) { active.classList.remove('active'); active.style.background = ''; } idx = (idx + 1) % items.length; items[idx].classList.add('active'); items[idx].style.background = 'var(--accent-dim)'; items[idx].scrollIntoView({ block: 'nearest' }); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); if (active) { active.classList.remove('active'); active.style.background = ''; } idx = (idx - 1 + items.length) % items.length; items[idx].classList.add('active'); items[idx].style.background = 'var(--accent-dim)'; items[idx].scrollIntoView({ block: 'nearest' }); }
  else if (event.key === 'Enter') { event.preventDefault(); const target = active || items[0]; if (target) seleccionarResponsable(target.dataset.nombre); }
  else if (event.key === 'Escape') { cerrarResponsables(); }
}

// =====================================================
// NOTIFICACIONES — Sin checkin 4+ días
// =====================================================
let notifPanelAbierto = false;

async function cargarNotificaciones() {
  try {
    const badge = document.getElementById('notifBadge');
    const lista  = document.getElementById('notifLista');
    const totalEl = document.getElementById('notifTotal');
    if (!badge) return;

    const [rCheckin, rVencer] = await Promise.all([
      fetch('/facial/notificaciones-sin-checkin').then(r => r.json()).catch(() => ({ success: false, data: [], total: 0 })),
      fetch('/solicitudes/proximas-a-vencer').then(r => r.json()).catch(() => ({ success: false, data: [] }))
    ]);

    const checkinItems = rCheckin.success ? (rCheckin.data || []) : [];
    const vencerItems  = rVencer.success  ? (rVencer.data  || []) : [];
    const hoy = new Date(); hoy.setHours(0,0,0,0);

    const vencerFiltrados = vencerItems.filter(p => {
      const soloFecha = String(p.fecha_fin || '').slice(0, 10);
      const fechaFin = new Date(soloFecha + 'T12:00:00');
      if (isNaN(fechaFin.getTime())) return false;
      const dias = Math.round((fechaFin - hoy) / (1000*60*60*24));
      return dias >= 0 && dias <= 3;
    });

    const htmlVencer = vencerFiltrados.map(p => {
      const soloFecha = String(p.fecha_fin || '').slice(0, 10);
      const fechaFin = new Date(soloFecha + 'T12:00:00');
      const diasRestantes = Math.round((fechaFin - hoy) / (1000*60*60*24));
      const diasTxt = diasRestantes === 0 ? 'vence HOY' : diasRestantes === 1 ? 'vence en 1 día' : `vence en ${diasRestantes} días`;
      const color = diasRestantes === 0 ? '#ef4444' : '#f59e0b';
      return `<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:4px;border-left:3px solid ${color}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600;color:var(--text);font-size:13px">📋 ${p.folio}</span>
          <span style="font-size:10px;padding:2px 8px;background:rgba(245,158,11,0.1);border:1px solid ${color};color:${color};font-family:'Barlow Condensed',sans-serif;font-weight:700;letter-spacing:0.5px">${diasTxt.toUpperCase()}</span>
        </div>
        <div style="font-size:11px;color:var(--text-3);font-family:'Share Tech Mono',monospace">Solicitud próxima a vencer · ${p.empresa}</div>
      </div>`;
    }).join('');

    
    const htmlCheckin = checkinItems.map(t => {
      const ultimo = t.ultimo_acceso ? new Date(t.ultimo_acceso).toLocaleString('es-MX', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Nunca ha checado';
      const diffDias = t.ultimo_acceso ? Math.floor((new Date() - new Date(t.ultimo_acceso)) / (1000*60*60*24)) : null;
      return `<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:4px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600;color:var(--text);font-size:13px">${t.nombre} ${t.apellido}</span>
          <span style="font-size:10px;padding:2px 8px;background:rgba(239,68,68,0.1);border:1px solid #ef4444;color:#ef4444;font-family:'Barlow Condensed',sans-serif;font-weight:700;letter-spacing:0.5px">${diffDias !== null ? diffDias + ' DÍAS' : 'SIN REGISTRO'}</span>
        </div>
        <div style="font-size:11px;color:var(--text-3);font-family:'Share Tech Mono',monospace">Último acceso: ${ultimo}</div>
      </div>`;
    }).join('');

    const totalCount = vencerFiltrados.length + checkinItems.length;

    if (totalCount === 0) {
      badge.style.display = 'none';
      if (lista)   lista.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">✅ Sin alertas.</div>';
      if (totalEl) totalEl.textContent = '0 alertas';
      return;
    }

    badge.style.display = 'flex';
    badge.textContent = totalCount > 9 ? '9+' : totalCount;
    if (totalEl) totalEl.textContent = totalCount + ' alerta' + (totalCount !== 1 ? 's' : '');
    if (lista)   lista.innerHTML = htmlVencer + htmlCheckin;
  } catch(e) { console.warn('Error cargando notificaciones:', e.message); }
}

function toggleNotificaciones() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  notifPanelAbierto = !notifPanelAbierto;
  panel.style.display = notifPanelAbierto ? 'block' : 'none';
  if (notifPanelAbierto) cargarNotificaciones();
}

document.addEventListener('click', e => {
  const wrapper = document.getElementById('notifWrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    const panel = document.getElementById('notifPanel');
    if (panel) panel.style.display = 'none';
    notifPanelAbierto = false;
  }
});

if (typeof USER_ROL !== 'undefined' && (USER_ROL === 'contratista' || USER_ROL === 'seguridad_fisica')) {
  cargarNotificaciones();
  setInterval(cargarNotificaciones, 5 * 60 * 1000);
}

// ── Aprobar/Rechazar lote (seguridad física) ──────
let loteParaRechazar = null;

// REEMPLAZA la función aprobarLote completa:
async function aprobarLote(loteId) {
  const btn = event.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  try {
    const ipPrivadaAprobacion = await obtenerIPPrivada();
    const r = await fetch(`/solicitudes/lote/${loteId}/aprobar`, { 
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firma_aprobacion_ubicacion: _ubicacionActual || 'No disponible',
        firma_aprobacion_ip_privada: ipPrivadaAprobacion
      })
    });
    const d = await r.json();
    if (d.success) { 
      verDetalle(detalleSolicitudId); 
    } else {
      alert(d.error || 'Error al aprobar');
      if (btn) { btn.disabled = false; btn.textContent = '✓ APROBAR'; }
    }
  } catch(e) {
    alert('Error de conexión: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '✓ APROBAR'; }
  }
}

function abrirRechazoLote(loteId) {
  loteParaRechazar = loteId;
  const motivoEl = document.getElementById('motivoTexto');
  if (motivoEl) motivoEl.value = '';
  const modal = document.getElementById('modalMotivo');
  if (modal) modal.classList.add('open');
}

async function rechazarLote(loteId, motivo) {
  try {
    const ipPrivada = await obtenerIPPrivada();
    const r = await fetch(`/solicitudes/lote/${loteId}/rechazar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        motivo,
        firma_aprobacion_ubicacion: _ubicacionActual || 'No disponible',
        firma_aprobacion_ip_privada: ipPrivada
      })
    });
    const d = await r.json();
    if (d.success) {
      verDetalle(detalleSolicitudId);
    } else {
      alert(d.error || 'Error al rechazar');
    }
  } catch(e) {
    alert('Error de conexión: ' + e.message);
  }
}










let loteAreaParaRechazar = null;

async function aprobarLoteArea(loteId) {
  if (!confirm('¿Aprobar esta solicitud de retiro?')) return;
  try {
    const ipPrivada = await obtenerIPPrivada();
    const r = await fetch(`/solicitudes/lote/${loteId}/aprobar-area`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firma_aprobacion_ubicacion: _ubicacionActual || 'No disponible',
        firma_aprobacion_ip_privada: ipPrivada
      })
    });
    const d = await r.json();
    if (d.success) { verDetalle(detalleSolicitudId); }
    else { alert(d.error || 'Error al aprobar'); }
  } catch(e) { alert('Error de conexión: ' + e.message); }
}

function abrirRechazoLoteArea(loteId) {
  loteAreaParaRechazar = loteId;
  loteParaRechazar = null;
  const motivoEl = document.getElementById('motivoTexto');
  if (motivoEl) motivoEl.value = '';
  const modal = document.getElementById('modalMotivo');
  if (modal) modal.classList.add('open');
}



async function aprobarLoteSeguridad(loteId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  try {
    const ipPrivadaAprobacion = await obtenerIPPrivada();
    const r = await fetch(`/solicitudes/lote/${loteId}/aprobar`, { 
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firma_aprobacion_ubicacion: _ubicacionActual || 'No disponible',
        firma_aprobacion_ip_privada: ipPrivadaAprobacion
      })
    });
    const d = await r.json();
    if (d.success) { 
      verDetalle(detalleSolicitudId); 
    } else {
      alert(d.error || 'Error al aprobar');
      if (btn) { btn.disabled = false; btn.textContent = '✓ APROBAR'; }
    }
  } catch(e) {
    alert('Error de conexión: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '✓ APROBAR'; }
  }
}




async function aprobarLoteAreaBtn(loteId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  try {
    const ipPrivada = await obtenerIPPrivada();
    const r = await fetch(`/solicitudes/lote/${loteId}/aprobar-area`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firma_aprobacion_ubicacion: _ubicacionActual || 'No disponible',
        firma_aprobacion_ip_privada: ipPrivada
      })
    });
    const d = await r.json();
    if (d.success) { verDetalle(detalleSolicitudId); }
    else { 
      alert(d.error || 'Error al aprobar');
      if (btn) { btn.disabled = false; btn.textContent = '✓ APROBAR'; }
    }
  } catch(e) { 
    alert('Error de conexión: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '✓ APROBAR'; }
  }
}



// Modificar confirmarRechazo para soportar rechazo de lote



window.confirmarRechazo = async function() {
  const motivo = document.getElementById('motivoTexto')?.value.trim() || '';
  if (loteAreaParaRechazar) {
    const ipPrivada = await obtenerIPPrivada();
    const r = await fetch(`/solicitudes/lote/${loteAreaParaRechazar}/rechazar-area`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo, firma_aprobacion_ubicacion: _ubicacionActual||'No disponible', firma_aprobacion_ip_privada: ipPrivada })
    });
    const d = await r.json();
    if (d.success) { verDetalle(detalleSolicitudId); }
    else { alert(d.error || 'Error al rechazar'); }
    loteAreaParaRechazar = null;
    closeMotivo();
  } else if (loteParaRechazar) {
    await rechazarLote(loteParaRechazar, motivo);
    loteParaRechazar = null;
    closeMotivo();
  } else if (detalleSolicitudId) {
    const ipPrivada = await obtenerIPPrivada();
    await rechazarSolicitud(detalleSolicitudId, motivo, ipPrivada, _ubicacionActual || 'No disponible');
    closeMotivo();
    closeDetalleBtn();
  }
};


async function extenderPermiso(solicitudId) {
  const dias = parseInt(document.getElementById('input-dias-ext')?.value);
  const statusEl = document.getElementById('ext-status');

  if (!dias || dias < 1) {
    if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = '❌ Ingresa al menos 1 día'; }
    return;
  }

  // Necesitamos el lote_id — usamos el último lote aprobado de esta solicitud
  const lotes = document.querySelectorAll('.lote-card');
  // Alternativamente llamamos directo al permiso
  if (statusEl) { statusEl.style.color = 'var(--text-3)'; statusEl.textContent = '⏳ Extendiendo...'; }

  try {
    const r = await fetch(`/solicitudes/${solicitudId}/extender`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dias })
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);

    if (statusEl) { 
      statusEl.style.color = 'var(--success)'; 
      statusEl.textContent = `✅ Extendido hasta: ${formatFecha(d.fecha_fin_nueva)}`; 
    }

    // Recargar tabla y detalle después de 1.5s
    setTimeout(() => { cargarSolicitudes(); verDetalle(solicitudId); }, 1500);

  } catch(e) {
    if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = '❌ ' + e.message; }
  }
}


