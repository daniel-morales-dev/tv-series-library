#!/usr/bin/env bash
# Construye la web y genera la unit de usuario de systemd. No usa sudo ni habilita nada.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="$(command -v node)" || { echo "node no está en el PATH" >&2; exit 1; }
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

(cd "$repo" && npm run build -w apps/web)

mkdir -p "$unit_dir"
sed -e "s|@REPO@|$repo|g" -e "s|@NODE@|$node_bin|g" "$repo/packaging/linux/sala.service" >"$unit_dir/sala.service"
echo "Unit escrita en $unit_dir/sala.service"

bin_dir="$HOME/.local/bin"
cli="$bin_dir/sala"
mkdir -p "$bin_dir"
if [ -e "$cli" ] && ! grep -q '^# sala-cli wrapper' "$cli" 2>/dev/null; then
  echo "No se tocó $cli: ya existe y no es de Sala." >&2
else
  printf '#!/bin/sh\n# sala-cli wrapper (lo regenera scripts/linux-install.sh)\nexec "%s" "%s/scripts/sala.mjs" "$@"\n' "$node_bin" "$repo" >"$cli"
  chmod +x "$cli"
  echo "Comando 'sala' instalado en $cli"
  case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "Aviso: $bin_dir no está en tu PATH; añádelo en ~/.profile para usar 'sala'." ;; esac
fi

cat <<MSG

Siguientes pasos (los ejecutas tú):

  systemctl --user daemon-reload
  systemctl --user enable --now sala
  sudo loginctl enable-linger "\$USER"     # arrancar al encender, sin iniciar sesión

Firewall (solo si 'sudo ufw status' dice active; cambia la subred por la tuya, ver 'ip -4 -o addr show scope global'):

  sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp comment 'sala'

Después, a diario: sala status | sala stop | sala start | sala --help
(equivale a systemctl --user ...; ver README, "Usar sala").

Estado:  systemctl --user status sala
Logs:    journalctl --user -u sala -f
Parar:   systemctl --user stop sala   (antes de 'npm run dev'; luego, al terminar: systemctl --user start sala)
MSG
