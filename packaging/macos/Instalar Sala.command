#!/bin/bash
# Instalar Sala - se ejecuta con doble clic desde el DMG.
# Copia Sala.app a /Applications (o a ~/Applications si la cuenta no puede escribir ahí),
# le quita la cuarentena y la abre. No usa sudo.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/Sala.app"

# Aviso nativo con el texto como argumento: comillas y espacios viajan seguros.
alert() {
  /usr/bin/osascript - "$1" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  display alert "Sala" message (item 1 of argv) as critical buttons {"Cerrar"} default button "Cerrar"
end run
APPLESCRIPT
}

echo "Instalando Sala..."
if [ ! -d "$SRC" ]; then
  alert "No se encontró Sala.app junto a este instalador. Abre el DMG y vuelve a intentarlo."
  exit 1
fi

INSTALLED="/Applications/Sala.app"
rm -rf "$INSTALLED"
if ! cp -R "$SRC" "$INSTALLED" 2>/dev/null; then
  echo "No hay permiso para escribir en /Applications; se instala en tu carpeta personal (~/Applications)."
  INSTALLED="$HOME/Applications/Sala.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$INSTALLED"
  if ! cp -R "$SRC" "$INSTALLED"; then
    alert "No se pudo copiar Sala. Arrastra Sala.app sobre la carpeta Aplicaciones de la ventana del DMG y vuelve a intentarlo."
    exit 1
  fi
fi

# Quita la cuarentena del DMG: el aviso de Gatekeeper de la primera apertura ya está documentado en LEEME.txt.
xattr -dr com.apple.quarantine "$INSTALLED" 2>/dev/null || true
echo "Listo: Sala quedó en $INSTALLED y se abrirá ahora en el navegador."
open "$INSTALLED"
exit 0
