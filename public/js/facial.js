// =====================================================
// FACIAL.JS — Reconocimiento facial integrado en PROAGRO
// Maneja: verificación, enrolamiento, historial
// Requiere face-api.js cargado antes en el HTML
// =====================================================

const Facial = {
  modelosListos: false,
  stream: null,
  videoEl: null,
  canvasEl: null,
  detectionInterval: null,
  ultimoDescriptor: null,

  // ── Inicializar modelos face-api ──────────────────
  async cargarModelos() {
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
      ]);
      this.modelosListos = true;
      console.log('✅ Modelos faciales listos');
      return true;
    } catch(e) {
      console.error('❌ Error cargando modelos:', e);
      return false;
    }
  },

  // ── Iniciar cámara ────────────────────────────────
  async iniciarCamara(videoId, canvasId) {
    this.videoEl  = document.getElementById(videoId);
    this.canvasEl = document.getElementById(canvasId);

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
      });
      this.videoEl.srcObject = this.stream;
      return true;
    } catch(e) {
      console.error('❌ Error cámara:', e);
      return false;
    }
  },

  // ── Detener cámara ────────────────────────────────
  detenerCamara() {
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
      this.detectionInterval = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  },

  // ── Obtener descriptor del rostro actual ──────────
  async obtenerDescriptor() {
    if (!this.modelosListos || !this.videoEl) return null;
    try {
      const detection = await faceapi
        .detectSingleFace(this.videoEl, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) return null;

      if (this.canvasEl) {
        const dims = faceapi.matchDimensions(this.canvasEl, this.videoEl, true);
        faceapi.draw.drawDetections(this.canvasEl,
          faceapi.resizeResults(detection, dims));
      }

      return Array.from(detection.descriptor);
    } catch(e) {
      return null;
    }
  },

  // ── Iniciar detección continua ────────────────────
  iniciarDeteccion(onRostro, sinRostro) {
    if (this.detectionInterval) clearInterval(this.detectionInterval);

    this.detectionInterval = setInterval(async () => {
      if (!this.modelosListos || !this.videoEl) return;
      try {
        const det = await faceapi
          .detectSingleFace(this.videoEl, new faceapi.TinyFaceDetectorOptions())
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (det) {
          if (this.canvasEl) {
            const dims = faceapi.matchDimensions(this.canvasEl, this.videoEl, true);
            const ctx  = this.canvasEl.getContext('2d');
            ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
            faceapi.draw.drawDetections(this.canvasEl,
              faceapi.resizeResults(det, dims));
          }
          this.ultimoDescriptor = Array.from(det.descriptor);
          if (onRostro) onRostro();
        } else {
          if (this.canvasEl) {
            const ctx = this.canvasEl.getContext('2d');
            ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
          }
          this.ultimoDescriptor = null;
          if (sinRostro) sinRostro();
        }
      } catch(e) {}
    }, 300);
  },

  // ── Verificar rostro contra DB ────────────────────
  // IP se obtiene en el servidor via x-forwarded-for (nginx), no desde el cliente
  async verificar(descriptor, tipo_movimiento = 'entrada') {
  let ip_cliente = '';
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const d = await r.json();
    ip_cliente = d.ip;
  } catch(e) {}
  const res = await fetch('/facial/verificar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descriptor, tipo_movimiento, ip_cliente })
  });
  return res.json();
},

  // ── Enrolar empleado ──────────────────────────────
  async enrolar(datos) {
    const res = await fetch('/facial/enrolar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos)
    });
    return res.json();
  },

  // ── Obtener historial de accesos ──────────────────
  async obtenerAccesos() {
    const res = await fetch('/facial/accesos');
    return res.json();
  },

  // ── Obtener lista de empleados ────────────────────
  async obtenerEmpleados() {
    const res = await fetch('/facial/empleados');
    return res.json();
  },

  // ── Verificar QR ──────────────────────────────────
  // IP se obtiene en el servidor via x-forwarded-for (nginx), no desde el cliente
  async verificarQR(qr_data) {
  let ip_cliente = '';
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const d = await r.json();
    ip_cliente = d.ip;
  } catch(e) {}
  const res = await fetch('/facial/verificar-qr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qr_data, ip_cliente })
  });
  return res.json();
}

};