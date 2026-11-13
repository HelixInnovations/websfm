#!/bin/bash
# Double-click to run WebSfM on this Mac at http://localhost:5173
# Everything (photos, processing, results) stays on this computer.
# Close this Terminal window, or press Ctrl+C in it, to stop WebSfM.

cd "$(dirname "$0")" || exit 1
# A double-clicked script does not load your shell profile: add the usual Node homes.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
pause_exit() { echo; read -r -p "Press Return to close this window." _; exit "${1:-1}"; }

say "WebSfM local engine (Helix)"

if ! command -v node >/dev/null 2>&1; then
  say "Node.js is not installed yet."
  echo "Your browser will open the Node.js download page. Install the LTS version"
  echo "(the big green button, the macOS Installer .pkg), then double-click this file again."
  open "https://nodejs.org/en/download"
  pause_exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 19 ]; } || [ "$NODE_MAJOR" -eq 21 ]; then
  say "Node.js $(node -v) is too old. WebSfM needs version 22 (or 20.19+, or 24)."
  echo "Install the LTS version from the page that opens, then double-click this file again."
  open "https://nodejs.org/en/download"
  pause_exit 1
fi
echo "Node.js $(node -v) found."

# Install the app's building blocks the first time, and again whenever they change.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "First run: installing WebSfM's building blocks (a few minutes, needs internet)..."
  if ! npm install --no-audit --no-fund; then
    say "The install did not finish. Check the internet connection and try again."
    pause_exit 1
  fi
fi

# The example project (42 drone photos, about 50 MB), fetched once so
# "Open the example project" works offline afterwards.
if [ ! -f public/examples/aukerman/manifest.json ]; then
  say "Fetching the example project (about 50 MB, once)..."
  npm run fetch:examples || echo "Skipped: the example can be fetched next time."
fi

say "Starting WebSfM. Your browser opens at http://localhost:5173 in a moment."
echo "Use Chrome or Edge for graphics-card speed (WebGPU). Keep this window open while you work."
echo "To stop: close this window, or press Ctrl+C here."
( sleep 4; open -a "Google Chrome" "http://localhost:5173" 2>/dev/null || open "http://localhost:5173" ) &
npx vite --port 5173 --strictPort
pause_exit 0
