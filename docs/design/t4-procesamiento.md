# T4 — Diseño del procesamiento

Convierte cada archivo registrado por la ingesta (`media_files.status = 'pending'`) a HLS reproducible en cualquier navegador. Ocurre una sola vez por archivo. Ver ADR 0002.

## Plan (función pura, a partir de `ffprobe`)
- **Video** (primer stream de video):
  - Copiar (`-c:v copy`) solo si es H.264 de 8 bits (`pix_fmt` `yuv420p`/`yuvj420p`) con perfil Baseline, Main o High.
  - Si no (High 10, HEVC, etc.): `libx264 -preset veryfast -crf 20 -pix_fmt yuv420p`, resolución nativa, keyframe cada ~2 s para segmentos limpios.
- **Audio**: una variante por pista. AAC y MP3 se copian; el resto (FLAC, DTS, AC3, Opus…) → AAC: estéreo a 192k, multicanal a 384k (máximo 6 canales).
- **Subtítulos de texto** (`ass`, `ssa`, `subrip`, `mov_text`, `webvtt`): cada pista → `subs/<n>.vtt`. Si es ASS/SSA, además se guarda `subs/<n>.ass` sin tocar.
- **Fuentes adjuntas** (`attachment`, TTF/OTF): se extraen a `fonts/` (para el renderizador ASS futuro).
- **Subtítulos de imagen** (PGS, DVD): se omiten y quedan registrados como no soportados.

## Salida
`DATA_DIR/hls/<mediaFileId>/`:
```
master.m3u8          # video + grupo de audio (EXT-X-MEDIA con LANGUAGE y NAME)
v/  …                # playlist y segmentos fMP4 del video (6 s, VOD)
a<n>/ …              # una playlist por pista de audio
subs/<n>.vtt  subs/<n>.ass
fonts/*.ttf
```
- Un solo `ffmpeg` para video + audios (`-var_stream_map` con `agroup`, `-hls_segment_type fmp4`, `-master_pl_name master.m3u8`). Subtítulos y fuentes en pasos aparte (rápidos).
- Se escribe en `<id>.tmp/` y se renombra al terminar. Si falla, se borra el temporal.
- `media_files.audio_tracks` y `subtitle_tracks` se completan con la ruta de salida (`playlist`, `vtt`, `ass`) y `supported`.

## Cola de jobs
- Tabla `jobs` existente, `type = 'process'`. Un job a la vez (`PROCESS_CONCURRENCY`, default 1).
- Orden: episodios antes que extras, luego por antigüedad.
- La ingesta encola cada archivo nuevo. Al arrancar: los `running` vuelven a `queued` y se encolan los `pending` sin job.
- Progreso desde `ffmpeg -progress pipe:1` (`out_time_us / duración`), guardado en `jobs.progress` como máximo una vez por segundo.
- `media_files.status`: `pending` → `processing` → `ready` (con `hls_dir`) o `error` (con mensaje).
- Si el archivo original ya no existe, el job termina en `error` sin reintentar.
- `PROCESSING=off` desactiva el worker.

## API
| Método y ruta | Comportamiento |
|---|---|
| `GET /api/jobs` | Cola actual y recientes, con progreso y archivo |
| `POST /api/media-files/:id/process` | Reencola (reprocesar) |
| `GET /api/stream/:mediaFileId/*` | Sirve la carpeta HLS (ruta validada, sin `..`; tipos `application/vnd.apple.mpegurl`, `video/mp4`, `text/vtt`) |

## Pruebas
- Plan: tabla de casos (H.264 8 bits → copy; High 10 → x264; FLAC → AAC; AAC → copy; ASS → vtt + ass; PGS → omitido).
- Cola y estados con `ffmpeg` inyectado (éxito, fallo, reinicio a mitad).
- Verificación real: procesar el episodio 01 de Bakemonogatari y un OP (no los 34). Comprobar con `ffprobe` que `master.m3u8` abre, video H.264 8 bits 1080p, audio AAC, duración igual al original y `.vtt` con texto.
