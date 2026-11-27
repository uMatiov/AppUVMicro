const DEFAULT_CONFIG = {
  app: {
    nombre: "Mi Pase TNE · Valparaíso",
    sello: "SELLO 2026",
    intervaloPollingMs: 1500,
    cooldownSegundos: 3,
    timeoutMs: 8000
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

// Limpieza única al actualizar desde versiones antiguas que precargaban un UID fijo
if (localStorage.getItem("tne_app_schema") !== "v2_clean_auth") {
  const darkGuardado = localStorage.getItem("tne_dark_mode");
  localStorage.clear();
  if (darkGuardado !== null) localStorage.setItem("tne_dark_mode", darkGuardado);
  localStorage.setItem("tne_app_schema", "v2_clean_auth");
}

let CONFIG = DEFAULT_CONFIG;
let headersSupabase = {};
let procesandoTransaccion = false;
let timerModoCelular = null;
let pollingTimer = null;
let pollingAbortController = null;
let nfcAbortController = null;
let cooldownIntervalId = null;
let cooldownSegsRestantes = 0;
let syncEpoch = 0;

// shortcut: historial sigue en localStorage para no agregar una tabla extra en el prototipo academico.
let state = {
  sesionActiva: localStorage.getItem("tne_sesion_activa") === "true",
  uid: localStorage.getItem("tne_uid_activo") || "",
  nombre: localStorage.getItem("tne_nombre") || "",
  rut: localStorage.getItem("tne_rut") || "",
  correo: localStorage.getItem("tne_correo") || "",
  institucion: localStorage.getItem("tne_institucion") || "Educación Superior",
  saldo: null,
  estado: "Inactivo",
  ocultarSaldo: localStorage.getItem("tne_ocultar_saldo") === "true",
  modoOscuro: localStorage.getItem("tne_dark_mode") === "true",
  prestamoEmergencia: localStorage.getItem("tne_prestamo_activo") === "true",
  validadorId: localStorage.getItem("tne_validador_id") || "VAL-01",
  ultimaZona: localStorage.getItem("tne_ultima_zona") || "Plan de Valparaíso",
  bloqueoCobro: false,
  historial: JSON.parse(localStorage.getItem("tne_historial_web") || "[]")
};

async function fetchConTimeout(url, options = {}, timeoutMs = CONFIG.app.timeoutMs || 8000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const onExternalAbort = () => controller.abort();

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { signal: _omit, ...restOptions } = options;
    return await fetch(url, { ...restOptions, signal: controller.signal });
  } finally {
    clearTimeout(timerId);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function cancelarPollingEnCurso() {
  syncEpoch += 1;
  if (pollingAbortController) {
    try { pollingAbortController.abort(); } catch {}
    pollingAbortController = null;
  }
}

function cambiarModoLectorNativo(activar) {
  try {
    if (window.AndroidNfc && typeof window.AndroidNfc.setModoLecturaTne === "function") {
      window.AndroidNfc.setModoLecturaTne(Boolean(activar));
    }
  } catch {}
}

// Normaliza y valida RUT Chileno (Módulo 11) -> formato único "21345678-9"
function normalizarRut(rutRaw) {
  const limpio = String(rutRaw || "").replace(/[.\-\s]/g, "").toUpperCase();
  if (!/^[0-9]{7,8}[0-9K]$/.test(limpio)) return "";
  return `${limpio.slice(0, -1)}-${limpio.slice(-1)}`;
}

function validarRut(rutRaw) {
  const normalizado = normalizarRut(rutRaw);
  if (!normalizado) return false;

  const [cuerpo, dv] = normalizado.split("-");
  if (/^(\d)\1+$/.test(cuerpo)) return false;

  let suma = 0;
  let multiplo = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += parseInt(cuerpo.charAt(i), 10) * multiplo;
    multiplo = multiplo === 7 ? 2 : multiplo + 1;
  }

  const resto = 11 - (suma % 11);
  const dvEsperado = resto === 11 ? "0" : resto === 10 ? "K" : String(resto);
  return dv === dvEsperado;
}

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

function limpiarRecuadrosRegistro() {
  ["regNombre", "regRut", "regInstitucion", "regCorreo", "regPassword", "regUid"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = "";
  });
}

function iniciarPolling() {
  detenerPolling();
  if (document.hidden) return;
  pollingTimer = setInterval(() => {
    if (!document.hidden) consultarSaldoEnNube();
  }, CONFIG.app.intervaloPollingMs);
}

function detenerPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function tarifaEscolarTexto() {
  return formatearPesos(CONFIG.tarifas.escolar);
}

async function inicializarApp() {
  try {
    const res = await fetchConTimeout("./config.json", { cache: "no-store" }, 4000);
    if (res.ok) {
      const jsonExterno = await res.json();
      CONFIG = {
        ...DEFAULT_CONFIG,
        ...jsonExterno,
        app: { ...DEFAULT_CONFIG.app, ...(jsonExterno.app || {}) },
        supabase: { ...DEFAULT_CONFIG.supabase, ...(jsonExterno.supabase || {}) },
        tarifas: { ...DEFAULT_CONFIG.tarifas, ...(jsonExterno.tarifas || {}) },
        stickersValidadores: {
          ...DEFAULT_CONFIG.stickersValidadores,
          ...(jsonExterno.stickersValidadores || {})
        },
        zonasMapa: jsonExterno.zonasMapa || DEFAULT_CONFIG.zonasMapa
      };
    }
  } catch {
    // shortcut: Si se abre via file:// o falla config.json, usa DEFAULT_CONFIG.
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
  cambiarModoLectorNativo(false);

  if (!state.sesionActiva || !state.uid) {
    state.sesionActiva = false;
    state.uid = "";
    state.saldo = 0;
    document.getElementById("loginModalBackdrop")?.classList.remove("open");
    mostrarPestana("cuenta", true);
    actualizarUI();
    renderizarHistorial();
  } else {
    mostrarPestana("saldo", true);
    actualizarUI();
    renderizarHistorial();
    await consultarSaldoEnNube();
  }

  iniciarPolling();
}

function aplicarModoOscuro() {
  document.body.classList.toggle("dark-mode", state.modoOscuro);
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.textContent = state.modoOscuro ? "☀️" : "🌙";
}

function poblarControlesDesdeConfig() {
  const tarifaTxt = tarifaEscolarTexto();

  const sealBadge = document.getElementById("sealBadge");
  if (sealBadge) sealBadge.textContent = CONFIG.app.sello;

  const fareAmountLabel = document.getElementById("fareAmountLabel");
  if (fareAmountLabel) fareAmountLabel.textContent = `${tarifaTxt} CLP`;

  const payBtnText = document.getElementById("payBtnText");
  if (payBtnText) payBtnText.textContent = `Pagar Pasaje Escolar (-${tarifaTxt})`;

  const bannerEmergencyBtn = document.getElementById("bannerEmergencyBtn");
  if (bannerEmergencyBtn) bannerEmergencyBtn.textContent = `Pedir Fiado -${tarifaTxt}`;

  const payViewLoanBtn = document.getElementById("payViewLoanBtn");
  if (payViewLoanBtn) payViewLoanBtn.textContent = `🆘 Usar Préstamo Escolar de Emergencia (-${tarifaTxt})`;

  const customMontoInput = document.getElementById("customMontoInput");
  if (customMontoInput) customMontoInput.min = String(CONFIG.tarifas.escolar);

  const zoneSelect = document.getElementById("zoneSelect");
  if (zoneSelect) {
    zoneSelect.textContent = "";
    Object.keys(CONFIG.zonasMapa).forEach((z) => {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = `📍 ${z}`;
      if (z === state.ultimaZona) opt.selected = true;
      zoneSelect.appendChild(opt);
    });
  }

  const recargaGrid = document.getElementById("rechargeButtonsContainer");
  if (recargaGrid) {
    recargaGrid.textContent = "";
    CONFIG.tarifas.montosRecarga.forEach((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-recharge";
      btn.dataset.monto = String(m);
      btn.textContent = `+${formatearPesos(m)}`;
      recargaGrid.appendChild(btn);
    });
  }
}

function formatearPesos(valor) {
  const n = Number(valor) || 0;
  return n < 0 ? `-$${Math.abs(n).toLocaleString("es-CL")}` : `$${n.toLocaleString("es-CL")}`;
}

function obtenerSaldoVisible() {
  const saldoBase = state.saldo !== null ? Number(state.saldo) : 0;
  return state.prestamoEmergencia ? saldoBase - CONFIG.tarifas.escolar : saldoBase;
}

function sanitizarUid(raw) {
  const limpio = String(raw || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  return limpio.length >= 4 ? limpio.slice(0, 16) : "";
}

function guardarPerfilLocal() {
  localStorage.setItem("tne_app_schema", "v2_clean_auth");
  localStorage.setItem("tne_sesion_activa", String(state.sesionActiva));
  localStorage.setItem("tne_uid_activo", state.uid);
  localStorage.setItem("tne_nombre", state.nombre);
  localStorage.setItem("tne_rut", state.rut);
  localStorage.setItem("tne_correo", state.correo);
  localStorage.setItem("tne_institucion", state.institucion);
  localStorage.setItem("tne_ocultar_saldo", String(state.ocultarSaldo));
  localStorage.setItem("tne_dark_mode", String(state.modoOscuro));
  localStorage.setItem("tne_prestamo_activo", String(state.prestamoEmergencia));
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

async function anunciarCelularEnValidadorEspecifico(activo) {
  if (!state.uid || !state.sesionActiva) return;
  clearTimeout(timerModoCelular);

  const uidObjetivo = state.uid;
  const estadoParaServidor = activo ? `PAGANDO_${state.validadorId}` : "Activo";
  const stageSub = document.getElementById("stageSubtitle");

  try {
    const res = await fetchConTimeout(
      `${CONFIG.supabase.url}/rest/v1/tarjetas_autorizadas?uid=eq.${encodeURIComponent(uidObjetivo)}`,
      {
        method: "PATCH",
        headers: headersSupabase,
        body: JSON.stringify({ estado: estadoParaServidor })
      }
    );

    if (activo && state.sesionActiva && state.uid === uidObjetivo) {
      if (!res.ok) {
        if (stageSub) stageSub.textContent = "⚠️ No se pudo activar el pago NFC en el servidor.";
        return;
      }
      if (stageSub) {
        const nfcOk = !window.AndroidNfc || window.AndroidNfc.tieneNfcActivo();
        stageSub.textContent = nfcOk
          ? "📲 Listo: acerca la espalda de tu celular al escáner del validador."
          : "⚠️ Enciende el NFC en los ajustes de tu teléfono para pagar acercándolo.";
      }
      timerModoCelular = setTimeout(() => anunciarCelularEnValidadorEspecifico(false), 60000);
    }
  } catch {
    if (activo && stageSub) {
      stageSub.textContent = "⚠️ Sin conexión para preparar el pago NFC.";
    }
  }
}

async function notificarCobroExitosoAlValidador(uidObjetivo = state.uid) {
  if (!uidObjetivo) return;
  try {
    await fetchConTimeout(
      `${CONFIG.supabase.url}/rest/v1/tarjetas_autorizadas?uid=eq.${encodeURIComponent(uidObjetivo)}`,
      {
        method: "PATCH",
        headers: headersSupabase,
        body: JSON.stringify({
          estado: `COBRO_OK_${state.validadorId}`
        })
      }
    );
  } catch {}
}

function mostrarPestana(tabId, silencioso = false) {
  if (!state.sesionActiva && tabId !== "cuenta") {
    if (!silencioso) mostrarToast("Crea tu cuenta o inicia sesión primero.", "warn");
    tabId = "cuenta";
  }
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".view-panel").forEach((p) => p.classList.toggle("active", p.id === `view-${tabId}`));

  if (tabId === "pago" && state.sesionActiva) {
    cambiarModoLectorNativo(false);
    anunciarCelularEnValidadorEspecifico(true);
  } else {
    anunciarCelularEnValidadorEspecifico(false);
  }
}

function actualizarVistaCuenta() {
  const profileCard = document.getElementById("accountProfileCard");
  const loginPromptCard = document.getElementById("loginPromptCard");
  const registerAccordion = document.getElementById("registerAccordion");

  const logueado = Boolean(state.sesionActiva && state.uid);
  if (profileCard) profileCard.style.display = logueado ? "block" : "none";
  if (loginPromptCard) loginPromptCard.style.display = logueado ? "none" : "block";
  if (registerAccordion) registerAccordion.style.display = logueado ? "none" : "block";

  if (logueado) {
    const pName = document.getElementById("profileNameText");
    const pMeta = document.getElementById("profileMetaText");
    const pEmail = document.getElementById("profileEmailText");
    const pUid = document.getElementById("profileUidText");

    if (pName) pName.textContent = state.nombre || "Estudiante TNE";
    if (pMeta) pMeta.textContent = `${state.rut || "Sin RUT"} · ${state.institucion || "Educación Superior"}`;
    if (pEmail) pEmail.textContent = state.correo || "Sin correo";
    if (pUid) pUid.textContent = state.uid;
  }
}

function actualizarUI() {
  const nameEl = document.getElementById("studentNameLabel");
  const metaEl = document.getElementById("studentMetaLabel");
  const statusBadgeEl = document.getElementById("cardStatusBadge");
  const syncText = document.getElementById("syncText");

  if (!state.sesionActiva || !state.uid) {
    if (nameEl) nameEl.textContent = "Sin Cuenta Activa";
    if (metaEl) metaEl.textContent = "Crea tu cuenta o inicia sesión";
    if (statusBadgeEl) statusBadgeEl.textContent = "SIN VINCULAR";
    if (syncText) syncText.textContent = "Sin cuenta";
  } else {
    if (nameEl) nameEl.textContent = state.nombre || "Estudiante TNE";
    if (metaEl) metaEl.textContent = `${state.institucion} · ${state.rut ? `RUT ${state.rut}` : "Vinculado"}`;
    if (statusBadgeEl) statusBadgeEl.textContent = "ACTIVA";
  }

  actualizarVistaCuenta();

  const saldoCargado = state.saldo !== null;
  const saldoMostrado = obtenerSaldoVisible();
  const viajes = Math.max(0, Math.floor(saldoMostrado / CONFIG.tarifas.escolar));
  const tarifaTxt = tarifaEscolarTexto();

  const balanceEl = document.getElementById("balanceDisplay");
  const tripsEl = document.getElementById("tripsLeftLabel");
  const eyeLabel = document.getElementById("eyeLabel");
  const fareFooterBox = document.getElementById("fareFooterBox");

  if (balanceEl && tripsEl && eyeLabel) {
    balanceEl.classList.toggle("negative-loan", saldoCargado && saldoMostrado < 0);
    if (state.ocultarSaldo) {
      balanceEl.textContent = "$ ••••••";
      tripsEl.textContent = "Viajes: •••";
      eyeLabel.textContent = "🙈 Mostrar";
    } else if (state.sesionActiva && !saldoCargado) {
      balanceEl.textContent = "Cargando...";
      tripsEl.textContent = "Sincronizando...";
      eyeLabel.textContent = "👁️ Ocultar";
    } else {
      balanceEl.textContent = formatearPesos(saldoMostrado);
      tripsEl.textContent = state.prestamoEmergencia
        ? `⚠️ En Préstamo (-${tarifaTxt})`
        : `Viajes: ${viajes}`;
      eyeLabel.textContent = "👁️ Ocultar";
    }
  }

  if (fareFooterBox) {
    fareFooterBox.classList.toggle(
      "critical-balance",
      state.sesionActiva && saldoCargado && !state.ocultarSaldo && viajes <= 1
    );
  }

  const necesitaPrestamo =
    state.sesionActiva &&
    saldoCargado &&
    Number(state.saldo) < CONFIG.tarifas.escolar &&
    !state.prestamoEmergencia;

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

function poblarListaHistorial(contenedor, items) {
  contenedor.textContent = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "history-item";
    const span = document.createElement("span");
    span.className = "history-time";
    span.textContent = "Sin movimientos registrados";
    li.appendChild(span);
    contenedor.appendChild(li);
    return;
  }

  items.forEach((m) => {
    const esPos = Number(m.monto) > 0;
    const saldoTxt = state.ocultarSaldo ? "$ ••••••" : formatearPesos(m.saldoFinal);

    const li = document.createElement("li");
    li.className = "history-item";

    const left = document.createElement("div");
    left.className = "history-left";

    const titleSpan = document.createElement("span");
    titleSpan.className = "history-title";
    titleSpan.textContent = String(m.titulo || "Movimiento");

    const timeSpan = document.createElement("span");
    timeSpan.className = "history-time";
    timeSpan.textContent = `${m.hora || ""} · 📍 ${m.zona || "Valparaíso"} · Saldo: ${saldoTxt}`;

    left.appendChild(titleSpan);
    left.appendChild(timeSpan);

    const amountSpan = document.createElement("span");
    amountSpan.className = `history-amount ${esPos ? "pos" : "neg"}`;
    amountSpan.textContent = `${esPos ? "+" : ""}${formatearPesos(m.monto)}`;

    li.appendChild(left);
    li.appendChild(amountSpan);
    contenedor.appendChild(li);
  });
}

function renderizarHistorial() {
  const cobros = state.historial.filter((m) => Number(m.monto) < 0).length;
  const ahorro = cobros * (CONFIG.tarifas.adultoReferencia - CONFIG.tarifas.escolar);

  const statTripsEl = document.getElementById("statTripsCount");
  const statSavingsEl = document.getElementById("statSavingsValue");
  if (statTripsEl) statTripsEl.textContent = `${cobros} viajes`;
  if (statSavingsEl) statSavingsEl.textContent = state.ocultarSaldo ? "$ ••••" : formatearPesos(ahorro);

  const historyList = document.getElementById("historyList");
  const homeMini = document.getElementById("homeMiniHistory");
  if (!historyList || !homeMini) return;

  poblarListaHistorial(historyList, state.historial);
  poblarListaHistorial(homeMini, state.historial.slice(0, 2));
}

async function consultarSaldoEnNube() {
  if (!state.sesionActiva || !state.uid || procesandoTransaccion) return;

  // En red lenta, deja terminar la consulta en vuelo en vez de cancelarla
  if (pollingAbortController) return;

  const controller = new AbortController();
  pollingAbortController = controller;
  const epochInicio = syncEpoch;
  const uidInicio = state.uid;

  const syncDot = document.getElementById("syncDot");
  const syncText = document.getElementById("syncText");

  try {
    const columnas = "uid,nombre,rut,institucion,correo,saldo,estado,prestamo_activo";
    const url = `${CONFIG.supabase.url}/rest/v1/tarjetas_autorizadas?uid=eq.${encodeURIComponent(uidInicio)}&select=${columnas}`;
    const res = await fetchConTimeout(url, {
      headers: headersSupabase,
      cache: "no-store",
      signal: controller.signal
    });
    if (!res.ok) throw new Error("Error de red");
    const lista = await res.json();

    if (procesandoTransaccion || epochInicio !== syncEpoch || uidInicio !== state.uid || !state.sesionActiva) {
      return;
    }

    if (syncDot) syncDot.classList.remove("offline");

    if (Array.isArray(lista) && lista.length > 0) {
      const datos = lista[0];

      if (datos.nombre && datos.nombre !== "Estudiante TNE" && datos.nombre !== "SIN ASIGNAR") {
        state.nombre = datos.nombre;
      }
      if (datos.rut) state.rut = datos.rut;
      if (datos.institucion) state.institucion = datos.institucion;
      if (datos.correo) state.correo = datos.correo;

      state.prestamoEmergencia = Boolean(datos.prestamo_activo);
      const nuevoSaldo = Number(datos.saldo);

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
        registrarMovimientoLocal("Pasaje Escolar Micro", descuento, obtenerSaldoVisible());
      } else if (state.saldo !== null && Number.isFinite(nuevoSaldo) && nuevoSaldo > state.saldo) {
        const abono = nuevoSaldo - state.saldo;
        state.saldo = nuevoSaldo;
        registrarMovimientoLocal("Recarga de Saldo", abono, obtenerSaldoVisible());
      } else if (Number.isFinite(nuevoSaldo)) {
        state.saldo = nuevoSaldo;
      }

      state.estado = datos.estado || "Activo";
      if (syncText) syncText.textContent = "Pase Activo";

      guardarPerfilLocal();
      actualizarUI();
    } else {
      state.estado = "No registrado";
      if (syncText) syncText.textContent = "Activar Pase";
      actualizarUI();
    }
  } catch (err) {
    if (err?.name === "AbortError" && (epochInicio !== syncEpoch || pollingAbortController !== controller)) {
      return;
    }
    if (syncDot) syncDot.classList.add("offline");
    if (syncText) syncText.textContent = "Sin conexión";
  } finally {
    if (pollingAbortController === controller) {
      pollingAbortController = null;
    }
  }
}

let overlayTimer = null;
let overlayCountdownInterval = null;

function ocultarPantallaCompletaPago() {
  const overlay = document.getElementById("paymentFullOverlay");
  clearTimeout(overlayTimer);
  clearInterval(overlayCountdownInterval);
  if (overlay) {
    overlay.className = "payment-full-overlay";
    overlay.setAttribute("aria-hidden", "true");
  }
}

function mostrarPantallaCargaPago(
  titulo = "Validando Pasaje...",
  subtitulo = "Esperando confirmación del servidor..."
) {
  const overlay = document.getElementById("paymentFullOverlay");
  const badge = document.getElementById("overlayTopBadge");
  const iconBox = document.getElementById("overlayIconBox");
  const titleEl = document.getElementById("overlayTitle");
  const subEl = document.getElementById("overlaySubtitle");
  const studentEl = document.getElementById("overlayStudentName");
  const zoneEl = document.getElementById("overlayZoneName");
  const balanceEl = document.getElementById("overlayBalance");

  if (!overlay) return;

  clearTimeout(overlayTimer);
  clearInterval(overlayCountdownInterval);

  overlay.className = "payment-full-overlay show is-loading";
  overlay.setAttribute("aria-hidden", "false");

  badge.textContent = "• PROCESANDO PAGO";
  titleEl.textContent = titulo;
  subEl.textContent = subtitulo;
  studentEl.textContent = state.nombre || "Estudiante TNE";
  if (zoneEl) zoneEl.textContent = state.ultimaZona || "Valparaíso";
  balanceEl.textContent = "Verificando...";

  iconBox.innerHTML = `
    <svg class="overlay-spinner-svg" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
      <circle cx="12" cy="12" r="9" stroke-opacity="0.25"></circle>
      <path d="M21 12a9 9 0 0 0-9-9"></path>
    </svg>`;
}

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

  balanceEl.textContent = state.ocultarSaldo ? "$ ••••••" : formatearPesos(obtenerSaldoVisible());

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
    ocultarPantallaCompletaPago();
  }, segundosTotales * 1000);
}

