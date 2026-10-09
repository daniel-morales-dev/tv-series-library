# 0002 — Procesar los videos al importar

**Estado:** aceptado · 2026-10-08

## Contexto
Los navegadores (sobre todo Chrome y los de TV) no reproducen MKV, HEVC, FLAC ni subtítulos ASS, y no permiten cambiar la pista de audio de un MKV.

## Decisión
Cada archivo se procesa una sola vez al importarlo con ffmpeg y se convierte a HLS con una variante por pista de audio y subtítulos en WebVTT.
- Video H.264: se copia sin recodificar (`-c:v copy`).
- Otros códecs (HEVC, etc.): se transcodifican a H.264.
- Audio que no sea AAC (FLAC, DTS, etc.): se transcodifica a AAC.
- El archivo original se conserva (puede seguir compartiéndose por torrent).

## Alternativas descartadas
- Transcodificar en vivo: alto uso de CPU en cada reproducción y adelantar el video es más lento.
- Solo direct play: no permite cambiar doblaje en Chrome.

## Consecuencias
- Esperar un tiempo al importar y usar ~1,2x de espacio en disco.
- Reproducción instantánea en cualquier dispositivo.
- Los estilos de los subtítulos ASS se pierden al pasar a WebVTT.
