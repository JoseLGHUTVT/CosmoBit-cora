const API_URL = "https://api.spaceflightnewsapi.net/v4/articles/?limit=12";
const $ = (id) => document.getElementById(id);
const FAVORITES_KEY = "cosmobitacora_favorites_v1";
const NOTES_KEY = "cosmobitacora_notes_v1"; // Clave heredada para migración a IndexedDB
const QUEUE_KEY = "cosmobitacora_sync_queue_v1"; // Clave heredada para migración a IndexedDB
const CACHED_SPACE_KEY = "cosmobitacora_cached_articles_v1";
const CACHED_LOCAL_KEY = "cosmobitacora_cached_local_articles_v1";
const NEWS_LOCATION_KEY = "cosmobitacora_news_location_v1";
let articles = [];
let currentView = "noticias";
let pendingLocation = null; // ubicación adjunta a la nota que se está redactando
let updateRequested = false;
let newsMode = "space"; // "space" = Spaceflight News, "local" = noticias de la ubicación
let savedLocation = readObject(NEWS_LOCATION_KEY); // { lat, lon, place }

function readObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function safeRead(key, fallback = []) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function makeId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function summarize(text = "", max = 145) {
  const clean = String(text).replace(/<[^>]*>/g, "").trim();
  return clean.length > max ? clean.slice(0, max).trim() + "…" : clean;
}

function updateConnection() {
  const online = navigator.onLine;
  $("connectionDot").classList.toggle("offline", !online);
  $("connectionText").textContent = online ? "Con conexión" : "Modo sin conexión";
  // Los controles que dependen de internet se atenúan y explican por qué.
  document.querySelectorAll("[data-needs-online]").forEach((el) => {
    el.classList.toggle("is-offline", !online);
    el.title = online ? "" : "Requiere conexión a internet";
  });
}

function showMessage(text, type = "info") {
  $("message").textContent = text;
  $("message").classList.remove("hidden");
  $("message").style.background = type === "error" ? "#fff0ed" : "#fff5e8";
  $("message").style.color = type === "error" ? "#8c392b" : "#80552c";
}

function hideMessage() {
  $("message").classList.add("hidden");
}

function updateNewsModeUI() {
  const btn = $("newsModeBtn");
  if (newsMode === "local") btn.textContent = "🚀 Ver noticias espaciales";
  else if (savedLocation) btn.textContent = `📍 Noticias de ${savedLocation.place || "mi zona"}`;
  else btn.textContent = "📍 Noticias de mi zona";
}

async function fetchArticlesFromApi() {
  if (newsMode === "local" && savedLocation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 70000); // el servidor puede tardar por los límites de GDELT
    let response;
    try {
      response = await fetch(`/api/news/local?lat=${savedLocation.lat}&lon=${savedLocation.lon}`, { signal: controller.signal });
    } catch (error) {
      throw new Error(error.name === "AbortError" ? "la consulta tardó demasiado" : error.message);
    } finally {
      clearTimeout(timer);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `El servidor respondió ${response.status}`);
    if (data.place && savedLocation.place !== data.place) {
      savedLocation.place = data.place;
      localStorage.setItem(NEWS_LOCATION_KEY, JSON.stringify(savedLocation));
      updateNewsModeUI();
    }
    return data.articles || [];
  }
  const response = await fetch(API_URL, { headers: { "Accept": "application/json" } });
  if (!response.ok) throw new Error(`La API respondió ${response.status}`);
  const data = await response.json();
  return (data.results || []).map((a) => ({
    id: String(a.id),
    title: a.title || "Noticia espacial",
    summary: a.summary || "",
    image: a.image_url || "",
    url: a.url || "#",
    published: a.published_at || "",
    source: a.news_site || "Spaceflight News"
  }));
}

// Mantiene el título y la etiqueta acordes al modo aunque la carga falle.
function updateNewsHeadings() {
  if (currentView !== "noticias") return;
  const localMode = newsMode === "local";
  $("sectionEyebrow").textContent = localMode ? "EN TU ZONA · MÉXICO" : "ACTUALIDAD ESPACIAL";
  $("sectionTitle").textContent = localMode ? `Noticias de ${savedLocation?.place || "tu zona"}` : "Últimas noticias";
  $("sourceBadge").textContent = !navigator.onLine ? "Contenido local" : localMode ? "Noticias · México" : "API externa · en vivo";
}