function actualizarEstadoBotonPago() {
  const payBtn = document.getElementById("payWebBtn");
  const payBtnText = document.getElementById("payBtnText");
  if (!payBtn || !payBtnText) return;

  if (state.bloqueoCobro && cooldownSegsRestantes > 0) {
    payBtn.disabled = true;
    payBtnText.textContent = procesandoTransaccion
      ? `⏳ Validando (${cooldownSegsRestantes}s)...`
      : `⏳ Espera ${cooldownSegsRestantes}s...`;
  } else if (procesandoTransaccion) {
    payBtn.disabled = true;
    payBtnText.textContent = "⏳ Validando pago...";
  } else {
    payBtn.disabled = false;
    payBtnText.textContent = `Pagar Pasaje Escolar (-${tarifaEscolarTexto()})`;
  }
}

function iniciarCooldownAntiDobleCobro() {
  clearInterval(cooldownIntervalId);
  state.bloqueoCobro = true;
  cooldownSegsRestantes = CONFIG.app.cooldownSegundos || 3;
  actualizarEstadoBotonPago();

  cooldownIntervalId = setInterval(() => {
    cooldownSegsRestantes -= 1;
    if (cooldownSegsRestantes <= 0) {
      clearInterval(cooldownIntervalId);
      cooldownIntervalId = null;
      state.bloqueoCobro = false;
    }
    actualizarEstadoBotonPago();
  }, 1000);
}

