const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "sync-records.json");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]", "utf8");

function readRecords() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return []; }
}
function writeRecords(records) {
  fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2), "utf8");
}

// Valida y normaliza la ubicación opcional enviada por el cliente.
function sanitizeLocation(loc) {
  if (!loc || typeof loc !== "object") return null;
  const lat = Number(loc.lat), lon = Number(loc.lon), acc = Number(loc.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    accuracy: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null
  };
}

// ===== Noticias por ubicación =====
// 1) Nominatim (OpenStreetMap) convierte coordenadas en nombre de lugar.
// 2) GDELT DOC 2.0 busca noticias recientes que mencionen ese lugar.
// Ambas APIs son públicas y sin clave; se cachea para respetar sus límites de uso.
const newsCache = new Map();
const NEWS_TTL_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (response.status === 429) throw new Error("el servicio de noticias limitó las consultas (HTTP 429); espera un minuto e inténtalo de nuevo");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    try { return JSON.parse(text); }
    catch { throw new Error(text.trim().slice(0, 120) || "Respuesta no válida"); }
  } catch (error) {
    if (error.name === "AbortError") throw new Error("tiempo de espera agotado");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Aproximación sin internet: estado mexicano con el centro más cercano (solo si Nominatim falla).
const MEXICO_STATES = [
  ["Aguascalientes", 21.88, -102.29], ["Baja California", 30.84, -115.28], ["Baja California Sur", 25.9, -111.9],
  ["Campeche", 18.9, -90.4], ["Chiapas", 16.5, -92.5], ["Chihuahua", 28.9, -106.1], ["Ciudad de México", 19.43, -99.13],
  ["Coahuila", 27.3, -102.0], ["Colima", 19.1, -103.9], ["Durango", 24.9, -104.9], ["Guanajuato", 21.0, -101.0],
  ["Guerrero", 17.6, -100.0], ["Hidalgo", 20.5, -98.9], ["Jalisco", 20.6, -103.6], ["Estado de México", 19.35, -99.65],
  ["Michoacán", 19.2, -101.9], ["Morelos", 18.75, -99.07], ["Nayarit", 21.8, -104.9], ["Nuevo León", 25.6, -99.9],
  ["Oaxaca", 17.0, -96.5], ["Puebla", 19.0, -98.2], ["Querétaro", 20.8, -99.9], ["Quintana Roo", 19.6, -88.0],
  ["San Luis Potosí", 22.5, -100.4], ["Sinaloa", 25.0, -107.5], ["Sonora", 29.6, -110.9], ["Tabasco", 17.9, -92.6],
  ["Tamaulipas", 24.3, -98.6], ["Tlaxcala", 19.4, -98.2], ["Veracruz", 19.5, -96.7], ["Yucatán", 20.8, -89.1],
  ["Zacatecas", 23.3, -102.6]
];
const inMexico = (lat, lon) => lat >= 14.5 && lat <= 32.8 && lon >= -118.5 && lon <= -86.7;
function nearestState(lat, lon) {
  let best = MEXICO_STATES[0], bestD = Infinity;
  for (const st of MEXICO_STATES) {
    const d = (st[1] - lat) ** 2 + ((st[2] - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
    if (d < bestD) { bestD = d; best = st; }
  }
  return { name: best[0], degrees: Math.sqrt(bestD) };
}

async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=es&lat=${lat}&lon=${lon}`;
  const data = await fetchJson(url, { headers: { "User-Agent": "CosmoBitacora-PWA/1.0 (proyecto academico)" } }, 6000);
  const a = data.address || {};
  return {
    city: a.city || a.town || a.village || a.municipality || a.county || a.state_district || "",
    state: a.state || "",
    country: a.country || ""
  };
}

function parseSeenDate(value = "") {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
}

// ----- Fuente principal: Google Noticias (RSS), configurado para México -----
const decodeXml = (t) => String(t || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, "&").trim();
const xmlTag = (block, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decodeXml(m[1]) : "";
};

async function searchGoogleNews(term) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(term + " when:7d")}&hl=es-419&gl=MX&ceid=MX:es-419`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let xml;
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 CosmoBitacora-PWA" } });
    if (response.status === 429) throw new Error("Google Noticias limitó las consultas (HTTP 429)");
    if (!response.ok) throw new Error(`Google Noticias respondió HTTP ${response.status}`);
    xml = await response.text();
  } catch (error) {
    throw new Error(error.name === "AbortError" ? "Google Noticias tardó demasiado" : error.message);
  } finally {
    clearTimeout(timer);
  }
  const articles = [];
  const seen = new Set();
  for (const block of xml.split("<item>").slice(1)) {
    const source = xmlTag(block, "source");
    let title = xmlTag(block, "title");
    const link = xmlTag(block, "link");
    if (!title || !link) continue;
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    if (seen.has(title)) continue;
    seen.add(title);
    const date = new Date(xmlTag(block, "pubDate"));
    articles.push({
      id: "gn-" + crypto.createHash("md5").update(link).digest("hex").slice(0, 12),
      title,
      summary: "",
      image: "",
      url: link,
      published: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
      source: source || "Google Noticias"
    });
    if (articles.length === 12) break;
  }
  return articles;
}

// ----- Respaldo: GDELT -----
// GDELT pide como máximo 1 petición cada 5 s: se espacian todas las consultas del servidor.
let lastGdeltAt = 0;
async function gdeltThrottle() {
  const wait = lastGdeltAt + 5300 - Date.now();
  if (wait > 0) await sleep(wait);
  lastGdeltAt = Date.now();
}

async function searchGdelt(query) {
  const params = new URLSearchParams({
    query, mode: "artlist", format: "json", maxrecords: "40", sort: "datedesc", timespan: "7d"
  });
  let data;
  for (let attempt = 0; ; attempt++) {
    await gdeltThrottle();
    try {
      data = await fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {}, 18000);
      break;
    } catch (error) {
      // Un límite de uso o un fallo temporal se reintenta una vez.
      if (attempt >= 1) throw error;
    }
  }
  const seen = new Set();
  const articles = [];
  for (const item of data.articles || []) {
    if (!item.url || !item.title || seen.has(item.title)) continue;
    seen.add(item.title);
    articles.push({
      id: "gd-" + crypto.createHash("md5").update(item.url).digest("hex").slice(0, 12),
      title: item.title,
      summary: "",
      image: item.socialimage || "",
      url: item.url,
      published: parseSeenDate(item.seendate),
      source: item.domain || "Noticias"
    });
    if (articles.length === 12) break;
  }
  return articles;
}

