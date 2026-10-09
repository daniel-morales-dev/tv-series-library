# 0003 — Instalador nativo para Windows y Docker para Linux

**Estado:** aceptado · 2026-10-08

## Contexto
Los usuarios de Windows no tienen conocimiento técnico. Docker Desktop exige WSL2 y virtualización activada en la BIOS.

## Decisión
- Windows: instalador `.exe` (Inno Setup) con Node portable, la app y ffmpeg. Arranca al iniciar sesión, agrega la regla de firewall para la red local y abre el navegador.
- Linux: Docker Compose con `restart: unless-stopped`.

## Consecuencias
- Dos formas de empaquetado que mantener.
- Evitar módulos nativos de Node: se usa `node:sqlite` integrado.
