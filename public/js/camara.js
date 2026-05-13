// ═══════════════════════════════════════════════════
// CAMARA.JS — Guía facial con óvalo y escáner de documentos
// Requiere: cargado ANTES que dashboard.js
// ═══════════════════════════════════════════════════

// ───────────────────────────────────────────────────
// FACE GUIDE — Óvalo de proximidad para reconocimiento
// ───────────────────────────────────────────────────
const FaceGuide = {
  contadorBien: 0,
  FRAMES_OK: 5,     // ~1.5 s a 300 ms/frame
  _onListo: null,
  _listo: false,

  reiniciar(onListo) {
    this.contadorBien = 0;
    this._listo = false;
    this._onListo = onListo || null;
  },

  // Analiza detección y devuelve estado
  analizar(detection, videoW, videoH) {
    if (!detection) { this.contadorBien = 0; return 'sin_rostro'; }
    const b = detection.detection.box;
    const ratio = (b.width * b.height) / (videoW * videoH);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const okX = Math.abs(cx - videoW * 0.5) < videoW * 0.22;
    const okY = Math.abs(cy - videoH * 0.5) < videoH * 0.24;
    if (ratio < 0.07) return 'lejos';
    if (ratio > 0.52) return 'cerca';
    if (!okX || !okY) return 'centrar';
    return 'bien';
  },

  // Dibuja el overlay en el canvas, devuelve el estado
  dibujar(canvas, detection, videoW, videoH) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const estado = this.analizar(detection, videoW, videoH);

    if (estado === 'bien') {
      this.contadorBien++;
      if (!this._listo && this.contadorBien >= this.FRAMES_OK) {
        this._listo = true;
        if (this._onListo) this._onListo();
      }
    } else {
      this.contadorBien = 0;
    }

    const cx = W / 2, cy = H / 2;
    const rx = W * 0.30, ry = H * 0.40;

    // Sombra exterior (todo lo que está fuera del óvalo)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.46)';
    ctx.fill('evenodd');
    ctx.restore();

    // Borde del óvalo
    const colores = {
      sin_rostro: 'rgba(255,255,255,0.55)',
      lejos:      '#f59e0b',
      cerca:      '#f59e0b',
      centrar:    '#ef4444',
      bien:       '#22c55e',
    };
    const color = colores[estado] || colores.sin_rostro;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = estado === 'bien' ? 3.5 : 2.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.restore();

    // Arco de progreso cuando está bien posicionado
    if (estado === 'bien' && !this._listo && this.contadorBien > 0) {
      const prog = Math.min(this.contadorBien / this.FRAMES_OK, 1);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx + 8, ry + 8, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog);
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.shadowColor = '#22c55e';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.restore();
    }

    return estado;
  },

  textoEstado(estado) {
    const t = {
      sin_rostro: '❌ Sin rostro — colócate frente a la cámara',
      lejos:      '🔍 Acércate un poco más',
      cerca:      '↩ Aléjate un poco',
      centrar:    '↔ Centra tu rostro en el óvalo',
      bien:       '✅ Mantén la posición...',
    };
    return t[estado] || t.sin_rostro;
  },

  claseEstado(estado) {
    if (estado === 'bien') return 'ok';
    if (estado === 'sin_rostro' || estado === 'centrar') return 'error';
    return 'warn';
  },
};


