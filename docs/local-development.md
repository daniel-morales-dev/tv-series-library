# Arrancar en local sin confundir la biblioteca

Desde la raíz del repositorio:

```sh
npm run dev
```

La interfaz queda en **http://localhost:5174** y la API en **http://localhost:8080/api/health**. El lanzador (`scripts/dev.mjs`) ancla `DATA_DIR` y `CONTENT_DIR` a la raíz del repositorio —nunca al directorio desde el que llamaste—, comprueba los puertos antes de abrir SQLite, crea una copia de seguridad verificada si ya existe `data/library.db` e inicia backend y frontend juntos. **Ctrl+C detiene ambos procesos.** Que los procesos arranquen no prueba que la app esté lista: confirma la salud HTTP (sección 4).

> **Antes de abrir una biblioteca existente:** el backend migra SQLite automáticamente, incluso con `INGEST=off PROCESSING=off`. La BD conservada está en esquema 4; el código actual aplicará la migración **005** (`titles.seasons_group_id`). El lanzador hace la copia antes de abrir, pero **arrancar equivale a aprobar la migración**: para la primera recuperación usa el arranque sin trabajadores de la sección 3 y no reproduzcas ni reescanees. Esta guía no ejecuta ni autoriza la recuperación.

## 1. Comprobar puertos

Antes de arrancar, identifica quién ocupa los puertos:

```sh
ss -ltnp '( sport = :8080 or sport = :5173 or sport = :5174 )'
```

En el diagnóstico del 2026-10-09, **5173 pertenecía a otro proyecto** y esta app usa 5174. Si 8080 o 5174 están ocupados, `npm run dev` falla **antes** de abrir o copiar la base, con el puerto y la instrucción de detener solo tu proceso. No lances otro proceso ni mates el proyecto ajeno: el lanzador jamás termina procesos que no inició él.

## 2. Copia de seguridad de SQLite

Si existe `data/library.db`, el lanzador crea automáticamente una copia consistente antes de cada arranque: origen de solo lectura y la API de backup de SQLite (incorpora los datos confirmados en WAL), destino **único** en `data/recovery/before-start-*/library.db` (nunca sobrescribe una copia anterior) y verificación `PRAGMA integrity_check`. Si algo falla, **no arranca** y lo explica. Al prepararla imprime la ruta:

```
Copia SQLite verificada (solo base de datos, no videos ni HLS): /ruta/data/recovery/...
```

Guarda esa ruta. **La copia protege SQLite, no los videos ni todos los HLS**; conserva también el resto de `data/` y `content/`. **No copies únicamente `library.db` con `cp` mientras hay un servidor abierto:** datos recientes pueden estar en `library.db-wal` y una copia suelta no es una instantánea consistente.

Bloque manual, solo si quieres preparar la copia **sin arrancar** la app (por ejemplo, antes de aprobar la migración). No migra ni modifica registros del origen; si la BD no existe, falla sin crear otra en su lugar:

```sh
python3 - <<'PY'
from pathlib import Path
import sqlite3
import tempfile

source = Path("data/library.db").resolve(strict=True)
recovery = Path("data/recovery")
recovery.mkdir(parents=True, exist_ok=True)
destination = Path(tempfile.mkdtemp(prefix="before-start-", dir=recovery)) / "library.db"
with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as original:
    with sqlite3.connect(destination) as backup:
        original.backup(backup)
        result = backup.execute("PRAGMA integrity_check").fetchall()
        if result != [("ok",)]:
            raise RuntimeError(f"Copia no válida: {result}")
print(f"Copia SQLite verificada: {destination.resolve()}")
PY
```

## 3. Primer arranque de recuperación, sin trabajadores

**Solo tras verificar la copia y aprobar explícitamente el arranque/migración:**

```sh
INGEST=off PROCESSING=off npm run dev
```

Este modo evita el escaneo automático y la cola de ffmpeg; **no es un servidor de solo lectura**: abre SQLite, migra y las acciones de la UI pueden escribir. Para comprobar el catálogo usa únicamente los GET de la sección siguiente; no reescanees ni reproduzcas archivos en cola durante esta revisión. El frontend también arranca, pero solo para consultar.

## 4. Comprobar la API, sin mutaciones

Con el backend ya aprobado y en marcha, estos comandos solo hacen GET:

```sh
curl --fail-with-body -i http://localhost:8080/api/health
curl --fail-with-body -i http://localhost:8080/api/titles
curl --fail-with-body -i http://localhost:8080/api/profiles
curl --fail-with-body -i http://localhost:5174/api/health
```

Espera HTTP 200; health devuelve `{"ok":true}`. Un catálogo vacío con HTTP 200 **no prueba** que los videos o la BD anterior hayan desaparecido. `/api` por sí sola responde **404 por diseño**: no es la ruta de salud ni una página de la interfaz. Un 404 en `/` de 8080 puede indicar que no existe el frontend compilado; en desarrollo abre 5174.

## 5. Uso habitual, después de resolver la recuperación

```sh
npm run dev
```