async function pagarPasajeWeb(origenCobro = "Pago Móvil Micro") {
  if (!state.sesionActiva || !state.uid) {
    mostrarToast("Primero registra tu cuenta y vincula tu TNE.", "warn");
    mostrarPestana("cuenta", true);
    return;
  }
  if (procesandoTransaccion) {
    mostrarToast("⏳ Ya hay un pago en proceso, espera un momento.", "warn");
    return;
  }
  if (state.bloqueoCobro) {
    mostrarToast(`⏳ Espera ${CONFIG.app.cooldownSegundos || 3} segundos antes de volver a validar.`, "warn");
    return;
  }
  if (state.saldo === null) {
    mostrarToast("⏳ Aún se está cargando tu saldo, intenta en un segundo.", "warn");
    consultarSaldoEnNube();
    return;
  }

  const tarifa = CONFIG.tarifas.escolar;
  const tarifaTxt = tarifaEscolarTexto();
  const saldoPrevio = Number(state.saldo);

  if (saldoPrevio < tarifa) {
    reproducirFeedbackSensorial(false);
    mostrarPantallaCompletaPago(
      false,
      "Saldo Insuficiente",
      `Tienes menos de ${tarifaTxt}. Activa el Préstamo Escolar de Emergencia abajo.`
    );
    actualizarUI();
    return;
  }

  const uidOperacion = state.uid;
  procesandoTransaccion = true;
  cancelarPollingEnCurso();
  iniciarCooldownAntiDobleCobro();
  mostrarPantallaCargaPago("Validando Pasaje...", "Esperando confirmación del servidor...");

  try {
    const res = await fetchConTimeout(`${CONFIG.supabase.url}/rest/v1/rpc/descontar_saldo`, {
      method: "POST",
      headers: headersSupabase,
      body: JSON.stringify({ card_uid: uidOperacion })
    });

    if (!state.sesionActiva || state.uid !== uidOperacion) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!state.sesionActiva || state.uid !== uidOperacion) return;

    const cobroConfirmado = Boolean(data && (data.status === "concedido" || data.exito === true));

    if (cobroConfirmado) {
      const saldoServidor =
        data.saldo_restante !== undefined
          ? Number(data.saldo_restante)
          : data.nuevo_saldo !== undefined
          ? Number(data.nuevo_saldo)
          : saldoPrevio - tarifa;

      await notificarCobroExitosoAlValidador(uidOperacion);
      if (!state.sesionActiva || state.uid !== uidOperacion) return;

      state.saldo = Number.isFinite(saldoServidor) ? saldoServidor : saldoPrevio - tarifa;
      guardarPerfilLocal();
      actualizarUI();
      reproducirFeedbackSensorial(true);
      registrarMovimientoLocal(origenCobro, -tarifa, obtenerSaldoVisible());
      mostrarPantallaCompletaPago(true, "¡Pasaje Aprobado!", `Tarifa Estudiante (-${tarifaTxt}) · ¡Buen viaje!`);
    } else {
      reproducirFeedbackSensorial(false);
      mostrarPantallaCompletaPago(
        false,
        "Pago Rechazado",
        data?.mensaje || "El servidor rechazó el cobro. Verifica tu saldo."
      );
    }
  } catch (err) {
    if (!state.sesionActiva || state.uid !== uidOperacion) return;
    reproducirFeedbackSensorial(false);
    const esTimeout = err?.name === "AbortError";
    mostrarPantallaCompletaPago(
      false,
      esTimeout ? "Tiempo Agotado" : "Error de Conexión",
      esTimeout
        ? "La red tardó demasiado. Revisa tu saldo antes de reintentar."
        : "No se pudo validar el pasaje con el servidor."
    );
  } finally {
    syncEpoch += 1;
    procesandoTransaccion = false;
    actualizarEstadoBotonPago();
  }
}

