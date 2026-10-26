# CosmoBitácora — ExploraPWA

PWA educativa creada desde cero para demostrar renderizado en cliente, consumo de API externa, almacenamiento local, funcionamiento básico sin conexión y sincronización idempotente con un backend.

## Funcionalidades

- Splash Screen y Home Screen adaptable a móvil y escritorio.
- Noticias espaciales desde **Spaceflight News API v4** (`https://api.spaceflightnewsapi.net/v4/articles/?limit=12`), API externa sin clave para este endpoint.
- Renderizado de tarjetas en JavaScript.
- Favoritos en `localStorage` y notas / cola de sincronización persistidas en **IndexedDB** (`CosmoBitacoraDB`).
- Caché local de noticias para consultarlas después de haberlas descargado una vez.
- Service Worker + Cache API para los archivos esenciales y módulo de persistencia `idb-helper.js`.
- Backend Express con `POST /api/sync` y `GET /api/sync`.
- Cola local de sincronización en IndexedDB y soporte dual: **Background Sync** del Service Worker y reintento automático al recuperar conexión.
- Prevención de duplicados mediante ID único creado en cliente y comprobado por el servidor.
- Registros recibidos guardados en `data/sync-records.json`.

## Requisitos

- Node.js 18 o superior
- npm
- Navegador moderno

## Ejecutar localmente

```bash
npm install
npm start
```

Abrir `http://localhost:3000`. El Service Worker requiere HTTPS o `localhost`; no abrir `index.html` directamente con `file://`.

## Prueba de sincronización

1. Con conexión, abre la aplicación.
2. Entra a **Mi bitácora**, crea una nota y pulsa **Guardar nota sin conexión**. Se guardará primero en IndexedDB y se sincronizará automáticamente con el servidor.
3. Para probar modo offline, abre DevTools > Network > Offline.
4. Crea otra nota: se guardará de forma segura en IndexedDB y se marcará como pendiente, registrando además el Background Sync.
5. Vuelve a Online: la app detectará la reconexión (o el Service Worker ejecutará Background Sync) enviando los registros pendientes y actualizando la interfaz a sincronizada.
6. También puedes pulsar **Sincronizar pendientes** en cualquier momento para forzar la sincronización manual desde IndexedDB.
7. Para comprobar idempotencia, vuelve a enviar un mismo ID con una solicitud repetida; el servidor ignorará el duplicado.

Ejemplo de consulta del servidor:
```bash
curl http://localhost:3000/api/sync
```

## Arquitectura y procesamiento

- **Cliente:** interfaz, renderizado de noticias, favoritos, notas y cola gestionadas en IndexedDB, caché de datos descargados y estado de conectividad.
- **API externa:** entrega noticias espaciales; es una API de consulta. No recibe nuestras notas.
- **Backend propio:** recibe la cola mediante `POST /api/sync`, valida el ID, evita duplicados y persiste registros en un archivo JSON.
- **Service Worker / Cache API:** almacena el shell estático (incluyendo `idb-helper.js`) y gestiona eventos `sync` para Background Sync automático en segundo plano.
- **IndexedDB (`CosmoBitacoraDB`):** almacena de forma asíncrona y transaccional las notas (`notes`) y la cola de sincronización (`sync_queue`), compartida tanto por la ventana como por el Service Worker.
- **localStorage:** almacena preferencias ligeras (favoritos y artículos cacheados).

## Limitaciones y notas

- La API externa necesita internet para obtener noticias nuevas; sin conexión solo se muestran artículos descargados previamente.
- Background Sync es compatible en navegadores Chromium (Chrome, Edge); para navegadores sin `SyncManager` (como Safari o Firefox), la PWA cuenta con un listener reactivo `window.online` y reintento manual mediante el botón.
- El almacenamiento JSON del backend es para demostración académica, no para producción multiusuario.
- No se deben guardar contraseñas ni datos personales sensibles en almacenamiento local.

## Pruebas sugeridas

