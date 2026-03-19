/* =====================================================
   PROAGRO - Dashboard JS
===================================================== */

let todosSolicitudes = [];
let filtroActual = 'todos';
let seccionesAgregadas = {};
let dragType = null;

// Contadores de filas por sección
const rowCounters = { personal: 0, vehiculo: 0, equipo: 0 };
let empleadosCache = []; // Cache de empleados enrolados

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

const ICON_SVG = {
  personal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  vehiculo:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
  equipo:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`
};

// Definición de columnas por sección
const SECTION_COLS = {
  personal: [
    { id: 'num_credencial', label: 'NO. CREDENCIAL',  placeholder: 'Ej. CRED-001',        type: 'text',   required: true  },
    { id: 'nombre',         label: 'NOMBRE',          placeholder: 'Nombre completo',      type: 'text',   required: true  },
    { id: 'categoria',      label: 'CATEGORÍA',       placeholder: 'Ej. Operador',         type: 'text',   required: true  },
    { id: 'observaciones',  label: 'OBSERVACIONES',   placeholder: 'Notas...',             type: 'text'                    }
  ],
  vehiculo: [
    { id: 'marca',    label: 'MARCA',    placeholder: 'Ej. Toyota',    type: 'text', required: true },
    { id: 'modelo',   label: 'MODELO',   placeholder: 'Ej. Hilux',     type: 'text', required: true },
    { id: 'placas',   label: 'PLACAS',   placeholder: 'Ej. ABC-123-D', type: 'text', required: true },
    { id: 'seguro',   label: 'SEGURO',   placeholder: '',              type: 'file', accept: '.pdf,.jpg,.jpeg,.png' },
    { id: 'licencia', label: 'LICENCIA', placeholder: '',              type: 'file', accept: '.pdf,.jpg,.jpeg,.png' }
  ],
  equipo: [
    { id: 'cantidad',     label: 'CANT.',        placeholder: '1',               type: 'number', required: true },
    { id: 'descripcion',  label: 'DESCRIPCIÓN',  placeholder: 'Nombre/desc.',    type: 'text',   required: true },
    { id: 'marca',        label: 'MARCA',        placeholder: 'Ej. Bosch',       type: 'text',   required: true },
    { id: 'modelo',       label: 'MODELO',       placeholder: 'Modelo',          type: 'text'                   },
    { id: 'serie',     label: 'SERIE',     placeholder: 'Serie',        type: 'text'                   },
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
function openModalSolicitud() {
  // Reset empleados cache al abrir modal
  empleadosCache = [];
  // Cargar empleados de la empresa del usuario al abrir el modal
  setTimeout(() => {
    const empInput = document.getElementById('empresa');
    if (empInput && empInput.value) {
      cargarEmpleadosPorEmpresa(empInput.value);
    }
    if (empInput && !empInput._listenerAdded) {
      empInput._listenerAdded = true;
      empInput.addEventListener('input',  () => cargarEmpleadosPorEmpresa(empInput.value));
      empInput.addEventListener('change', () => cargarEmpleadosPorEmpresa(empInput.value));
    }
  }, 100);
  const modal = document.getElementById('modalSolicitud');
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  const hoy = new Date().toISOString().split('T')[0];
  document.getElementById('fecha_inicio').min = hoy;
  document.getElementById('fecha_fin').min = hoy;
}

function closeModal() {
  const modal = document.getElementById('modalSolicitud');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
  document.getElementById('formSolicitud').reset();
  document.getElementById('formDias').style.display = 'none';
  document.getElementById('modalAlert').style.display = 'none';
  document.getElementById('fechaHint').style.color = '';
  document.getElementById('fechaHint').textContent = 'Máximo 30 días desde la fecha de inicio.';
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
      document.getElementById('diasTexto').textContent = `${diffDays} día${diffDays!==1?'s':''} de duración`;
    }
  } else {
    hint.textContent = `Máximo 30 días. (Max: ${finInput.max})`;
    hint.style.color = ''; diasEl.style.display = 'none';
  }
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

  // Cabeceras
  const headers = `<tr>
    <th class="col-num">#</th>
    ${cols.map(c => `<th>${c.label}${c.required ? ' <span style="color:#ef4444">*</span>' : ''}</th>`).join('')}
    <th class="col-del"></th>
  </tr>`;

  // Botones del footer
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
        <label class="dnd-file-btn compact">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span class="file-label-text" id="fl-${rowId}-${c.id}">Adjuntar</span>
          <input type="file" accept="${c.accept||'*'}"
            onchange="onFileChange('${tipo}','${rowId}','${c.id}',this)">
        </label>
      </td>`;
    }
    // Campo nombre en personal — con autocomplete al escribir
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

  return `<tr id="row-${rowId}" class="sec-row">
    <td class="col-num">${rowNum}</td>
    ${cells.join('')}
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

  // Agregar fila vacía — el usuario escribe para buscar empleados
  addRow(tipo);
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

function onNombreInput(rowId, value) {
  onCellChange('personal', rowId, 'nombre', value);
  if (!value || value.length < 1) {
    const sugEl = document.getElementById(`sug-${rowId}`);
    if (sugEl) sugEl.style.display = 'none';
    return;
  }
  mostrarSugerencias(rowId);
}

function seleccionarEmpleadoIdx(rowId, idx) {
  const e = empleadosCache[idx];
  if (!e) return;
  seleccionarEmpleado(rowId, e);
}

function seleccionarEmpleado(rowId, e) {
  if (typeof e === 'string') e = JSON.parse(e);
  // Llenar nombre
  const inpNombre = document.getElementById(`inp-${rowId}-nombre`);
  if (inpNombre) { inpNombre.value = `${e.nombre} ${e.apellido}`; }
  onCellChange('personal', rowId, 'nombre', `${e.nombre} ${e.apellido}`);

  // Llenar credencial con documento si existe
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
  cerrarSugerencias(rowId);
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
  const tr = document.createElement('tr');
  tr.outerHTML; // just to init
  tbody.insertAdjacentHTML('beforeend', buildRowHTML(tipo, rowId, rowNum));
  if (!Array.isArray(seccionesAgregadas[tipo])) seccionesAgregadas[tipo] = [];
  seccionesAgregadas[tipo].push({ _id: rowId });
  updateRowCount(tipo);
}

function deleteRow(tipo, rowId) {
  const row = document.getElementById(`row-${rowId}`);
  if (row) row.remove();
  seccionesAgregadas[tipo] = (seccionesAgregadas[tipo] || []).filter(r => r._id !== rowId);
  // Renumerar
  const tbody = document.getElementById(`tbody-${tipo}`);
  if (tbody) Array.from(tbody.rows).forEach((r, i) => { if(r.cells[0]) r.cells[0].textContent = i + 1; });
  updateRowCount(tipo);
}

function removerSeccion(tipo) {
  delete seccionesAgregadas[tipo];
  document.getElementById(`expanded-${tipo}`)?.remove();
  document.querySelector(`.dnd-card-source[data-type="${tipo}"]`)?.classList.remove('used');
  if (Object.keys(seccionesAgregadas).length === 0) {
    const ph = document.getElementById('dndPlaceholder');
    if (ph) ph.style.display = 'flex';
  }
}

function onCellChange(tipo, rowId, fieldId, value) {
  const rows = seccionesAgregadas[tipo] || [];
  const row = rows.find(r => r._id === rowId);
  if (row) row[fieldId] = value;
  updateRowCount(tipo);
}

function onFileChange(tipo, rowId, fieldId, input) {
  const fname = input.files[0] ? input.files[0].name : 'Adjuntar';
  const label = document.getElementById(`fl-${rowId}-${fieldId}`);
  if (label) label.textContent = fname.length > 12 ? fname.substring(0,12)+'…' : fname;
  const rows = seccionesAgregadas[tipo] || [];
  const row = rows.find(r => r._id === rowId);
  if (row) row[fieldId] = input.files[0] ? input.files[0].name : '';
  updateRowCount(tipo);
}

function updateRowCount(tipo) {
  const rows = seccionesAgregadas[tipo] || [];
  const total = document.getElementById(`tbody-${tipo}`)?.rows.length || 0;
  const countEl = document.getElementById(`count-${tipo}`);
  if (countEl) countEl.textContent = `${total} registro${total !== 1 ? 's' : ''}`;
  const badge = document.getElementById(`badge-${tipo}`);
  if (badge) {
    badge.textContent = `${total} REGISTRO${total !== 1 ? 'S' : ''}`;
    badge.className = 'dnd-expanded-badge' + (total > 0 ? ' filled' : '');
  }
}

// ===================== EXCEL PLACEHOLDER =====================
function importarExcel() {
  alert('Función de importar Excel próximamente disponible.');
}

// ===================== FORM SUBMIT =====================
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('formSolicitud');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btnSubmit');
      const alertEl = document.getElementById('modalAlert');
      btn.disabled = true;
      btn.innerHTML = '<div class="loading-spinner" style="width:14px;height:14px;border-width:2px;margin:0"></div> CREANDO...';
      alertEl.style.display = 'none';
      const data = {
        empresa: document.getElementById('empresa').value,
        contrato: document.getElementById('contrato').value,
        fecha_inicio: document.getElementById('fecha_inicio').value,
        fecha_fin: document.getElementById('fecha_fin').value,
        secciones: seccionesAgregadas
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
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px"><polyline points="20,6 9,17 4,12"/></svg> CREAR SOLICITUD`;
      }
    });
  }
  cargarSolicitudes();
});

