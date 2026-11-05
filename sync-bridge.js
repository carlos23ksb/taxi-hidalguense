/* ============================================================================
   TAXI HIDALGUENSE V7 · Puente de sincronización con Supabase
   ----------------------------------------------------------------------------
   La app local (index.html) sigue siendo la base y funciona sin red. Este
   puente espeja los datos compartidos a Supabase y los trae en vivo a todos
   los celulares con Realtime:
     cuentas (registro/login, dueño permanente 7712913066 con is_owner),
     conductores reales registrados, viajes (precio fijo según tarifa,
     aceptar/rechazar), chat interno por viaje, reseñas y notificaciones
     (cada evento importante genera su fila y Realtime la empuja).
   Reglas:
     - NUNCA se guarda una contraseña en claro (Supabase: SHA-256 + sal;
       espejo local: sal + hash SHA-256 propio).
     - NUNCA se siembran conductores, viajes ni datos de muestra.
     - Sin red o si Supabase no responde, la app sigue en local
       (localStorage) y reintenta en el siguiente inicio de sesión.
     - La sesión NO vive en localStorage: solo en memoria de la página
       (el módulo Supabase y la app la guardan en variables).
     - Sin distancia no se inventa: un viaje sin km queda solo en local.
   Si este archivo o los módulos no cargan, la app sigue en modo local.
   ============================================================================ */
