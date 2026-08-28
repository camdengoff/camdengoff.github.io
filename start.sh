#!/usr/bin/env bash
#
# One-command local run of The Cage, for someone who just wants to look at it.
#
#   ./start.sh
#
# Checks for Node and Postgres, offers to install them, creates a local
# database, fills it with demo gear, starts the app and prints a sign-in link.
# Safe to run again — it skips whatever is already done.
#
# macOS. On Windows or Linux see SETUP.md.

set -uo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RESET=$'\033[0m'

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s\n' "$YELLOW" "$RESET" "$BOLD" "$*$RESET"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '\n%sCouldn'\''t continue:%s %s\n\n' "$RED" "$RESET" "$*"; exit 1; }

# Read a line from the user. Prefers the terminal so this still works when the
# script is piped (curl | bash), but falls back to stdin rather than failing.
prompt_read() {  # prompt_read VARNAME "prompt text"
  local __var="$1" __text="$2" __reply=""
  printf '%s' "$__text"
  # Check the terminal can actually be opened before redirecting from it —
  # testing it this way keeps the shell from printing its own error.
  if { : </dev/tty; } 2>/dev/null; then
    read -r __reply </dev/tty || true
  else
    read -r __reply || true
  fi
  printf -v "$__var" '%s' "$__reply"
}

ask() {  # ask "question" -> 0 for yes
  local reply
  prompt_read reply "    $1 [y/N] "
  [[ "$reply" =~ ^[Yy] ]]
}

cd "$(dirname "$0")" || die "couldn't find the project folder"
PROJECT_DIR="$PWD"

if [[ "$(uname)" != "Darwin" ]]; then
  die "this script is for macOS. On Windows or Linux, follow SETUP.md instead."
fi

say ""
say "${BOLD}The Cage${RESET} ${DIM}— local setup${RESET}"
say "${DIM}Nothing here touches the internet or sends any email.${RESET}"

# ----------------------------------------------------------------- Homebrew
step "Checking for Homebrew"
if command -v brew >/dev/null 2>&1; then
  BREW="$(command -v brew)"
  ok "found at $BREW"
elif [[ -x /opt/homebrew/bin/brew ]]; then
  BREW=/opt/homebrew/bin/brew
  ok "found at $BREW"
elif [[ -x /usr/local/bin/brew ]]; then
  BREW=/usr/local/bin/brew
  ok "found at $BREW"
else
  warn "Homebrew isn't installed. It's the usual way to get Node and Postgres on a Mac."
  say  "    Install it from ${BOLD}https://brew.sh${RESET}, then run this script again."
  die  "Homebrew required."
fi
eval "$("$BREW" shellenv)" 2>/dev/null || true

# --------------------------------------------------------------------- Node
step "Checking for Node 20.12 or newer"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' 2>/dev/null
}
if node_ok; then
  ok "node $(node -v)"
else
  if command -v node >/dev/null 2>&1; then
    warn "node $(node -v) is too old — the app needs 20.12+."
  else
    warn "Node isn't installed."
  fi
  if ask "Install the latest Node with Homebrew now?"; then
    "$BREW" install node || die "Homebrew couldn't install Node."
    eval "$("$BREW" shellenv)" 2>/dev/null || true
    hash -r
    node_ok || die "Node still isn't on your PATH. Open a new terminal and re-run this script."
    ok "node $(node -v)"
  else
    die "Node is required."
  fi
fi

# ----------------------------------------------------------------- Postgres
step "Checking for Postgres"
PG_PREFIX=""
for v in 17 16 15 14; do
  if [[ -d "$("$BREW" --prefix 2>/dev/null)/opt/postgresql@$v" ]]; then
    PG_PREFIX="$("$BREW" --prefix)/opt/postgresql@$v"
    PG_FORMULA="postgresql@$v"
    break
  fi
done

if [[ -z "$PG_PREFIX" ]] && command -v psql >/dev/null 2>&1; then
  ok "psql already on your PATH ($(psql --version | head -1))"
elif [[ -z "$PG_PREFIX" ]]; then
  warn "Postgres isn't installed. The app stores everything in it."
  if ask "Install PostgreSQL 16 with Homebrew now? (a few minutes)"; then
    "$BREW" install postgresql@16 || die "Homebrew couldn't install Postgres."
    PG_PREFIX="$("$BREW" --prefix)/opt/postgresql@16"
    PG_FORMULA="postgresql@16"
  else
    die "Postgres is required."
  fi
fi
[[ -n "$PG_PREFIX" ]] && export PATH="$PG_PREFIX/bin:$PATH"
command -v psql >/dev/null 2>&1 || die "psql still isn't on your PATH. Open a new terminal and re-run."
ok "$(psql --version | head -1)"

step "Making sure Postgres is running"
if pg_isready -q 2>/dev/null; then
  ok "already running"
else
  if [[ -n "${PG_FORMULA:-}" ]]; then
    "$BREW" services start "$PG_FORMULA" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 15); do pg_isready -q 2>/dev/null && break; sleep 1; done
  pg_isready -q 2>/dev/null || die "Postgres wouldn't start. Try: brew services start ${PG_FORMULA:-postgresql@16}"
  ok "started"
fi

# ---------------------------------------------------------------- database
step "Setting up the database"
DB_NAME="cage"
if psql -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$DB_NAME"; then
  ok "database '$DB_NAME' already exists"