async function activarPrestamoEmergencia() {
  if (!state.sesionActiva || !state.uid) return;
  if (procesandoTransaccion) {
    mostrarToast("⏳ Espera a que termine la operación actual.", "warn");
    return;
  }
  if (state.saldo === null) {
    mostrarToast("⏳ Aún se está cargando tu saldo, intenta en un segundo.", "warn");
    consultarSaldoEnNube();
    return;
  }

  const tarifaTxt = tarifaEscolarTexto();
  if (state.prestamoEmergencia) {
    mostrarToast(`Ya tienes 1 Préstamo Escolar activo (-${tarifaTxt}).`, "warn");
    return;
  }

  const uidOperacion = state.uid;
  procesandoTransaccion = true;
  cancelarPollingEnCurso();
  iniciarCooldownAntiDobleCobro();
  mostrarPantallaCargaPago("Activando Préstamo...", "Sincronizando viaje de emergencia...");

  try {
    const res = await fetchConTimeout(`${CONFIG.supabase.url}/rest/v1/rpc/activar_prestamo_tne`, {
      method: "POST",
      headers: headersSupabase,
      body: JSON.stringify({ card_uid: uidOperacion })
    });
    if (!state.sesionActiva || state.uid !== uidOperacion) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!state.sesionActiva || state.uid !== uidOperacion) return;

    if (data && data.status === "concedido") {
      await notificarCobroExitosoAlValidador(uidOperacion);
      if (!state.sesionActiva || state.uid !== uidOperacion) return;

      state.prestamoEmergencia = true;
      if (data.saldo_restante !== undefined) state.saldo = Number(data.saldo_restante);
      guardarPerfilLocal();
      reproducirFeedbackSensorial(true);
      registrarMovimientoLocal("Préstamo Escolar de Emergencia", -CONFIG.tarifas.escolar, obtenerSaldoVisible());
      actualizarUI();
      mostrarPantallaCompletaPago(
        true,
        "¡Viaje de Emergencia!",
        `Préstamo Escolar activado (-${tarifaTxt}). Se descontará en tu próxima recarga.`
      );
    } else {
      reproducirFeedbackSensorial(false);
      mostrarPantallaCompletaPago(
        false,
        "Préstamo No Disponible",
        data?.mensaje || "No se pudo activar el préstamo escolar."
      );
    }
  } catch (err) {
    if (!state.sesionActiva || state.uid !== uidOperacion) return;
    reproducirFeedbackSensorial(false);
    const esTimeout = err?.name === "AbortError";
    mostrarPantallaCompletaPago(
      false,
      esTimeout ? "Tiempo Agotado" : "Error de Conexión",
      esTimeout
        ? "La red tardó demasiado al registrar el préstamo."
        : "No se pudo registrar el préstamo en el servidor."
    );
  } finally {
    syncEpoch += 1;
    procesandoTransaccion = false;
    actualizarEstadoBotonPago();
  }
}

