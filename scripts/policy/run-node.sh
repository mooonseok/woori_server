#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
required_node=$(cat "$repo_dir/.nvmrc")
node_candidate="${NVM_DIR:-$HOME/.nvm}/versions/node/v${required_node}/bin"
if [ -x "$node_candidate/node" ]; then
  PATH="$node_candidate:$PATH"
  export PATH
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]; then
  echo 'woori policy requires Node 24. Run nvm install && nvm use.' >&2
  exit 2
fi
exec node "$@"
