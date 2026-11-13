#!/bin/sh
# Starts the PC's end of away access. Run once, after `node tools/away.mjs make`:
#
#   sudo sh tools/away-install.sh
#
# It installs WireGuard from the system's own packages, waits if need be for the phone's public key
# (given with `node tools/away.mjs phone <key>`, from another window or the phone's chat), lets that
# phone in, starts the tunnel now and at every boot, and lets the phone reach only the yard
# through it: the phone door and the game previews, nothing else on this PC. Run it again to swap in
# a new phone's key.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run this with sudo.'; exit 1; }
owner=${SUDO_USER:-}
[ -n "$owner" ] && [ "$owner" != root ] || { echo 'Run this with sudo from your own account.'; exit 1; }
home=$(getent passwd "$owner" | cut -d: -f6)
here=$(cd "$(dirname "$0")" && pwd)
# The yard's home is the owner's: sudo keeps BOTYARD_HOME only when asked to, so it may be given here too.
folder="${BOTYARD_HOME:-$home/.botyard}/config/away"
made="$folder/pc.conf"
phone="$folder/phone.pub"
installed=/etc/wireguard/botyard.conf
wait_s=7200
# A WireGuard public key: 32 bytes in base64.
key='^[A-Za-z0-9+/]\{42\}[AEIMQUYcgkosw048]=$'

say() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }

if [ ! -f "$made" ] && [ ! -f "$installed" ]; then
  echo "Run 'node tools/away.mjs make' first, as yourself."
  exit 1
fi

say 'Password accepted. Installing WireGuard...'
apt-get -o DPkg::Lock::Timeout=300 install -y wireguard-tools

if [ ! -f "$phone" ]; then
  say 'Waiting for the phone. Leave this window open: it carries on by itself once the phone key arrives.'
  waited=0
  while [ ! -f "$phone" ] && [ "$waited" -lt "$wait_s" ]; do sleep 3; waited=$((waited + 3)); done
  [ -f "$phone" ] || { echo 'No phone key came in two hours. Run this again once it has.'; exit 1; }
fi
phone_key=$(head -n 1 "$phone")
printf '%s\n' "$phone_key" | grep -q "$key" || { echo 'The phone key on file is not a WireGuard key.'; exit 1; }

install -d -m 700 /etc/wireguard
if [ -f "$made" ]; then
  # The PC's key now lives only where root can read it.
  install -m 600 -o root -g root "$made" "$installed.base"
  rm -f "$made"
fi
umask 077
{ cat "$installed.base"; printf '\n[Peer]\n# The phone\nPublicKey = %s\nAllowedIPs = 10.88.0.2/32\n' "$phone_key"; } > "$installed.next"
mv "$installed.next" "$installed"

systemctl enable wg-quick@botyard
systemctl restart wg-quick@botyard

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  port=$(sed -n 's/^ListenPort *= *//p' "$installed")
  ufw allow "$port"/udp comment 'Botyard away access'
  ufw allow in on botyard proto tcp to any port 5288,5290 comment 'Botyard through the tunnel'
fi

# Open the router's port now rather than at the next timer run.
runuser -u "$owner" -- /usr/bin/node "$here/away.mjs" keep || true

say 'Done. Away access is on. You can close this window.'