async function recargarSaldoWeb(monto) {
  if (!state.sesionActiva || !state.uid) {
    mostrarToast("Vincula tu TNE antes de recargar.", "warn");
    mostrarPestana("cuenta", true);
    return;
  }
  if (procesandoTransaccion) {
    mostrarToast("⏳ Hay una operación en curso, espera un momento.", "warn");
    return;
  }

  const valor = parseInt(monto, 10);
  const minimo = CONFIG.tarifas.escolar || 200;
  const tarifaTxt = tarifaEscolarTexto();
  if (!Number.isFinite(valor) || valor < minimo) {
    mostrarToast(`El monto mínimo de recarga es ${formatearPesos(minimo)}.`, "warn");
    return;
  }

  const uidOperacion = state.uid;
  procesandoTransaccion = true;
  cancelarPollingEnCurso();
  actualizarEstadoBotonPago();

  try {
    const res = await fetchConTimeout(`${CONFIG.supabase.url}/rest/v1/rpc/recargar_saldo`, {
      method: "POST",
      headers: headersSupabase,
      body: JSON.stringify({ card_uid: uidOperacion, monto: valor })
    });

    if (!state.sesionActiva || state.uid !== uidOperacion) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!state.sesionActiva || state.uid !== uidOperacion) return;

    if (data && (data.status === "exito" || data.exito === true)) {
      const saldoPrestamo = Boolean(data.prestamo_saldado);
      const montoAcreditado = data.monto_acreditado !== undefined ? Number(data.monto_acreditado) : valor;

      state.prestamoEmergencia = false;
      state.saldo =
        data.saldo_restante !== undefined
          ? Number(data.saldo_restante)
          : (state.saldo !== null ? Number(state.saldo) : 0) + montoAcreditado;

      guardarPerfilLocal();
      reproducirFeedbackSensorial(true);
      registrarMovimientoLocal(
        saldoPrestamo ? `Recarga (Saldó préstamo -${tarifaTxt})` : "Recarga de Saldo",
        montoAcreditado,
        obtenerSaldoVisible()
      );
      actualizarUI();
      mostrarToast(
        saldoPrestamo
          ? `✔ Recarga +${formatearPesos(valor)} (Se descontaron -${tarifaTxt} del préstamo)`
          : `✔ Recarga exitosa (+${formatearPesos(valor)})`,
        "ok"
      );
    } else {
      reproducirFeedbackSensorial(false);
      mostrarToast(data?.mensaje || "No se pudo completar la recarga.", "err");
    }
  } catch (err) {
    if (!state.sesionActiva || state.uid !== uidOperacion) return;
    reproducirFeedbackSensorial(false);
    mostrarToast(
      err?.name === "AbortError"
        ? "Tiempo de espera agotado al recargar."
        : "Sin conexión para recargar en este momento.",
      "err"
    );
  } finally {
    syncEpoch += 1;
    procesandoTransaccion = false;
    actualizarEstadoBotonPago();
    if (state.sesionActiva && state.uid === uidOperacion) {
      await consultarSaldoEnNube();
    }
  }
}

