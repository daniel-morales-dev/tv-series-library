# T6 — Diseño del player básico

Meta: primer hito verificable del MVP — ver un episodio desde el celular **y** la TV por WiFi, con el router sin internet.

## Alcance
- Nueva app `apps/web`: Vue 3 + Vite + vue-router + hls.js. Todo empaquetado (sin CDN); fuentes del sistema.
- Pantallas **mínimas y temporales** (T5 las reemplaza con la UI completa):
  - `/` elegir perfil (si no hay ninguno, crear uno con solo nombre). El perfil elegido se guarda en `localStorage`.
  - `/titles` lista simple de títulos.
  - `/titles/:id` temporadas → episodios y extras, cada uno con su estado (listo, procesando N %, en cola, error).
  - `/watch/:mediaFileId` el player.
- Fuera de alcance: hero, filas, búsqueda, filtros, tema, navegación espacial (T5); renderizador ASS.

## Player
- `<video>` + hls.js (MSE). Si el navegador reproduce HLS nativo (Safari/iOS: `canPlayType('application/vnd.apple.mpegurl')`), se usa `video.src` directo.
- Entrada: `POST /api/media-files/:id/play`. Si responde `processing`, se muestra el avance (`GET /api/jobs`) y se reintenta `master.m3u8` cada 2 s hasta que responda 200; la playlist `EVENT` crece y solo se puede adelantar hasta lo ya procesado.
- Audio: `hls.audioTracks` (nombres desde `master.m3u8`). Subtítulos: archivos `.vtt` sueltos → `<track kind="subtitles" src="/api/stream/:id/subs/N.vtt">`, uno por pista `supported`; por defecto el primero en español si existe, si no ninguno.
- Controles nativos del `<video>` + un menú propio para audio y subtítulos. Teclado/control remoto: espacio/Enter pausa, ←/→ ±10 s.
- Progreso: `PUT /api/profiles/:pid/progress` cada 10 s mientras reproduce, al pausar y al salir (`fetch` con `keepalive`).
- Reanudar: desde `progress` del detalle del título; si está `completed` o en < 10 s, empieza en 0.
- Siguiente episodio: orden temporada → episodio del detalle; al terminar, cuenta regresiva de 10 s (cancelable) y navega al siguiente archivo.

## Backend
- Detalle del título: incluir los archivos en **cualquier** estado con su `status` (hoy solo `ready`), para poder dar play a uno que se está procesando. Confirmar que `subtitle_tracks` ya está en la BD cuando empieza el video (los subs se extraen antes, T4d1); si no, guardarlo en ese momento.
- Servir `apps/web/dist` en `/` con `sendFile` y fallback a `index.html` para rutas del SPA (`WEB_DIR`, por defecto `../web/dist`). `/api/*` intacto.
- Desarrollo: `vite` con proxy de `/api` al servidor.

## TV (TCL C635, Google TV)
Google TV no trae Chrome. En la verificación (T6d) probar un navegador de Play Store con MSE (p. ej. TV Bro); si falla, evaluar app WebView o Cast como paso aparte.

## Subtareas
- T6a Backend: archivos de cualquier estado en el detalle + servir la web + tests.
- T6b `apps/web`: andamiaje, cliente API y pantallas mínimas (perfil, títulos, detalle).
- T6c Player: play/espera, hls.js, audio/subs, progreso, reanudar, siguiente episodio.
- T6d Verificación real: celular y TV por WiFi, con un archivo listo y otro en proceso.

## Pruebas
- Backend: vitest (detalle con estados, fallback SPA, `/api` no afectado, `..` → 404).
- Web: vitest para la lógica pura (posición de reanudar, siguiente episodio, pista de subtítulos por defecto). El resto se verifica en dispositivos reales.
