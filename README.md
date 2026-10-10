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

## Correrlo en Linux (laptop) y verlo desde celular y TV

Requisitos: Node.js 24 o superior, npm y ffmpeg. No hace falta internet, pero celular y TV deben estar en la **misma WiFi** que la laptop.

1. **Instalar dependencias y compilar la web**, desde la raíz del repo:
   ```sh
   npm ci
   bash scripts/linux-install.sh
   ```
   El script compila la web y escribe `~/.config/systemd/user/sala.service`. No usa sudo ni habilita nada.

2. **Activar el servicio:**
   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now sala
   ```

3. **Arrancar al encender, sin iniciar sesión** (único paso con sudo de esta guía):
   ```sh
   sudo loginctl enable-linger "$USER"
   ```

4. **Firewall, solo si ufw está activo.** Primero revisa el estado:
   ```sh
   sudo ufw status
   ```
   Si dice `inactive`, sáltate este paso. Si dice `active`, averigua tu subred LAN:
   ```sh
   ip -4 -o addr show scope global
   ```
   Con tu subred (por ejemplo `192.168.1.0/24`), abre el puerto solo para ella:
   ```sh
   sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp comment 'sala'
   ```
   No abras a `any`: la app no tiene autenticación.

5. **Conectar celular y TV.** En la laptop abre http://localhost:8080, ve a **Ajustes** (menú del perfil) y en **Ver desde el celular o la TV** escanea el QR con el celular, o escribe la URL en la TV. Si aparecen varias URL (Ethernet y WiFi), usa la de la red WiFi.

6. **Reservar la IP de la laptop en el router** (una vez): busca la reserva DHCP o IP fija por MAC y asigna la IP que muestra Ajustes. Así la URL y el QR no cambian.

7. **Operación:**
   - Estado: `systemctl --user status sala`
   - Logs: `journalctl --user -u sala -f`
   - Parar: `systemctl --user stop sala`
   - Reiniciar: `systemctl --user restart sala`
   - Actualizar: `git pull`, luego `npm ci`, `bash scripts/linux-install.sh` y `systemctl --user restart sala`

> **Aviso:** el servicio `sala` y `npm run dev` comparten el puerto 8080.
> - Con el servicio activo, `npm run dev` se niega a correr. Antes de desarrollar: `systemctl --user stop sala`.
> - Al detener el servicio, la app deja de responder (celular y TV) hasta que ejecutes `systemctl --user start sala`.
> - Detener `npm run dev` **no** arranca el servicio: hazlo tú con `systemctl --user start sala`.
> - Para saber si está corriendo: `systemctl --user status sala` (`inactive (dead)` = detenido).

### Desarrollo vs producción

- `npm run dev`: **solo desarrollo**. Backend con `--watch` (8080) + Vite (5174); la interfaz está en http://localhost:5174.
- `npm start`: **producción**. Construye `apps/web/dist` si falta o está viejo respecto al código web y corre solo el servidor (sin watch ni Vite) en http://localhost:8080, con las mismas guardias de puerto, carpeta de datos y copia SQLite que `dev`. El servicio `sala` ejecuta el mismo servidor y la misma carpeta `apps/web/dist` (la web la construye `scripts/linux-install.sh`).

## Documentación

- [Glosario](CONTEXT.md)
- [Decisiones de arquitectura](docs/adr/)
