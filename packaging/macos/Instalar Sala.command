#!/bin/bash
# Instalar Sala - se ejecuta con doble clic desde el DMG.
# Copia Sala.app a /Applications (o a ~/Applications si la cuenta no puede escribir ahí),
# le quita la cuarentena y la abre. No usa sudo.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/Sala.app"

# Idioma de los mensajes: el del sistema, o SALA_LANG=es|en|pt para forzarlo
# (SALA_LANG también es el punto de prueba de esta rama; ver packaging/macos/README.md).
# ponytail: solo estos tres idiomas. Si algun dia son mas, esto pasa a ser un archivo de traducciones.
LOCALE="${SALA_LANG:-$(/usr/bin/defaults read -g AppleLocale 2>/dev/null)}"
case "$(printf '%s' "$LOCALE" | cut -c1-2)" in
  es) L=es ;;
  pt) L=pt ;;
  *)  L=en ;;
esac

# msg <español> <english> <português>
msg() {
  case "$L" in
    es) printf '%s' "$1" ;;
    pt) printf '%s' "$3" ;;
    *)  printf '%s' "$2" ;;
  esac
}

case "$L" in
  es) BTN="Cerrar" ;;
  pt) BTN="Fechar" ;;
  *)  BTN="Close" ;;
esac

# Aviso nativo con el texto como argumento: comillas y espacios viajan seguros.
alert() {
  /usr/bin/osascript - "$1" "$BTN" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  set btn to item 2 of argv
  display alert "Sala" message (item 1 of argv) as critical buttons {btn} default button btn
end run
APPLESCRIPT
}

echo "$(msg "Instalando Sala..." \
            "Installing Sala..." \
            "Instalando o Sala...")"
if [ ! -d "$SRC" ]; then
  alert "$(msg "No se encontró Sala.app junto a este instalador. Abre el DMG y vuelve a intentarlo." \
             "Sala.app was not found next to this installer. Open the DMG and try again." \
             "Sala.app não foi encontrado junto a este instalador. Abra o DMG e tente novamente.")"
  exit 1
fi

INSTALLED="/Applications/Sala.app"
rm -rf "$INSTALLED"
if ! cp -R "$SRC" "$INSTALLED" 2>/dev/null; then
  echo "$(msg "No hay permiso para escribir en /Applications; se instala en tu carpeta personal (~/Applications)." \
              "No permission to write to /Applications; installing to your home folder (~/Applications)." \
              "Sem permissão para escrever em /Applications; instalando na sua pasta pessoal (~/Applications).")"
  INSTALLED="$HOME/Applications/Sala.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$INSTALLED"
  if ! cp -R "$SRC" "$INSTALLED"; then
    alert "$(msg "No se pudo copiar Sala. Arrastra Sala.app sobre la carpeta Aplicaciones de la ventana del DMG y vuelve a intentarlo." \
               "Sala could not be copied. Drag Sala.app onto the Aplicaciones folder in the DMG window and try again." \
               "Não foi possível copiar o Sala. Arraste Sala.app para a pasta Aplicaciones na janela do DMG e tente novamente.")"
    exit 1
  fi
fi

# Quita la cuarentena del DMG: el aviso de Gatekeeper de la primera apertura ya está documentado en LEEME.txt.
xattr -dr com.apple.quarantine "$INSTALLED" 2>/dev/null || true
echo "$(msg "Listo: Sala quedó en $INSTALLED y se abrirá ahora en el navegador." \
            "Done: Sala is at $INSTALLED and will now open in your browser." \
            "Pronto: o Sala está em $INSTALLED e será aberto agora no navegador.")"
open "$INSTALLED"
exit 0
