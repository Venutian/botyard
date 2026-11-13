# Where Botyard keeps things and what a run is told, for the crew's shell scripts: the same answers as
# botyard_home.py (the Python scripts) and studio/server/lib/home.mjs (the server). Source it with
# `here` set to this folder:
#
#   here=$(dirname "$(readlink -f "$0")"); . "$here/botyard-home.sh"
#
# It sets BOTYARD_HOME_DIR ($BOTYARD_HOME, default ~/.botyard), BOTYARD_CREW_DIR (bots, instructions,
# the crew's state), BOTYARD_KEYS_DIR, BOTYARD_CONFIG_DIR, BOTYARD_SCRIPTS (the crew's scripts) and
# BOTYARD_PROJECTS_DIR, and gives run_var NAME and run_var_name NAME.
BOTYARD_HOME_DIR=$(printf %s "${BOTYARD_HOME:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
[ -n "$BOTYARD_HOME_DIR" ] || BOTYARD_HOME_DIR="$HOME/.botyard"
BOTYARD_CREW_DIR="$BOTYARD_HOME_DIR/crew"
BOTYARD_KEYS_DIR="$BOTYARD_HOME_DIR/keys"
BOTYARD_CONFIG_DIR="$BOTYARD_HOME_DIR/config"
BOTYARD_SCRIPTS=${here:?set here to the crew folder before sourcing botyard-home.sh}
# A copy of the crew (install.sh --copy) names the repository in a one-line .repo file beside itself.
studio_repo=$(dirname "$BOTYARD_SCRIPTS")
[ -s "$BOTYARD_SCRIPTS/.repo" ] && studio_repo=$(head -n1 "$BOTYARD_SCRIPTS/.repo")
BOTYARD_PROJECTS_DIR=${BOTYARD_PROJECTS:-$(dirname "$studio_repo")}
export BOTYARD_CREW_DIR BOTYARD_KEYS_DIR BOTYARD_CONFIG_DIR BOTYARD_SCRIPTS BOTYARD_PROJECTS_DIR

# What a run is told: run_var NAME, run_var_name NAME, set_run_var NAME VALUE. One file holds the names,
# and it travels with the job-closing skill, whose script reads it too.
. "$studio_repo/crew/skills/botyard/scripts/run-vars.sh"
