# 0002 — Procesar los videos al importar

**Estado:** aceptado · 2026-10-08

## Contexto
Los navegadores (sobre todo Chrome y los de TV) no reproducen MKV, HEVC, FLAC ni subtítulos ASS, y no permiten cambiar la pista de audio de un MKV.

## Decisión
Cada archivo se procesa una sola vez al importarlo con ffmpeg y se convierte a HLS con una variante por pista de audio y subtítulos en WebVTT.
- Video H.264 de 8 bits: se copia sin recodificar (`-c:v copy`).
- H.264 de 10 bits (High 10, típico en anime BD), HEVC y otros: se transcodifican a H.264 8 bits a la resolución nativa (`libx264 -preset veryfast -crf 20`). Medido: ~3 min por episodio de 24 min a 1080p en la laptop del dueño (16 núcleos).
- Audio que no sea AAC (FLAC, DTS, etc.): se transcodifica a AAC.
- El archivo original se conserva (puede seguir compartiéndose por torrent).

## Alternativas descartadas
- Transcodificar en vivo: alto uso de CPU en cada reproducción y adelantar el video es más lento.
- Solo direct play: no permite cambiar doblaje en Chrome.

## Consecuencias
- Esperar un tiempo al importar y usar ~1,2x de espacio en disco.
- Reproducción instantánea en cualquier dispositivo.
- Los estilos de los subtítulos ASS se pierden al pasar a WebVTT. Se guarda el `.ass` original y sus fuentes junto al HLS para sumar después un renderizador ASS en el navegador (ej. JASSUB) sin reprocesar.

## Actualización 2026-10-09
Los archivos reales (Bakemonogatari, Coalgirls BD) son H.264 High 10: no se pueden copiar. El dueño eligió 1080p nativo y WebVTT con cabida para ASS a futuro.
