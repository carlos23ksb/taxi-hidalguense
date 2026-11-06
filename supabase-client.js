// ============================================================================
// Taxi Hidalguense — Cliente Supabase
// ============================================================================
// Módulo ESM para la app (web o WebView). Usa @supabase/supabase-js vía CDN
// y la configuración de ./config.js (URL + anon key, sin secretos quemados).
//
// Reglas de este módulo:
//  - Precios FIJOS según tarifa. El precio no se discute: el
//    conductor solo ACEPTA o RECHAZA el viaje.
//  - Solo conductores REALES registrados. No hay conductores sembrados,
//    simulados ni de muestra.
//  - La contraseña NUNCA se guarda en claro: SHA-256 + sal, verificada
//    contra la tabla accounts (única fuente de verdad de acceso).
//  - El dueño (7712913066) es permanente: el registro con ese número crea
//    la cuenta con is_owner=true y rol dueño; si ya existe, el flujo es
//    inicio de sesión; ningún otro número puede ser dueño.
//  - Ese mismo número también puede ser conductor: la cuenta en
//    `accounts` sigue siendo una sola (dueño), y el perfil de conductor
//    vive en `drivers` con ese mismo teléfono.
//  - La sesión en línea se restaura desde el usuario ya registrado en
//    este celular (sin guardar contraseñas): al cerrar y volver a entrar
//    sigue iniciada, y solo "Cerrar sesión" la borra. Los datos
//    compartidos (viajes, chats, notificaciones) viven en Supabase y
//    llegan en vivo por Realtime.
//  - Cada evento importante genera una fila en `notifications` y Realtime
//    la empuja al centro de notificaciones del destinatario.
// ============================================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// ---------------------------------------------------------------------------
// Constantes del negocio
// ---------------------------------------------------------------------------

/** Teléfono del dueño permanente (10 dígitos, sin código de país). */
export const OWNER_PHONE = '7712913066';

/** Tarifa fija. Día 04:00–21:59; noche 22:00–03:59. Km extra redondeado arriba. */
export const TARIFA = Object.freeze({
  DIA: Object.freeze({ base: 80, porKmExtra: 7, horaInicio: 4, horaFin: 22 }),
  NOCHE: Object.freeze({ base: 100, porKmExtra: 10 }),
});
export const KM_INCLUIDOS = 4;

/** Estados válidos de un viaje. */
export const ESTADOS_VIAJE = Object.freeze([
  'solicitado',
  'aceptado',
  'rechazado',
  'completado',
  'cancelado',
]);

// ---------------------------------------------------------------------------
// Cliente Supabase (singleton perezoso)
// ---------------------------------------------------------------------------

let _client = null;

export function getClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      'Falta la configuración de Supabase: rellena SUPABASE_URL y ' +
        'SUPABASE_ANON_KEY en config.js (Dashboard → Project Settings → API).',
    );
  }
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

// ---------------------------------------------------------------------------
// Sesión en memoria, restaurable desde el usuario local ya registrado
// (sin guardar contraseñas: solo se restaura telefono/nombre/rol).
// ---------------------------------------------------------------------------

let _session = null; // { telefono, nombre, rol, is_owner }

export function getSession() {
  return _session;
}

/** Restaura la sesión en línea del usuario ya registrado en este celular
 *  (después de un inicio de sesión previo en este mismo dispositivo).
 *  No recibe ni guarda contraseñas. */
export function restoreSession({ telefono, nombre, rol, is_owner }) {
  const tel = normalizePhone(telefono);
  if (!tel) throw new Error('No hay sesión guardada.');
  _session = { telefono: tel, nombre: nombre || '', rol: rol || 'cliente', is_owner: !!is_owner };
  return _session;
}

export function clearSession() {
  _session = null;
}

function requireSession() {
  if (!_session) throw new Error('No hay sesión iniciada.');
  return _session;
}

function requireOwner() {
  const s = requireSession();
  if (!s.is_owner || s.telefono !== OWNER_PHONE) {
    throw new Error('Solo el dueño puede hacer esto.');
  }
  return s;
}

// ---------------------------------------------------------------------------
// Utilidades: teléfono y contraseña (SHA-256 + sal)
// ---------------------------------------------------------------------------

/** Normaliza un teléfono a 10 dígitos (quita espacios, guiones y +52). */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('52')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateSalt(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return toHex(arr.buffer);
}