const clean = (t) => String(t || "").replace(/["\\]/g, "").trim();
// Solo medios de México (sourcecountry:MX) y en español.
const MX = "sourcecountry:MX sourcelang:spanish";

app.get("/api/news/local", async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: "Coordenadas no válidas." });
  }
  // Se redondea (~1 km) para proteger la privacidad y reutilizar la caché.
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.at < NEWS_TTL_MS) return res.json(hit.data);

  try {
    // Candidatos de búsqueda, de lo más específico a lo más general. Siempre noticias de México.
    const candidates = [];
    let state = "";
    if (inMexico(lat, lon)) {
      let geo = null;
      try { geo = await reverseGeocode(lat.toFixed(2), lon.toFixed(2)); } catch { /* se usa la aproximación */ }
      if (geo) {
        // Nominatim respondió: solo se usa el lugar si realmente está en México.
        if (/m[eé]xico/i.test(geo.country)) {
          state = clean(geo.state);
          const city = clean(geo.city);
          if (city && city !== state) candidates.push({ place: city, term: `"${city}"`, query: `"${city}" ${MX}` });
        }
      } else {
        // Sin Nominatim: estado más cercano, siempre que esté a una distancia razonable.
        const near = nearestState(lat, lon);
        if (near.degrees < 4.5) state = near.name;
      }
      if (state) candidates.push({ place: state, term: `"${state}"`, query: `"${state}" ${MX}` });
    }
    candidates.push({ place: "México", term: "México", query: `México ${MX}` });

    // Se busca en Google Noticias; GDELT solo se usa si Google falla.
    let found = { place: "México", articles: [] };
    let anySourceWorked = false, lastError = null;
    for (const c of candidates) {
      let articles = [];
      try {
        articles = await searchGoogleNews(c.term);
        anySourceWorked = true;
      } catch (googleError) {
        lastError = googleError;
        try {
          articles = await searchGdelt(c.query);
          anySourceWorked = true;
        } catch (gdeltError) {
          throw gdeltError; // ambas fuentes fallaron: no se insiste con más consultas
        }
      }
      if (articles.length) { found = { place: c.place, articles }; break; }
    }
    if (!anySourceWorked && lastError) throw lastError;
    const data = { place: found.place, state, country: "México", articles: found.articles };
    if (data.articles.length) newsCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: `No se pudieron obtener noticias de la zona: ${error.message}` });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "ExploraPWA Sync API" }));

// Idempotencia: cada registro tiene un id creado por el cliente. Si se reenvía,
// el servidor no lo duplica.
//1
app.post("/api/sync", (req, res) => {
  const incoming = Array.isArray(req.body.records) ? req.body.records : [];
  if (!incoming.length) return res.status(400).json({ error: "Envía records como arreglo." });

  const records = readRecords();
  const knownIds = new Set(records.map(r => r.id));
  const added = [];
  let duplicates = 0;

  for (const item of incoming) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
    if (knownIds.has(item.id)) { duplicates++; continue; }
    const safe = {
      id: item.id,
      type: String(item.type || "nota").slice(0, 40),
      title: String(item.title || "Registro sin título").slice(0, 180),
      detail: String(item.detail || "").slice(0, 2000),
      location: sanitizeLocation(item.location),
      createdAt: String(item.createdAt || new Date().toISOString()),
      syncedAt: new Date().toISOString()
    };
    records.push(safe);
    knownIds.add(safe.id);
    added.push(safe.id);
  }
  writeRecords(records);
  res.json({ ok: true, received: incoming.length, added: added.length, duplicatesIgnored: duplicates, total: records.length });
});

app.get("/api/sync", (_req, res) => res.json({ records: readRecords() }));

app.listen(PORT, () => console.log(`ExploraPWA disponible en http://localhost:${PORT}`));
