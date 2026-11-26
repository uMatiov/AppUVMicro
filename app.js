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

// Limpieza única al actualizar desde la APK anterior que guardaba FCDC1198 por defecto
if (localStorage.getItem("tne_app_schema") !== "v2_clean_auth") {
  localStorage.clear();
  localStorage.setItem("tne_app_schema", "v2_clean_auth");
}

let CONFIG = DEFAULT_CONFIG;
let headersSupabase = {};
let procesandoTransaccion = false;
let timerModoCelular = null;

// Arranca 100% vacío si no hay cuenta iniciada
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

function cambiarModoLectorNativo(activar) {
  try {
    if (window.AndroidNfc && typeof window.AndroidNfc.setModoLecturaTne === "function") {
      window.AndroidNfc.setModoLecturaTne(Boolean(activar));
    }
  } catch {}
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

async function inicializarApp() {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (res.ok) {
      const jsonExterno = await res.json();
      CONFIG = { ...DEFAULT_CONFIG, ...jsonExterno };
    }
  } catch {}

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

  // Primera vez sin cuenta: inicia directo en la pestaña "Cuenta" sin datos ajenos
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

function formatearPesos(valor) {
  const n = Number(valor) || 0;
  return n < 0 ? `-$${Math.abs(n).toLocaleString("es-CL")}` : `$${n.toLocaleString("es-CL")}`;
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
        const nfcOk = !window.AndroidNfc || window.AndroidNfc.tieneNfcActivo();
        stageSub.textContent = nfcOk
          ? "📲 Antena NFC lista: acerca la espalda de tu celular al lector azul del validador."
          : "⚠️ Enciende el NFC en los ajustes de tu teléfono para pagar acercándolo.";
      }
      timerModoCelular = setTimeout(() => anunciarCelularEnValidadorEspecifico(false), 60000);
    }
  } catch {}
}

async function notificarCobroExitosoAlValidador(nuevoSaldo) {
  if (!state.uid) return;
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

function mostrarPestana(tabId, silencioso = false) {
  if (!state.sesionActiva && tabId !== "cuenta") {
    if (!silencioso) mostrarToast("Crea tu cuenta o inicia sesión primero.", "warn");
    tabId = "cuenta";
  }
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".view-panel").forEach((p) => p.classList.toggle("active", p.id === `view-${tabId}`));

  if (tabId === "pago" && state.sesionActiva) {
    cambiarModoLectorNativo(false); // Emulación HCE activa para el lector RFID-RC522
    anunciarCelularEnValidadorEspecifico(true);
  } else {
    anunciarCelularEnValidadorEspecifico(false);
  }
}

