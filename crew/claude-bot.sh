#!/bin/sh
# Runs Claude Code for the bots on the owner's long-lived token, made with `claude setup-token`, so
# they keep working when the desktop sign-in ends. Without the token file it uses that sign-in.
here=$(dirname "$(readlink -f "$0")")
. "$here/botyard-home.sh"
token="$BOTYARD_CREW_DIR/claude-token"
if [ -s "$token" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=$(cat "$token")
  export CLAUDE_CODE_OAUTH_TOKEN
fi
# A studio's own additions to every Claude bot's start (a browser profile, notes put in the job's folder):
# its crew/own/claude-bot.sh is read here, in this shell, when there is one.
[ -r "$BOTYARD_CREW_DIR/own/claude-bot.sh" ] && . "$BOTYARD_CREW_DIR/own/claude-bot.sh"
# Every Claude bot gets the crew's loop guard through these settings. setup-bots.py
# gives each bot its own copy (BOTYARD_BOT_SETTINGS) that also hides the PC's skills outside its job (skill_sets.py).
settings="$BOTYARD_SCRIPTS/bot-settings.json"
[ -n "$BOTYARD_BOT_SETTINGS" ] && [ -s "$BOTYARD_BOT_SETTINGS" ] && settings="$BOTYARD_BOT_SETTINGS"
# Connectors the owner gave this bot in Botyard (the Connectors page). Botyard writes the list; the bot reaches
# each service through Botyard's own gateway and never holds a key. BOTYARD_CONNECTORS=off leaves them out.
if [ "$BOTYARD_CONNECTORS" != off ] && [ -n "$BOTYARD_BOT_SETTINGS" ]; then
  mine="${BOTYARD_BOT_CONNECTORS:-$BOTYARD_CREW_DIR/connectors}/$(basename "$BOTYARD_BOT_SETTINGS" .claude.json).claude.json"
  if grep -q '"url"' "$mine" 2>/dev/null; then
    claude=${BOTYARD_CLAUDE:-$(PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH" command -v claude)}
    exec "${claude:?Claude Code is not installed: npm install -g @anthropic-ai/claude-code}" --settings "$settings" --mcp-config "$mine" "$@"
  fi
fi
claude=${BOTYARD_CLAUDE:-$(PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH" command -v claude)}
exec "${claude:?Claude Code is not installed: npm install -g @anthropic-ai/claude-code}" --settings "$settings" "$@"