| ID | Caso | Resultado esperado |
|---|---|---|
| PR-01 | Abrir la aplicación | Splash y después Home |
| PR-02 | Obtener noticias | Tarjetas cargadas desde API externa |
| PR-03 | Guardar favorito y recargar | Favorito persiste |
| PR-04 | Abrir tras haber cargado archivos y quedar offline | Shell de la PWA disponible |
| PR-05 | Crear nota offline | Nota guardada y marcada pendiente |
| PR-06 | Recuperar internet y sincronizar | Backend recibe el registro |
| PR-07 | Reenviar un ID existente | El servidor ignora duplicado |
| PR-08 | API externa no disponible | Se muestran noticias cacheadas o mensaje de error |

> Registrar los resultados reales (Aprobada/No aprobada) y las capturas después de ejecutar cada prueba; no marcar pruebas como aprobadas sin ejecutarlas.

## Funciones PWA añadidas (Service Worker, notificaciones y geolocalización)

- **Service Worker:** se registra en `app.js` (`registerServiceWorker`). Caché `cosmobitacora-static-v3`; al activarse borra cachés antiguas. Las actualizaciones **no** se imponen: la nueva versión queda en espera y la app muestra el aviso "Actualizar ahora", que envía `SKIP_WAITING` y recarga.
- **Sin conexión:** el shell (HTML, CSS, JS, manifest, icono) se precarga en la instalación. Los botones que dependen de internet (Actualizar noticias, Sincronizar, Consultar servidor) se atenúan y muestran un mensaje cuando no hay red.
- **Notificaciones locales (solo con botón):** *Mi bitácora* → "Activar notificaciones" pide el permiso y, al concederlo, muestra una notificación de confirmación. Después, "Notificarme la última noticia" muestra la primera noticia cargada. El Service Worker **no** dispara notificaciones por su cuenta; solo atiende el clic (`notificationclick`) para abrir o enfocar la app.
- **Geolocalización:** botón "Adjuntar mi ubicación" en el formulario de notas (`navigator.geolocation.getCurrentPosition`). Es opcional, explica los errores de permiso/tiempo/señal, guarda `{lat, lon, accuracy}` en IndexedDB y la envía al backend, que la valida (`sanitizeLocation`).
- **Noticias por ubicación (México):** al agregar la ubicación, la pestaña Noticias cambia a "Noticias de <lugar>". Con el botón de esa pestaña se alterna con las noticias espaciales (si aún no hay ubicación, la solicita). El backend expone `GET /api/news/local?lat=&lon=`: identifica el lugar con **Nominatim (OpenStreetMap)** (si falla, usa el estado mexicano más cercano) y busca noticias de los últimos 7 días en el **RSS de Google Noticias** configurado para México (`hl=es-419&gl=MX`); si Google falla, usa **GDELT DOC 2.0** como respaldo (`sourcecountry:MX sourcelang:spanish`). Prueba primero la ciudad, luego el estado y por último noticias generales de México. Las coordenadas se redondean a ~1 km, se cachea 10 minutos y los resultados se guardan en el dispositivo para consultarlos sin conexión.

### Compatibilidad y limitaciones conocidas

- Geolocalización y Service Worker requieren HTTPS o `localhost`.
- En iOS/Safari las notificaciones solo funcionan con la PWA instalada en la pantalla de inicio (iOS 16.4 o superior).
- Background Sync solo existe en navegadores Chromium; en los demás se usa el evento `online` y el botón manual.
- El enlace "Ver mapa" abre OpenStreetMap y requiere conexión.
- Las noticias por ubicación dependen de servicios públicos sin clave con límites de uso (Google Noticias RSS es para uso personal/académico; GDELT ~1 petición cada 5 s y responde HTTP 429 si se excede; Nominatim ~1 por segundo) y requieren Node 18+ en el servidor. Las notas no incluyen resumen ni imagen, solo título, fuente y fecha; en ciudades pequeñas puede devolver pocos resultados.
- No hay notificaciones push (servidor → dispositivo); son notificaciones locales.
