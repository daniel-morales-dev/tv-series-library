# T7 — Empaquetado Linux (diseño)

Objetivo #1 del proyecto: la laptop del dueño sirve la app al encender, y celular/TV la abren por WiFi (sin internet). Estado verificado hoy: el servidor ya escucha en `0.0.0.0`, lee `PORT`, `DATA_DIR`, `CONTENT_DIR`, `WEB_DIR` y sirve `apps/web/dist` con fallback SPA (`http/web.ts`). **No hay** Dockerfile, compose ni unit de systemd. Docker 29.1 y ufw 0.36 están instalados en la laptop; Node 24.14.

## 1. Docker Compose vs systemd de usuario

**Recomendación: servicio systemd de usuario, sin Docker.** Esto contradice la parte Linux del ADR 0003, así que requiere tu visto bueno (ambigüedad A1) y un ADR 0005 que lo reemplace.

| Criterio | systemd de usuario | Docker Compose |
|---|---|---|
| ffmpeg | el del host (`/usr/bin`), ya probado | hay que instalarlo en la imagen: otra versión que validar |
| Asistente de carpeta (T22) | funciona igual: guarda `~/.config/sala/config.json` con rutas del host | el asistente elegiría rutas **del contenedor**; hay que fijar `CONTENT_DIR` por env (el asistente deja de poder cambiarla) o montar la config |
| HDD (T9/T22c) | rutas idénticas, el disco se monta/desmonta sin tocar nada | bind mount con `rslave` y reinicio ante discos movidos; más frágil |
| Prioridad baja | `nice` directo | solo `cpu_shares`, sin `nice`/`ionice` |
| IP LAN para el QR | `os.networkInterfaces()` ve la IP real | ve la IP del contenedor (172.x) salvo `network_mode: host` |
| ufw | se aplica | Docker publica el puerto saltándose ufw: la regla del firewall **no protege** |
| Autoarranque | `systemctl --user enable` + `loginctl enable-linger` (1 sudo) | `restart: unless-stopped` + docker habilitado (probablemente ya) |
| Aislamiento/reproducibilidad | ninguno | sí (su única ventaja real aquí, útil si algún día se distribuye a otros) |
| Mantenimiento | 1 unit + 1 script | Dockerfile + compose + imagen que reconstruir en cada cambio |

Unit propuesta (`packaging/linux/sala.service`, plantilla con rutas absolutas del repo):
`WorkingDirectory=<repo>/apps/server`, `ExecStart=node --env-file-if-exists=<repo>/.env src/index.ts`, `Environment=PORT=8080 DATA_DIR=<repo>/data WEB_DIR=<repo>/apps/web/dist`, `Restart=on-failure`, `TimeoutStopSec=10` (el shutdown de T34 mata ffmpeg con SIGTERM). Prioridad baja: **no** `Nice=` sobre toda la unidad (degradaría también la reproducción); en su lugar lanzar ffmpeg con `nice -n 10` desde `processing/ffmpeg.ts` (cambio chico, se prueba con un test del argv). `CONTENT_DIR` no se fija: lo resuelve `config.json`.

Hallazgo que condiciona T7c: `scripts/dev.mjs` considera "huérfano propio" a cualquier proceso en 8080 con cwd dentro del repo y `src/index.ts` en su cmdline. El servicio cumple eso: `npm run dev` lo mataría y `Restart=` lo levantaría otra vez. Solución: el lanzador detecta que el holder pertenece a `sala.service` (lee `/proc/<pid>/cgroup`) y aborta con "detén el servicio: `systemctl --user stop sala`". Además, el servicio debería hacer la copia SQLite verificada de `backupLibrary` antes de arrancar (`ExecStartPre` con un CLI mínimo que reutilice esa función).

## 2. IP LAN, URL y QR

- **Backend:** `GET /api/network` → `{ port, urls: string[] }`. Función pura `lanUrls(interfaces, port)` sobre `os.networkInterfaces()`: IPv4, no internas, solo rangos privados (10/8, 172.16/12, 192.168/16), descartando interfaces `docker*`, `br-*`, `veth*`, `virbr*`, `tailscale*`. Orden estable; la primera es la sugerida. Sin dependencias ni red externa: funciona con el router sin internet.
- **Ajustes (web):** panel "Ver desde el celular o la TV" con la URL (`http://192.168.x.x:8080`), botón copiar, QR de la primera URL y selector si hay varias (Ethernet + WiFi). Texto de ayuda: el celular debe estar en la misma WiFi.
- **QR sin CDN ni módulo nativo:** recomiendo `qrcode-generator` (JS puro, sin dependencias, licencia MIT, ~20 kB, dibuja SVG), instalado en `apps/web` y empaquetado por Vite como el resto. Alternativa: generador propio (~150 líneas: modo byte, nivel L/M, Reed-Solomon, máscaras): sin dependencia, pero riesgo de QR inválido que solo se descubre escaneando; no compensa. Al instalar, confirmar versión, licencia y tamaño reales (aquí no se instaló nada).
- **IP cambiante (DHCP):** la URL se recalcula en cada visita a Ajustes; no se persiste. Para que no cambie, el dueño puede reservar la IP en el router (A4). `hostname.local` queda fuera: depende de mDNS en cada TV/celular y no se puede garantizar.

