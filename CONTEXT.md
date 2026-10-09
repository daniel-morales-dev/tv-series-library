# Glosario

Lenguaje común del proyecto. Código en inglés (término entre paréntesis), documentación en español.

- **Título** (`Title`): obra del catálogo: película, serie o anime. Evitar: "show", "contenido".
- **Tipo** (`kind`): `movie`, `series` o `anime`. Anime se detecta automáticamente (animación + origen JP) y es editable.
- **Saga** (`Collection`): grupo de películas relacionadas (ej. Harry Potter). Equivale a una colección de TMDB.
- **Temporada** (`Season`): agrupación de episodios de una serie. La temporada 0 contiene especiales.
- **Episodio** (`Episode`): unidad reproducible de una temporada.
- **Extra** (`Extra`): video no numerado como episodio (openings, endings, comentarios). No cuenta para el progreso.
- **Archivo** (`MediaFile`): video físico en disco asociado a un episodio, película o extra. Un archivo no es un título.
- **Pendiente** (`Pending`): archivo detectado que aún no tiene título confirmado. Debe confirmarse en la pantalla Pendientes.
- **Procesar** (`process`): convertir un archivo a HLS con ffmpeg para reproducirlo en cualquier navegador. Ocurre una sola vez, al importar.
- **Perfil** (`Profile`): persona que usa la app. Sin contraseña. Tiene su propia Mi lista, progreso y preferencias.
- **Mi lista** (`MyList`): títulos guardados por un perfil.
- **Progreso** (`WatchProgress`): segundo en que un perfil quedó en un archivo. Visto al llegar al 90%.
- **Continuar viendo**: títulos con progreso incompleto o con siguiente episodio disponible, sin ocultar.
- **Terminado** (`finished`): título marcado como visto completo por el perfil, manual o automáticamente.
