#!/usr/bin/env bash
# Install every dshell-* package into a dsh profile as plain dependencies.
# Required because pnpm's `add` only links the named directory and does
# not recurse into its `dependencies`. dsh treats these as profile layers
# only when their manifest declares `dsh.bundle` (currently only
# dshell-bundle does; the rest are plain runtime deps of that bundle).
#
# Usage: ./scripts/install-into-dsh-profile.sh <profile-name>
# Default profile: web
#
# Prerequisites: dshell workspace must be installed
# (`pnpm install` in this repo) and dsh must be on PATH.

set -euo pipefail

PROFILE="${1:-web}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DSH_PKG="${DSH_CMD:-pnpm dsh}"

# Order matters: bundle must be added last so its deps are already present
# when dsh's reconcile pass promotes it into dsh.profile.bundles.
PLUGINS=(
  conversation
  terminal-bridge
  mode
  commands
  workspace
  ssh
  buffer
  files
)

echo "Installing dshell plugins into profile '$PROFILE'..."

for plugin in "${PLUGINS[@]}"; do
  pkg_dir="$HERE/packages/dshell/$plugin"
  if [[ ! -d "$pkg_dir" ]]; then
    echo "  ! skipping $plugin: $pkg_dir not found" >&2
    continue
  fi
  echo "  + dshell-$plugin"
  ( cd "$HERE/dsh" && $DSH_PKG plugin --profile "$PROFILE" add -w "$pkg_dir" )
done

echo "  + dshell-bundle (as patch layer)"
( cd "$HERE/dsh" && $DSH_PKG plugin --profile "$PROFILE" add -w "$HERE/packages/dshell/bundle" )

# dshell is not a preset: the terminal unification is a host-side backend
# takeover (the bridge registers the `shell` PTY type), so no preset is
# installed. Remove a copy left by an earlier install so the roster does not
# list a stale fifth mode.
PRESET_HOME="${DSH_HOME:-$HOME/.dsh}/.agent-presets/dshell"
if [ -d "$PRESET_HOME" ]; then
  rm -rf "$PRESET_HOME"
  echo "  - stale dshell agent preset removed from $PRESET_HOME"
fi

echo "Done. Run 'pnpm dsh web --profile $PROFILE' to verify."