## 3. Firewall (nada se ejecuta solo)

Primero ver si ufw está activo: `sudo ufw status`. Si dice `inactive`, no hay nada que abrir. Si está activo, el dueño ejecuta, con su subred real (`ip -4 -o addr show scope global` la muestra; ejemplo 192.168.1.0/24):

```sh
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp comment 'sala'
sudo ufw status numbered      # verificar
```

Abrir solo a la LAN, no a `any`, porque la app no tiene autenticación (solo perfiles). Deshacer: `sudo ufw delete allow from 192.168.1.0/24 to any port 8080 proto tcp`. El único otro comando con sudo es `sudo loginctl enable-linger "$USER"` (arranque sin iniciar sesión). Todo lo demás (copiar la unit, `systemctl --user daemon-reload/enable --now sala`) es sin sudo y lo corre el dueño.

## 4. Plan en tareas

| Tarea | Contenido | Pruebas automáticas | Solo en la máquina real |
|---|---|---|---|
| **T7a** | `lanUrls` + `GET /api/network` | vitest con interfaces simuladas (privadas, docker, IPv6, sin red → `urls: []`) | IP real de la laptop |
| **T7b** | Panel de Ajustes + QR | render de URL y SVG, copiar, sin peticiones externas | escanear el QR con el celular |
| **T7c** | `sala.service`, `scripts/linux-install.sh` (build web + genera la unit, no usa sudo ni habilita nada), `nice` de ffmpeg, guardia en `dev.mjs`, backup previo | test del argv de ffmpeg y de la guardia; `systemd-analyze --user verify` | `enable --now`, reiniciar la laptop y comprobar que sube sola; `systemctl --user stop` no deja ffmpeg huérfano |
| **T7d** | ADR 0005, README en español (laptop + celular + TV), ajustar `local-development.md` (líneas "T7 pendiente") | revisión de que los comandos de la guía existen | seguir la guía de cero |
| **T7e** (= T6d) | Prueba final: celular y TV por WiFi con el router sin internet, ufw activo | — | todo |

Paralelo: **T7a, T7b y T7c** son independientes (T7b solo necesita el contrato `{ urls: string[] }`). T7d espera a las tres; T7e es lo último y solo se hace en la laptop.

## 5. Ambigüedades para el dueño

1. **A1 — Docker o systemd.** El ADR 0003 dice Docker Compose para Linux. Recomiendo systemd de usuario (tabla de §1) y reemplazar esa parte del ADR. Si prefieres Docker, el diseño cambia: `network_mode: host`, `CONTENT_DIR` fijo y la regla ufw no aplica.
2. **A2 — Dónde vive el servicio.** Recomiendo correrlo desde este repo, con el `data/` y `content/` actuales (sin mover nada ni migrar). Alternativa: instalar en `~/sala` aparte; cada actualización sería un paso extra.
3. **A3 — Firewall.** Recomiendo abrir 8080 solo a tu subred LAN. Alternativa: a cualquier origen (más simple, menos seguro). Antes, confirma si ufw está activo.
4. **A4 — IP fija.** Recomiendo reservar la IP de la laptop en el router (tarea tuya, una vez) para que la URL y el QR no cambien; si no, el QR se regenera al abrir Ajustes y los favoritos de la TV dejarían de servir.

**Incidente (loop de arranques):** la unit corría con `WorkingDirectory=apps/server` y sin `CONTENT_DIR`, así que `./content` resolvía a `apps/server/content` (inexistente); con el 8080 ocupado por `npm run dev` la unit reinició ~200 veces, cada una con backup y jobs en error "source file not found". Guardia: `CONTENT_DIR` relativo se ancla a la raíz del repo (`resolveContentDir`), una carpeta de contenido inexistente (`missing` o `unset` sin default) no escanea, no reencola ni procesa, el CLI de backup sale con error si el puerto está ocupado, `RestartSec=10` con `StartLimitBurst=5/300s`, y el backup previo conserva solo las 5 `before-start-*` más recientes y se reutiliza si tiene <10 min. Podar a mano las antiguas: `eza -1 -d -s modified -r data/recovery/before-start-* | tail -n +6 | xargs rm -rf`.