/** SHA-256 de (sal + contraseña). Nunca se guarda ni se compara en claro. */
export async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

async function verifyPassword(password, salt, expectedHash) {
  return (await hashPassword(password, salt)) === expectedHash;
}

// ---------------------------------------------------------------------------
// Tarifa fija
// ---------------------------------------------------------------------------

/** true si la fecha/hora cae en horario nocturno (22:00–03:59). */
export function esHorarioNoche(fecha = new Date()) {
  const h = fecha.getHours();
  return h >= 22 || h < TARIFA.DIA.horaInicio;
}

/**
 * Precio fijo del viaje. Km extra = ceil(distancia) - 4 (mínimo 0).
 * Ej.: 3 km día $80 · 6 km día $94 · 10 km día $122 · 10 km noche $160.
 */
export function calcularPrecioFijo(distanciaKm, fecha = new Date()) {
  const km = Number(distanciaKm);
  if (!Number.isFinite(km) || km <= 0) {
    throw new Error('La distancia debe ser mayor que 0.');
  }
  const tarifa = esHorarioNoche(fecha) ? TARIFA.NOCHE : TARIFA.DIA;
  const extra = Math.max(0, Math.ceil(km) - KM_INCLUIDOS);
  return tarifa.base + extra * tarifa.porKmExtra;
}

// ---------------------------------------------------------------------------
// Cuentas: registro e inicio de sesión
// ---------------------------------------------------------------------------

function validarPassword(password) {
  if (typeof password !== 'string' || password.length < 6) {
    throw new Error('La contraseña debe tener al menos 6 caracteres.');
  }
}

