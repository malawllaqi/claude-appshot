#!/bin/zsh
# Installs the AppShot helper into Hammerspoon's config and reloads it.
set -euo pipefail

here="${0:A:h}"
config="$HOME/.hammerspoon"

if [[ ! -d /Applications/Hammerspoon.app && ! -d "$HOME/Applications/Hammerspoon.app" ]]; then
  echo "Hammerspoon is not installed. Install it first:  brew install --cask hammerspoon" >&2
  exit 1
fi

mkdir -p "$config"
cp "$here/appshot.lua" "$config/appshot.lua"

touch "$config/init.lua"
if ! grep -q 'require("hs.ipc")' "$config/init.lua"; then
  printf '\n-- Lets the `hs` command-line tool talk to Hammerspoon.\nrequire("hs.ipc")\n' >> "$config/init.lua"
fi
if ! grep -q 'require("appshot")' "$config/init.lua"; then
  printf '\n-- AppShot: send the frontmost window to Claude\nappshot = require("appshot").start()\n' >> "$config/init.lua"
fi

open -g -a Hammerspoon
echo "Installed. If Hammerspoon was already running, choose Reload Config from its menu-bar icon."
echo "Grant Hammerspoon Accessibility and Screen & System Audio Recording in System Settings > Privacy & Security."
