const DEFAULT_CONFIG = {
  app: {
    nombre: "Mi Pase TNE · Valparaíso",
    sello: "SELLO 2026",
    intervaloPollingMs: 1500,
    cooldownSegundos: 3
  },
  supabase: {
    url: "https://yrbdxblbeezqqlubbxcf.supabase.co",
    anonKey: "sb_publishable_cNpSzGUBVe0trfYXppsgRg_mWHzJafw"
  },
  tarifas: {
    escolar: 200,
    adultoReferencia: 760,
    alertaSaldoBajo: 400,
    montosRecarga: [1000, 2000, 5000]
  },
  stickersValidadores: {
    "044110AE8F6181": "VAL-01"
  },
  zonasMapa: {
    "Playa Ancha": { cx: 38, cy: 52, coords: "-33.028, -71.641" },
    "Plan de Valparaíso": { cx: 105, cy: 72, coords: "-33.045, -71.619" },
    "Cerro Barón": { cx: 165, cy: 78, coords: "-33.048, -71.605" },
    "Av. España": { cx: 245, cy: 54, coords: "-33.034, -71.585" },
    "Viña del Mar": { cx: 330, cy: 30, coords: "-33.015, -71.549" },
    "Placilla": { cx: 195, cy: 124, coords: "-33.116, -71.571" }
  }
};

let CONFIG = DEFAULT_CONFIG;
let headersSupabase = {};
let procesandoTransaccion = false;
let timerModoCelular = null;

let state = {
  sesionActiva: localStorage.getItem("tne_sesion_activa") === "true",
  uid: localStorage.getItem("tne_uid_activo") || "FCDC1198",
  nombre: localStorage.getItem("tne_nombre") || "Estudiante TNE",
  rut: localStorage.getItem("tne_rut") || "",
  correo: localStorage.getItem("tne_correo") || "",
  institucion: localStorage.getItem("tne_institucion") || "Educación Superior",
  saldo: null,
  estado: "Activo",
  ocultarSaldo: localStorage.getItem("tne_ocultar_saldo") === "true",
  modoOscuro: localStorage.getItem("tne_dark_mode") === "true",
  prestamoEmergencia: localStorage.getItem("tne_prestamo_activo") === "true",
  tarjetaCongelada: localStorage.getItem("tne_congelada") === "true",
  validadorId: localStorage.getItem("tne_validador_id") || "VAL-01",
  ultimaZona: localStorage.getItem("tne_ultima_zona") || "Plan de Valparaíso",
  bloqueoCobro: false,
  historial: JSON.parse(localStorage.getItem("tne_historial_web") || "[]")
};

function limpiarTextosTecnicosHistorial() {
  let modificado = false;
  state.historial = state.historial.map((item) => {
    let t = String(item.titulo || "");
    const original = t;
    t = t.replace(/\s*\[VAL-\d+\]/gi, "");
    t = t.replace(/Validación en Arduino \(TNE\)/gi, "Pasaje Escolar Micro");
    t = t.replace(/Validación en Validador Arduino/gi, "Pasaje Escolar Micro");
    t = t.replace(/Validación en Arduino/gi, "Pasaje Escolar Micro");
    t = t.replace(/Recarga sincronizada/gi, "Recarga de Saldo");
    if (t !== original) modificado = true;
    return { ...item, titulo: t };
  });
  if (modificado) {
    localStorage.setItem("tne_historial_web", JSON.stringify(state.historial));
  }
}

// Limpia todos los recuadros del formulario de registro para que solo se vea el placeholder de ejemplo
function limpiarRecuadrosRegistro() {
  ["regNombre", "regRut", "regInstitucion", "regCorreo", "regPassword", "regUid"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = "";
  });
}

// 1. Inicialización y carga de config.json
async function inicializarApp() {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (res.ok) {
      const jsonExterno = await res.json();
      CONFIG = { ...DEFAULT_CONFIG, ...jsonExterno };
    }
  } catch {
    // shortcut: Respaldo local automático si falla la carga de config.json
  }

  headersSupabase = {
    apikey: CONFIG.supabase.anonKey,
    Authorization: `Bearer ${CONFIG.supabase.anonKey}`,
    "Content-Type": "application/json"
  };

  limpiarTextosTecnicosHistorial();
  limpiarRecuadrosRegistro();
  aplicarModoOscuro();
  poblarControlesDesdeConfig();
  configurarEventos();
  verificarSesionInicial();
  actualizarUI();
  renderizarHistorial();
  await consultarSaldoEnNube();
  setInterval(consultarSaldoEnNube, CONFIG.app.intervaloPollingMs);
}