async function fetchAccount(telefono) {
  const { data, error } = await getClient()
    .from('accounts')
    .select('telefono, nombre, rol, is_owner, password_hash, password_salt')
    .eq('telefono', telefono)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Crea una cuenta. Si el teléfono es el del dueño, la cuenta nace con
 * is_owner=true y rol 'dueño' (la base también lo impone con restricciones
 * y trigger). Si la cuenta ya existe, lanza error: el flujo es login.
 */
export async function registerAccount({ telefono, nombre, rol, password }) {
  const tel = normalizePhone(telefono);
  if (tel.length !== 10) throw new Error('El teléfono debe tener 10 dígitos.');
  if (!nombre) throw new Error('El nombre es obligatorio.');
  if (!['cliente', 'conductor', 'dueño'].includes(rol)) {
    throw new Error('Rol inválido.');
  }
  validarPassword(password);

  const existing = await fetchAccount(tel);
  if (existing) {
    throw new Error(
      'Ese número ya tiene cuenta. Inicia sesión con tu contraseña.',
    );
  }

  const isOwner = tel === OWNER_PHONE;
  const finalRol = isOwner ? 'dueño' : rol;
  const salt = generateSalt();
  const { data, error } = await getClient()
    .from('accounts')
    .insert({
      telefono: tel,
      nombre,
      rol: finalRol,
      is_owner: isOwner,
      password_hash: await hashPassword(password, salt),
      password_salt: salt,
    })
    .select('telefono, nombre, rol, is_owner')
    .single();
  if (error) throw error;
  return data;
}

/** Registro de cliente (rol cliente). */
export async function registerClient({ telefono, nombre, password }) {
  return registerAccount({ telefono, nombre, rol: 'cliente', password });
}

/**
 * Registro de conductor REAL. La foto de perfil es obligatoria, así como
 * placa, color, modelo y número económico. Solo sedanes.
 */
export async function registerDriver({
  telefono,
  nombre,
  password,
  fotoUrl,
  placa,
  color,
  modelo,
  numeroEconomico,
}) {
  if (!fotoUrl) throw new Error('La foto de perfil es obligatoria.');
  if (!placa || !color || !modelo || !numeroEconomico) {
    throw new Error('Placa, color, modelo y número económico son obligatorios.');
  }
  const telNorm = normalizePhone(telefono);
  /* El número del dueño puede ser dueño Y conductor con el mismo
     número. Si su cuenta de dueño ya existe, la contraseña debe ser
     la de dueño (para que nadie más registre ese número como
     conductor); si aún no existe, se crea como dueño y como
     conductor en el mismo registro. */
  if (telNorm === OWNER_PHONE) {
    const existing = await fetchAccount(telNorm);
    if (existing) {
      const ok = await verifyPassword(
        password,
        existing.password_salt,
        existing.password_hash,
      );
      if (!ok) {
        throw new Error(
          'Ese número ya es del dueño. Para registrarte también como conductor, usa tu contraseña de dueño.',
        );
      }
    } else {
      await registerAccount({
        telefono: telNorm,
        nombre,
        rol: 'dueño',
        password,
      });
    }
    const salt = generateSalt();
    const { data, error } = await getClient()
      .from('drivers')
      .upsert(
        {
          telefono: telNorm,
          nombre,
          foto_url: fotoUrl,
          placa,
          color,
          modelo,
          numero_economico: numeroEconomico,
          tipo_vehiculo: 'sedán',
          password_hash: await hashPassword(password, salt),
          password_salt: salt,
          activo: true,
        },
        { onConflict: 'telefono' },
      )
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const account = await registerAccount({
    telefono,
    nombre,
    rol: 'conductor',
    password,
  });
  const tel = account.telefono;
  const salt = generateSalt();
  const { data, error } = await getClient()
    .from('drivers')
    .insert({
      telefono: tel,
      nombre,
      foto_url: fotoUrl,
      placa,
      color,
      modelo,
      numero_economico: numeroEconomico,
      tipo_vehiculo: 'sedán',
      password_hash: await hashPassword(password, salt),
      password_salt: salt,
      activo: true,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Inicio de sesión con número + contraseña. Devuelve la sesión en memoria. */
export async function login({ telefono, password }) {
  const tel = normalizePhone(telefono);
  const account = await fetchAccount(tel);
  if (!account) throw new Error('No existe una cuenta con ese número.');
  const ok = await verifyPassword(
    password,
    account.password_salt,
    account.password_hash,
  );
  if (!ok) throw new Error('La contraseña es incorrecta.');
  _session = {
    telefono: account.telefono,
    nombre: account.nombre,
    rol: account.rol,
    is_owner: account.is_owner,
  };
  return _session;
}

// ---------------------------------------------------------------------------
// Dueño permanente
// ---------------------------------------------------------------------------

/**
 * Acceso del dueño (7712913066): si la cuenta NO existe, la crea con la
 * contraseña que él mismo elige (is_owner=true, rol dueño); si YA existe,
 * inicia sesión con número + contraseña. Nunca crea una segunda cuenta
 * ni pierde el rol: la base lo garantiza con restricciones y trigger.
 */
export async function accederDueno({ nombre = 'Dueño', password }) {
  validarPassword(password);
  const existing = await fetchAccount(OWNER_PHONE);
  if (existing) {
    return login({ telefono: OWNER_PHONE, password });
  }
  await registerAccount({
    telefono: OWNER_PHONE,
    nombre,
    rol: 'dueño',
    password,
  });
  return login({ telefono: OWNER_PHONE, password });
}

/** Inicio de sesión del dueño cuando su cuenta ya existe. */
export async function loginOwner(password) {
  return login({ telefono: OWNER_PHONE, password });
}

// ---------------------------------------------------------------------------
// Notificaciones (cada evento genera una fila; Realtime la empuja en vivo)
// ---------------------------------------------------------------------------

export async function crearNotificacion({
  destinatarioTelefono,
  tipo,
  texto,
  tripId = null,
}) {
  const { data, error } = await getClient()
    .from('notifications')
    .insert({
      destinatario_telefono: normalizePhone(destinatarioTelefono),
      tipo,
      texto,
      trip_id: tripId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listarNotificaciones(telefono, { soloNoLeidas = false } = {}) {
  let q = getClient()
    .from('notifications')
    .select('*')
    .eq('destinatario_telefono', normalizePhone(telefono))
    .order('created_at', { ascending: false })
    .limit(50);
  if (soloNoLeidas) q = q.eq('leida', false);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function contarNoLeidas(telefono) {
  const { count, error } = await getClient()
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('destinatario_telefono', normalizePhone(telefono))
    .eq('leida', false);
  if (error) throw error;
  return count ?? 0;
}

export async function marcarNotificacionLeida(id) {
  const { error } = await getClient()
    .from('notifications')
    .update({ leida: true })
    .eq('id', id);
  if (error) throw error;
}

export async function marcarTodasLeidas(telefono) {
  const { error } = await getClient()
    .from('notifications')
    .update({ leida: true })
    .eq('destinatario_telefono', normalizePhone(telefono))
    .eq('leida', false);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Conductores (solo reales; castigo y activación solo los hace el dueño)
// ---------------------------------------------------------------------------

/** Conductores disponibles: activos y sin castigo vigente. */
export async function listarConductoresDisponibles() {
  const { data, error } = await getClient()
    .from('drivers')
    .select(
      'telefono, nombre, foto_url, placa, color, modelo, numero_economico, tipo_vehiculo, calificacion, total_viajes, created_at',
    )
    .eq('activo', true)
    .or(`castigo_hasta.is.null,castigo_hasta.lt.${new Date().toISOString()}`)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

/** Todos los conductores (panel del dueño). */
export async function listarConductores() {
  requireOwner();
  const { data, error } = await getClient()
    .from('drivers')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function suspenderConductor(telefono, hastaISO) {
  requireOwner();
  const tel = normalizePhone(telefono);
  const { error } = await getClient()
    .from('drivers')
    .update({ castigo_hasta: hastaISO })
    .eq('telefono', tel);
  if (error) throw error;
  await crearNotificacion({
    destinatarioTelefono: tel,
    tipo: 'castigo',
    texto: `Tu cuenta está suspendida hasta ${hastaISO}.`,
  });
}

export async function activarConductor(telefono) {
  requireOwner();
  const tel = normalizePhone(telefono);
  const { error } = await getClient()
    .from('drivers')
    .update({ activo: true, castigo_hasta: null })
    .eq('telefono', tel);
  if (error) throw error;
  await crearNotificacion({
    destinatarioTelefono: tel,
    tipo: 'activacion',
    texto: 'Tu cuenta de conductor está activa de nuevo.',
  });
}

export async function desactivarConductor(telefono) {
  requireOwner();
  const tel = normalizePhone(telefono);
  const { error } = await getClient()
    .from('drivers')
    .update({ activo: false })
    .eq('telefono', tel);
  if (error) throw error;
  await crearNotificacion({
    destinatarioTelefono: tel,
    tipo: 'desactivacion',
    texto: 'Tu cuenta de conductor fue desactivada por el dueño.',
  });
}

// ---------------------------------------------------------------------------
// Viajes (precio fijo; aceptar/rechazar)
// ---------------------------------------------------------------------------

/**
 * Crea un viaje solicitado con precio fijo calculado por la tarifa.
 * Notifica a los conductores disponibles y al dueño.
 */
export async function crearViaje({
  clienteTelefono,
  origen,
  destino,
  distanciaKm,
  origenLat = null,
  origenLng = null,
  destinoLat = null,
  destinoLng = null,
  fecha = new Date(),
}) {
  if (!origen || !destino) throw new Error('Origen y destino son obligatorios.');
  const precioFijo = calcularPrecioFijo(distanciaKm, fecha);
  const { data, error } = await getClient()
    .from('trips')
    .insert({
      cliente_telefono: normalizePhone(clienteTelefono),
      origen,
      destino,
      origen_lat: origenLat,
      origen_lng: origenLng,
      destino_lat: destinoLat,
      destino_lng: destinoLng,
      distancia_km: distanciaKm,
      precio_fijo: precioFijo,
      estado: 'solicitado',
    })
    .select()
    .single();
  if (error) throw error;

  /* Los avisos son best-effort: si la lista de conductores o un aviso
     falla, el viaje ya creado no se pierde (antes, un fallo aquí dejaba
     el viaje sin _rid en el cliente y ningún conductor avisado). El
     conductor ve el viaje en Solicitudes y se le avisa al entrar si
     sigue abierto. */
  let conductores = [];
  try { conductores = await listarConductoresDisponibles(); } catch (e) {}
  const avisados = new Set();
  for (const c of conductores) {
    avisados.add(c.telefono);
    try {
      await crearNotificacion({
        destinatarioTelefono: c.telefono,
        tipo: 'viaje_nuevo',
        texto: `Viaje nuevo: ${origen} → ${destino}, $${precioFijo}.`,
        tripId: data.id,
      });
    } catch (e) {}
  }
  if (!avisados.has(OWNER_PHONE)) {
    try {
      await crearNotificacion({
        destinatarioTelefono: OWNER_PHONE,
        tipo: 'viaje_nuevo',
        texto: `Viaje nuevo: ${origen} → ${destino}, $${precioFijo}.`,
        tripId: data.id,
      });
    } catch (e) {}
  }
  return data;
}

/** El conductor ACEPTA el viaje (solo desde 'solicitado'). */
export async function aceptarViaje(tripId, conductorTelefono) {
  const tel = normalizePhone(conductorTelefono);
  const { data, error } = await getClient()
    .from('trips')
    .update({ estado: 'aceptado', conductor_telefono: tel })
    .eq('id', tripId)
    .eq('estado', 'solicitado')
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('El viaje ya no está disponible.');
  await crearNotificacion({
    destinatarioTelefono: data.cliente_telefono,
    tipo: 'viaje_aceptado',
    texto: `Tu viaje fue aceptado. Precio fijo: $${data.precio_fijo}.`,
    tripId: data.id,
  });
  return data;
}

/** El conductor RECHAZA el viaje (solo desde 'solicitado'). */
export async function rechazarViaje(tripId, conductorTelefono) {
  const tel = normalizePhone(conductorTelefono);
  const { data, error } = await getClient()
    .from('trips')
    .update({ estado: 'rechazado' })
    .eq('id', tripId)
    .eq('estado', 'solicitado')
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('El viaje ya no está disponible.');
  await crearNotificacion({
    destinatarioTelefono: data.cliente_telefono,
    tipo: 'viaje_rechazado',
    texto: 'Un conductor rechazó tu viaje. Puedes pedir otro.',
    tripId: data.id,
  });
  return data;
}

/** Marca el viaje como completado (solo desde 'aceptado'). */
export async function completarViaje(tripId) {
  const { data, error } = await getClient()
    .from('trips')
    .update({ estado: 'completado' })
    .eq('id', tripId)
    .eq('estado', 'aceptado')
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('El viaje no está en curso.');
  await crearNotificacion({
    destinatarioTelefono: data.cliente_telefono,
    tipo: 'viaje_completado',
    texto: 'Tu viaje terminó. ¡Califica a tu conductor!',
    tripId: data.id,
  });
  if (data.conductor_telefono) {
    await getClient().rpc('increment_driver_trips', {
      p_telefono: data.conductor_telefono,
    });
  }
  return data;
}

/** Cancela un viaje solicitado o aceptado. */
export async function cancelarViaje(tripId, telefonoQuienCancela) {
  const { data, error } = await getClient()
    .from('trips')
    .update({ estado: 'cancelado' })
    .eq('id', tripId)
    .in('estado', ['solicitado', 'aceptado'])
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('El viaje ya no se puede cancelar.');
  const otro =
    normalizePhone(telefonoQuienCancela) === data.cliente_telefono
      ? data.conductor_telefono
      : data.cliente_telefono;
  if (otro) {
    await crearNotificacion({
      destinatarioTelefono: otro,
      tipo: 'viaje_cancelado',
      texto: 'Un viaje fue cancelado.',
      tripId: data.id,
    });
  }
  return data;
}

export async function listarSolicitudes() {
  const { data, error } = await getClient()
    .from('trips')
    .select('*')
    .eq('estado', 'solicitado')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function listarViajesPorCliente(clienteTelefono) {
  const { data, error } = await getClient()
    .from('trips')
    .select('*')
    .eq('cliente_telefono', normalizePhone(clienteTelefono))
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function listarViajesPorConductor(conductorTelefono) {
  const { data, error } = await getClient()
    .from('trips')
    .select('*')
    .eq('conductor_telefono', normalizePhone(conductorTelefono))
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Chat interno por viaje
// ---------------------------------------------------------------------------

export async function enviarMensaje({
  tripId,
  remitenteTelefono,
  remitenteRol,
  texto,
}) {
  const clean = String(texto || '').trim();
  if (!clean) throw new Error('El mensaje no puede estar vacío.');
  const { data, error } = await getClient()
    .from('messages')
    .insert({
      trip_id: tripId,
      remitente_telefono: normalizePhone(remitenteTelefono),
      remitente_rol: remitenteRol,
      texto: clean,
    })
    .select()
    .single();
  if (error) throw error;

  // Avisa a la otra parte del viaje.
  const { data: trip } = await getClient()
    .from('trips')
    .select('cliente_telefono, conductor_telefono')
    .eq('id', tripId)
    .maybeSingle();
  if (trip) {
    const otro =
      normalizePhone(remitenteTelefono) === trip.cliente_telefono
        ? trip.conductor_telefono
        : trip.cliente_telefono;
    if (otro) {
      await crearNotificacion({
        destinatarioTelefono: otro,
        tipo: 'mensaje',
        texto: `Mensaje nuevo en tu viaje: ${clean.slice(0, 80)}`,
        tripId,
      });
    }
  }
  return data;
}

export async function listarMensajes(tripId) {
  const { data, error } = await getClient()
    .from('messages')
    .select('*')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Reseñas (una por viaje y cliente; actualiza la calificación del conductor)
// ---------------------------------------------------------------------------

export async function crearResena({
  tripId,
  clienteTelefono,
  conductorTelefono,
  estrellas,
  texto = '',
}) {
  if (!Number.isInteger(estrellas) || estrellas < 1 || estrellas > 5) {
    throw new Error('Las estrellas van de 1 a 5.');
  }
  const { data, error } = await getClient()
    .from('reviews')
    .insert({
      trip_id: tripId,
      cliente_telefono: normalizePhone(clienteTelefono),
      conductor_telefono: normalizePhone(conductorTelefono),
      estrellas,
      texto,
    })
    .select()
    .single();
  if (error) throw error;

  const { data: resenas } = await getClient()
    .from('reviews')
    .select('estrellas')
    .eq('conductor_telefono', normalizePhone(conductorTelefono));
  if (resenas && resenas.length > 0) {
    const avg =
      resenas.reduce((s, r) => s + r.estrellas, 0) / resenas.length;
    await getClient()
      .from('drivers')
      .update({ calificacion: Math.round(avg * 100) / 100 })
      .eq('telefono', normalizePhone(conductorTelefono));
  }
  await crearNotificacion({
    destinatarioTelefono: conductorTelefono,
    tipo: 'resena',
    texto: `Recibiste una reseña de ${estrellas} estrellas.`,
    tripId,
  });
  return data;
}

export async function listarResenasPorConductor(conductorTelefono) {
  const { data, error } = await getClient()
    .from('reviews')
    .select('*')
    .eq('conductor_telefono', normalizePhone(conductorTelefono))
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Realtime (postgres_changes): todo llega en vivo; cada evento ya generó
// su fila en `notifications`, así que el centro de notificaciones solo
// tiene que escuchar onNotificaciones() y recargar su lista.
// ---------------------------------------------------------------------------

function subscribeTable({ channel, table, event = '*', filter, onEvent }) {
  const ch = getClient().channel(channel);
  ch.on(
    'postgres_changes',
    { event, schema: 'public', table, ...(filter ? { filter } : {}) },
    (payload) => onEvent(payload),
  ).subscribe();
  return () => {
    getClient().removeChannel(ch);
  };
}

/** Cambios en la lista de conductores (altas, activación, castigos). */
export function onConductoresChange(onEvent) {
  return subscribeTable({
    channel: 'drivers-changes',
    table: 'drivers',
    onEvent,
  });
}

/** Viajes nuevos solicitados (para la pantalla del conductor). */
export function onSolicitudesNuevas(onEvent) {
  return subscribeTable({
    channel: 'trips-solicitados',
    table: 'trips',
    event: 'INSERT',
    filter: 'estado=eq.solicitado',
    onEvent,
  });
}

/** Cambios de estado de un viaje concreto (cliente y conductor). */
export function onViajeChange(tripId, onEvent) {
  return subscribeTable({
    channel: `trip-${tripId}`,
    table: 'trips',
    event: 'UPDATE',
    filter: `id=eq.${tripId}`,
    onEvent,
  });
}

/** Mensajes nuevos del chat de un viaje. */
export function onMensajes(tripId, onEvent) {
  return subscribeTable({
    channel: `messages-${tripId}`,
    table: 'messages',
    event: 'INSERT',
    filter: `trip_id=eq.${tripId}`,
    onEvent,
  });
}

/** Notificaciones nuevas para un teléfono (centro de notificaciones). */
export function onNotificaciones(telefono, onEvent) {
  return subscribeTable({
    channel: `notifications-${normalizePhone(telefono)}`,
    table: 'notifications',
    event: 'INSERT',
    filter: `destinatario_telefono=eq.${normalizePhone(telefono)}`,
    onEvent,
  });
}

// Fin del módulo. La función RPC `increment_driver_trips` se crea en la
// migración 001 (migrations/001_taxi_hidalguense.sql) y la usa
// completarViaje() para el contador de viajes del conductor.