function detenerEscaneoWebNfc() {
  if (nfcAbortController) {
    try { nfcAbortController.abort(); } catch {}
    nfcAbortController = null;
  }
}

function abrirMenuGuiaNfc(tituloModal, callbackUid) {
  const modal = document.getElementById("nfcGuideModalBackdrop");
  const titleEl = document.getElementById("nfcGuideTitle");
  const statusEl = document.getElementById("nfcLiveStatusText");

  window.callbackNfcGuiaActivo = callbackUid;
  if (titleEl) titleEl.textContent = tituloModal;
  if (modal) modal.classList.add("open");

  cambiarModoLectorNativo(true);

  if (window.AndroidNfc) {
    const activo = window.AndroidNfc.tieneNfcActivo();
    if (statusEl) {
      statusEl.textContent = activo
        ? "📡 Lector activo: apoya tu TNE física detrás del teléfono..."
        : "⚠️ Activa el NFC en los ajustes de tu teléfono y apoya tu TNE.";
    }
    return;
  }

  if (statusEl) statusEl.textContent = "📡 Apoya tu TNE física detrás del teléfono...";
  if ("NDEFReader" in window) {
    detenerEscaneoWebNfc();
    nfcAbortController = new AbortController();
    try {
      const ndef = new NDEFReader();
      ndef.scan({ signal: nfcAbortController.signal }).then(() => {
        ndef.onreading = (event) => {
          if (event.serialNumber) window.onNativeNfcScanned(event.serialNumber);
        };
      }).catch(() => {
        if (statusEl) {
          statusEl.textContent = "⚠️ Web NFC no disponible o sin permiso. Puedes escribir el código TNE manualmente.";
        }
      });
    } catch {}
  } else if (statusEl) {
    statusEl.textContent = "ℹ️ Este navegador no soporta lectura NFC. Escribe tu código TNE en el campo manual.";
  }
}

