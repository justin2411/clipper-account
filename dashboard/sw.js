// Service Worker (Nachtrag 8): App-Shell offline verfügbar, Daten immer aus dem Netz (kein Zwischenspeichern von Kennzahlen).
// Bei fehlender Verbindung wird die zuletzt geladene Seite ausgeliefert; API-Antworten werden nie gecacht.
const SHELL = "clipforge-shell-v1";
const FILES = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES).catch(() => undefined)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;                       // Worker-API und R2-Medien: immer direkt aus dem Netz
  e.respondWith(
    fetch(e.request).then((r) => {                                       // Netz zuerst, Kopie der Hülle im Cache
      if (r.ok && FILES.includes(url.pathname)) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("/index.html")))
  );
});
// Web-Push (optional statt Telegram): Nachricht kommt als JSON {title, body, url}
self.addEventListener("push", (e) => {
  let d = { title: "ClipForge", body: "", url: "/#inbox" };
  try { d = { ...d, ...(e.data ? e.data.json() : {}) }; } catch { d.body = e.data ? e.data.text() : ""; }
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/#inbox";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