La ingesta y el procesamiento están habilitados por defecto, salvo que el entorno o `.env` los desactiven. La ingesta escanea y vigila los videos, guarda el catálogo y consulta TMDB cuando corresponde; la cola convierte archivos a HLS con ffmpeg y **puede consumir CPU y espacio**. No habilites ese trabajo como primer intento de arreglar una biblioteca vacía. Para cerrar la sesión basta **Ctrl+C una vez**: el lanzador detiene ambos árboles de procesos. Reiniciar el PC no inicia la app automáticamente: el autoarranque Linux sigue pendiente en **T7**.

## Por qué había perfiles y catálogo vacíos

Los scripts de workspace ejecutan Node con directorio de trabajo `apps/server` y cargan `../../.env` desde allí. Sin embargo, `CONTENT_DIR=./content` y `DATA_DIR=./data` se interpretan respecto a ese directorio, **no respecto al archivo `.env`**. Por eso el backend abrió otra BD. Con `npm run dev`, el lanzador convierte esas variables a rutas absolutas ancladas a la raíz del repositorio antes de iniciar los procesos, así que este error de directorio no puede repetirse; para comandos directos de workspace sigue aplicando el consejo anterior de usar `$PWD` desde la raíz. Las rutas de `.env` pueden seguir siendo relativas.

| Ubicación | Qué conserva |
|---|---|
| `content/` (`CONTENT_DIR`) | Videos originales; tenerlos no equivale a tener un catálogo en SQLite. |
| `data/library.db` (`DATA_DIR`) | Títulos, archivos indexados, perfiles, Mi lista y progreso. |
| `data/hls/` y resto de `data/` | Video procesado, subtítulos, fuentes e imágenes; mantenlos junto a su BD, cuyos ids referencian los HLS. |
| `data/recovery/` | Copias automáticas de SQLite antes de cada arranque; puedes borrar las antiguas, no la más reciente que quieras conservar. |

**Instantánea del diagnóstico, no una promesa de recuperación:**

- `apps/server/data/library.db`: esquema 5, 0 títulos, 0 archivos indexados y 1 perfil.
- `data/library.db` de la raíz: esquema 4, 2 títulos (Monogatari y Frieren), 67 archivos indexados, 3 perfiles y 2 registros de progreso conservados.
- Monogatari: sus 34 videos siguen presentes. Frieren: las 33 rutas antiguas de Cifer no existen; los videos actuales son lotes SubsPlease (S01: 28, S02: 10). Danmachi tiene 1 video nuevo sin indexar.

**Recuperar el catálogo no garantiza recuperar la reproducción.** Las referencias antiguas de Frieren no se arreglan cambiando `DATA_DIR`; tampoco se ha probado aquí la reproducción de Monogatari. No borres bases, no renombres videos ni reescanees como remedio automático: reconciliar los reemplazos y conservar el progreso requiere un paso separado aprobado.

## Instalación nueva, sin biblioteca previa

Necesitas Node.js **24 o superior**, npm y ffmpeg/ffprobe (Python 3 con `sqlite3` solo para la copia manual de la sección 2). El entorno de referencia usa Node 24.14. Comprueba sin instalar:

```sh
node --version
npm --version
command -v ffmpeg ffprobe python3
```

Desde la raíz, instala las dependencias según el lockfile y crea **tú mismo** las carpetas de trabajo:

```sh
npm ci
mkdir -p content data
```

El lanzador **no crea** `content/` ni `data/`: si no existen, falla con un mensaje claro en vez de fabricar una biblioteca vacía (por ejemplo, en un disco desconectado). En una instalación nueva créalas a propósito, como arriba.

Crea `.env` desde `.env.example` **únicamente si no existe**; no sustituyas el de una instalación previa. Configura `TMDB_READ_ACCESS_TOKEN` de forma privada (esta instalación ya lo tiene). Nunca imprimas el token ni subas `.env`. Sin token, la ingesta funciona sin metadata de TMDB y la reintenta cuando esté disponible. Después usa `npm run dev`. No uses `seed` para reparar una biblioteca existente.

## Servir el frontend compilado desde 8080

Alternativa confirmada por los scripts y el servidor, no ejecutada en esta documentación. Se aplican **las mismas precauciones de copia y aprobación**; para la primera recuperación usa antes el modo sin trabajadores. Desde la raíz, para uso habitual:

```sh
npm run build -w apps/web
PORT=8080 CONTENT_DIR="$PWD/content" DATA_DIR="$PWD/data" \
  WEB_DIR="$PWD/apps/web/dist" npm start -w apps/server
```

Abre **http://localhost:8080**; aquí no necesitas Vite. `WEB_DIR` es absoluto y apunta al resultado de la compilación. Para LAN, la URL usa la IP de la laptop en vez de `localhost`; la validación en celular/TV (**T6d**) y el empaquetado/autoarranque (**T7**) siguen pendientes.

Siguiente paso: revisar la copia y aprobar el arranque controlado (T18b); consultar el estado en [el documento de tareas](../odd/tasks/tv-series-library.md).