function cerrarMenuGuiaNfc() {
  window.callbackNfcGuiaActivo = null;
  detenerEscaneoWebNfc();
  document.getElementById("nfcGuideModalBackdrop")?.classList.remove("open");
  cambiarModoLectorNativo(false);
}

function cerrarSesionUsuario() {
  anunciarCelularEnValidadorEspecifico(false);
  cancelarPollingEnCurso();
  cambiarModoLectorNativo(false);
  cerrarMenuGuiaNfc();
  ocultarPantallaCompletaPago();

  clearInterval(cooldownIntervalId);
  cooldownIntervalId = null;
  cooldownSegsRestantes = 0;
  procesandoTransaccion = false;

  const modoOscuroActual = state.modoOscuro;
  localStorage.clear();
  localStorage.setItem("tne_app_schema", "v2_clean_auth");
  localStorage.setItem("tne_dark_mode", String(modoOscuroActual));

  state.sesionActiva = false;
  state.uid = "";
  state.nombre = "";
  state.rut = "";
  state.correo = "";
  state.institucion = "Educación Superior";
  state.saldo = 0;
  state.estado = "Inactivo";
  state.prestamoEmergencia = false;
  state.ocultarSaldo = false;
  state.bloqueoCobro = false;
  state.historial = [];

  limpiarRecuadrosRegistro();
  actualizarEstadoBotonPago();
  actualizarUI();
  renderizarHistorial();
  mostrarPestana("cuenta", true);
  mostrarToast("Sesión cerrada. Registra una nueva cuenta o inicia sesión.", "ok");
}