function aplicarModoOscuro() {
  document.body.classList.toggle("dark-mode", state.modoOscuro);
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.textContent = state.modoOscuro ? "☀️" : "🌙";
}

function poblarControlesDesdeConfig() {
  const sealBadge = document.getElementById("sealBadge");
  if (sealBadge) sealBadge.textContent = CONFIG.app.sello;

  const fareAmountLabel = document.getElementById("fareAmountLabel");
  if (fareAmountLabel) fareAmountLabel.textContent = `${formatearPesos(CONFIG.tarifas.escolar)} CLP`;

  const zoneSelect = document.getElementById("zoneSelect");
  if (zoneSelect) {
    zoneSelect.innerHTML = Object.keys(CONFIG.zonasMapa)
      .map((z) => `<option value="${z}" ${z === state.ultimaZona ? "selected" : ""}>📍 ${z}</option>`)
      .join("");
  }

  const recargaGrid = document.getElementById("rechargeButtonsContainer");
  if (recargaGrid) {
    recargaGrid.innerHTML = CONFIG.tarifas.montosRecarga
      .map((m) => `<button type="button" class="btn-recharge" data-monto="${m}">+${formatearPesos(m)}</button>`)
      .join("");
  }
}

// 2. Utilidades de formato, vibración y persistencia
function formatearPesos(valor) {
  const n = Number(valor) || 0;
  return n < 0 ? `-$${Math.abs(n).toLocaleString("es-CL")}` : `$${n.toLocaleString("es-CL")}`;
}

