// ============================================================================
// Taxi Hidalguense — Configuración de Supabase
// ============================================================================
// Rellena estos dos valores con los de TU proyecto (Dashboard → Project
// Settings → API). NO pegues aquí ninguna clave secreta (service_role):
// solo la URL pública y la anon key (clave pública, diseñada para usarse
// en el cliente bajo RLS). Sin estos valores, supabase-client.js lanza un
// error claro en lugar de fallar en silencio.
// ============================================================================

export const SUPABASE_URL = 'https://fgktqammxgduxzufjbca.supabase.co'; // Proyecto taxi-hidalguense (org Taxi Hidalguense, cuenta carlos23ksb)
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna3RxYW1teGdkdXh6dWZqYmNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM4Mzg4NTgsImV4cCI6MjEwOTQxNDg1OH0.9J8PGIy2cUGDCAQSsAY-3wy_sGmeZAsdhLfhM1nfX0E'; // anon key pública (empieza con 'eyJ...')

// --- Avisos push con la app cerrada (pendiente el proyecto Firebase) ---
// Clave pública VAPID del proyecto Firebase (ver README, paso externo único).
// Vacía = suscripción push desactivada (los avisos en vivo siguen por Realtime).
export const VAPID_PUBLIC_KEY = '';
// URL de la Edge Function push-hook una vez desplegada (ver README).
export const PUSH_FUNCTION_URL = '';
