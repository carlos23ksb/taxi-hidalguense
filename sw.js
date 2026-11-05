/* Taxi Hidalguense V7 · Service worker para avisos push.
   Solo muestra notificaciones que llegan por push (con la app cerrada) y
   abre la app al tocarlas. No cachea nada: evita versiones viejas atoradas.
   El envío real lo hace la Edge Function push-hook (ver supabase/functions);
   sin proyecto Firebase ni clave VAPID, este archivo no recibe nada. */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Taxi Hidalguense";
  const options = {
    body: data.body || data.texto || "",
    icon: "./assets/icon-192.png",
    badge: "./assets/icon-192.png",
    data: { url: (data.data && data.data.url) || "./index.html" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