// ───────────────────────────────────────────────────
// DOC SCANNER — Cámara trasera para escanear documentos
// ───────────────────────────────────────────────────
const DocScanner = {
  stream: null,
  videoEl: null,
  onCaptura: null,

  esMobile() {
    return ('ontouchstart' in window && navigator.maxTouchPoints > 0) ||
           /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  },

  async abrir(onCaptura) {
    this.onCaptura = onCaptura;
    this._crearModal();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
        }
      });
      this.videoEl = document.getElementById('docCam-video');
      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();

      const st = document.getElementById('docCam-status');
      st.textContent = 'Alinea el documento dentro del marco y presiona capturar';
      document.getElementById('docCam-btnCapturar').disabled = false;
    } catch(e) {
      const st = document.getElementById('docCam-status');
      st.textContent = '❌ Sin acceso a cámara: ' + e.message;
    }
  },

  _crearModal() {
    let modal = document.getElementById('modalDocCamara');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modalDocCamara';
      modal.style.cssText = [
        'display:flex;position:fixed;inset:0;z-index:99999;',
        'background:#000;flex-direction:column;align-items:stretch;',
      ].join('');

      modal.innerHTML = `
        <div style="flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#000">
          <video id="docCam-video" autoplay muted playsinline
            style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>

          <!-- Marco guía del documento (proporción tarjeta/credencial) -->
          <div style="
            position:relative;z-index:2;
            width:84vw;max-width:480px;
            aspect-ratio:85.6/54;
            pointer-events:none;
          ">
            <div style="
              position:absolute;top:-34px;left:0;right:0;text-align:center;
              font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:0.12em;
              color:rgba(245,166,35,0.95);text-shadow:0 1px 4px rgba(0,0,0,0.9);
            ">CREDENCIAL / PASAPORTE / LICENCIA</div>

            <!-- Sombra exterior + borde -->
            <div style="
              position:absolute;inset:0;
              border:2.5px solid rgba(245,166,35,0.85);
              box-shadow:0 0 0 9999px rgba(0,0,0,0.44);
            "></div>

            <!-- Esquinas decorativas -->
            <div style="position:absolute;top:-2px;left:-2px;width:24px;height:24px;border-top:4px solid #f5a623;border-left:4px solid #f5a623"></div>
            <div style="position:absolute;top:-2px;right:-2px;width:24px;height:24px;border-top:4px solid #f5a623;border-right:4px solid #f5a623"></div>
            <div style="position:absolute;bottom:-2px;left:-2px;width:24px;height:24px;border-bottom:4px solid #f5a623;border-left:4px solid #f5a623"></div>
            <div style="position:absolute;bottom:-2px;right:-2px;width:24px;height:24px;border-bottom:4px solid #f5a623;border-right:4px solid #f5a623"></div>
          </div>
        </div>

        <div id="docCam-status" style="
          padding:10px 16px;text-align:center;background:rgba(0,0,0,0.88);
          font-family:'Share Tech Mono',monospace;font-size:12px;letter-spacing:0.1em;
          color:rgba(245,166,35,0.9);min-height:38px;display:flex;align-items:center;justify-content:center;
        ">Iniciando cámara...</div>

        <div style="display:flex;gap:12px;padding:16px 20px;background:#0f0f0f;justify-content:center;align-items:center">
          <button id="docCam-btnCapturar" disabled onclick="DocScanner.capturar()"
            style="
              flex:1;max-width:280px;height:58px;
              background:#f5a623;color:#000;border:none;
              font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:18px;letter-spacing:0.1em;
              cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;
            ">
            📷 CAPTURAR FOTO
          </button>
          <button onclick="DocScanner.cerrar()"
            style="
              height:58px;padding:0 22px;
              background:transparent;color:#999;border:1px solid #444;
              font-family:'Barlow Condensed',sans-serif;font-size:14px;letter-spacing:0.08em;cursor:pointer;
            ">CANCELAR</button>
        </div>
      `;
      document.body.appendChild(modal);
    } else {
      modal.style.display = 'flex';
      const st = document.getElementById('docCam-status');
      if (st) st.textContent = 'Iniciando cámara...';
      const btn = document.getElementById('docCam-btnCapturar');
      if (btn) { btn.disabled = true; btn.textContent = '📷 CAPTURAR FOTO'; }
    }
    this.videoEl = null;
  },

  capturar() {
    if (!this.videoEl) return;
    const vw = this.videoEl.videoWidth  || 1280;
    const vh = this.videoEl.videoHeight || 720;

    const canvas = document.createElement('canvas');
    canvas.width  = vw;
    canvas.height = vh;
    canvas.getContext('2d').drawImage(this.videoEl, 0, 0);

    const btn = document.getElementById('docCam-btnCapturar');
    if (btn) { btn.textContent = '✅ CAPTURADO'; btn.disabled = true; }

    canvas.toBlob(blob => {
      this.cerrar();
      if (this.onCaptura && blob) {
        const file = new File([blob], 'foto-documento.jpg', { type: 'image/jpeg' });
        this.onCaptura(file);
      }
    }, 'image/jpeg', 0.92);
  },

  cerrar() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    const modal = document.getElementById('modalDocCamara');
    if (modal) modal.style.display = 'none';
    this.videoEl = null;
  },
};

// ───────────────────────────────────────────────────
// abrirCamaraDoc — conecta DocScanner con enrolamiento
// ───────────────────────────────────────────────────
function abrirCamaraDoc(tipo) {
  DocScanner.abrir(file => {
    const input = document.getElementById(`enrol-${tipo}-input`);
    if (!input) return;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch(e) {
      // DataTransfer no soportado en Safari antiguo — fallback
      console.warn('DataTransfer no soportado, usando fallback base64');
    }
    enrolArchivoSeleccionado(input, tipo);
  });
}