function sanitizarUid(raw) {
  const limpio = String(raw || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  return limpio.length >= 4 ? limpio.slice(0, 16) : state.uid;
}

function guardarPerfilLocal() {
  localStorage.setItem("tne_sesion_activa", String(state.sesionActiva));
  localStorage.setItem("tne_uid_activo", state.uid);
  localStorage.setItem("tne_nombre", state.nombre);
  localStorage.setItem("tne_rut", state.rut);
  localStorage.setItem("tne_correo", state.correo);
  localStorage.setItem("tne_institucion", state.institucion);
  localStorage.setItem("tne_ocultar_saldo", String(state.ocultarSaldo));
  localStorage.setItem("tne_dark_mode", String(state.modoOscuro));
  localStorage.setItem("tne_prestamo_activo", String(state.prestamoEmergencia));
  localStorage.setItem("tne_congelada", String(state.tarjetaCongelada));
  localStorage.setItem("tne_validador_id", state.validadorId);
  localStorage.setItem("tne_ultima_zona", state.ultimaZona);
}

let toastTimer = null;
function mostrarToast(texto, tipo = "ok") {
  const banner = document.getElementById("toastBanner");
  const textEl = document.getElementById("toastText");
  if (!banner || !textEl) return;

  textEl.textContent = texto;
  banner.className = `toast-banner show ${tipo}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => banner.classList.remove("show"), 3500);
}

function reproducirFeedbackSensorial(aprobado) {
  if ("vibrate" in navigator) {
    navigator.vibrate(aprobado ? [120] : [180, 90, 180]);
  }

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    if (aprobado) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(2100, ctx.currentTime);
      gain.gain.setValueAtTime(0.22, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
    } else {
      [0, 0.22].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(340, ctx.currentTime + offset);
        gain.gain.setValueAtTime(0.22, ctx.currentTime + offset);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.16);
      });
    }
  } catch {}
}

// 3. Emparejamiento silencioso en segundo plano
async function anunciarCelularEnValidadorEspecifico(activo) {
  if (!state.uid || state.tarjetaCongelada) return;
  clearTimeout(timerModoCelular);

  const estadoParaServidor = activo ? `PAGANDO_${state.validadorId}` : "Activo";
  try {
    await fetch(`${CONFIG.supabase.url}/rest/v1/tarjetas_autorizadas?uid=eq.${encodeURIComponent(state.uid)}`, {
      method: "PATCH",
      headers: headersSupabase,
      body: JSON.stringify({ estado: estadoParaServidor })
    });

    if (activo) {
      const stageSub = document.getElementById("stageSubtitle");
      if (stageSub) {
        stageSub.textContent = "📲 Listo para viajar: acerca tu TNE o celular al validador de la micro.";
      }
      timerModoCelular = setTimeout(() => anunciarCelularEnValidadorEspecifico(false), 30000);
    }
  } catch {}
}

async function notificarCobroExitosoAlValidador(nuevoSaldo) {
  try {
    await fetch(`${CONFIG.supabase.url}/rest/v1/tarjetas_autorizadas?uid=eq.${encodeURIComponent(state.uid)}`, {
      method: "PATCH",
      headers: headersSupabase,
      body: JSON.stringify({
        saldo: nuevoSaldo,
        estado: `COBRO_OK_${state.validadorId}`
      })
    });
  } catch {}
}

// 4. Navegación y actualización de interfaz
function mostrarPestana(tabId) {
  if (!state.sesionActiva && tabId !== "cuenta") {
    document.getElementById("loginModalBackdrop")?.classList.add("open");
    return;
  }
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".view-panel").forEach((p) => p.classList.toggle("active", p.id === `view-${tabId}`));

  if (tabId === "pago") {
    anunciarCelularEnValidadorEspecifico(true);
  } else {
    anunciarCelularEnValidadorEspecifico(false);
  }
}

function actualizarUI() {
  const nameEl = document.getElementById("studentNameLabel");
  const metaEl = document.getElementById("studentMetaLabel");
  const statusBadgeEl = document.getElementById("cardStatusBadge");

  if (nameEl) nameEl.textContent = state.nombre || "Titular TNE";
  if (metaEl) metaEl.textContent = `${state.institucion} · ${state.rut ? `RUT ${state.rut}` : "Estudiante"}`;

  if (statusBadgeEl) {
    statusBadgeEl.textContent = state.tarjetaCongelada ? "BLOQUEADA" : "ACTIVA";
  }

  const saldoBase = state.saldo !== null ? Number(state.saldo) : 0;
  const saldoMostrado = state.prestamoEmergencia && saldoBase === 0 ? -CONFIG.tarifas.escolar : saldoBase;
  const viajes = Math.max(0, Math.floor(saldoBase / CONFIG.tarifas.escolar));

  const balanceEl = document.getElementById("balanceDisplay");
  const tripsEl = document.getElementById("tripsLeftLabel");
  const eyeLabel = document.getElementById("eyeLabel");
  const fareFooterBox = document.getElementById("fareFooterBox");

  if (balanceEl && tripsEl && eyeLabel) {
    balanceEl.classList.toggle("negative-loan", saldoMostrado < 0);
    if (state.ocultarSaldo) {
      balanceEl.textContent = "$ ••••••";
      tripsEl.textContent = "Viajes: •••";
      eyeLabel.textContent = "🙈 Mostrar";
    } else {
      balanceEl.textContent = formatearPesos(saldoMostrado);
      tripsEl.textContent = state.prestamoEmergencia
        ? "⚠️ En Préstamo (-$200)"
        : `Viajes: ${viajes}`;
      eyeLabel.textContent = "👁️ Ocultar";
    }
  }

  if (fareFooterBox) {
    fareFooterBox.classList.toggle("critical-balance", !state.ocultarSaldo && viajes <= 1);
  }

  const necesitaPrestamo =
    state.saldo !== null &&
    Number(state.saldo) < CONFIG.tarifas.escolar &&
    !state.prestamoEmergencia &&
    !state.tarjetaCongelada;

  const emergencyBanner = document.getElementById("emergencyBanner");
  const payViewLoanBtn = document.getElementById("payViewLoanBtn");

  if (emergencyBanner) emergencyBanner.classList.toggle("show", necesitaPrestamo);
  if (payViewLoanBtn) payViewLoanBtn.style.display = necesitaPrestamo ? "block" : "none";
}

function registrarMovimientoLocal(titulo, monto, saldoFinal) {
  const hora = new Date().toLocaleTimeString("es-CL");
  state.historial.unshift({
    titulo,
    monto,
    saldoFinal,
    hora,
    zona: state.ultimaZona
  });
  state.historial = state.historial.slice(0, 40);
  localStorage.setItem("tne_historial_web", JSON.stringify(state.historial));
  renderizarHistorial();
}

function renderizarHistorial() {
  const cobros = state.historial.filter((m) => m.monto < 0).length;
  const ahorro = cobros * (CONFIG.tarifas.adultoReferencia - CONFIG.tarifas.escolar);

  const statTripsEl = document.getElementById("statTripsCount");
  const statSavingsEl = document.getElementById("statSavingsValue");
  if (statTripsEl) statTripsEl.textContent = `${cobros} viajes`;
  if (statSavingsEl) statSavingsEl.textContent = state.ocultarSaldo ? "$ ••••" : formatearPesos(ahorro);

  const historyList = document.getElementById("historyList");
  const homeMini = document.getElementById("homeMiniHistory");
  if (!historyList || !homeMini) return;

  if (!state.historial.length) {
    const vacio = `<li class="history-item"><span class="history-time">Sin movimientos registrados</span></li>`;
    historyList.innerHTML = vacio;
    homeMini.innerHTML = vacio;
    return;
  }

  const renderFilas = (items) =>
    items
      .map((m) => {
        const esPos = m.monto > 0;
        const signo = esPos ? "+" : "";
        const saldoTxt = state.ocultarSaldo ? "$ ••••" : formatearPesos(m.saldoFinal);
        return `
        <li class="history-item">
          <div class="history-left">
            <span class="history-title">${m.titulo}</span>
            <span class="history-time">${m.hora} · 📍 ${m.zona || "Valparaíso"} · Saldo: ${saldoTxt}</span>
          </div>
          <span class="history-amount ${esPos ? "pos" : "neg"}">${signo}${formatearPesos(m.monto)}</span>
        </li>`;
      })
      .join("");

  historyList.innerHTML = renderFilas(state.historial);
  homeMini.innerHTML = renderFilas(state.historial.slice(0, 2));
}

// 5. Sincronización silenciosa en tiempo real
async function consultarSaldoEnNube() {
  if (!state.uid || procesandoTransaccion) return;
  const syncDot = document.getElementById("syncDot");
  const syncText = document.getElementById("syncText");

  try {
    const url = `${CONFIG.supabase.url}/rest/v1/tarjetas_autorizadas?uid=eq.${encodeURIComponent(state.uid)}&select=*`;
    const res = await fetch(url, { headers: headersSupabase, cache: "no-store" });
    if (!res.ok) throw new Error("Error de red");
    const lista = await res.json();

    if (syncDot) syncDot.classList.remove("offline");

    if (Array.isArray(lista) && lista.length > 0) {
      const datos = lista[0];

      if (datos.nombre && datos.nombre !== "Estudiante TNE") state.nombre = datos.nombre;
      if (datos.rut) state.rut = datos.rut;
      if (datos.institucion) state.institucion = datos.institucion;
      if (datos.correo) state.correo = datos.correo;

      if (datos.estado === "Bloqueado" || datos.estado === "Extraviada") {
        state.tarjetaCongelada = true;
      }

      const nuevoSaldo = Number(datos.saldo);
      if (nuevoSaldo >= CONFIG.tarifas.escolar && state.prestamoEmergencia) {
        state.prestamoEmergencia = false;
      }

      if (state.saldo !== null && Number.isFinite(nuevoSaldo) && nuevoSaldo < state.saldo) {
        const descuento = nuevoSaldo - state.saldo;
        state.saldo = nuevoSaldo;
        iniciarCooldownAntiDobleCobro();
        reproducirFeedbackSensorial(true);
        mostrarPantallaCompletaPago(
          true,
          "¡Pasaje Aprobado!",
          `Tarifa Escolar (${formatearPesos(descuento)}) · ¡Buen viaje!`
        );
        registrarMovimientoLocal("Pasaje Escolar Micro", descuento, nuevoSaldo);
      } else if (state.saldo !== null && Number.isFinite(nuevoSaldo) && nuevoSaldo > state.saldo) {
        const abono = nuevoSaldo - state.saldo;
        state.saldo = nuevoSaldo;
        registrarMovimientoLocal("Recarga de Saldo", abono, nuevoSaldo);
      } else {
        state.saldo = nuevoSaldo;
      }

      state.estado = datos.estado || "Activo";
      if (syncText) syncText.textContent = state.tarjetaCongelada ? "Pase Bloqueado" : "Pase Activo";

      guardarPerfilLocal();
      actualizarUI();
    } else {
      state.estado = "No registrado";
      if (syncText) syncText.textContent = "Activar Pase";
      actualizarUI();
    }
  } catch {
    if (syncDot) syncDot.classList.add("offline");
    if (syncText) syncText.textContent = "Sin conexión";
  }
}

// 6. Pantalla Completa Verde/Roja con Check/Cruz Animado y Cooldown de 3 segundos
let overlayTimer = null;
let overlayCountdownInterval = null;

function mostrarPantallaCompletaPago(aprobado, titulo, subtitulo) {
  const overlay = document.getElementById("paymentFullOverlay");
  const badge = document.getElementById("overlayTopBadge");
  const iconBox = document.getElementById("overlayIconBox");
  const titleEl = document.getElementById("overlayTitle");
  const subEl = document.getElementById("overlaySubtitle");
  const studentEl = document.getElementById("overlayStudentName");
  const zoneEl = document.getElementById("overlayZoneName");
  const balanceEl = document.getElementById("overlayBalance");
  const countNum = document.getElementById("overlayCountdownNum");
  const progressBar = document.getElementById("overlayProgressBar");

  if (!overlay) return;

  clearTimeout(overlayTimer);
  clearInterval(overlayCountdownInterval);

  overlay.className = `payment-full-overlay show ${aprobado ? "is-success" : "is-error"}`;
  overlay.setAttribute("aria-hidden", "false");

  badge.textContent = aprobado ? "• PASAJE VALIDADO" : "• VALIDACIÓN RECHAZADA";
  titleEl.textContent = titulo;
  subEl.textContent = subtitulo;
  studentEl.textContent = state.nombre || "Estudiante TNE";
  if (zoneEl) zoneEl.textContent = state.ultimaZona || "Valparaíso";

  const saldoReal = state.prestamoEmergencia && state.saldo === 0 ? -CONFIG.tarifas.escolar : state.saldo;
  balanceEl.textContent = state.ocultarSaldo ? "$ ••••••" : formatearPesos(saldoReal);

  if (aprobado) {
    iconBox.innerHTML = `
      <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
        <polyline class="overlay-svg-stroke" points="20 6 9 17 4 12"></polyline>
      </svg>`;
  } else {
    iconBox.innerHTML = `
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
        <line class="overlay-svg-stroke" x1="18" y1="6" x2="6" y2="18"></line>
        <line class="overlay-svg-stroke" x1="6" y1="6" x2="18" y2="18"></line>
      </svg>`;
  }

  const segundosTotales = CONFIG.app.cooldownSegundos || 3;
  let restantes = segundosTotales;
  countNum.textContent = String(restantes);

  progressBar.style.transition = "none";
  progressBar.style.transform = "scaleX(1)";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      progressBar.style.transition = `transform ${segundosTotales}s linear`;
      progressBar.style.transform = "scaleX(0)";
    });
  });

  overlayCountdownInterval = setInterval(() => {
    restantes -= 1;
    if (restantes > 0) countNum.textContent = String(restantes);
  }, 1000);

  overlayTimer = setTimeout(() => {
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
    clearInterval(overlayCountdownInterval);
  }, segundosTotales * 1000);
}

function iniciarCooldownAntiDobleCobro() {
  state.bloqueoCobro = true;
  const payBtn = document.getElementById("payWebBtn");
  const payBtnText = document.getElementById("payBtnText");
  let segs = CONFIG.app.cooldownSegundos || 3;

  if (payBtn && payBtnText) {
    payBtn.disabled = true;
    payBtnText.textContent = `⏳ Espera ${segs}s...`;
  }

  const timer = setInterval(() => {
    segs -= 1;
    if (segs > 0 && payBtnText) {
      payBtnText.textContent = `⏳ Espera ${segs}s...`;
    } else {
      clearInterval(timer);
      state.bloqueoCobro = false;
      if (payBtn && payBtnText) {
        payBtn.disabled = false;
        payBtnText.textContent = "Pagar Pasaje Escolar (-$200)";
      }
    }
  }, 1000);
}

// 7. Cobro, Préstamo Escolar y Recarga
async function pagarPasajeWeb(origenCobro = "Pago Móvil Micro") {
  if (state.tarjetaCongelada) {
    reproducirFeedbackSensorial(false);
    mostrarPantallaCompletaPago(false, "TNE Bloqueada", "Tu pase está congelado por seguridad.");
    return;
  }
  if (state.bloqueoCobro) {
    mostrarToast("⏳ Espera 3 segundos antes de volver a validar.", "warn");
    return;
  }

  const tarifa = CONFIG.tarifas.escolar;
  const saldoPrevio = state.saldo !== null ? Number(state.saldo) : 0;

  if (saldoPrevio < tarifa) {
    reproducirFeedbackSensorial(false);
    mostrarPantallaCompletaPago(
      false,
      "Saldo Insuficiente",
      "Tienes menos de $200. Activa el Préstamo Escolar de Emergencia abajo."
    );
    actualizarUI();
    return;
  }

  procesandoTransaccion = true;
  iniciarCooldownAntiDobleCobro();

  try {
    const res = await fetch(`${CONFIG.supabase.url}/rest/v1/rpc/descontar_saldo`, {
      method: "POST",
      headers: headersSupabase,
      body: JSON.stringify({ card_uid: state.uid })
    });
    const data = await res.json();

    let cobroExitoso = false;
    let nuevoSaldoCalculado = saldoPrevio - tarifa;

    if (data && (data.status === "concedido" || data.exito === true)) {
      const saldoDevuelto =
        data.saldo_restante !== undefined
          ? Number(data.saldo_restante)
          : data.nuevo_saldo !== undefined
          ? Number(data.nuevo_saldo)
          : nuevoSaldoCalculado;

      if (saldoDevuelto < saldoPrevio) {
        nuevoSaldoCalculado = saldoDevuelto;
      }
      cobroExitoso = true;
    } else if (saldoPrevio >= tarifa) {
      cobroExitoso = true;
    }

    if (cobroExitoso) {
      state.saldo = nuevoSaldoCalculado;
      await notificarCobroExitosoAlValidador(nuevoSaldoCalculado);
      guardarPerfilLocal();
      actualizarUI();
      reproducirFeedbackSensorial(true);
      registrarMovimientoLocal(origenCobro, -tarifa, state.saldo);
      mostrarPantallaCompletaPago(true, "¡Pasaje Aprobado!", "Tarifa Estudiante (-$200) · ¡Buen viaje!");
    } else {
      reproducirFeedbackSensorial(false);
      mostrarPantallaCompletaPago(false, "Pago No Realizado", "Verifica tu saldo disponible.");
    }
  } catch {
    reproducirFeedbackSensorial(false);
    mostrarToast("No se pudo procesar el pago. Revisa tu conexión.", "err");
  } finally {
    procesandoTransaccion = false;
  }
}

async function activarPrestamoEmergencia() {
  if (state.tarjetaCongelada) {
    reproducirFeedbackSensorial(false);
    mostrarPantallaCompletaPago(false, "TNE Bloqueada", "Desbloquea tu tarjeta antes de pedir un préstamo.");
    return;
  }
  if (state.prestamoEmergencia) {
    mostrarToast("Ya tienes 1 Préstamo Escolar activo (-$200).", "warn");
    return;
  }

  state.prestamoEmergencia = true;
  state.saldo = 0;
  guardarPerfilLocal();
  iniciarCooldownAntiDobleCobro();
  reproducirFeedbackSensorial(true);
  await notificarCobroExitosoAlValidador(0);
  registrarMovimientoLocal("Préstamo Escolar de Emergencia", -CONFIG.tarifas.escolar, -CONFIG.tarifas.escolar);
  actualizarUI();
  mostrarPantallaCompletaPago(
    true,
    "¡Viaje de Emergencia!",
    "Préstamo Escolar activado (-$200). Se descontará en tu próxima recarga."
  );
}

async function recargarSaldoWeb(monto) {
  const valor = parseInt(monto, 10);
  if (!Number.isFinite(valor) || valor <= 0) return;

  const teniaPrestamo = state.prestamoEmergencia;
  const montoEfectivo = teniaPrestamo ? Math.max(0, valor - CONFIG.tarifas.escolar) : valor;

  procesandoTransaccion = true;
  try {
    const res = await fetch(`${CONFIG.supabase.url}/rest/v1/rpc/recargar_saldo`, {
      method: "POST",
      headers: headersSupabase,
      body: JSON.stringify({ card_uid: state.uid, monto: montoEfectivo })
    });
    const data = await res.json();

    if (data && (data.status === "exito" || data.exito === true)) {
      state.prestamoEmergencia = false;
      state.saldo = (state.saldo !== null ? Number(state.saldo) : 0) + montoEfectivo;
      guardarPerfilLocal();
      reproducirFeedbackSensorial(true);
      registrarMovimientoLocal(
        teniaPrestamo ? "Recarga (Saldó préstamo -$200)" : "Recarga de Saldo",
        montoEfectivo,
        state.saldo
      );
      actualizarUI();
      mostrarToast(
        teniaPrestamo
          ? `✔ Recarga +${formatearPesos(valor)} (Se descontaron -$200 del préstamo)`
          : `✔ Recarga exitosa (+${formatearPesos(valor)})`,
        "ok"
      );
    } else {
      reproducirFeedbackSensorial(false);
      mostrarToast("No se pudo completar la recarga.", "err");
    }
  } catch {
    reproducirFeedbackSensorial(false);
    mostrarToast("Sin conexión para recargar en este momento.", "err");
  } finally {
    procesandoTransaccion = false;
    await consultarSaldoEnNube();
  }
}

// 8. Menú Guía Visual de 2 Pasos ("Ponga su TNE detrás del celular") y Lectura NFC
function abrirMenuGuiaNfc(tituloModal, callbackUid) {
  const modal = document.getElementById("nfcGuideModalBackdrop");
  const titleEl = document.getElementById("nfcGuideTitle");
  const statusEl = document.getElementById("nfcLiveStatusText");

  if (titleEl) titleEl.textContent = tituloModal;
  if (statusEl) statusEl.textContent = "Ponga su TNE detrás del celular...";
  if (modal) modal.classList.add("open");

  if (!("NDEFReader" in window)) {
    if (statusEl) {
      statusEl.textContent = "Ponga su TNE detrás del celular (Requiere Chrome en Android)";
    }
    return;
  }

  const ndef = new NDEFReader();
  ndef
    .scan()
    .then(() => {
      if (statusEl) statusEl.textContent = "📡 Lector activo: ponga su TNE detrás del celular...";
      ndef.onreading = (event) => {
        if (event.serialNumber) {
          reproducirFeedbackSensorial(true);
          modal?.classList.remove("open");
          callbackUid(sanitizarUid(event.serialNumber));
        }
      };
    })
    .catch(() => {
      if (statusEl) statusEl.textContent = "⚠️ Activa el NFC en los ajustes de tu teléfono.";
    });
}

function verificarSesionInicial() {
  const modal = document.getElementById("loginModalBackdrop");
  if (modal) modal.classList.toggle("open", !state.sesionActiva || !state.uid);
}

// 9. Eventos de la Interfaz
function configurarEventos() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => mostrarPestana(btn.dataset.tab));
  });

  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => mostrarPestana(btn.dataset.goto));
  });

  document.getElementById("themeToggleBtn")?.addEventListener("click", () => {
    state.modoOscuro = !state.modoOscuro;
    guardarPerfilLocal();
    aplicarModoOscuro();
  });

  document.getElementById("toggleEyeBtn")?.addEventListener("click", () => {
    state.ocultarSaldo = !state.ocultarSaldo;
    guardarPerfilLocal();
    actualizarUI();
    renderizarHistorial();
  });

  document.getElementById("zoneSelect")?.addEventListener("change", (e) => {
    state.ultimaZona = e.target.value;
    guardarPerfilLocal();
  });

  document.getElementById("payWebBtn")?.addEventListener("click", () => pagarPasajeWeb("Pago Móvil Micro"));
  document.getElementById("bannerEmergencyBtn")?.addEventListener("click", activarPrestamoEmergencia);
  document.getElementById("payViewLoanBtn")?.addEventListener("click", activarPrestamoEmergencia);

  document.getElementById("paymentFullOverlay")?.addEventListener("click", () => {
    const overlay = document.getElementById("paymentFullOverlay");
    overlay?.classList.remove("show");
    clearTimeout(overlayTimer);
    clearInterval(overlayCountdownInterval);
  });

  document.getElementById("closeNfcGuideBtn")?.addEventListener("click", () => {
    document.getElementById("nfcGuideModalBackdrop")?.classList.remove("open");
  });

  // 1. Botón "Cambiar TNE" (en pestaña Pagar)
  document.getElementById("scanNfcWalletBtn")?.addEventListener("click", () => {
    abrirMenuGuiaNfc("Cambiar TNE", (uidLeido) => {
      const validadorAsociado = CONFIG.stickersValidadores?.[uidLeido];
      if (validadorAsociado) {
        state.validadorId = validadorAsociado;
        guardarPerfilLocal();
        pagarPasajeWeb("Pago NFC Micro");
      } else {
        state.uid = uidLeido;
        state.saldo = null;
        guardarPerfilLocal();
        actualizarUI();
        consultarSaldoEnNube();
        mostrarToast("✔ Tarjeta TNE cambiada con éxito", "ok");
      }
    });
  });

  // 2. Botón "Vincular TNE" (en pestaña Cuenta)
  document.getElementById("scanNfcRegBtn")?.addEventListener("click", () => {
    abrirMenuGuiaNfc("Vincular TNE", (uidHex) => {
      const regUidInput = document.getElementById("regUid");
      if (regUidInput) regUidInput.value = uidHex;
      state.uid = uidHex;
      mostrarToast("✔ Tarjeta TNE vinculada correctamente", "ok");
    });
  });

  document.getElementById("rechargeButtonsContainer")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-monto]");
    if (btn) recargarSaldoWeb(btn.dataset.monto);
  });

  document.getElementById("customRechargeBtn")?.addEventListener("click", () => {
    const input = document.getElementById("customMontoInput");
    if (input && input.value) {
      recargarSaldoWeb(input.value);
      input.value = "";
    }
  });

  document.getElementById("clearHistoryBtn")?.addEventListener("click", () => {
    state.historial = [];
    localStorage.setItem("tne_historial_web", "[]");
    renderizarHistorial();
  });

  document.getElementById("toggleFreezeBtn")?.addEventListener("click", async () => {
    state.tarjetaCongelada = !state.tarjetaCongelada;
    const nuevoEstadoBD = state.tarjetaCongelada ? "Bloqueado" : "Activo";
    state.estado = nuevoEstadoBD;
    guardarPerfilLocal();
    actualizarUI();

    try {
      await fetch(`${CONFIG.supabase.url}/rest/v1/tarjetas_autorizadas?uid=eq.${encodeURIComponent(state.uid)}`, {
        method: "PATCH",
        headers: headersSupabase,
        body: JSON.stringify({ estado: nuevoEstadoBD })
      });
    } catch {}

    mostrarToast(state.tarjetaCongelada ? "🔒 Tu TNE fue congelada temporalmente" : "✔ Tu TNE fue desbloqueada", "ok");
  });

  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    anunciarCelularEnValidadorEspecifico(false);
    state.sesionActiva = false;
    guardarPerfilLocal();
    limpiarRecuadrosRegistro();
    verificarSesionInicial();
  });

  document.getElementById("goToRegisterFromLogin")?.addEventListener("click", () => {
    document.getElementById("loginModalBackdrop")?.classList.remove("open");
    limpiarRecuadrosRegistro();
    mostrarPestana("cuenta");
  });

  document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const correo = document.getElementById("loginCorreo").value.trim();
    const pass = document.getElementById("loginPassword").value.trim();
    try {
      const res = await fetch(`${CONFIG.supabase.url}/rest/v1/rpc/login_tne`, {
        method: "POST",
        headers: headersSupabase,
        body: JSON.stringify({ p_correo: correo, p_password: pass })
      });
      const data = await res.json();
      if (data && (data.status === "exito" || data.exito === true || data.uid)) {
        state.sesionActiva = true;
        if (data.uid) state.uid = sanitizarUid(data.uid);
        if (data.nombre) state.nombre = data.nombre;
        if (data.rut) state.rut = data.rut;
        state.correo = correo;
        guardarPerfilLocal();
        document.getElementById("loginModalBackdrop")?.classList.remove("open");
        limpiarRecuadrosRegistro();
        actualizarUI();
        await consultarSaldoEnNube();
        mostrarPestana("saldo");
      } else {
        mostrarToast(data?.mensaje || "Correo o contraseña incorrectos", "err");
      }
    } catch {
      mostrarToast("Error de conexión al iniciar sesión", "err");
    }
  });

  document.getElementById("registerForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    state.nombre = document.getElementById("regNombre").value.trim().toUpperCase();
    state.rut = document.getElementById("regRut").value.trim();
    state.institucion = document.getElementById("regInstitucion").value.trim();
    state.correo = document.getElementById("regCorreo").value.trim();
    const uidInputVal = document.getElementById("regUid")?.value;
    if (uidInputVal) state.uid = sanitizarUid(uidInputVal);
    const pass = document.getElementById("regPassword").value.trim() || "1234";

    try {
      await fetch(`${CONFIG.supabase.url}/rest/v1/rpc/registrar_cuenta_tne`, {
        method: "POST",
        headers: headersSupabase,
        body: JSON.stringify({
          p_uid: state.uid,
          p_nombre: state.nombre,
          p_rut: state.rut,
          p_institucion: state.institucion,
          p_correo: state.correo,
          p_saldo_inicial: state.saldo !== null ? state.saldo : 1000,
          p_password: pass
        })
      });

      await fetch(`${CONFIG.supabase.url}/rest/v1/tarjetas_autorizadas?uid=eq.${encodeURIComponent(state.uid)}`, {
        method: "PATCH",
        headers: headersSupabase,
        body: JSON.stringify({
          nombre: state.nombre,
          rut: state.rut,
          institucion: state.institucion,
          correo: state.correo,
          estado: "Activo"
        })
      });

      state.sesionActiva = true;
      guardarPerfilLocal();
      limpiarRecuadrosRegistro();
      actualizarUI();
      await consultarSaldoEnNube();
      mostrarToast("✔ Datos guardados correctamente", "ok");
      mostrarPestana("saldo");
    } catch {
      mostrarToast("Datos guardados en el dispositivo", "warn");
    }
  });
}

document.addEventListener("DOMContentLoaded", inicializarApp);
