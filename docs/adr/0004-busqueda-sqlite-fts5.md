# 0004 — Búsqueda con SQLite FTS5 en lugar de Elasticsearch

**Estado:** aceptado · 2026-10-08

## Contexto
Se requiere búsqueda con autocompletado por título, actor y director. Elasticsearch consume entre 1 y 2 GB de RAM y agrega un contenedor más.

## Decisión
Usar una tabla virtual FTS5 de SQLite con `tokenize='unicode61 remove_diacritics 2'` y consultas por prefijo (`term*`).

## Consecuencias
- Cero servicios extra. Verificado en Node 24.14: `mas*` encuentra "Más".
- `node:sqlite` aún es experimental en Node 24 (muestra un aviso).