else
  createdb "$DB_NAME" || die "couldn't create the '$DB_NAME' database."
  ok "created database '$DB_NAME'"
fi

# --------------------------------------------------------------------- .env
step "Writing local settings"
if [[ -f .env ]]; then
  ok ".env already exists — leaving it alone"
  ADMIN_EMAIL="$(grep -E '^ADMIN_EMAILS=' .env | cut -d= -f2- | cut -d, -f1)"
  [[ -z "$ADMIN_EMAIL" ]] && ADMIN_EMAIL="you@example.com"
else
  prompt_read ADMIN_EMAIL "    Your email (makes you an admin; nothing is ever sent to it): "
  [[ -z "${ADMIN_EMAIL:-}" ]] && ADMIN_EMAIL="you@example.com"
  cat > .env <<ENVFILE
# Local demo settings. No email is sent; sign-in links print to the terminal.
DATABASE_URL=postgresql://$(whoami)@localhost:5432/$DB_NAME
APP_URL=http://localhost:3000
PORT=3000
TZ_NAME=America/Chicago
ADMIN_EMAILS=$ADMIN_EMAIL
ALLOWED_EMAIL_DOMAINS=
CRON_SECRET=local-demo-only
ENVFILE
  ok "wrote .env (admin: $ADMIN_EMAIL)"
fi

# -------------------------------------------------------------- git guards
if [[ -d .git ]]; then
  step "Setting up the repo guards"
  # Committed hooks, so both machines get them without anyone remembering to
  # copy a file. Guards against pushing straight to main.
  git config core.hooksPath .githooks 2>/dev/null && ok "pre-push guard active" \
    || warn "couldn't set core.hooksPath — pushes to main won't be caught"
  chmod +x .githooks/* 2>/dev/null || true
fi

# ------------------------------------------------------------- dependencies
step "Installing dependencies"
if [[ -d node_modules ]]; then
  ok "already installed"
else
  npm install --no-audit --no-fund || die "npm install failed."
  ok "done"
fi

# ---------------------------------------------------------------- demo data
step "Filling the cage with demo gear"
if npm run --silent seed 2>&1 | tail -4; then
  ok "ready"
else
  warn "the seed reported a problem — the app will still start, it may just be empty"
fi

# ------------------------------------------------------------------- launch
step "Starting the app"
LOG="$PROJECT_DIR/cage-local.log"
: > "$LOG"

# Free the port if a previous run is still holding it.
if lsof -ti tcp:3000 >/dev/null 2>&1; then
  warn "something is already using port 3000 — stopping it"
  lsof -ti tcp:3000 | xargs kill 2>/dev/null || true
  sleep 1
fi

node --env-file-if-exists=.env src/server.js >"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 20); do
  curl -fsS -m 2 http://localhost:3000/healthz >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { say ""; cat "$LOG"; die "the app stopped while starting up (log above)."; }
  sleep 1
done
curl -fsS -m 2 http://localhost:3000/healthz >/dev/null 2>&1 \
  || { say ""; cat "$LOG"; die "the app didn't come up (log above)."; }
ok "running on http://localhost:3000"

# --------------------------------------------------------------- sign-in link
step "Getting you a sign-in link"

# Sign-in links are single use. Opening one in the browser spends it, so the
# link printed below is a second, independent one — otherwise anybody who let
# the browser open and then tried to copy the link would be told it's expired.
request_link() {
  curl -fsS -X POST http://localhost:3000/auth/request \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\"}" >/dev/null 2>&1
  sleep 1
  grep -o 'http://localhost:3000/auth/callback?token=[A-Za-z0-9_-]*' "$LOG" | tail -1
}

OPEN_LINK="$(request_link)"
if [[ -n "$OPEN_LINK" ]] && command -v open >/dev/null 2>&1; then
  open "$OPEN_LINK" >/dev/null 2>&1 &
  OPENED=1
fi
LINK="$(request_link)"

say ""
say "  ────────────────────────────────────────────────────────────────"
say "  ${BOLD}The Cage is running.${RESET}"
say ""
if [[ -n "$LINK" ]]; then
  if [[ -n "${OPENED:-}" ]]; then
    say "  ${DIM}Your browser should be opening and signing you in now.${RESET}"
    say "  If it didn't, open this ${DIM}(good for 15 minutes, one use)${RESET}:"
  else
    say "  Sign in by opening this link ${DIM}(good for 15 minutes, one use)${RESET}:"
  fi
  say ""
  say "  ${GREEN}$LINK${RESET}"
  say ""
  say "  ${DIM}Need another later? Re-run this script, or open${RESET}"
  say "  ${DIM}http://localhost:3000, enter your email, and check $LOG${RESET}"
else
  say "  Open ${GREEN}http://localhost:3000${RESET} and enter ${BOLD}$ADMIN_EMAIL${RESET}."
  say "  There's no email set up, so the sign-in link prints into:"
  say "  ${DIM}$LOG${RESET}"
fi
say ""
say "  ${DIM}Sign-in is by emailed link, but no email provider is configured —${RESET}"
say "  ${DIM}links print to the terminal instead. That's expected locally.${RESET}"
say ""
say "  ${BOLD}Press Ctrl-C to stop.${RESET}"
say "  ────────────────────────────────────────────────────────────────"
say ""

wait "$SERVER_PID"
