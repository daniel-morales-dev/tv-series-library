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

cat <<MSG

Siguientes pasos (los ejecutas tú):

  systemctl --user daemon-reload
  systemctl --user enable --now sala
  sudo loginctl enable-linger "\$USER"     # arrancar al encender, sin iniciar sesión

Firewall (solo si 'sudo ufw status' dice active; cambia la subred por la tuya, ver 'ip -4 -o addr show scope global'):

  sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp comment 'sala'

Estado:  systemctl --user status sala
Logs:    journalctl --user -u sala -f
Parar:   systemctl --user stop sala   (antes de 'npm run dev'; luego, al terminar: systemctl --user start sala)
MSG
