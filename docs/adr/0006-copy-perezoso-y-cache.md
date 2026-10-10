# 0006 — Copy perezoso, caché LRU y protección de espacio

**Estado:** aceptado · 2026-10-10 · reemplaza parcialmente [0002](0002-procesar-al-importar.md)

## Contexto
Medido en la biblioteca real (`docs/design/t47-data.md`): los 40 paquetes en modo copy (H.264 8 bits) ocupan 61,6 GB, una copia byte a byte de los originales (79 % de `data/`), y se regeneran en ~4 s con un remux. El re-encode (x264) sí es caro (3–6 min) y no se puede rehacer a la ligera.

## Decisión
1. **El modo copy ya no se procesa al importar.** El worker prueba el archivo, guarda sus pistas y lo deja `ready` sin paquete (`hls_dir` vacío, `pkg_mode = 'copy'`). El paquete se genera en el primer `POST /api/media-files/:id/play` (o la primera petición a `/api/stream`), por el camino de T4d: prioridad, ver mientras crece. Mientras tanto `/play` responde `202 { status: "processing", preparing: true }` y el player espera como siempre.
2. **Los paquetes x264 siguen en la cola al importar y nunca se expulsan.**
3. **Los paquetes copy son una caché regenerable** con presupuesto `CACHE_BUDGET_GB` (default 20). Al terminar de generar uno que supera el presupuesto, se expulsan los menos recientemente reproducidos (`last_played_at`, o la creación si nunca se reprodujo). Nunca se expulsa: x264, el que se acaba de generar, uno reproducido en los últimos 30 min, uno con trabajo pendiente, uno cuyo original no se puede leer (borrado o disco desmontado), ni un paquete de modo desconocido. Expulsar deja el archivo `ready` y se regenera en su próximo play. Antes de borrar se escribe en el log qué se expulsa y por qué.
4. **Protección de espacio.** Antes de escribir cualquier paquete (copy o x264) se mide el volumen del HLS (`statfs`). Tras escribir deben quedar libres al menos el mayor entre `MIN_FREE_GB` (default 10) y `MIN_FREE_PCT` % del volumen (default 10). Si no alcanza, primero se expulsa caché LRU, solo si con eso basta; si no, el worker se pausa con motivo `low_disk`: `/api/activity` expone `paused: true`, `lowDisk: true` y `lowDiskMessage`. Se reanuda solo cuando cabe el trabajo que se detuvo, o con reanudar manual (que vuelve a pausar si sigue sin espacio).
5. **Compatibilidad.** Los paquetes existentes se quedan. Al arrancar el worker se clasifican en segundo plano sondeando el original (copy → caché expulsable; x264 o sin original → nunca). No hay borrado al instalar: la primera expulsión ocurre solo cuando se genera un paquete copy y la caché supera el presupuesto.

## Consecuencias
- Importar masivo ya no copia ~1,0x del original por archivo; el espacio en `data/` pasa a ser solo lo que se reproduce.
- El primer play de un episodio copy espera ~4 s (más con HDD frío) y exige el original presente.
- Un original ausente al reproducir sigue marcando el archivo en `error` (ver deuda abajo).

## Resuelto en T47d
- Un original ausente por disco desmontado ya no pasa a `error`: el worker comprueba el marcador de biblioteca (`libraryId`) y `stat.dev`, reencola y se reanuda al volver el disco.
- `/api/stream` y `/play` responden 503 `disk_absent`. El reintento del player queda para el frontend.
