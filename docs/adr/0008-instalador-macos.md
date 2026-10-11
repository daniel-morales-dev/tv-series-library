# 0008 — Instalador nativo para macOS

**Estado:** aceptado · 2026-10-11

## Contexto
Los usuarios de macOS tampoco tienen conocimiento técnico, y arrancar la app desde el repo (git, npm) no es una opción. Apple Silicon exige que todo binario esté firmado; sin cuenta Apple Developer no hay notarización, y Gatekeeper avisa la primera vez que se abre una app sin verificar. Un `.pkg` obligaría a diálogos de administrador que la app no necesita.

## Decisión
- macOS: DMG con `Sala.app` (no `.pkg`) y todo incluido: Node portable, ffmpeg/ffprobe, el servidor y la web compilada. Instalador de doble clic (`Instalar Sala.command`) que copia a `/Applications` y quita la cuarentena; sin sudo.
- Firma ad-hoc (`codesign --sign -`) obligatoria en Apple Silicon. Sin notarización: no hay cuenta Apple Developer. El primer arranque muestra el aviso de Gatekeeper y la guía `LEEME.txt` del DMG documenta clic derecho → Abrir.
- Arranque al iniciar sesión con un LaunchAgent (`com.sala.launcher`, `RunAtLoad`) que el lanzador crea la primera vez que el servidor arranca desde `/Applications`. Dual: al iniciar sesión arranca el servidor en silencio (`--no-open`); el doble clic normal abre el navegador.
- El estado vive en `~/Library/Application Support/sala` y los logs en `~/Library/Logs/sala/server.log`.

## Consecuencias
- Tercera forma de empaquetado que mantener junto a Windows (`.exe`) y Linux (systemd de usuario).
- El primer arranque lleva un aviso de Gatekeeper esperado y documentado; no hace falta cuenta de pago.
- Deliberadamente distinto de Windows: el autostart abre el servidor sin navegador (`--no-open`) y no hay asistente nativo: la guía es `LEEME.txt` en lugar del wizard de Inno Setup.
- El LaunchAgent solo se instala si la app vive en `/Applications`; desde `~/Applications` (cuentas sin permiso) todo funciona igual, pero sin arranque automático.
- La firma ad-hoc no verifica identidad ante Apple: actualizar es volver a copiar la app desde el DMG; si Gatekeeper vuelve a avisar, repetir clic derecho → Abrir.