async function loadArticles() {
  hideMessage();
  updateNewsModeUI();
  updateNewsHeadings();
  const cacheKey = newsMode === "local" ? CACHED_LOCAL_KEY : CACHED_SPACE_KEY;
  const label = newsMode === "local" ? `de ${savedLocation?.place || "tu zona"}` : "espaciales";
  $("newsGrid").innerHTML = `<div class="empty">Buscando noticias ${escapeHTML(label)}…</div>`;

  if (!navigator.onLine) {
    articles = safeRead(cacheKey);
    if (articles.length) {
      showMessage("Estás sin conexión. Se muestran las noticias guardadas anteriormente en este dispositivo.");
      await renderView();
    } else {
      $("newsGrid").innerHTML = '<div class="empty">No hay noticias guardadas todavía. Conéctate una vez para descargar contenido.</div>';
      showMessage("Sin internet y sin noticias en caché. La interfaz sigue disponible.", "error");
    }
    return;
  }

  try {
    articles = await fetchArticlesFromApi();
    if (articles.length) safeWrite(cacheKey, articles);
    else if (newsMode === "local") showMessage(`No se encontraron noticias recientes de ${savedLocation?.place || "tu zona"} en medios de México.`);
    await renderView();
  } catch (error) {
    articles = safeRead(cacheKey);
    if (articles.length) {
      showMessage("No se pudo contactar la API. Se muestran las noticias guardadas localmente.");
      await renderView();
    } else {
      $("newsGrid").innerHTML = '<div class="empty">No fue posible obtener noticias. Revisa la conexión e inténtalo de nuevo.</div>';
      showMessage("Error al consultar las noticias: " + error.message + (newsMode === "local" ? ". Puedes volver a las noticias espaciales con el botón de arriba." : ""), "error");
    }
  }
}

