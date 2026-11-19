#!/usr/bin/env sh
# Platypus: avvio da terminale (Linux e macOS) · start from a terminal
cd "$(dirname "$0")" || exit 1
# Node installato con Homebrew, nvm o Volta non sempre è nel PATH delle app grafiche
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"; export PATH
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi
if ! command -v node >/dev/null 2>&1; then
  echo "Serve Node.js 22.13 o più recente: https://nodejs.org (macOS: brew install node; con nvm: nvm install --lts)"
  echo "Node.js 22.13 or newer is required: https://nodejs.org (macOS: brew install node; with nvm: nvm install --lts)"
  exit 1
fi
exec node scripts/launch.js "$@"
