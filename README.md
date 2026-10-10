# TV Series Library

Plataforma local para ver tus películas, series y anime desde cualquier dispositivo conectado a tu WiFi (TV, celular, tablet o PC). Sin anuncios ni cuentas, con perfiles, Mi lista y Continuar viendo.

> **Arranque local:** `npm run dev` desde la raíz inicia backend (8080) y frontend (5174), con copia SQLite verificada y parada conjunta con `Ctrl+C`. Guía y aviso de copia/migración: [docs/local-development.md](docs/local-development.md). Si ya tienes biblioteca, lee ese aviso **antes de iniciar el backend**.
>
> Estado: en construcción. Ver el plan en [`odd/tasks/tv-series-library.md`](odd/tasks/tv-series-library.md).

## Cómo agregar contenido

Coloca los videos dentro de la carpeta de contenido (`content/` por defecto, o la que elijas en la primera ejecución):

```
content/
├── films/      películas (un archivo o una carpeta por película)
└── shows/      series y anime (una carpeta por título)
    └── bakemonogatari/
        └── cualquier/subcarpeta/episodio_01.mkv
```

- **No hace falta renombrar.** La app busca en subcarpetas y deduce el título, la temporada y el episodio a partir de los nombres.
- **Si estás compartiendo un torrent (seeding), no renombres ni muevas los archivos**: el cliente torrent dejaría de encontrarlos.
- Descarga el torrent directamente en `content/shows/` o `content/films/`.
- Los archivos aún en descarga que se puedan identificar aparecen como **Próximamente**; los demás esperan hasta poder importarse.
- Openings, endings y comentarios se guardan como **extras**, no como episodios.
- Lo que la app no reconozca con seguridad aparece en **Pendientes** para que lo confirmes.

## Configuración

La app guarda la carpeta donde está tu contenido en su propia configuración (`~/.config/sala/config.json` en Linux, `%LOCALAPPDATA%\sala` en Windows); puedes cambiarla en Ajustes. No edites ese archivo a mano. Hasta que llegue el asistente de primera ejecución (T22b), el valor por defecto es `content/` y puedes fijar otro con la API de configuración.

1. Solo en una instalación nueva y **solo para desarrollo**, crea `.env` desde `.env.example` **sin sobrescribir uno existente**. `CONTENT_DIR` ahí es opcional: tu elección en la app tiene prioridad.
2. Configura tu *Read Access Token* de TMDB en `TMDB_READ_ACCESS_TOKEN`. Esta instalación ya lo tiene; no lo imprimas ni lo subas a git.

## Documentación

- [Glosario](CONTEXT.md)
- [Decisiones de arquitectura](docs/adr/)