async function renderView() {
  await updateCounters();
  $("newsGrid").classList.toggle("hidden", currentView === "bitacora");
  $("journalPanel").classList.toggle("hidden", currentView !== "bitacora");
  const localMode = newsMode === "local";
  $("sourceBadge").textContent = !navigator.onLine ? "Contenido local" : localMode ? "Noticias · México" : "API externa · en vivo";

  if (currentView === "bitacora") {
    await renderJournal();
    return;
  }

  let list = articles;
  if (currentView === "favoritos") {
    list = safeRead(FAVORITES_KEY); // los favoritos guardan la noticia completa, sin importar el origen
    $("sectionEyebrow").textContent = "TU COLECCIÓN";
    $("sectionTitle").textContent = "Noticias favoritas";
  } else {
    $("sectionEyebrow").textContent = localMode ? "EN TU ZONA · MÉXICO" : "ACTUALIDAD ESPACIAL";
    $("sectionTitle").textContent = localMode ? `Noticias de ${savedLocation?.place || "tu zona"}` : "Últimas noticias";
  }

  if (!list.length) {
    $("newsGrid").innerHTML = `<div class="empty">${
      currentView === "favoritos"
        ? "Aún no guardas favoritos. Presiona “Guardar” en una noticia."
        : "No hay noticias disponibles."
    }</div>`;
    return;
  }

  $("newsGrid").innerHTML = list.map((a) => {
    const saved = safeRead(FAVORITES_KEY).some((x) => String(x.id) === String(a.id));
    const date = a.published
      ? new Date(a.published).toLocaleDateString("es-MX", { year: "numeric", month: "short", day: "numeric" })
      : "Fecha no disponible";

    return `<article class="news-card">
      ${a.image ? `<img class="news-image" src="${escapeHTML(a.image)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="news-image placeholder">✦</div>`}
      <div class="news-body">
        <div class="card-meta">${escapeHTML(a.source)} · ${escapeHTML(date)}</div>
        <h3>${escapeHTML(a.title)}</h3>
        <p>${escapeHTML(summarize(a.summary || "Consulta la publicación original para conocer más detalles.", 155))}</p>
        <div class="card-actions">
          <button class="small-btn ${saved ? "saved" : ""}" data-fav="${escapeHTML(a.id)}">${saved ? "★ Guardada" : "☆ Guardar"}</button>
          <a class="small-btn link" href="${escapeHTML(a.url)}" target="_blank" rel="noopener noreferrer">Leer noticia ↗</a>
        </div>
      </div>
    </article>`;
  }).join("");

  $("newsGrid").querySelectorAll("[data-fav]").forEach((btn) =>
    btn.addEventListener("click", () => toggleFavorite(btn.dataset.fav))
  );
}

async function toggleFavorite(id) {
  const favorites = safeRead(FAVORITES_KEY);
  const existing = favorites.some((x) => String(x.id) === String(id));
  let next;
  if (existing) {
    next = favorites.filter((x) => String(x.id) !== String(id));
  } else {
    const article = articles.find((x) => String(x.id) === String(id));
    if (!article) return;
    next = [...favorites, article];
  }
  safeWrite(FAVORITES_KEY, next);
  await renderView();
}

async function updateCounters() {
  $("favCount").textContent = safeRead(FAVORITES_KEY).length;
  try {
    const pending = await CosmoDB.countPending();
    $("pendingCount").textContent = pending;
  } catch (e) {
    $("pendingCount").textContent = "0";
  }
}

async function renderJournal() {
  $("sectionTitle").textContent = "Mi bitácora";

  try {
    const notes = await CosmoDB.getAllNotes();
    $("journalList").innerHTML = notes.length
      ? notes.slice().reverse().map((n) => `
          <article class="journal-item">
            <h4>${escapeHTML(n.title)}</h4>
            <p>${escapeHTML(n.detail || "Sin descripción")}</p>
            ${locationTag(n.location)}
            <small>
              ${escapeHTML(new Date(n.createdAt).toLocaleString("es-MX"))} · 
              <span class="sync-status ${n.synced ? "synced" : "pending"}">
                ${n.synced ? "Sincronizado" : "Guardado (Pendiente de sincronizar)"}
              </span>
            </small>
          </article>
        `).join("")
      : '<div class="empty">Todavía no hay notas. Puedes crear una incluso sin conexión; se guardará localmente.</div>';
  } catch (error) {
    $("journalList").innerHTML = `<div class="empty">Error al consultar IndexedDB: ${escapeHTML(error.message)}</div>`;
  }
}

/**
 * Registra o envía una nota:
 * 1. Guarda siempre de forma segura en IndexedDB (persistencia local offline-first).
 * 2. Si hay conexión: intenta el envío inmediato a la API REST. Si tiene éxito, limpia de la cola y marca sincronizada.
 * 3. Si no hay conexión (o falla la red): la nota queda protegida en IndexedDB y se activa Background Sync o listener online.
 */
async function addNote(event) {
  event.preventDefault();
  const title = $("noteTitle").value.trim();
  const detail = $("noteDetail").value.trim();
  if (!title) return;

  const note = {
    id: makeId(),
    type: "nota",
    title,
    detail,
    createdAt: new Date().toISOString(),
    synced: false,
    location: pendingLocation
  };

  const queueRecord = {
    id: note.id,
    type: note.type,
    title: note.title,
    detail: note.detail,
    createdAt: note.createdAt,
    location: note.location
  };

  // Paso 1: Guardar localmente en IndexedDB
  try {
    await CosmoDB.saveNote(note);
    await CosmoDB.addToSyncQueue(queueRecord);
  } catch (dbError) {
    console.error("Error al persistir:", dbError);
    showMessage("No se pudo guardar: " + dbError.message, "error");
    return;
  }

  $("noteForm").reset();
  clearLocation();
  await renderJournal();
  await updateCounters();

  // Paso 2: Evaluar si hay conexión de red
  if (navigator.onLine) {
    showMessage("Guardado. Enviando al servidor...");
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: [queueRecord] })
      });

      if (!response.ok) {
        throw new Error(`El servidor respondió con código HTTP ${response.status}`);
      }

      // Paso 3a: Envío exitoso -> Limpiar registro de la cola y marcar como sincronizado
      await CosmoDB.removeFromSyncQueue(note.id);
      await CosmoDB.markNotesAsSynced(note.id);

      showMessage("Nota guardada localmente y sincronizada con éxito en el servidor.");
      await renderJournal();
      await updateCounters();
      await loadServerRecords();
    } catch (networkError) {
      console.warn("Fallo el envío directo al servidor:", networkError);
      showMessage("Nota protegida. Falló el envío inmediato; se reintentará automáticamente.", "error");
      await requestBackgroundSync();
    }
  } else {
    // Paso 3b: Sin conexión -> Datos seguros en IndexedDB y se activa Background Sync
    showMessage("Modo sin conexión: la nota quedó guardada. Se sincronizará automáticamente cuando vuelva internet.");
    await requestBackgroundSync();
  }
}

/**
 * Sincronización manual accionada por el botón "Sincronizar pendientes":
 * Lee todos los registros pendientes de IndexedDB y los envía al backend.
 */
async function syncPending() {
  const queue = await CosmoDB.getSyncQueue();
  if (!queue.length) {
    showMessage("No hay registros pendientes de sincronización.");
    return;
  }

  if (!navigator.onLine) {
    showMessage(`Sin conexión. Hay ${queue.length} registro(s) listos para sincronizar.`, "error");
    await requestBackgroundSync();
    return;
  }

  $("syncBtn").disabled = true;
  $("syncBtn").textContent = "Sincronizando…";

  try {
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: queue })
    });

    if (!response.ok) throw new Error(`El servidor respondió con código HTTP ${response.status}`);
    const result = await response.json();

    const ids = queue.map((x) => x.id);
    // Limpiar de la cola de sincronización y actualizar estado en IndexedDB
    await CosmoDB.removeManyFromSyncQueue(ids);
    await CosmoDB.markNotesAsSynced(ids);

    showMessage(`Sincronización completada. Nuevos registros: ${result.added}. Duplicados ignorados: ${result.duplicatesIgnored}.`);
    await renderJournal();
    await updateCounters();
    await loadServerRecords();
  } catch (error) {
    showMessage("No se pudo sincronizar. Los datos continúan guardados localmente: " + error.message, "error");
    await requestBackgroundSync();
  } finally {
    $("syncBtn").disabled = false;
    $("syncBtn").textContent = "⇅ Sincronizar pendientes";
  }
}

/**
 * Solicita al Service Worker registrar una tarea de Background Sync
 */
async function requestBackgroundSync() {
  if ("serviceWorker" in navigator && "SyncManager" in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register("sync-notes");
    } catch (err) {
      console.warn("[App] No se pudo registrar Background Sync:", err);
    }
  }
}

async function loadServerRecords() {
  if (!navigator.onLine) {
    $("serverList").innerHTML = '<p class="empty">El servidor no está disponible sin conexión.</p>';
    showMessage("Consultar el servidor requiere conexión a internet. Tus notas siguen guardadas en este dispositivo.", "error");
    return;
  }
  try {
    const response = await fetch("/api/sync");
    if (!response.ok) throw new Error("No se pudieron consultar los registros del servidor.");
    const data = await response.json();
    $("serverList").innerHTML = data.records.length
      ? data.records.slice().reverse().map((r) => `
          <div class="server-record">
            <strong>${escapeHTML(r.title)}</strong><br>
            <span>${escapeHTML(r.detail || "Sin descripción")}</span><br>
            ${locationTag(r.location)}
            <small>Recibido: ${escapeHTML(new Date(r.syncedAt).toLocaleString("es-MX"))}</small>
          </div>
        `).join("")
      : "<p>Aún no hay registros recibidos por el servidor.</p>";
  } catch (error) {
    $("serverList").textContent = error.message;
  }
}

async function setView(view) {
  currentView = view;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  hideMessage();
  await renderView();
}

// Migración de datos existentes en localStorage hacia IndexedDB
async function migrateLegacyLocalStorage() {
  try {
    const oldNotes = safeRead(NOTES_KEY, []);
    const oldQueue = safeRead(QUEUE_KEY, []);

    if (oldNotes.length) {
      for (const note of oldNotes) {
        await CosmoDB.saveNote(note);
      }
      localStorage.removeItem(NOTES_KEY);
    }

    if (oldQueue.length) {
      for (const item of oldQueue) {
        await CosmoDB.addToSyncQueue(item);
      }
      localStorage.removeItem(QUEUE_KEY);
    }
  } catch (err) {
    console.warn("Aviso durante la migración de localStorage a IndexedDB:", err);
  }
}

// Event Listeners de la interfaz
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("refreshBtn").addEventListener("click", loadArticles);
$("noteForm").addEventListener("submit", addNote);
$("syncBtn").addEventListener("click", syncPending);
$("loadServerBtn").addEventListener("click", loadServerRecords);
$("locBtn").addEventListener("click", captureLocation);
$("locClear").addEventListener("click", clearLocation);
$("notifBtn").addEventListener("click", enableNotifications);
$("notifTestBtn").addEventListener("click", sendNewsNotification);
$("newsModeBtn").addEventListener("click", toggleNewsMode);
$("updateBtn").addEventListener("click", applyUpdate);

// Escuchar cambios de conectividad
window.addEventListener("online", async () => {
  updateConnection();
  const pending = await CosmoDB.countPending();
  if (pending > 0) {
    showMessage(`Conexión recuperada. Sincronizando ${pending} registro(s) pendientes de IndexedDB...`);
    await syncPending();
  } else {
    showMessage("Conexión recuperada.");
  }
  await loadArticles();
});

window.addEventListener("offline", () => {
  updateConnection();
  showMessage("Sin conexión. Puedes consultar contenido guardado y crear notas (se guardarán en IndexedDB).", "error");
});

// Escuchar mensajes del Service Worker cuando ejecute sincronización en segundo plano
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", async (event) => {
    if (event.data && event.data.type === "SYNC_COMPLETED") {
      showMessage(`Sincronización en segundo plano completada (${event.data.count} nuevo(s) registro(s)).`);
      await renderJournal();
      await updateCounters();
      await loadServerRecords();
    }
  });
}

// ==========================================
// SERVICE WORKER: registro y actualización
// ==========================================
function showUpdateBanner(worker) {
  $("updateBanner").classList.remove("hidden");
  $("updateBtn").onclick = () => applyUpdate(worker);
}

function applyUpdate(worker) {
  updateRequested = true;
  const target = worker && worker.postMessage ? worker : null;
  if (target) {
    target.postMessage({ type: "SKIP_WAITING" });
  } else {
    navigator.serviceWorker.getRegistration().then((reg) => reg && reg.waiting && reg.waiting.postMessage({ type: "SKIP_WAITING" }));
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    showMessage("Este navegador no admite Service Workers: la app funcionará, pero sin modo sin conexión.", "error");
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register("/service-worker.js");
    console.info("[PWA] Service Worker registrado. Scope:", reg.scope);

    // Una versión nueva ya descargada y en espera
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);

    // Una versión nueva que se instala mientras la app está abierta
    reg.addEventListener("updatefound", () => {
      const incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener("statechange", () => {
        if (incoming.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(incoming);
      });
    });

    // Recarga solo cuando el usuario aceptó actualizar (evita recargar en la primera instalación)
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (updateRequested) window.location.reload();
    });

    // Buscar actualizaciones periódicamente mientras la app permanece abierta
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  } catch (error) {
    console.error("[PWA] No se pudo registrar el Service Worker", error);
    showMessage("No se pudo activar el modo sin conexión: " + error.message, "error");
  }
}

// ==========================================
// NOTIFICACIONES LOCALES
// ==========================================
function notificationsSupported() {
  return "Notification" in window && "serviceWorker" in navigator;
}

function refreshNotifUI() {
  const status = $("notifStatus");
  const btn = $("notifBtn");
  const test = $("notifTestBtn");
  if (!notificationsSupported()) {
    status.textContent = "Este navegador no admite notificaciones. La app seguirá mostrando avisos dentro de la pantalla.";
    btn.disabled = true;
    test.classList.add("hidden");
    return;
  }
  const permission = Notification.permission;
  if (permission === "granted") {
    status.textContent = "Notificaciones activadas. Solo se envían cuando pulsas el botón de abajo.";
    btn.classList.add("hidden");
    test.classList.remove("hidden");
  } else if (permission === "denied") {
    status.textContent = "Las notificaciones están bloqueadas. Para activarlas, cambia el permiso del sitio en la configuración del navegador.";
    btn.disabled = true;
    test.classList.add("hidden");
  } else {
    status.textContent = "Actívalas con el botón; el navegador te pedirá permiso. Los avisos solo se envían cuando tú lo pides.";
    btn.disabled = false;
    btn.classList.remove("hidden");
    test.classList.add("hidden");
  }
}

// Muestra la notificación mediante el Service Worker (requerido en Android/Chrome).
async function notifyUser(title, body, tag = "cosmobitacora") {
  if (!notificationsSupported() || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body,
      tag,
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      data: { url: "/#bitacora" }
    });
    return true;
  } catch (error) {
    console.warn("[PWA] No se pudo mostrar la notificación:", error);
    return false;
  }
}

async function enableNotifications() {
  if (!notificationsSupported()) return;
  try {
    const result = await Notification.requestPermission();
    refreshNotifUI();
    if (result === "granted") {
      showMessage("Notificaciones activadas.");
      await notifyUser("Notificaciones activadas", "Ya puedes recibir avisos desde CosmoBitácora.", "permission-granted");
    } else if (result === "denied") {
      showMessage("No se activaron las notificaciones porque el permiso fue denegado.", "error");
    } else {
      showMessage("No elegiste una opción; las notificaciones siguen desactivadas.");
    }
  } catch (error) {
    showMessage("No se pudo solicitar el permiso de notificaciones: " + error.message, "error");
  }
}

async function sendNewsNotification() {
  const first = articles[0];
  if (!first) {
    showMessage("Aún no hay noticias cargadas para notificar.", "error");
    return;
  }
  const where = newsMode === "local" && savedLocation ? ` · ${savedLocation.place || "tu zona"}` : "";
  const ok = await notifyUser(`Última noticia${where}`, first.title, "latest-news");
  if (!ok) showMessage("No se pudo mostrar la notificación.", "error");
}

// ==========================================
// GEOLOCALIZACIÓN
// ==========================================
function formatLocation(loc) {
  const acc = loc.accuracy != null ? ` (±${loc.accuracy} m)` : "";
  return `${Number(loc.lat).toFixed(5)}, ${Number(loc.lon).toFixed(5)}${acc}`;
}

function locationTag(loc) {
  if (!loc || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lon))) return "";
  const lat = Number(loc.lat), lon = Number(loc.lon);
  const map = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
  return `<span class="loc-tag">📍 ${escapeHTML(formatLocation(loc))} · <a href="${map}" target="_blank" rel="noopener noreferrer" title="Requiere conexión a internet">Ver mapa ↗</a></span>`;
}

function clearLocation() {
  pendingLocation = null;
  $("locClear").classList.add("hidden");
  $("locBtn").textContent = "📍 Adjuntar mi ubicación";
  $("locStatus").textContent = "Opcional. El navegador te pedirá permiso para acceder a tu ubicación.";
}

function geoErrorText(error) {
  if (error.code === 1) return "Permiso de ubicación denegado. Puedes habilitarlo en la configuración del sitio o continuar sin ubicación.";
  if (error.code === 2) return "No se pudo determinar tu ubicación (señal GPS o red no disponible). Inténtalo de nuevo.";
  if (error.code === 3) return "Se agotó el tiempo para obtener la ubicación. Inténtalo de nuevo.";
  return error.message || "Error al obtener la ubicación.";
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("Este navegador no admite geolocalización."));
    if (!window.isSecureContext) return reject(new Error("La geolocalización solo funciona en HTTPS o en localhost."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) }),
      reject,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

// Guarda la ubicación para las noticias y cambia el feed a "noticias de mi zona".
async function applyNewsLocation(loc) {
  savedLocation = { lat: loc.lat, lon: loc.lon, place: "" };
  localStorage.removeItem(CACHED_LOCAL_KEY); // evita mostrar noticias guardadas de otra zona
  localStorage.setItem(NEWS_LOCATION_KEY, JSON.stringify(savedLocation));
  newsMode = "local";
  await loadArticles();
}

// Botón del formulario: adjunta la ubicación a la nota y también actualiza las noticias.
async function captureLocation() {
  const status = $("locStatus");
  const btn = $("locBtn");
  btn.disabled = true;
  status.textContent = "Obteniendo ubicación… si el navegador lo solicita, acepta el permiso.";
  try {
    pendingLocation = await getPosition();
    status.textContent = "Ubicación adjunta: " + formatLocation(pendingLocation);
    btn.textContent = "📍 Actualizar ubicación";
    $("locClear").classList.remove("hidden");
    await applyNewsLocation(pendingLocation);
    showMessage(`Ubicación agregada. Las noticias ahora son de ${savedLocation.place || "tu zona"}; revísalas en la pestaña Noticias.`);
  } catch (error) {
    status.textContent = geoErrorText(error);
  } finally {
    btn.disabled = false;
  }
}

// Botón de la pestaña Noticias: alterna entre noticias espaciales y de la zona.
async function toggleNewsMode() {
  if (newsMode === "local") {
    newsMode = "space";
    await loadArticles();
    return;
  }
  if (savedLocation) {
    newsMode = "local";
    await loadArticles();
    return;
  }
  $("newsModeBtn").disabled = true;
  showMessage("Obteniendo tu ubicación… si el navegador lo solicita, acepta el permiso.");
  try {
    await applyNewsLocation(await getPosition());
  } catch (error) {
    showMessage(geoErrorText(error), "error");
  } finally {
    $("newsModeBtn").disabled = false;
  }
}

async function boot() {
  updateConnection();

  // Asegurar persistencia y migrar registros previos a IndexedDB
  await migrateLegacyLocalStorage();

  await registerServiceWorker();
  refreshNotifUI();

  await loadArticles();
  await updateCounters();

  setTimeout(() => {
    $("splash").classList.add("fade");
    setTimeout(() => {
      $("splash").classList.add("hidden");
      $("app").classList.remove("hidden");
    }, 500);
  }, 700);
}

boot();