// ===================== TABLA SOLICITUDS =====================
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

// Mapa de estatus
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
    // Botón VER para todos los roles
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
  renderTabla(f);
}

async function aprobarSolicitud(id) {
  try {
    const res = await fetch(`/solicitudes/${id}/aprobar`, { method:'PUT', headers:{'Content-Type':'application/json'} });
    const r = await res.json();
    if (r.success) cargarSolicitudes();
    else alert(r.error || 'Error al aprobar.');
  } catch(e) { console.error(e); }
}

// Modal de rechazo con motivo
function abrirRechazo(id) {
  const motivo = prompt('Motivo de rechazo (opcional):');
  if (motivo === null) return; // canceló
  rechazarSolicitud(id, motivo);
}

async function rechazarSolicitud(id, motivo) {
  try {
    const res = await fetch(`/solicitudes/${id}/rechazar`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ motivo })
    });
    const r = await res.json();
    if (r.success) cargarSolicitudes();
    else alert(r.error || 'Error al rechazar.');
  } catch(e) { console.error(e); }
}

function formatFecha(f) {
  if (!f) return '—';
  // Soporta: '2026-03-10', '2026-03-10T00:00:00.000Z', objetos Date
  const s = String(f).substring(0, 10); // toma solo YYYY-MM-DD
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return '—';
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return `${d} ${meses[parseInt(m,10)-1]} ${y}`;
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
document.addEventListener('keydown', e => { if (e.key==='Escape') { closeSidebar(); closeModal(); } });


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
    const result     = await res.json();
    const lotesResult = resLotes.ok ? await resLotes.json() : { success: false, data: [] };
    const accesosResult = resAccesos.ok ? await resAccesos.json() : { success: false, data: [] };
    const accesosFaciales = accesosResult.success ? accesosResult.data : [];
    if (!result.success) { body.innerHTML = `<p style="padding:40px;color:var(--danger)">${result.error}</p>`; return; }

    const { solicitud, personal, vehiculos, equipos } = result.data;
    const lotes       = lotesResult.success ? lotesResult.data : [];
    const puedeRegistrar = USER_ROL === 'seguridad_fisica' && solicitud.estado === 'activo';

    // Calcular totales ya registrados por equipo
    const salidasPorEquipo = {};
    lotes.forEach(lote => {
      (lote.items || []).forEach(item => {
        if (item.tipo_item === 'equipo') {
          salidasPorEquipo[item.item_id] = (salidasPorEquipo[item.item_id] || 0) + parseInt(item.cantidad || 1);
        }
      });
    });

    // Calcular salidas por personal y vehiculo
    const personalConSalida = new Set();
    const vehiculoConSalida = new Set();
    lotes.forEach(lote => {
      (lote.items || []).forEach(item => {
        if (item.tipo_item === 'personal') personalConSalida.add(item.item_id);
        if (item.tipo_item === 'vehiculo') vehiculoConSalida.add(item.item_id);
      });
    });

    const info = ESTADO_INFO[solicitud.estado] || { label: solicitud.estado, cls: 'status-pendiente' };
    folioEl.textContent = solicitud.folio;
    eyebrow.innerHTML = `SOLICITUD &nbsp;/&nbsp; <span class="status-badge ${info.cls}" style="font-size:10px;padding:2px 10px"><span class="status-dot-sm"></span>${info.label}</span>`;

    // Botones de acción según rol y estado
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

    // Botón QR para solicitudes activos (todos los roles pueden verlo)
    if (solicitud.estado === 'activo') {
      acciones.innerHTML += `
        <button class="btn-qr" onclick="verQRSolicitud(${solicitud.id})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="3" height="3"/>
            <rect x="18" y="14" width="3" height="3"/><rect x="14" y="18" width="3" height="3"/>
            <rect x="18" y="18" width="3" height="3"/>
          </svg>
          VER QR
        </button>`;
    }

    // ---- RENDER BODY ----
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
          <div class="detalle-field"><div class="detalle-field-label">RESPONSABLE</div><div class="detalle-field-value">${escapeHtml(solicitud.responsable_contrato)}</div></div>
          <div class="detalle-field"><div class="detalle-field-label">FECHA INICIO</div><div class="detalle-field-value">${formatFecha(solicitud.fecha_inicio)}</div></div>
          <div class="detalle-field"><div class="detalle-field-label">FECHA FIN</div><div class="detalle-field-value">${formatFecha(solicitud.fecha_fin)}</div></div>
          <div class="detalle-field"><div class="detalle-field-label">CREADO POR</div><div class="detalle-field-value">${escapeHtml(solicitud.creado_por_nombre||'—')}</div></div>
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

      <!-- PERSONAL -->
      ${personal.length > 0 ? `
      <div class="detalle-section">
        <div class="detalle-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          Personal (${personal.length} registros)
          ${puedeRegistrar ? '<span class="sec-hint">— marca los que salen</span>' : ''}
        </div>
        <table class="detalle-table">
          <thead><tr>
            ${puedeRegistrar ? '<th style="width:40px"><input type="checkbox" id="chk-all-personal" onchange="toggleAll(\'personal\',this.checked)" title="Seleccionar todos"></th>' : ''}
            <th>#</th><th>NO. CREDENCIAL</th><th>NOMBRE</th><th>CATEGORÍA</th><th>ESTADO SALIDA</th>
          </tr></thead>
          <tbody>${personal.map((p,i) => {
            const yaSalio = personalConSalida.has(p.id);
            return `<tr>
              ${puedeRegistrar ? `<td style="text-align:center">${yaSalio ? '' : `<input type="checkbox" class="chk-item" data-tipo="personal" data-id="${p.id}">`}</td>` : ''}
              <td style="color:var(--text-3);font-family:'Share Tech Mono',monospace">${i+1}</td>
              <td style="font-family:'Share Tech Mono',monospace;color:var(--accent)">${escapeHtml(p.num_credencial||'—')}</td>
              <td style="color:var(--text);font-weight:500">
                ${escapeHtml(p.nombre||'—')}
                ${p.imss_vigente === false ? '<span style="font-size:10px;padding:2px 6px;border:1px solid #f59e0b;color:#f59e0b;margin-left:6px;font-family:Barlow Condensed,sans-serif">⚠ IMSS NO VIGENTE</span>' : ''}
                ${p.imss_vigente === true ? '<span style="font-size:10px;padding:2px 6px;border:1px solid var(--success);color:var(--success);margin-left:6px;font-family:Barlow Condensed,sans-serif">✓ IMSS</span>' : ''}
              </td>
              <td>${escapeHtml(p.categoria||'—')}</td>
              <td>${yaSalio ? '<span class="salida-badge salida-ok">✓ Registrado</span>' : '<span class="salida-badge" style="color:var(--text-3);border-color:var(--border)">Pendiente</span>'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>

        ${accesosFaciales.length > 0 ? `
        <div style="margin-top:16px">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;color:var(--text-3);margin-bottom:8px">REGISTRO DE ACCESOS FACIALES</div>
          <table class="detalle-table">
            <thead><tr><th>#</th><th>NOMBRE</th><th>MOVIMIENTO</th><th>HORA</th></tr></thead>
            <tbody>${accesosFaciales.map((a,i) => {
              const esEntrada = a.tipo_movimiento === 'entrada';
              const hora = a.fecha_hora ? new Date(a.fecha_hora).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}) : '—';
              return '<tr>' +
                '<td style="color:var(--text-3);font-family:Share Tech Mono,monospace">'+(i+1)+'</td>' +
                '<td style="color:var(--text);font-weight:500">'+escapeHtml((a.nombre||'')+' '+(a.apellido||''))+'</td>' +
                '<td>'+(esEntrada ? '<span style="color:var(--accent);font-weight:700">↓ ENTRADA</span>' : '<span style="color:var(--danger);font-weight:700">↑ SALIDA</span>')+'</td>' +
                '<td style="font-family:Share Tech Mono,monospace;color:var(--text-3)">'+hora+'</td>' +
                '</tr>';
            }).join('')}</tbody>
          </table>
        </div>` : ''}

      </div>` : ''}

      <!-- VEHÍCULOS -->
      ${vehiculos.length > 0 ? `
      <div class="detalle-section">
        <div class="detalle-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
          Vehículos (${vehiculos.length} registros)
          ${puedeRegistrar ? '<span class="sec-hint">— marca los que salen</span>' : ''}
        </div>
        <table class="detalle-table">
          <thead><tr>
            ${puedeRegistrar ? '<th style="width:40px"><input type="checkbox" id="chk-all-vehiculo" onchange="toggleAll(\'vehiculo\',this.checked)" title="Seleccionar todos"></th>' : ''}
            <th>#</th><th>MARCA</th><th>MODELO</th><th>PLACAS</th><th>SEGURO</th><th>LICENCIA</th><th>ESTADO SALIDA</th>
          </tr></thead>
          <tbody>${vehiculos.map((v,i) => {
            const yaSalio = vehiculoConSalida.has(v.id);
            return `<tr>
              ${puedeRegistrar ? `<td style="text-align:center">${yaSalio ? '' : `<input type="checkbox" class="chk-item" data-tipo="vehiculo" data-id="${v.id}">`}</td>` : ''}
              <td style="color:var(--text-3);font-family:'Share Tech Mono',monospace">${i+1}</td>
              <td style="color:var(--text);font-weight:500">${escapeHtml(v.marca||'—')}</td>
              <td>${escapeHtml(v.modelo||'—')}</td>
              <td style="font-family:'Share Tech Mono',monospace;color:var(--accent)">${escapeHtml(v.placas||'—')}</td>
              <td>${escapeHtml(v.seguro||'—')}</td>
              <td>${escapeHtml(v.licencia||'—')}</td>
              <td>${yaSalio ? '<span class="salida-badge salida-ok">✓ Registrado</span>' : '<span class="salida-badge" style="color:var(--text-3);border-color:var(--border)">Pendiente</span>'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>` : ''}

      <!-- EQUIPOS -->
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
              ${puedeRegistrar ? `<td style="text-align:center">${agotado ? '' : `<input type="checkbox" class="chk-item" data-tipo="equipo" data-id="${e.id}">`}</td>` : ''}
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

      <!-- BOTÓN REGISTRAR LOTE (solo seguridad activo) -->
      ${puedeRegistrar ? `
      <div class="detalle-section" style="background:rgba(245,158,11,0.04);border-top:2px solid rgba(245,158,11,0.2)">
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <div style="flex:1">
            <div class="detalle-field-label" style="margin-bottom:6px">OBSERVACIONES DEL LOTE (opcional)</div>
            <input type="text" id="lote-obs" class="form-input" placeholder="Ej: Salida para trabajo en bodega norte..." style="width:100%;max-width:500px">
          </div>
          <button class="btn-registrar-lote" id="btnRegistrarLote" onclick="registrarLote(${solicitud.id})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px"><polyline points="9,11 12,14 22,4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            REGISTRAR SALIDA
          </button>
        </div>
        <div id="lote-feedback" style="margin-top:10px;font-size:13px;display:none"></div>
      </div>` : ''}

      <!-- BOTÓN CREDENCIALES PDF -->
      ${solicitud.estado === 'activo' ? `
      <div style="margin-bottom:16px">
        <a href="/solicitudes/${solicitud.id}/credenciales" target="_blank"
          style="display:inline-flex;align-items:center;gap:8px;padding:10px 18px;background:transparent;border:1.5px solid var(--accent);color:var(--accent);font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;letter-spacing:1px;text-decoration:none">
          📄 DESCARGAR CREDENCIALES PDF
        </a>
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
                <span class="lote-fecha">${formatHora(lote.registrado_en)}</span>
                <span class="lote-quien">por ${escapeHtml(lote.registrado_por_nombre||'—')}</span>
                ${lote.observaciones ? `<span class="lote-obs-preview">"${escapeHtml(lote.observaciones)}"</span>` : ''}
              </div>
              <div class="lote-header-right">
                <span class="lote-count">${(lote.items||[]).length} item${(lote.items||[]).length!==1?'s':''}</span>
                <svg class="lote-chevron" id="chev-${lote.id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;transition:transform 0.2s"><polyline points="6,9 12,15 18,9"/></svg>
              </div>
            </div>
            <div class="lote-detalle" id="lote-${lote.id}">
              <table class="detalle-table" style="margin-top:8px">
                <thead><tr><th>TIPO</th><th>DESCRIPCIÓN</th><th>CANT.</th></tr></thead>
                <tbody>${(lote.items||[]).map(item => `<tr>
                  <td><span class="tipo-badge tipo-${item.tipo_item}">${item.tipo_item}</span></td>
                  <td style="color:var(--text);font-weight:500">${escapeHtml(item.descripcion||String(item.item_id))}</td>
                  <td style="font-family:'Share Tech Mono',monospace;text-align:center;color:var(--warning);font-weight:700">${item.cantidad||1}</td>
                </tr>`).join('')}</tbody>
              </table>
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

// Toggle checkbox "seleccionar todos" por sección
function toggleAll(tipo, checked) {
  document.querySelectorAll(`.chk-item[data-tipo="${tipo}"]`).forEach(c => c.checked = checked);
}

// Expandir/colapsar lote en bitácora
function toggleLote(id) {
  const el   = document.getElementById(`lote-${id}`);
  const chev = document.getElementById(`chev-${id}`);
  const open = el.classList.toggle('open');
  if (chev) chev.style.transform = open ? 'rotate(180deg)' : '';
}

// Registrar lote de salida
async function registrarLote(solicitud_id) {
  const items = [];

  // Recolectar checkboxes seleccionados
  document.querySelectorAll('.chk-item:checked').forEach(chk => {
    const tipo  = chk.dataset.tipo;
    const id    = parseInt(chk.dataset.id);
    let cantidad = 1;
    if (tipo === 'equipo') {
      const qInput = document.getElementById(`qty-${id}`);
      cantidad = qInput ? parseInt(qInput.value) || 1 : 1;
    }
    items.push({ tipo_item: tipo, item_id: id, cantidad });
  });

  if (items.length === 0) {
    mostrarFeedback('Selecciona al menos un item para registrar.', 'error');
    return;
  }

  const obs = document.getElementById('lote-obs')?.value?.trim() || null;
  const btn = document.getElementById('btnRegistrarLote');
  if (btn) { btn.disabled = true; btn.textContent = 'Registrando...'; }

  try {
    const res = await fetch(`/solicitudes/${solicitud_id}/lote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, observaciones: obs })
    });
    const r = await res.json();
    if (r.success) {
      verDetalle(solicitud_id); // recargar modal
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
  const pasos = [
    { label: 'Creado por Contratista',   estado: 'en_espera_area',       meta: solicitud.creado_por_nombre,         fecha: solicitud.creado_en },
    { label: 'Revisión del Área',         estado: 'aprobado_area',         meta: solicitud.aprobado_area_nombre,      fecha: solicitud.fecha_aprobacion_area },
    { label: 'Validación de Seguridad',   estado: 'activo',                meta: solicitud.aprobado_seg_nombre,       fecha: solicitud.fecha_aprobacion_seg },
  ];

  const orden = ['en_espera_area','aprobado_area','en_espera_seguridad','activo'];
  const idxActual = orden.indexOf(solicitud.estado);

  return pasos.map((paso, i) => {
    let dotClass = '';
    let icono = '○';
    if (solicitud.estado === 'rechazado' && i === (idxActual < 0 ? 1 : idxActual)) {
      dotClass = 'rejected'; icono = '✕';
    } else if (i < idxActual || solicitud.estado === 'activo') {
      dotClass = 'done'; icono = '✓';
    } else if (i === idxActual || (i === 0 && solicitud.estado === 'en_espera_area')) {
      dotClass = 'active'; icono = '●';
    }

    return `<div class="timeline-step">
      <div class="timeline-dot ${dotClass}">${icono}</div>
      <div class="timeline-info">
        <div class="timeline-label">${paso.label}</div>
        <div class="timeline-meta">${paso.meta ? escapeHtml(paso.meta) : '—'}${paso.fecha ? ' · ' + formatFecha(paso.fecha) : ''}</div>
      </div>
    </div>`;
  }).join('');
}

function closeDetalle(e) {
  // Solo cierra con el botón X
}
function closeDetalleBtn() {
  document.getElementById('modalDetalle').classList.remove('open');
  document.body.style.overflow = '';
  detalleSolicitudId = null;
}

// Aprobar desde el modal de detalle
async function aprobarDesdeDetalle() {
  if (!detalleSolicitudId) return;
  const id = detalleSolicitudId;

  try {
    const res = await fetch(`/solicitudes/${id}/aprobar`, { method:'PUT', headers:{'Content-Type':'application/json'} });
    const r = await res.json();
    if (!r.success) { alert(r.error || 'Error al aprobar.'); return; }

    cargarSolicitudes();
    closeDetalleBtn();

    // Si es Seguridad Física y la solicitud quedó Activo → generar QR
    if (USER_ROL === 'seguridad_fisica' && r.data && r.data.estado === 'activo') {
      // Cargar detalle completo para el QR
      const resD = await fetch(`/solicitudes/${id}`);
      const detalle = await resD.json();
      if (detalle.success) {
        mostrarQR(detalle.data);
      }
    }
  } catch(e) { console.error(e); alert('Error de conexión.'); }
}

// Rechazar desde el modal de detalle
function abrirRechazoDetalle() {
  document.getElementById('motivoTexto').value = '';
  document.getElementById('modalMotivo').classList.add('open');
}
function closeMotivo() {
  document.getElementById('modalMotivo').classList.remove('open');
}
async function confirmarRechazo() {
  const motivo = document.getElementById('motivoTexto').value.trim();
  if (!detalleSolicitudId) return;
  await rechazarSolicitud(detalleSolicitudId, motivo);
  closeMotivo();
  closeDetalleBtn();
}

// Mantener compatibilidad con botones viejos de la tabla
function abrirRechazo(id) {
  detalleSolicitudId = id;
  abrirRechazoDetalle();
}

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
    if (r.success) {
      // Recargar el modal para reflejar cambios
      verDetalle(solicitud_id);
    } else {
      alert(r.error || 'Error al registrar salida.');
    }
  } catch(e) {
    console.error(e);
    alert('Error de conexión.');
  }
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
// QR — SOLICITUD ACTIVO
// =====================================================
let qrInstance = null;

function buildQRText(data) {
  const { solicitud } = data;
  // Solo folio + datos mínimos para no exceder el límite del QR (~1248 chars)
  return [
    'PROAGRO - SOLICITUD ACTIVO',
    `FOLIO: ${solicitud.folio}`,
    `EMPRESA: ${solicitud.empresa.substring(0,40)}`,
    `INICIO: ${formatFecha(solicitud.fecha_inicio)}`,
    `FIN: ${formatFecha(solicitud.fecha_fin)}`,
    `AUTORIZADO: ${(solicitud.aprobado_seg_nombre||'').substring(0,30)}`
  ].join('\n');
}

// Texto legible completo para mostrar en pantalla (no va al QR)
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
  if (personal && personal.length > 0) {
    lineas.push(`----- PERSONAL (${personal.length}) -----`);
    personal.forEach((p,i) => lineas.push(`${i+1}. ${p.nombre} | Cred: ${p.num_credencial||'—'} | ${p.categoria||'—'}`));
    lineas.push('');
  }
  if (vehiculos && vehiculos.length > 0) {
    lineas.push(`----- VEHÍCULOS (${vehiculos.length}) -----`);
    vehiculos.forEach((v,i) => lineas.push(`${i+1}. ${v.marca} ${v.modelo} | Placas: ${v.placas}`));
    lineas.push('');
  }
  if (equipos && equipos.length > 0) {
    lineas.push(`----- EQUIPO/HERRAMIENTAS (${equipos.length}) -----`);
    equipos.forEach((e,i) => lineas.push(`${i+1}. ${e.descripcion} | Cant: ${e.cantidad} | ${e.marca||'—'}`));
  }
  lineas.push('');
  lineas.push(`Generado: ${new Date().toLocaleString('es-MX')}`);
  return lineas.join('\n');
}

