# 0001 — Construir plataforma propia en lugar de usar Jellyfin

**Estado:** aceptado · 2026-10-08

## Contexto
Jellyfin cubre la mayoría de requisitos (perfiles, continuar viendo, audio/subs, metadata, LAN, instalador Windows).

## Decisión
Construir una plataforma propia con Vue 3 + Node.js (Fastify) + SQLite.

## Consecuencias
- UX a medida (estilo Netflix/Crunchyroll/HBO) y aprendizaje del stack completo.
- Asumimos el costo del pipeline de video, la ingesta y el empaquetado para Windows.