function actualizarUI() {
  const nameEl = document.getElementById("studentNameLabel");
  const metaEl = document.getElementById("studentMetaLabel");
  const statusBadgeEl = document.getElementById("cardStatusBadge");
  const syncText = document.getElementById("syncText");

  if (!state.sesionActiva || !state.uid) {
    if (nameEl) nameEl.textContent = "Sin Cuenta Activa";
    if (metaEl) metaEl.textContent = "Crea tu cuenta y vincula tu TNE";
    if (statusBadgeEl) statusBadgeEl.textContent = "SIN VINCULAR";
    if (syncText) syncText.textContent = "Sin cuenta";
  } else {
    if (nameEl) nameEl.textContent = state.nombre || "Estudiante TNE";
    if (metaEl) metaEl.textContent = `${state.institucion} · ${state.rut ? `RUT ${state.rut}` : "Vinculado"}`;
    if (statusBadgeEl) statusBadgeEl.textContent = "ACTIVA";
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
    fareFooterBox.classList.toggle("critical-balance", state.sesionActiva && !state.ocultarSaldo && viajes <= 1);
  }

  const necesitaPrestamo =
    state.sesionActiva &&
    state.saldo !== null &&
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
        const saldoTxt = state.ocultarSaldo ? "$ ••••••" : formatearPesos(m.saldoFinal);
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

async function consultarSaldoEnNube() {
  if (!state.sesionActiva || !state.uid || procesandoTransaccion) return;
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

      if (datos.nombre && datos.nombre !== "Estudiante TNE" && datos.nombre !== "SIN ASIGNAR") {
        state.nombre = datos.nombre;
      }
      if (datos.rut) state.rut = datos.rut;
      if (datos.institucion) state.institucion = datos.institucion;
      if (datos.correo) state.correo = datos.correo;

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
      if (syncText) syncText.textContent = "Pase Activo";

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

async function pagarPasajeWeb(origenCobro = "Pago Móvil Micro") {
  if (!state.sesionActiva || !state.uid) {
    mostrarToast("Primero registra tu cuenta y vincula tu TNE.", "warn");
    mostrarPestana("cuenta", true);
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
  if (!state.sesionActiva || !state.uid) {
    mostrarToast("Vincula tu TNE antes de recargar.", "warn");
    mostrarPestana("cuenta", true);
    return;
  }
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

function abrirMenuGuiaNfc(tituloModal, callbackUid) {
  const modal = document.getElementById("nfcGuideModalBackdrop");
  const titleEl = document.getElementById("nfcGuideTitle");
  const statusEl = document.getElementById("nfcLiveStatusText");

  window.callbackNfcGuiaActivo = callbackUid;
  if (titleEl) titleEl.textContent = tituloModal;
  if (modal) modal.classList.add("open");

  // Activa ReaderMode nativo de Android (lee TNE física Mifare Classic al instante)
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
    try {
      const ndef = new NDEFReader();
      ndef.scan().then(() => {
        ndef.onreading = (event) => {
          if (event.serialNumber) window.onNativeNfcScanned(event.serialNumber);
        };
      }).catch(() => {});
    } catch {}
  }
}

function cerrarMenuGuiaNfc() {
  window.callbackNfcGuiaActivo = null;
  document.getElementById("nfcGuideModalBackdrop")?.classList.remove("open");
  // Apaga ReaderMode para reactivar HCE (pago sin contacto en RC522)
  cambiarModoLectorNativo(false);
}

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

  document.getElementById("closeNfcGuideBtn")?.addEventListener("click", cerrarMenuGuiaNfc);

  // Botón "Cambiar TNE" (pestaña Pagar)
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
        mostrarToast(`✔ Tarjeta TNE (${uidLeido}) cambiada con éxito`, "ok");
      }
    });
  });

  // Botón "Vincular TNE" (pestaña Cuenta)
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

  // Cerrar sesión deja la app 100% limpia en Cuenta
  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    anunciarCelularEnValidadorEspecifico(false);
    cambiarModoLectorNativo(false);
    localStorage.clear();
    localStorage.setItem("tne_app_schema", "v2_clean_auth");
    state.sesionActiva = false;
    state.uid = "";
    state.nombre = "";
    state.rut = "";
    state.correo = "";
    state.saldo = 0;
    state.historial = [];
    limpiarRecuadrosRegistro();
    actualizarUI();
    renderizarHistorial();
    mostrarPestana("cuenta", true);
    mostrarToast("Sesión cerrada. Registra una nueva cuenta o inicia sesión.", "ok");
  });

  document.getElementById("openLoginModalBtn")?.addEventListener("click", () => {
    document.getElementById("loginModalBackdrop")?.classList.add("open");
  });

  document.getElementById("goToRegisterFromLogin")?.addEventListener("click", () => {
    document.getElementById("loginModalBackdrop")?.classList.remove("open");
    limpiarRecuadrosRegistro();
    mostrarPestana("cuenta", true);
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
        state.saldo = null;
        guardarPerfilLocal();
        document.getElementById("loginModalBackdrop")?.classList.remove("open");
        limpiarRecuadrosRegistro();
        actualizarUI();
        await consultarSaldoEnNube();
        mostrarPestana("saldo", true);
      } else {
        mostrarToast(data?.mensaje || "Correo o contraseña incorrectos", "err");
      }
    } catch {
      mostrarToast("Error de conexión al iniciar sesión", "err");
    }
  });

  document.getElementById("registerForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const uidIngresado = sanitizarUid(document.getElementById("regUid")?.value || state.uid);
    if (!uidIngresado) {
      mostrarToast("⚠️ Primero presiona 'Vincular TNE' y acerca tu tarjeta detrás del celular.", "err");
      return;
    }

    state.uid = uidIngresado;
    state.nombre = document.getElementById("regNombre").value.trim().toUpperCase();
    state.rut = document.getElementById("regRut").value.trim();
    state.institucion = document.getElementById("regInstitucion").value.trim();
    state.correo = document.getElementById("regCorreo").value.trim();
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
          p_saldo_inicial: 0,
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
      state.saldo = null;
      guardarPerfilLocal();
      limpiarRecuadrosRegistro();
      actualizarUI();
      await consultarSaldoEnNube();
      mostrarToast(`✔ Cuenta creada y TNE ${state.uid} vinculada`, "ok");
      mostrarPestana("saldo", true);
    } catch {
      mostrarToast("Error al guardar cuenta en la nube", "err");
    }
  });
}

document.addEventListener("DOMContentLoaded", inicializarApp);

// Puente nativo llamado desde MainActivity.java al leer una TNE física o sticker NFC
window.onNativeNfcScanned = function(uidLeido) {
  const uidLimpio = sanitizarUid(uidLeido);
  if (!uidLimpio) return;

  reproducirFeedbackSensorial(true);

  const modalNfc = document.getElementById("nfcGuideModalBackdrop");
  if (modalNfc && modalNfc.classList.contains("open")) {
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

  // Si toca un sticker/tag NFC del validador estando en la pestaña Pagar
  pagarPasajeWeb("Pago NFC en Validador (-$200)");
};