function mostrarQR(data) {
  const { solicitud } = data;
  const texto = buildQRText(data);

  // Mostrar folio en header
  document.getElementById('qrFolio').textContent = solicitud.folio;

  // Mostrar texto completo en el panel (legible), QR usa versión corta
  document.getElementById('qrInfo').textContent = buildTextoCompleto(data);

  // Limpiar QR anterior
  const canvas = document.getElementById('qrCanvas');
  canvas.innerHTML = '';
  qrInstance = null;

  // Generar QR
  qrInstance = new QRCode(canvas, {
    text: texto,
    width: 240,
    height: 240,
    colorDark: '#0f0f0f',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.L
  });

  // Mostrar modal
  document.getElementById('modalQR').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeQR(e) {
  // Solo cierra con el botón X
}
function closeQRBtn() {
  document.getElementById('modalQR').classList.remove('open');
  document.body.style.overflow = '';
}

function descargarQR() {
  const canvas = document.querySelector('#qrCanvas canvas') ||
                 document.querySelector('#qrCanvas img');
  if (!canvas) return;

  const folio = document.getElementById('qrFolio').textContent || 'solicitud';

  if (canvas.tagName === 'CANVAS') {
    const link = document.createElement('a');
    link.download = `QR-${folio}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  } else if (canvas.tagName === 'IMG') {
    const link = document.createElement('a');
    link.download = `QR-${folio}.png`;
    link.href = canvas.src;
    link.click();
  }
}

// También permitir ver QR desde el modal de detalle (solicitud ya activo)
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
  if (tipo === 'entrada') {
    btnEntrada.style.background = 'var(--accent)';
    btnEntrada.style.color = '#000';
    btnSalida.style.background = 'var(--dark-4)';
    btnSalida.style.color = 'var(--text-2)';
  } else {
    btnSalida.style.background = '#ef4444';
    btnSalida.style.color = '#fff';
    btnEntrada.style.background = 'var(--dark-4)';
    btnEntrada.style.color = 'var(--text-2)';
  }
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
  // tipo_movimiento ahora es automático
  const statusEl = document.getElementById('verif-status');
  statusEl.className = 'facial-status';
  statusEl.textContent = '⏳ Iniciando cámara...';
  if (!facialModelos) {
    statusEl.className = 'facial-status warn';
    statusEl.textContent = '⏳ Cargando modelos faciales...';
    facialModelos = await Facial.cargarModelos();
  }
  const ok = await Facial.iniciarCamara('verif-video', 'verif-canvas');
  if (!ok) { statusEl.className = 'facial-status error'; statusEl.textContent = '❌ No se pudo acceder a la cámara'; return; }
  Facial.iniciarDeteccion(
    () => { statusEl.className = 'facial-status ok'; statusEl.textContent = '✅ Rostro detectado — listo para verificar'; document.getElementById('btn-verif-capturar').disabled = false; },
    () => { statusEl.className = 'facial-status error'; statusEl.textContent = '❌ Sin rostro — colócate frente a la cámara'; document.getElementById('btn-verif-capturar').disabled = true; }
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
    const permInfo = r.solicitud
      ? `<div style="font-size:12px;margin-top:6px;opacity:0.8">Solicitud: ${r.solicitud.folio} · ${r.solicitud.empresa}</div>`
      : `<div style="font-size:12px;margin-top:6px;color:#f59e0b">⚠️ Sin solicitud activo hoy</div>`;
    resultEl.className = 'facial-result permitido';
    resultEl.innerHTML = `${icono} ${mov} — ${r.empleado.nombre} ${r.empleado.apellido}<br>
      <span style="font-size:13px">${r.empleado.area||''} · ${r.hora||''}</span>
      ${permInfo}`;
  } else {
    resultEl.className = 'facial-result denegado';
    resultEl.textContent = '❌ Rostro no reconocido';
  }
  btn.disabled = false; btn.textContent = 'VERIFICAR';
}

function cerrarFacialVerificar() {
  Facial.detenerCamara();
  document.getElementById('modalVerificar').classList.remove('open');
  document.body.style.overflow = '';
}

async function abrirFacialEnrolar() {
  document.getElementById('modalEnrolar').classList.add('open');
  document.body.style.overflow = 'hidden';
  facialDescriptorEnrol = null;
  // Limpiar campos
  ['enrol-nombre','enrol-apellido','enrol-email','enrol-documento','enrol-empresa','enrol-area','enrol-cargo'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('enrol-pendiente-id').textContent = '';
  // Prellenar empresa si es contratista
  if (window._userRol === 'contratista' && window._userEmpresa) {
    document.getElementById('enrol-empresa').value = window._userEmpresa;
  }
  // Sin dropdown de empleados pendientes
  const statusEl = document.getElementById('enrol-status');
  const capEl = document.getElementById('enrol-cap-status');
  statusEl.className = 'facial-status'; statusEl.textContent = '⏳ Iniciando cámara...';
  capEl.className = 'facial-status error'; capEl.textContent = '❌ Rostro no capturado';
  document.getElementById('btn-enrol-capturar').disabled = true;
  document.getElementById('btn-enrol-guardar').disabled = true;
  if (!facialModelos) { facialModelos = await Facial.cargarModelos(); }
  const ok = await Facial.iniciarCamara('enrol-video', 'enrol-canvas');
  if (!ok) { statusEl.className = 'facial-status error'; statusEl.textContent = '❌ No se pudo acceder a la cámara'; return; }
  Facial.iniciarDeteccion(
    () => { statusEl.className = 'facial-status ok'; statusEl.textContent = '✅ Rostro detectado'; document.getElementById('btn-enrol-capturar').disabled = false; },
    () => { statusEl.className = 'facial-status error'; statusEl.textContent = '❌ Sin rostro detectado'; document.getElementById('btn-enrol-capturar').disabled = true; }
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
let enrolCredFile    = null;
let enrolImssFile    = null;
let enrolCredProcesado = false;
let enrolImssProcesado = false;
let enrolCredData    = null; // base64
let enrolImssData    = null; // base64

function enrolArchivoSeleccionado(input, tipo) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Archivo demasiado grande (máx 10 MB)'); return; }
  if (tipo === 'cred') {
    enrolCredFile = file;
    enrolCredProcesado = false;
    enrolCredData = null;
    document.getElementById('enrol-cred-label').textContent = '⏳ ' + file.name;
  } else {
    enrolImssFile = file;
    enrolImssProcesado = false;
    enrolImssData = null;
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
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  enrolArchivoSeleccionado(input, tipo);
}

function enrolReintentarDoc(tipo) {
  // Reset y volver a seleccionar
  if (tipo === 'cred') {
    enrolCredFile = null; enrolCredProcesado = false; enrolCredData = null;
    document.getElementById('enrol-cred-proceso').style.display = 'none';
    document.getElementById('enrol-cred-retry').style.display = 'none';
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
  procesoEl.style.color   = 'var(--text-2)';
  procesoEl.innerHTML     = '⏳ Comprimiendo imagen...';
  retryEl.style.display   = 'none';

  try {
    const base64 = await fileToBase64(file);

    procesoEl.innerHTML = '⏳ Enviando a procesamiento con IA...';

    // Enviar a n8n según tipo
    const endpoint = tipo === 'imss' ? '/documentos/procesar-imss' : '/documentos/procesar-doc';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, mime: file.type, nombre: file.name })
    });
    const data = await resp.json();

    if (!data.success) throw new Error(data.error || 'Error de procesamiento');

    // Éxito
    if (tipo === 'cred') {
      enrolCredProcesado = true;
      enrolCredData = { base64, mime: file.type, nombre: file.name, extracted: data.extracted };
      const docType = data.extracted?.clave_elector ? 'INE' : data.extracted?.numero_pasaporte ? 'PASAPORTE' : 'Documento';
      const nombre  = data.extracted?.nombre || '';
      procesoEl.innerHTML = `✅ ${docType} procesado — ${nombre}`;
      procesoEl.style.color = 'var(--success)';
      dropEl.style.borderColor = 'var(--success)';
      labelEl.textContent = '✅ ' + file.name;
      if (warnEl) warnEl.style.display = 'none';
    } else {
      enrolImssProcesado = true;
      enrolImssData = { base64, mime: file.type, nombre: file.name, extracted: data.extracted };
      const vigente = data.extracted?.vigente;
      const nombre  = data.extracted?.nombre_asegurado || '';
      const fecha   = data.extracted?.fecha_vigencia || '';
      procesoEl.innerHTML = vigente
        ? `✅ VIGENTE — ${nombre} — Hasta: ${fecha}`
        : `⚠️ NO VIGENTE — ${nombre}`;
      procesoEl.style.color = vigente ? 'var(--success)' : 'var(--warning)';
      dropEl.style.borderColor = vigente ? 'var(--success)' : 'var(--warning)';
      labelEl.textContent = '✅ ' + file.name;
      if (warnEl) warnEl.style.display = 'none';
    }

  } catch(e) {
    procesoEl.innerHTML = `❌ Error: ${e.message}`;
    procesoEl.style.color = 'var(--danger)';
    dropEl.style.borderColor = 'var(--danger)';
    retryEl.style.display = 'block';
    if (tipo === 'cred') { enrolCredFile = null; enrolCredProcesado = false; }
    else { enrolImssFile = null; enrolImssProcesado = false; }
  }
  verificarBotonGuardar();
}

function verificarBotonGuardar() {
  const tieneFoto = facialDescriptorEnrol !== null;
  const tieneCred = enrolCredProcesado;
  const tieneImss = enrolImssProcesado;

  const fotoWarn = document.getElementById('warn-foto');
  const credWarn = document.getElementById('warn-cred');
  const imssWarn = document.getElementById('warn-imss');
  if (fotoWarn) fotoWarn.style.display = tieneFoto ? 'none' : 'flex';
  if (credWarn) credWarn.style.display = (enrolCredFile || tieneCred) ? 'none' : 'flex';
  if (imssWarn) imssWarn.style.display = (enrolImssFile || tieneImss) ? 'none' : 'flex';

  const btn = document.getElementById('btn-enrol-guardar');
  btn.disabled = !(tieneFoto && tieneCred && tieneImss);
  btn.style.opacity = (tieneFoto && tieneCred && tieneImss) ? '1' : '0.5';
}

async function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function guardarEnrolamiento() {
  const nombre    = document.getElementById('enrol-nombre').value.trim();
  const apellido  = document.getElementById('enrol-apellido').value.trim();
  const email     = document.getElementById('enrol-email').value.trim();
  const documento = document.getElementById('enrol-documento').value.trim();
  const area      = document.getElementById('enrol-area').value.trim();
  const cargo     = document.getElementById('enrol-cargo').value.trim();
  const empresa   = document.getElementById('enrol-empresa')?.value.trim() || '';

  // Validar campos de texto
  const warnDatos = document.getElementById('warn-datos');
  if (!nombre || !apellido) {
    if (warnDatos) { warnDatos.style.display = 'flex'; warnDatos.textContent = '⚠ Nombre y apellido son obligatorios'; }
    return;
  }
  if (!empresa) {
    if (warnDatos) { warnDatos.style.display = 'flex'; warnDatos.textContent = '⚠ La empresa es obligatoria'; }
    return;
  }
  if (warnDatos) warnDatos.style.display = 'none';

  // Validar foto, credencial e IMSS
  verificarBotonGuardar();
  if (!facialDescriptorEnrol || !enrolCredFile || !enrolImssFile) return;

  const btn = document.getElementById('btn-enrol-guardar');
  const statusEl = document.getElementById('enrol-save-status');
  btn.disabled = true;
  btn.textContent = '⏳ Procesando...';
  statusEl.style.display = 'block';
  statusEl.textContent = 'Convirtiendo documentos...';

  try {
    statusEl.textContent = 'Registrando empleado...';

    // 1. Crear empleado con estatus no_activo
    const rEmp = await Facial.enrolar({
      nombre, apellido, email, documento, area, cargo, empresa,
      descriptor: facialDescriptorEnrol,
      estatus: 'no_activo'
    });

    if (!rEmp.success) throw new Error(rEmp.error || 'Error al registrar empleado');

    const empleadoId = rEmp.empleado.id;
    statusEl.textContent = 'Subiendo credencial...';

    statusEl.textContent = 'Guardando credencial...';

    // 2. Guardar credencial ya procesada
    const rCred = await fetch('/documentos/subir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archivos: [{ nombre: enrolCredData.nombre, mime: enrolCredData.mime, base64: enrolCredData.base64, tipo: 'DOC' }],
        empleado_id: empleadoId
      })
    }).then(r => r.json());

    statusEl.textContent = 'Guardando vigencia IMSS...';

    // 3. Guardar vigencia IMSS ya procesada
    const rImss = await fetch('/documentos/subir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archivos: [{ nombre: enrolImssData.nombre, mime: enrolImssData.mime, base64: enrolImssData.base64, tipo: 'IMSS' }],
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

function cargarEmpleadoPendiente(id) {
  if (!id) return;
  const sel = document.getElementById('enrol-pendientes');
  const opt = sel.querySelector(`option[value="${id}"]`);
  if (!opt) return;
  const e = JSON.parse(opt.dataset.emp);
  const partes = (e.apellido || '').split(' ');
  document.getElementById('enrol-nombre').value    = e.nombre || '';
  document.getElementById('enrol-apellido').value  = e.apellido || '';
  document.getElementById('enrol-documento').value = e.documento_identidad || '';
  document.getElementById('enrol-empresa').value   = e.empresa || '';
  document.getElementById('enrol-cargo').value     = e.cargo && e.cargo !== 'Pendiente' ? e.cargo : '';
  document.getElementById('enrol-pendiente-id').textContent = id;
}

function cerrarFacialEnrolar() {
  enrolCredFile = null; enrolImssFile = null;
  enrolCredProcesado = false; enrolImssProcesado = false;
  enrolCredData = null; enrolImssData = null;
  Facial.detenerCamara();
  document.getElementById('modalEnrolar').classList.remove('open');
  document.body.style.overflow = '';
  ['enrol-nombre','enrol-apellido','enrol-email','enrol-documento','enrol-area','enrol-cargo','enrol-empresa']
    .forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  facialDescriptorEnrol = null;
}

async function abrirFacialHistorial() {
  document.getElementById('modalHistorial').classList.add('open');
  document.body.style.overflow = 'hidden';
  const loading = document.getElementById('historial-loading');
  const table = document.getElementById('historial-table');
  const tbody = document.getElementById('historial-body');
  loading.style.display = 'block'; loading.className = 'facial-status'; loading.textContent = '⏳ Cargando historial...';
  table.style.display = 'none';
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

function cerrarFacialHistorial() {
  document.getElementById('modalHistorial').classList.remove('open');
  document.body.style.overflow = '';
}

function exportarAccesosExcel() {
  const tbody = document.getElementById('historial-body');
  if (!tbody || !tbody.rows.length) { alert('No hay datos para exportar'); return; }
  const headers = ['Fecha / Hora', 'Resultado', 'Empleado', 'Area', 'Similitud'];
  const rows = Array.from(tbody.rows).map(row =>
    Array.from(row.cells).map(cell => cell.textContent.trim().replace(/^[✅❌]\s*/, ''))
  );
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [{wch:22},{wch:12},{wch:30},{wch:15},{wch:12}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Accesos Faciales');
  const fecha = new Date().toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric'}).replace(/\//g,'-');
  XLSX.writeFile(wb, 'PROAGRO_Accesos_Faciales_' + fecha + '.xlsx');
}
