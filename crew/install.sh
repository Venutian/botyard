#!/bin/sh
# Puts the crew's scripts in place for this studio. Safe to run again, from wherever the repository
# was cloned.
#
#   install.sh          link the crew's scripts into the crew's folder
#   install.sh --copy   copy instead of link, for a crew folder that must not point into a clone
#
# The crew's folder is $BOTYARD_HOME/crew (default ~/.botyard/crew). Nothing else is installed:
# Botyard's own timetable runs the helpers (crew/timetable.json), and setup-bots.py seeds the bots.
set -e
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
. "$here/botyard-home.sh"
copy=
for arg in "$@"; do
  case "$arg" in
    --no-timers) ;;  # accepted for older callers: there are no timers to leave out
    --copy) copy=1;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "install.sh: unknown option $arg (try --help)" >&2; exit 1;;
  esac
done
crew=$BOTYARD_CREW_DIR
repo=$(dirname "$here")
mkdir -p "$crew" "$HOME/.local/bin"

put() {  # put NAME: one script or folder of the crew's, linked or copied into the crew's folder
  if [ -n "$copy" ]; then
    rm -rf "$crew/$1"
    cp -R "$here/$1" "$crew/$1"
  else
    ln -sfn "$here/$1" "$crew/$1"
  fi
}
# Every script a bot, a timer or a person runs by name from the crew's folder, and what they import.
for f in "$here"/*.py "$here"/*.sh "$here"/bot-settings.json; do
  name=$(basename "$f")
  [ -e "$f" ] || continue
  [ "$name" = install.sh ] && continue
  put "$name"
done
put agy-bin
if [ -n "$copy" ]; then
  # Copies cannot find the repository from their own place, so they are told where it is. The bots'
  # files, the skills and the scout's test stay in the repository and are read from there.
  printf '%s\n' "$repo" > "$crew/.repo"
else
  rm -f "$crew/.repo"
fi
# The one command a bot calls by name. A studio whose home was chosen by hand (a second studio, a
# trial) leaves the computer's own command alone.
if [ "$BOTYARD_HOME_DIR" = "$HOME/.botyard" ]; then
  ln -sf "$crew/botyard-wait.py" "$HOME/.local/bin/botyard-wait"
else
  echo "Not linked: $HOME/.local/bin/botyard-wait (this studio's home is not the default one)."
fi
echo "The crew's scripts are in $crew."
