# What a run is told, for shell scripts: the one place the shell reads a run variable's name from
# (botyard_home.py is the same for Python). Source it, then ask by what the variable is:
#
#   run_var JOB_ID          its value ('' when not set)
#   run_var_name JOB_ID     its name, for a message
#   set_run_var API_URL x   changes what the rest of the run is told
#
# Names: API_URL API_KEY RUN_ID JOB_ID BOT_ID ID (this studio's id).
run_var_name() {
  case "$1" in
    API_URL|API_KEY|RUN_ID|JOB_ID|BOT_ID|ID) printf 'BOTYARD_%s' "$1";;
    *) echo "run_var: no such name: $1" >&2; return 1;;
  esac
}
run_var() { eval "printf %s \"\${$(run_var_name "$1"):-}\""; }
set_run_var() { eval "$(run_var_name "$1")=\$2; export $(run_var_name "$1")"; }
