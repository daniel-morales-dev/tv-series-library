# TV Series Library

Plataforma local para ver tus películas, series y anime desde cualquier dispositivo conectado a tu WiFi (TV, celular, tablet o PC). Sin anuncios ni cuentas, con perfiles, Mi lista y Continuar viendo.

> Estado: en construcción (Fase 1: fundación). Ver el plan en [`odd/tasks/tv-series-library.md`](odd/tasks/tv-series-library.md).

## Cómo agregar contenido

Coloca los videos dentro de `content/`:

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
- Los archivos que aún se están descargando se ignoran hasta que estén completos.
- Openings, endings y comentarios se guardan como **extras**, no como episodios.
- Lo que la app no reconozca con seguridad aparece en **Pendientes** para que lo confirmes.

## Configuración

1. Copia `.env.example` como `.env`.
2. Pega tu *Read Access Token* de TMDB en `TMDB_READ_ACCESS_TOKEN`. Nunca lo subas a git.

## Documentación

- [Glosario](CONTEXT.md)
- [Decisiones de arquitectura](docs/adr/)
