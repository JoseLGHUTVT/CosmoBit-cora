// Importar helper de IndexedDB para tener acceso a la base de datos en segundo plano
try {
  importScripts("/idb-helper.js");
} catch (e) {
  console.error("[SW] Error al importar idb-helper.js:", e);
}

const CACHE_NAME = "cosmobitacora-static-v3";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/idb-helper.js",
  "/app.js",
  "/manifest.json",
  "/icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
  );
});

// La nueva versión espera hasta que el usuario acepte actualizar desde la app.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // API externa y API local de sincronización no se interceptan en caché de navegación estática
  if (url.hostname === "api.spaceflightnewsapi.net") return;
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response && response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached || caches.match("/index.html"));

      return cached || network;
    })
  );
});

// ==========================================
// BACKGROUND SYNC - SINCRONIZACIÓN EN SEGUNDO PLANO
// ==========================================
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-notes" || event.tag === "cosmobitacora-sync") {
    console.log(`[SW] Evento de sincronización en segundo plano recibido (${event.tag})`);
    event.waitUntil(syncPendingNotes());
  }
});

/**
 * Procesa la cola de sincronización pendiente desde IndexedDB y la envía al servidor.
 */
async function syncPendingNotes() {
  if (!self.CosmoDB) {
    console.warn("[SW] CosmoDB no disponible para sincronización.");
    return;
  }

  try {
    const queue = await self.CosmoDB.getSyncQueue();
    if (!queue || !queue.length) {
      console.log("[SW] No hay registros pendientes en IndexedDB.");
      return;
    }

    console.log(`[SW] Sincronizando ${queue.length} registro(s) pendientes con /api/sync...`);

    const response = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: queue })
    });

    if (!response.ok) {
      throw new Error(`El servidor respondió con código HTTP ${response.status}`);
    }

    const result = await response.json();
    const ids = queue.map((item) => item.id);

    // 1. Limpiar registros de la cola en IndexedDB
    await self.CosmoDB.removeManyFromSyncQueue(ids);

    // 2. Marcar las notas correspondientes como sincronizadas en IndexedDB
    await self.CosmoDB.markNotesAsSynced(ids);

    console.log(`[SW] Sincronización exitosa: ${ids.length} registros procesados.`);

    // Las notificaciones NO se disparan desde el Service Worker: el usuario las solicita con el botón de la app.

    // 3. Notificar a las ventanas abiertas para refrescar la interfaz sin recargar
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({
        type: "SYNC_COMPLETED",
        count: result.added !== undefined ? result.added : queue.length,
        duplicatesIgnored: result.duplicatesIgnored || 0,
        ids: ids
      });
    }
  } catch (error) {
    console.error("[SW] Error durante Background Sync:", error);
    // Relanzar el error le indica al Background Sync que vuelva a intentar más tarde con backoff
    throw error;
  }
}

// ==========================================
// CLIC EN NOTIFICACIÓN: enfocar la app o abrirla
// ==========================================
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
