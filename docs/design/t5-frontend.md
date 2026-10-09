# T5 — Diseño de la UI completa

Reemplaza las pantallas temporales de T6b. Referencias del dueño: Netflix (estructura de inicio, filas, Mi lista) y Crunchyroll (Seguir viendo con "Xm restantes", Mis listas en grilla).

## Dirección visual
- Identidad propia sobre la estructura de Netflix/Crunchyroll: fondo casi negro, tarjetas redondeadas, un solo color de acento como token (`--accent`), fácil de cambiar en una línea.
- Tema oscuro por defecto y claro opcional (tokens en `:root` y `[data-theme="light"]`), guardado por perfil en `localStorage`.
- Tipografía del sistema (offline-first), tamaños pensados para verse a 3 m en la TV.
- Responsive: celular (1 columna, filas deslizables con el dedo), PC y TV (1080p).

## Estructura
1. **Perfiles** (`/`): avatares grandes con inicial y color, "¿Quién está viendo?", agregar y administrar perfiles.
2. **Header** fijo: logo, Inicio, Series, Películas, Anime, Mi lista; búsqueda con autocompletado (`/api/search/suggest`); menú de perfil (cambiar perfil, tema). Se vuelve sólido al hacer scroll.
3. **Inicio** (`/browse`):
   - Hero con el `backdrop` y el `logo` (o el título), géneros, año, sinopsis corta, botones **Reproducir / Continuar** y **Más info**; rota entre algunos títulos.
   - Filas horizontales: **Continuar viendo** (miniatura, barra de progreso, "Xm restantes", T·E y nombre del episodio, menú ⋮ → *Quitar de Continuar viendo*), **Mi lista**, **Agregados recientemente**, una fila por **género**.
   - Tarjeta: póster o backdrop; al enfocar/hover crece y muestra Reproducir, + Mi lista y Más info.
4. **Título** (`/title/:id`): hero con backdrop, Reproducir/Continuar (siguiente episodio según el progreso), + Mi lista, marcar como terminado; selector de temporada; episodios con miniatura (`still`), duración, sinopsis, barra de progreso y estado de procesamiento; extras aparte; reparto.
5. **Mi lista** (`/my-list`): grilla como Crunchyroll, con quitar.
6. **Series / Películas / Anime** (`/browse/:kind`): grilla con filtros de género, año y orden.
7. **Búsqueda** (`/search?q=`): resultados en grilla.
8. **Player**: el de T6c, sin cambios de lógica.

## Navegación con control remoto (TV)
Navegación espacial con flechas entre elementos enfocables (filas, tarjetas, header), foco visible y grande, Enter = activar, Atrás/Escape = volver. Sin librerías si un módulo pequeño basta.

## API (ya existe desde T2/T3)
Perfiles, `GET /titles` (kind, genre, year, sort), detalle, `GET /search/suggest`, Mi lista (`GET/PUT/DELETE /profiles/:pid/my-list/...`), `GET /profiles/:pid/continue-watching`, `DELETE .../continue-watching/:titleId`, `PUT .../titles/:id/finished`, imágenes en `/api/images/...`. Los géneros se derivan de los títulos.

## Subtareas
- T5a Base: tokens, tema, layout, header con búsqueda, perfiles, rutas nuevas.
- T5b Inicio: hero, filas, tarjetas, Continuar viendo con quitar.
- T5c Página de título.
- T5d Mi lista, Series/Películas/Anime con filtros y Búsqueda.
- T5e Navegación espacial para TV y responsive fino.

## Pruebas
Lógica pura (tiempo restante, hero, agrupación por género, navegación espacial) con vitest. Lo visual se revisa en el navegador; la prueba en dispositivos es T6d, al final.
