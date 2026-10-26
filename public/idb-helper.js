/**
 * CosmoDB - Capa de persistencia IndexedDB para CosmoBitácora PWA
 * 
 * Diseñada para funcionar tanto en el contexto de la ventana (Window)
 * como en el hilo de fondo del Service Worker (ServiceWorkerGlobalScope).
 * Proporciona almacenamiento transaccional seguro y asíncrono para notas
 * y para la cola de sincronización pendiente (Background Sync / Offline Sync).
 */
(function (global) {
  const DB_NAME = "CosmoBitacoraDB";
  const DB_VERSION = 1;

  const STORES = {
    NOTES: "notes",
    SYNC_QUEUE: "sync_queue"
  };

  let dbPromise = null;

  /**
   * Abre o inicializa la base de datos IndexedDB.
   * Crea los almacenes de objetos (stores) e índices necesarios si no existen.
   * @returns {Promise<IDBDatabase>}
   */
  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const idb = global.indexedDB || global.mozIndexedDB || global.webkitIndexedDB || global.msIndexedDB;
      if (!idb) {
        return reject(new Error("IndexedDB no está disponible en este entorno."));
      }

      const request = idb.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Store para la bitácora completa (historial local)
        if (!db.objectStoreNames.contains(STORES.NOTES)) {
          const notesStore = db.createObjectStore(STORES.NOTES, { keyPath: "id" });
          notesStore.createIndex("by_createdAt", "createdAt", { unique: false });
          notesStore.createIndex("by_synced", "synced", { unique: false });
        }

        // Store para la cola de sincronización (registros pendientes de enviar al backend)
        if (!db.objectStoreNames.contains(STORES.SYNC_QUEUE)) {
          const queueStore = db.createObjectStore(STORES.SYNC_QUEUE, { keyPath: "id" });
          queueStore.createIndex("by_createdAt", "createdAt", { unique: false });
        }
      };

      request.onsuccess = (event) => {
        const db = event.target.result;
        db.onclose = () => { dbPromise = null; };
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = (event) => {
        dbPromise = null;
        reject(event.target.error || new Error("Error al abrir IndexedDB"));
      };

      request.onblocked = () => {
        console.warn("[CosmoDB] La apertura de IndexedDB está bloqueada por otra pestaña abierta.");
      };
    });

    return dbPromise;
  }

  // ==========================================
  // OPERACIONES DE NOTAS (BITÁCORA)
  // ==========================================

  /**
   * Guarda o actualiza una nota en el almacén de notas.
   * @param {Object} note Objeto de nota { id, type, title, detail, createdAt, synced }
   * @returns {Promise<Object>}
   */
  async function saveNote(note) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.NOTES], "readwrite");
      const store = tx.objectStore(STORES.NOTES);
      const req = store.put(note);
      req.onsuccess = () => resolve(note);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Obtiene todas las notas guardadas localmente.
   * @returns {Promise<Array>}
   */
  async function getAllNotes() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.NOTES], "readonly");
      const store = tx.objectStore(STORES.NOTES);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Marca una o varias notas como sincronizadas (synced: true).
   * @param {string|string[]} ids Identificador(es) de nota
   * @returns {Promise<void>}
   */
  async function markNotesAsSynced(ids) {
    if (!ids) return;
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length) return;

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.NOTES], "readwrite");
      const store = tx.objectStore(STORES.NOTES);

      for (const id of list) {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          if (getReq.result) {
            const updated = { ...getReq.result, synced: true };
            store.put(updated);
          }
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // ==========================================
  // OPERACIONES DE LA COLA DE SINCRONIZACIÓN
  // ==========================================

  /**
   * Añade un registro a la cola de sincronización pendiente.
   * @param {Object} item Registro pendiente { id, type, title, detail, createdAt }
   * @returns {Promise<Object>}
   */
  async function addToSyncQueue(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.SYNC_QUEUE], "readwrite");
      const store = tx.objectStore(STORES.SYNC_QUEUE);
      const req = store.put(item);
      req.onsuccess = () => resolve(item);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Obtiene todos los registros pendientes de sincronizar con el backend.
   * @returns {Promise<Array>}
   */
  async function getSyncQueue() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.SYNC_QUEUE], "readonly");
      const store = tx.objectStore(STORES.SYNC_QUEUE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Elimina un único registro de la cola de sincronización por su ID.
   * @param {string} id ID del registro
   * @returns {Promise<void>}
   */
  async function removeFromSyncQueue(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.SYNC_QUEUE], "readwrite");
      const store = tx.objectStore(STORES.SYNC_QUEUE);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Elimina un conjunto de registros de la cola de sincronización.
   * @param {string[]} ids Lista de IDs
   * @returns {Promise<void>}
   */
  async function removeManyFromSyncQueue(ids) {
    if (!ids) return;
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length) return;

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.SYNC_QUEUE], "readwrite");
      const store = tx.objectStore(STORES.SYNC_QUEUE);
      for (const id of list) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * Cuenta cuántos registros están pendientes de sincronizar.
   * @returns {Promise<number>}
   */
  async function countPending() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.SYNC_QUEUE], "readonly");
      const store = tx.objectStore(STORES.SYNC_QUEUE);
      const req = store.count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }

  // Exponer API limpia en el ámbito global (window o ServiceWorkerGlobalScope)
  global.CosmoDB = {
    openDB,
    saveNote,
    getAllNotes,
    markNotesAsSynced,
    addToSyncQueue,
    getSyncQueue,
    removeFromSyncQueue,
    removeManyFromSyncQueue,
    countPending,
    STORES
  };
})(typeof self !== "undefined" ? self : this);