(function(){
"use strict";
/* HARNESS-START (funciones puras; el harness las extrae y prueba tal cual) */
const normTel = (t) => String(t || "").replace(/\D/g, "").replace(/^52(\d{10})$/, "$1");
const mapEstadoToRemote = (e) => ({ buscando: "solicitado", aceptado: "aceptado", en_curso: "aceptado", completado: "completado", cancelado: "cancelado" })[e] || "solicitado";
const mapEstadoToLocal = (e) => ({ solicitado: "buscando", aceptado: "aceptado", rechazado: "cancelado", completado: "completado", cancelado: "cancelado" })[e] || "buscando";
const tituloDeTipo = (tipo) => ({ viaje_nuevo: "Nueva solicitud de viaje", viaje_aceptado: "¡Tu viaje fue confirmado!", viaje_rechazado: "Viaje rechazado", viaje_completado: "Viaje completado", viaje_cancelado: "Viaje cancelado", mensaje: "Nuevo mensaje en tu viaje", resena: "Reseña recibida", castigo: "Acción del dueño", activacion: "Acción del dueño", desactivacion: "Acción del dueño", viaje_iniciado: "El viaje comenzó" })[tipo] || "Aviso";
/* HARNESS-END */

let SB = null, CFG = null;
let online = false;
let unsubs = [];
let tripChannels = new Map();
let pullEnCurso = false;
let timerLigero = null;
const accountCache = new Map();

const loadRemoteIds = () => { try { return JSON.parse(localStorage.getItem("th7_remote_ids")) || {}; } catch (e){ return {}; } };
const saveRemoteIds = (m) => { try { localStorage.setItem("th7_remote_ids", JSON.stringify(m)); } catch (e){} };
const remoteIdDeLocal = (localId) => loadRemoteIds()[localId] || null;
const localIdDeRemote = (uuid) => { const m = loadRemoteIds(); for (const k in m) if (m[k] === uuid) return Number(k); return null; };
const setRemoteId = (localId, uuid) => { const m = loadRemoteIds(); m[localId] = uuid; saveRemoteIds(m); };
const nextMirrorId = () => { let s = parseInt(localStorage.getItem("th7_mirror_seq") || "0", 10) || 0; s += 1; try { localStorage.setItem("th7_mirror_seq", String(s)); } catch (e){} return 9000000000000 + s; };

const yoTel = () => { try { const me = (typeof yo === "function") ? yo() : null; return me ? normTel(me.telefono) : null; } catch (e){ return null; } };
const userByTel = (tel) => { const d = normTel(tel); try { return users.find(u => normTel(u.telefono) === d) || null; } catch (e){ return null; } };
const vistaActiva = (id) => { try { const el = document.getElementById(id); return !!(el && el.classList.contains("active")); } catch (e){ return false; } };
const refrescarVistas = () => {
  try {
    if (vistaActiva("view-inicio") && typeof renderInicio === "function") renderInicio();
    if (vistaActiva("view-pedir") && typeof renderPedir === "function") renderPedir();
    if (vistaActiva("view-viajes") && typeof renderViajes === "function") renderViajes();
    if (vistaActiva("view-avisos") && typeof renderAvisos === "function") renderAvisos();
    if (typeof actualizarBadges === "function") actualizarBadges();
  } catch (e){}
};

/* ---------------- Espejos local <-> remoto ---------------- */
function espejoConductorRemoto(row){
  const tel = normTel(row.telefono);
  let u = userByTel(tel);
  if (!u){
    u = { id: "sb-" + tel, rol: "conductor", nombre: row.nombre, telefono: tel, activo: true };
    users.push(u);
  }
  u.nombre = row.nombre; u.rol = "conductor";
  u.foto = row.foto_url || u.foto || null;
  u.placa = row.placa; u.color = row.color; u.modelo = row.modelo; u.economico = row.numero_economico;
  u.vehiculoTipo = "sedan";
  u.activo = row.activo !== false;
  u.suspendedUntil = row.castigo_hasta ? Date.parse(row.castigo_hasta) : null;
  u.sbCalif = (row.calificacion != null ? Number(row.calificacion) : null);
  if (row.latitud != null) u.lat = row.latitud;
  if (row.longitud != null) u.lng = row.longitud;
  u._sb = true;
  return u;
}
async function espejoCuentaRemota(tel){
  let u = userByTel(tel);
  if (u) return u;
  let nombre = "Cliente", rol = "cliente";
  try {
    const cached = accountCache.get(normTel(tel));
    if (cached){ nombre = cached.nombre; rol = cached.rol; }
    else {
      const res = await SB.getClient().from("accounts").select("nombre, rol").eq("telefono", normTel(tel)).maybeSingle();
      if (res.data){ nombre = res.data.nombre; rol = res.data.rol; accountCache.set(normTel(tel), res.data); }
    }
  } catch (e){}
  /* El cliente Supabase usa 'dueño' (con ñ); la app usa 'dueno'. Se
     normaliza y se conserva 'conductor' para los espejos de conductores. */
  const rolN = (rol === "dueno" || rol === "dueño") ? "dueno" : (rol === "conductor" ? "conductor" : "cliente");
  u = { id: "sb-" + normTel(tel), rol: rolN, nombre, telefono: normTel(tel), activo: true };
  users.push(u);
  return u;
}
async function espejoViajeRemoto(row){
  const ya = localIdDeRemote(row.id);
  const cliente = await espejoCuentaRemota(row.cliente_telefono);
  let conductor = null;
  if (row.conductor_telefono) conductor = await espejoCuentaRemota(row.conductor_telefono);
  let t = (ya != null) ? trips.find(x => x.id === ya) : null;
  const estadoLocal = mapEstadoToLocal(row.estado);
  if (!t){
    t = { id: nextMirrorId(), clienteId: cliente.id, conductorId: conductor ? conductor.id : null, origen: row.origen, destino: row.destino, distanciaKm: row.distancia_km, foraneo: false, vehiculo: "sedan", pasajeros: 0, precioFinal: row.precio_fijo, estado: estadoLocal, notas: "", fecha: row.created_at ? Date.parse(row.created_at) : Date.now(), califConductor: null, califCliente: null, _rid: row.id };
    trips.unshift(t);
    setRemoteId(t.id, row.id);
  } else {
    t.clienteId = cliente.id;
    t.conductorId = conductor ? conductor.id : null;
    t.origen = row.origen; t.destino = row.destino; t.distanciaKm = row.distancia_km;
    t.precioFinal = row.precio_fijo;
    if (!(t.estado === "en_curso" && estadoLocal === "aceptado")) t.estado = estadoLocal;
    t._rid = row.id;
  }
  return t;
}

/* ---------------- Pull (bajada) ---------------- */
async function pullConductores(){
  try {
    let rows = null;
    try {
      const r = await SB.getClient().from("drivers").select("telefono, nombre, foto_url, placa, color, modelo, numero_economico, tipo_vehiculo, activo, castigo_hasta, calificacion, total_viajes, latitud, longitud, created_at").eq("activo", true).order("created_at", { ascending: true });
      if (r.error) throw r.error;
      rows = r.data || [];
    } catch (eLat){
      /* La migración 002 (latitud/longitud) aún no se ejecutó: sin columnas. */
      rows = await SB.listarConductoresDisponibles();
    }
    rows.forEach(espejoConductorRemoto);
    guardar(K.users, users);
    for (const row of rows){
      try {
        const res = await SB.listarResenasPorConductor(row.telefono);
        const u = userByTel(row.telefono);
        if (u) u.sbN = res.length;
        for (const rv of res){
          const key = "sb-r-" + rv.id;
          if (resenasRemotas.some(x => x._key === key)) continue;
          const cli = await espejoCuentaRemota(rv.cliente_telefono);
          resenasRemotas.push({ _key: key, stars: rv.estrellas, comentario: rv.texto || "", cliente: { nombre: cli.nombre }, clienteTelefono: rv.cliente_telefono, conductorTelefono: rv.conductor_telefono, fecha: rv.created_at ? Date.parse(rv.created_at) : Date.now() });
        }
      } catch (e){}
    }
    guardar(K.users, users);
  } catch (e){}
}
async function pullViajes(){
  const me = (typeof yo === "function") ? yo() : null;
  if (!me) return;
  const tel = normTel(me.telefono);
  try {
    const abiertas = await SB.listarSolicitudes();
    for (const row of abiertas) await espejoViajeRemoto(row);
    const miasC = await SB.listarViajesPorCliente(tel);
    for (const row of miasC) await espejoViajeRemoto(row);
    if (me.rol === "conductor" || me.rol === "dueno"){
      const miasD = await SB.listarViajesPorConductor(tel);
      for (const row of miasD) await espejoViajeRemoto(row);
    }
    const mios = trips.filter(t => (t.clienteId === me.id || t.conductorId === me.id) && t.estado === "completado" && t._rid);
    for (const t of mios){
      try {
        const res = await SB.getClient().from("reviews").select("*").eq("trip_id", t._rid);
        (res.data || []).forEach(rv => {
          if (rv.cliente_telefono === tel && !t.califConductor) t.califConductor = { stars: rv.estrellas, comentario: rv.texto || "" };
        });
      } catch (e){}
    }
    guardar(K.trips, trips); guardar(K.users, users);
  } catch (e){}
}
function mergeNotif(row, avisar){
  const rid = "sb-n-" + row.id;
  if (notifs.some(n => n.rid === rid)) return;
  const me = (typeof yo === "function") ? yo() : null;
  if (!me) return;
  const localTripId = row.trip_id ? localIdDeRemote(row.trip_id) : null;
  /* Si el aviso de solicitud nueva ya se creó en este celular al entrar
     (avisarSolicitudesAbiertas), la fila remota del mismo viaje no se
     duplica en Avisos. Solo aplica a viaje_nuevo: un viaje solo se publica
     una vez; los mensajes sí se repiten y no se tocan. */
  if (row.tipo === "viaje_nuevo" && localTripId != null && notifs.some(n => n.userId === me.id && n.tripId === localTripId && n.titulo === tituloDeTipo(row.tipo))) return;
  /* Aceptación duplicada: al aceptar, el conductor crea un aviso local
     detallado (precio + auto) y la capa Supabase crea la fila remota
     (texto corto). En Avisos queda un solo aviso por viaje: el de texto
     más largo. Si la fila entrante es más larga, reemplaza al existente;
     si no, se descarta. */
  if (row.tipo === "viaje_aceptado" && localTripId != null){
    const idx = notifs.findIndex(n => n.userId === me.id && n.tripId === localTripId && n.titulo === tituloDeTipo(row.tipo));
    if (idx !== -1){
      if ((notifs[idx].texto || "").length >= (row.texto || "").length) return;
      notifs.splice(idx, 1);
    }
  }
  const n = { id: "n" + Date.now() + Math.floor(Math.random() * 999), rid, userId: me.id, titulo: tituloDeTipo(row.tipo), texto: row.texto, tripId: localTripId, ts: row.created_at ? Date.parse(row.created_at) : Date.now(), leida: !!row.leida };
  notifs.unshift(n);
  guardar(K.notifs, notifs);
  if (typeof actualizarBadges === "function") actualizarBadges();
  if (avisar && typeof notificarNavegador === "function") notificarNavegador(n.titulo, n.texto);
}
async function pullNotifs(){
  const me = (typeof yo === "function") ? yo() : null;
  if (!me) return;
  try {
    const rows = await SB.listarNotificaciones(normTel(me.telefono));
    rows.forEach(row => mergeNotif(row, false));
    guardar(K.notifs, notifs);
  } catch (e){}
}
function mergeMsg(localTripId, row){
  const rid = "sb-m-" + row.id;
  if (!msgs[localTripId]) msgs[localTripId] = [];
  if (msgs[localTripId].some(m => m.rid === rid)) return;
  const remitente = userByTel(row.remitente_telefono);
  msgs[localTripId].push({ de: remitente ? remitente.id : ("sb-" + normTel(row.remitente_telefono)), texto: row.texto, ts: row.created_at ? Date.parse(row.created_at) : Date.now(), rid });
  guardar(K.msgs, msgs);
}
async function pullMensajesActivos(){
  const me = (typeof yo === "function") ? yo() : null;
  if (!me) return;
  const activos = trips.filter(t => (t.clienteId === me.id || t.conductorId === me.id) && ["aceptado", "en_curso"].includes(t.estado) && t._rid);
  for (const t of activos){
    try {
      const rows = await SB.listarMensajes(t._rid);
      rows.forEach(row => mergeMsg(t.id, row));
    } catch (e){}
  }
  guardar(K.msgs, msgs);
}
async function pullAll(){
  if (pullEnCurso) return;
  pullEnCurso = true;
  try { await pullConductores(); await pullViajes(); await pullNotifs(); await pullMensajesActivos(); }
  finally { pullEnCurso = false; }
}
async function pullLigero(){
  if (!online) return;
  const me = (typeof yo === "function") ? yo() : null;
  if (!me) return;
  try { await pullConductores(); await pullViajes(); await pullNotifs(); } catch (e){}
  /* Por si el aviso en vivo (Realtime) se perdió: las solicitudes que
     siguen abiertas se avisan al entrar/actualizar, sin duplicar. */
  try { if (typeof avisarSolicitudesAbiertas === "function") avisarSolicitudesAbiertas(); } catch (e){}
  refrescarVistas(); suscribirViajesActivos();
}

/* ---------------- Realtime (subida en vivo) ---------------- */
function limpiarSubs(){
  unsubs.forEach(fn => { try { fn(); } catch (e){} });
  unsubs = [];
  tripChannels.forEach(fn => { try { fn(); } catch (e){} });
  tripChannels.clear();
}
function suscribirViajesActivos(){
  const me = (typeof yo === "function") ? yo() : null;
  if (!me) return;
  trips.filter(t => (t.clienteId === me.id || t.conductorId === me.id) && ["buscando", "aceptado", "en_curso"].includes(t.estado) && t._rid).forEach(t => {
    if (tripChannels.has(t.id)) return;
    try {
      const off1 = SB.onViajeChange(t._rid, async (payload) => {
        const row = payload.new;
        if (!row) return;
        const lt = trips.find(x => x.id === t.id);
        if (!lt) return;
        const nuevo = mapEstadoToLocal(row.estado);
        if (!(lt.estado === "en_curso" && nuevo === "aceptado")) lt.estado = nuevo;
        lt.precioFinal = row.precio_fijo;
        if (row.conductor_telefono){
          const c = await espejoCuentaRemota(row.conductor_telefono);
          lt.conductorId = c.id;
        }
        guardar(K.trips, trips);
        refrescarVistas();
      });
      const off2 = SB.onMensajes(t._rid, (payload) => {
        mergeMsg(t.id, payload.new);
        try { if (typeof chatTripId !== "undefined" && chatTripId === t.id && typeof renderChat === "function") renderChat(); } catch (e){}
      });
      tripChannels.set(t.id, () => { try { off1(); } catch (e){} try { off2(); } catch (e){} });
    } catch (e){}
  });
}
function suscribirTodo(){
  limpiarSubs();
  const me = (typeof yo === "function") ? yo() : null;
  if (!me || !online) return;
  const tel = normTel(me.telefono);
  try { unsubs.push(SB.onConductoresChange(() => { pullConductores().then(refrescarVistas); })); } catch (e){}
  try {
    if (me.rol === "conductor" || me.rol === "dueno"){
      unsubs.push(SB.onSolicitudesNuevas(async (payload) => {
        try {
          const res = await SB.getClient().from("trips").select("*").eq("id", payload.new.id).maybeSingle();
          if (res.data){ await espejoViajeRemoto(res.data); guardar(K.trips, trips); refrescarVistas(); try { if (typeof avisarSolicitudesAbiertas === "function") avisarSolicitudesAbiertas(); } catch (e2){} }
        } catch (e){}
      }));
    }
  } catch (e){}
  try { unsubs.push(SB.onNotificaciones(tel, (payload) => { mergeNotif(payload.new, true); refrescarVistas(); })); } catch (e){}
  suscribirViajesActivos();
}

/* ---------------- API pública del puente ---------------- */
function urlBase64ToUint8Array(base64String){
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
const Sync = {
  get online(){ return online; },
  ready: null,
  async probe(){
    try { await SB.listarConductoresDisponibles(); online = true; }
    catch (e){ online = false; }
    return online;
  },
  async ownerExists(){
    const res = await SB.getClient().from("accounts").select("telefono").eq("telefono", SB.OWNER_PHONE).maybeSingle();
    if (res.error) throw res.error;
    return !!res.data;
  },
  async ownerCreate(password){ const ses = await SB.accederDueno({ password }); online = true; return ses; },
  async ownerLogin(password){
    try { const ses = await SB.loginOwner(password); online = true; return ses; }
    catch (e){
      if (/No existe una cuenta/.test(e.message || "")) throw Object.assign(new Error("Aún no existe la cuenta del dueño."), { code: "SIN_CUENTA" });
      throw e;
    }
  },
  async login(telefono, password){ const ses = await SB.login({ telefono, password }); online = true; return ses; },
  async registerClient(d){ const acc = await SB.registerClient(d); online = true; return { telefono: acc.telefono, nombre: acc.nombre, rol: acc.rol, driver: null }; },
  async registerDriver(d){
    const drv = await SB.registerDriver(d);
    online = true;
    try { await SB.getClient().from("drivers").update({ latitud: d.lat, longitud: d.lng }).eq("telefono", drv.telefono); } catch (e){}
    return { telefono: drv.telefono, nombre: drv.nombre, rol: "conductor", driver: Object.assign({}, drv, { latitud: d.lat, longitud: d.lng }) };
  },
  async driverProfile(telefono){
    const res = await SB.getClient().from("drivers").select("*").eq("telefono", normTel(telefono)).maybeSingle();
    return res.data;
  },
  async afterLogin(user){
    if (!online) return;
    await pullAll();
    suscribirTodo();
    refrescarVistas();
    this.setupPush();
    if (timerLigero) clearInterval(timerLigero);
    timerLigero = setInterval(pullLigero, 60000);
  },
  afterLogout(){
    limpiarSubs();
    if (timerLigero){ clearInterval(timerLigero); timerLigero = null; }
    try { SB.clearSession(); } catch (e){}
  },
  tripCreated(t, opts){
    if (!online || t._rid || t._localOnly) return;
    if (!((t.distanciaKm || 0) > 0)){
      /* Sin distancia no hay base para el precio fijo remoto: el viaje
         queda solo en este celular (no se inventa distancia). */
      t._localOnly = true;
      return;
    }
    const me = (typeof yo === "function") ? yo() : null;
    if (!me) return;
    /* La fecha solo sirve para que el precio remoto coincida con el
       precio fijo que la app ya mostró (modo día/noche de la calculadora);
       la fecha real del viaje la pone el servidor al crearlo. */
    const ahora = new Date();
    const fecha = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), (opts && opts.noche) ? 23 : 12, 0, 0);
    SB.crearViaje({ clienteTelefono: normTel(me.telefono), origen: t.origen, destino: t.destino, distanciaKm: t.distanciaKm, fecha })
      .then(row => { t._rid = row.id; setRemoteId(t.id, row.id); guardar(K.trips, trips); suscribirViajesActivos(); })
      .catch(() => {});
  },
  tripAccepted(t){
    if (!online || !t._rid) return;
    const me = (typeof yo === "function") ? yo() : null;
    if (!me) return;
    SB.aceptarViaje(t._rid, normTel(me.telefono)).catch(() => {});
  },
  tripCancelled(t){
    if (!online || !t._rid) return;
    const me = (typeof yo === "function") ? yo() : null;
    if (!me) return;
    SB.cancelarViaje(t._rid, normTel(me.telefono)).catch(() => {});
  },
  notificarRemoto({ telefono, tipo, texto, tripId }){
    /* Espejo best-effort de un aviso a la tabla notifications (lo usa el
       servicio de avisos con la app cerrada). Solo lo llaman los eventos
       que la capa Supabase no cubre ya; si falla, el aviso local sigue
       funcionando y nunca se rompe la página. */
    if (!online) return;
    try { SB.crearNotificacion({ destinatarioTelefono: normTel(telefono), tipo, texto, tripId: tripId || null }).catch(() => {}); }
    catch (e){}
  },
  tripStarted(t){
    if (!online || !t._rid) return;
    const me = (typeof yo === "function") ? yo() : null;
    if (!me) return;
    const otro = (me.rol === "cliente") ? userById(t.conductorId) : userById(t.clienteId);
    if (!otro) return;
    SB.crearNotificacion({ destinatarioTelefono: normTel(otro.telefono), tipo: "viaje_iniciado", texto: "El viaje de " + t.origen + " a " + t.destino + " ya está en curso.", tripId: t._rid }).catch(() => {});
  },
  tripCompleted(t){
    if (!online || !t._rid) return;
    SB.completarViaje(t._rid).catch(() => {});
  },
  messageSent(t, texto){
    if (!online || !t._rid) return;
    const me = (typeof yo === "function") ? yo() : null;
    if (!me) return;
    SB.enviarMensaje({ tripId: t._rid, remitenteTelefono: normTel(me.telefono), remitenteRol: me.rol, texto }).catch(() => {});
  },
  reviewSent(t, stars, comment){
    if (!online || !t._rid) return;
    const me = (typeof yo === "function") ? yo() : null;
    if (!me || !t.conductorId) return;
    const cond = userById(t.conductorId);
    if (!cond) return;
    SB.crearResena({ tripId: t._rid, clienteTelefono: normTel(me.telefono), conductorTelefono: normTel(cond.telefono), estrellas: stars, texto: comment || "" }).catch(() => {});
  },
  driverSetActive(u, active){
    if (!online) return;
    SB.getClient().from("drivers").update({ activo: !!active }).eq("telefono", normTel(u.telefono)).then(() => {}).catch(() => {});
  },
  driverSuspend(u, hastaISO){
    if (!online) return;
    SB.suspenderConductor(normTel(u.telefono), hastaISO).catch(() => {
      SB.getClient().from("drivers").update({ castigo_hasta: hastaISO }).eq("telefono", normTel(u.telefono)).catch(() => {});
    });
  },
  driverUnsuspend(u){
    if (!online) return;
    SB.activarConductor(normTel(u.telefono)).catch(() => {
      SB.getClient().from("drivers").update({ activo: true, castigo_hasta: null }).eq("telefono", normTel(u.telefono)).catch(() => {});
    });
  },
  profileUpdated(me){
    if (!online || !me) return;
    const tel = normTel(me.telefono);
    SB.getClient().from("accounts").update({ nombre: me.nombre }).eq("telefono", tel).catch(() => {});
    if (me.rol === "conductor"){
      SB.getClient().from("drivers").update({ nombre: me.nombre, placa: me.placa, color: me.color, modelo: me.modelo, numero_economico: me.economico, foto_url: me.foto || null }).eq("telefono", tel).catch(() => {});
    }
  },
  async setupPush(){
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      if (!CFG || !CFG.VAPID_PUBLIC_KEY) return;
      const reg = await navigator.serviceWorker.ready;
      const exist = await reg.pushManager.getSubscription();
      const sub = exist || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(CFG.VAPID_PUBLIC_KEY) });
      const tel = yoTel();
      if (!tel) return;
      const toB64 = (buf) => { let s = ""; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
      const p256dh = sub.getKey ? sub.getKey("p256dh") : null;
      const auth = sub.getKey ? sub.getKey("auth") : null;
      await SB.getClient().from("push_subscriptions").upsert({ telefono: tel, endpoint: sub.endpoint, p256dh: p256dh ? toB64(p256dh) : null, auth: auth ? toB64(auth) : null }, { onConflict: "telefono" });
    } catch (e){}
  },
  _internals: { mapEstadoToRemote, mapEstadoToLocal, tituloDeTipo, normTel }
};

/* ---------------- Arranque del puente ---------------- */
(async () => {
  try {
    const [mod, cfg] = await Promise.all([import("./supabase-client.js"), import("./config.js")]);
    SB = mod; CFG = cfg;
    window.TaxiSync = Sync;
    Sync.ready = (async () => {
      await Sync.probe();
      if (Sync.online && typeof marcarDuenoRemotoExiste === "function"){
        try { if (await Sync.ownerExists()) marcarDuenoRemotoExiste(); } catch (e){}
      }
    })();
  } catch (e){
    /* Sin red o sin acceso a los módulos: la app sigue en modo local. */
    try { window.TaxiSync = undefined; } catch (e2){}
  }
})();
})();
