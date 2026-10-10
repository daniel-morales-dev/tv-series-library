# T47 — `data/` junto a la biblioteca y más liviana

Informe de investigación (2026-10-10, solo lectura, medido sobre la biblioteca real). **Decisión aprobada por el dueño (2026-10-10):** copy perezoso + caché LRU y opción B (ver Ubicación).

## Casos de uso objetivo
1. Usuarios sin HDD: todo queda en la máquina.
2. Usuarios que empiezan directo en HDD.
3. Usuarios como el dueño: empiezan en la máquina y luego pasan a HDD.

## Medido
- `data/` = 78,2 GB; `content/` = 87,2 GB; mismo disco (79 GB libres, 83 % lleno).
- Video HLS 95,5 %, audio 4 %, fuentes 0,5 %, subtítulos/imágenes/BD ≈ 0.
- **Modo copy** (H.264 8 bits): 40 archivos, 61,8 GB originales → 61,6 GB de HLS (ratio 1,00). Es el 79 % de `data/`: copia byte a byte del original.
- Bakemonogatari (10 bits → x264 CRF 20): ratio 0,46. HEVC (Danmachi) → x264 CRF 20: ratio **1,30** (pesa más que el original).
- Fuentes: 1066 archivos, 126 únicos (419 MB → 74 MB).
- 6 paquetes `ready` truncados (originales Cifer ya borrados): 0,5 GB.
- Existe `apps/server/data/library.db` sobrante (default relativo `./data`).
- Remux copy de un episodio de 1,5 GB a HLS: **4,2 s** (vs 3–6 min de re-encode).

## Opciones de ahorro
| Opción | Ahorro | Costo |
|---|---|---|
| Copy perezoso + caché LRU con presupuesto | hasta ~61,6 GB | ~4 s en el primer play; requiere original disponible |
| Fuentes únicas por hash | 345 MB | ninguno |
| Purgar huérfanos truncados (con confirmación) | 0,5 GB | ninguno |
| Bakemonogatari CRF 24 (+`-tune animation`) | ~3,3–3,9 GB | SSIM −0,003/−0,005 |
| HEVC CRF 24 | ~3,3 GB | SSIM −0,002 |
| 720p opcional | −54 % al mismo CRF | pierde nitidez en TV |
| preset medium/slow | −19/−24 % | 1,8×/3,4× CPU: no conviene |

Bajar solo el bitrate ahorra ~7–9 GB (~10 %); lo grande es no duplicar lo ya compatible. Cambia el ADR 0002 ("procesar una vez al importar") → ADR 0006.

## Ubicación (aprobada: opción B)
- **Estado local** (BD, imágenes, recovery; ~27 MB) fuera del repo: `~/.local/share/sala/` (Linux) / `%LOCALAPPDATA%\sala\data` (Windows).
- **HLS** en `<contenido>/.sala/hls/`, junto a `.sala-library.json`: viaja con el disco y se reconoce por `libraryId`.
- Descartadas: todo en el disco (SQLite WAL frágil en HDD/USB y el catálogo desaparece con el disco, viola T9); `dataDir` configurable como camino principal (dos punteros que se desincronizan; solo válvula avanzada).
- **Disco ausente:** nunca crear `.sala/` sin marcador con `libraryId` coincidente (hoy `configStatus` crea un marcador nuevo: cambiar); `stat.dev` distinto del padre; `/api/stream` 503 `disk_absent`; un original ausente por disco desmontado no pasa a `error` ni a `requeueErrors`.
- **Migración:** misma partición → rename/hardlink por paquete (copiar 78 GB no cabe); otro FS → copia por paquete a `.tmp`, verificar, renombrar; origen solo se borra con confirmación. `meta.json` por paquete (ruta relativa + tamaño del original) para re-adoptar en otra máquina. Hacer antes el copy perezoso (migra ~17 GB en vez de 78).
- Vigilar con el watcher solo `shows/` y `films/` (no `.sala/`).
- Cambiar la carpeta en Ajustes exige resolvedor en vivo o reinicio.

## Tareas (≈ 22 pts)
- T47a (3, en curso) resolvedor `stateDir`/`libraryDir`; BD e imágenes fuera del repo con migración; unit/lanzador/backup/`index.ts` lo usan; eliminar la BD sobrante.
- T47b (2, en curso) fuentes por hash, purga de huérfanos con dry-run y confirmación, informe.
- T47c (5) copy perezoso + LRU + presupuesto + ADR 0006.
  - Presupuesto de caché configurable con default seguro. El LRU expulsa solo cachés regenerables (copy); nunca paquetes x264 ni originales.
  - Comprobar espacio libre antes de generar una caché de copy.
- T47d (5) HLS bajo `.sala/hls` + guardián de disco ausente + watcher acotado.
  - Comprobar espacio libre antes de procesar (encode/HLS). Si el espacio libre baja del umbral (referencia: 10 % o 10 GB), el worker pausa el procesado y muestra un aviso claro en Actividad; nunca llena el disco.
- T47e (5) migración (rename/hardlink o copia verificada) + UI "mover datos con la biblioteca".
  - Flujo guiado en Ajustes y por CLI `sala` (T45): elegir destino → verificar espacio → mover → verificar → confirmar → liberar origen. Reanudable.
  - Nunca borrar el origen sin confirmación explícita; el origen queda intacto hasta confirmar.
  - Comprobar espacio libre en el destino antes de empezar, con el mismo umbral de T47d.
- T47f (2) perfil de encode nuevo (CRF 23–24 + animation; tope para HEVC) solo para nuevos.

## Riesgos
1. T47c cambia "reproducción instantánea" por ~4 s la primera vez (más con HDD frío) y exige el original presente.
2. BD local y HLS separados pueden desincronizarse → `meta.json` + verificación al arrancar.
3. CRF alto puede dar bandas en degradados oscuros (10→8 bits): mirar una escena oscura antes de fijar.
4. Migración interrumpida: el origen intacto hasta confirmar.
5. Medidas con clips de 60 s; el ahorro varía por episodio (0,28–0,85).