function configurarEventos() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      detenerPolling();
      cancelarPollingEnCurso();
    } else {
      consultarSaldoEnNube();
      iniciarPolling();
    }
  });

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
    if (overlay && !overlay.classList.contains("is-loading")) {
      ocultarPantallaCompletaPago();
    }
  });

  document.getElementById("closeNfcGuideBtn")?.addEventListener("click", cerrarMenuGuiaNfc);

  document.getElementById("scanNfcWalletBtn")?.addEventListener("click", () => {
    abrirMenuGuiaNfc("Cambiar TNE", (uidLeido) => {
      const validadorAsociado = CONFIG.stickersValidadores?.[uidLeido];
      if (validadorAsociado) {
        state.validadorId = validadorAsociado;
        guardarPerfilLocal();
        pagarPasajeWeb("Pago NFC Micro");
      } else {
        cancelarPollingEnCurso();
        state.uid = uidLeido;
        state.saldo = null;
        state.prestamoEmergencia = false;
        guardarPerfilLocal();
        actualizarUI();
        consultarSaldoEnNube();
        mostrarToast(`✔ Tarjeta TNE (${uidLeido}) cambiada con éxito`, "ok");
      }
    });
  });

  document.getElementById("scanNfcRegBtn")?.addEventListener("click", () => {
    abrirMenuGuiaNfc("Vincular TNE", (uidHex) => {
      const regUidInput = document.getElementById("regUid");
      if (regUidInput) regUidInput.value = uidHex;
      state.uid = uidHex;
      mostrarToast(`✔ TNE ${uidHex} leída correctamente`, "ok");
    });
  });

  document.getElementById("rechargeButtonsContainer")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-monto]");
    if (btn) recargarSaldoWeb(btn.dataset.monto);
  });

  document.getElementById("customRechargeBtn")?.addEventListener("click", () => {
    const input = document.getElementById("customMontoInput");
    if (!input || !input.value) {
      mostrarToast(`Ingresa un monto a recargar (mínimo ${tarifaEscolarTexto()}).`, "warn");
      return;
    }
    recargarSaldoWeb(input.value);
    input.value = "";
  });

  document.getElementById("clearHistoryBtn")?.addEventListener("click", () => {
    state.historial = [];
    localStorage.setItem("tne_historial_web", "[]");
    renderizarHistorial();
  });

  document.getElementById("logoutBtn")?.addEventListener("click", cerrarSesionUsuario);
  document.getElementById("accountLogoutBtn")?.addEventListener("click", cerrarSesionUsuario);

  const loginBackdrop = document.getElementById("loginModalBackdrop");
  document.getElementById("openLoginModalBtn")?.addEventListener("click", () => {
    loginBackdrop?.classList.add("open");
  });

  loginBackdrop?.addEventListener("click", (e) => {
    if (e.target === loginBackdrop) loginBackdrop.classList.remove("open");
  });

  document.getElementById("goToRegisterFromLogin")?.addEventListener("click", () => {
    loginBackdrop?.classList.remove("open");
    limpiarRecuadrosRegistro();
    mostrarPestana("cuenta", true);
  });

  document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (procesandoTransaccion) return;

    const correo = document.getElementById("loginCorreo").value.trim();
    const pass = document.getElementById("loginPassword").value.trim();
    if (!correo || pass.length < 4) {
      mostrarToast("Ingresa tu correo y una contraseña válida.", "warn");
      return;
    }

    procesandoTransaccion = true;
    cancelarPollingEnCurso();

    try {
      const res = await fetchConTimeout(`${CONFIG.supabase.url}/rest/v1/rpc/login_tne`, {
        method: "POST",
        headers: headersSupabase,
        body: JSON.stringify({ p_correo: correo, p_password: pass })
      });

      if (res.status === 400 || res.status === 401 || res.status === 403) {
        mostrarToast("Correo o contraseña incorrectos.", "err");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const loginAprobado = Boolean(data && (data.status === "exito" || data.exito === true || data.uid));
      if (!loginAprobado) {
        mostrarToast(data?.mensaje || "Correo o contraseña incorrectos.", "err");
        return;
      }

      const uidValido = sanitizarUid(data.uid);
      if (!uidValido) {
        mostrarToast("La cuenta no tiene una tarjeta TNE válida asociada.", "err");
        return;
      }

      state.sesionActiva = true;
      state.uid = uidValido;
      if (data.nombre) state.nombre = data.nombre;
      if (data.rut) state.rut = data.rut;
      state.correo = correo;
      state.saldo = null;
      state.prestamoEmergencia = Boolean(data.prestamo_activo);
      guardarPerfilLocal();
      loginBackdrop?.classList.remove("open");
      limpiarRecuadrosRegistro();
      actualizarUI();
      procesandoTransaccion = false;
      await consultarSaldoEnNube();
      mostrarPestana("saldo", true);
    } catch (err) {
      mostrarToast(
        err?.name === "AbortError" ? "Tiempo de espera agotado al iniciar sesión." : "Error de conexión al iniciar sesión",
        "err"
      );
    } finally {
      procesandoTransaccion = false;
    }
  });

  document.getElementById("registerForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (procesandoTransaccion) return;

    const uidIngresado = sanitizarUid(document.getElementById("regUid")?.value || state.uid);
    const nombre = document.getElementById("regNombre").value.trim().replace(/\s+/g, " ").toUpperCase();
    const rutRaw = document.getElementById("regRut").value.trim();
    const institucion = document.getElementById("regInstitucion").value.trim().replace(/\s+/g, " ");
    const correo = document.getElementById("regCorreo").value.trim().toLowerCase();
    const pass = document.getElementById("regPassword").value.trim();

    if (nombre.length < 2) {
      mostrarToast("⚠️ Ingresa tu nombre completo.", "err");
      return;
    }
    if (!validarRut(rutRaw)) {
      mostrarToast("⚠️ El RUT ingresado no es válido. Revisa el dígito verificador.", "err");
      return;
    }
    if (institucion.length < 2) {
      mostrarToast("⚠️ Ingresa el nombre de tu institución.", "err");
      return;
    }
    if (!correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      mostrarToast("⚠️ Ingresa un correo electrónico válido.", "err");
      return;
    }
    if (!uidIngresado) {
      mostrarToast("⚠️ Ingresa un código TNE válido (8 o 14 caracteres hexadecimales) o escanéalo por NFC.", "err");
      return;
    }
    if (pass.length < 4) {
      mostrarToast("⚠️ La contraseña debe tener al menos 4 caracteres.", "err");
      return;
    }

    const rutNormalizado = normalizarRut(rutRaw);
    procesandoTransaccion = true;
    cancelarPollingEnCurso();

    try {
      const resReg = await fetchConTimeout(`${CONFIG.supabase.url}/rest/v1/rpc/registrar_cuenta_tne`, {
        method: "POST",
        headers: headersSupabase,
        body: JSON.stringify({
          p_uid: uidIngresado,
          p_nombre: nombre,
          p_rut: rutNormalizado,
          p_institucion: institucion,
          p_correo: correo,
          p_saldo_inicial: 0,
          p_password: pass
        })
      });

      if (!resReg.ok) throw new Error(`HTTP ${resReg.status}`);
      const regData = await resReg.json().catch(() => null);
      if (regData && (regData.status === "error" || regData.exito === false)) {
        mostrarToast(regData.mensaje || "No se pudo registrar la cuenta.", "err");
        return;
      }

      state.uid = uidIngresado;
      state.nombre = nombre;
      state.rut = rutNormalizado;
      state.institucion = institucion;
      state.correo = correo;
      state.sesionActiva = true;
      state.saldo = null;
      state.prestamoEmergencia = false;
      guardarPerfilLocal();
      limpiarRecuadrosRegistro();
      actualizarUI();
      procesandoTransaccion = false;
      await consultarSaldoEnNube();
      mostrarToast(`✔ Cuenta creada y TNE ${state.uid} vinculada`, "ok");
      mostrarPestana("saldo", true);
    } catch (err) {
      mostrarToast(
        err?.name === "AbortError"
          ? "Tiempo de espera agotado al registrar la cuenta."
          : "No se pudo guardar la cuenta en el servidor. Intenta nuevamente.",
        "err"
      );
    } finally {
      procesandoTransaccion = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", inicializarApp);

window.onNativeNfcScanned = function(uidLeido) {
  const uidLimpio = sanitizarUid(uidLeido);
  if (!uidLimpio) return;

  const modalNfc = document.getElementById("nfcGuideModalBackdrop");
  if (modalNfc && modalNfc.classList.contains("open")) {
    reproducirFeedbackSensorial(true);
    const cb = window.callbackNfcGuiaActivo;
    cerrarMenuGuiaNfc();
    if (typeof cb === "function") {
      cb(uidLimpio);
    } else {
      const regUidInput = document.getElementById("regUid");
      if (regUidInput) regUidInput.value = uidLimpio;
      state.uid = uidLimpio;
      mostrarToast(`✔ TNE ${uidLimpio} vinculada`, "ok");
    }
    return;
  }

  // Fuera del modal solo cobra si el chip leído es un sticker validador registrado en config.json
  const tarifaTxt = tarifaEscolarTexto();
  const esStickerValidador = Boolean(CONFIG.stickersValidadores?.[uidLimpio]);
  if (esStickerValidador) {
    state.validadorId = CONFIG.stickersValidadores[uidLimpio];
    guardarPerfilLocal();
    pagarPasajeWeb(`Pago NFC en Validador (-${tarifaTxt})`);
  }
};