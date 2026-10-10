# 0005 — Servicio systemd de usuario en Linux, sin Docker

**Estado:** aceptado · 2026-10-10

Reemplaza la parte Linux del [ADR 0003](0003-instalador-nativo-windows.md) (Docker Compose). Windows no cambia.

## Contexto
La laptop Linux del dueño debe servir la app al encender y verse desde celular y TV por WiFi, sin internet. Con Docker Compose:
- El asistente de carpeta (T22) guardaría rutas del contenedor, no del host y del HDD.
- La IP LAN para la URL y el QR saldría como 172.x salvo `network_mode: host`.
- Docker publica puertos saltándose ufw: la regla del firewall no protegería.
- ffmpeg tendría que instalarse en la imagen, con otra versión que validar.

## Decisión
- En Linux, la app corre como servicio de usuario de systemd (`sala.service`), sin Docker.
- `scripts/linux-install.sh` compila la web y genera la unit desde `packaging/linux/sala.service`. No usa sudo ni habilita nada.
- Arranque al encender: `loginctl enable-linger`, paso manual del dueño con sudo.
- Firewall: regla ufw solo para la subred LAN, nunca para cualquier origen.
- `npm run dev` se niega a correr si `sala.service` ocupa el puerto 8080.
- Prioridad baja de ffmpeg: ya la aplica el código de procesamiento (`setPriority(pid, 19)`, T4d3); la unit no usa `Nice=` global para no degradar la reproducción.

## Consecuencias
- Un solo mecanismo por plataforma: systemd en Linux, instalador `.exe` en Windows.
- Requiere systemd de usuario. El arranque sin sesión necesita un paso con sudo.
- La unit tiene rutas absolutas del repo: si el repo se mueve, hay que volver a ejecutar `scripts/linux-install.sh`.
- ffmpeg es el del host; no hay aislamiento de contenedor.
- Actualizar exige recompilar la web y reiniciar el servicio.
- Falta validar en la laptop real (T7e).
