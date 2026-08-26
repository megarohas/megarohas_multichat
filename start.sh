#!/bin/sh
# megarohas_multichat — запуск под Linux / macOS.
# Использует портативный Node из runtime/node, если он лежит рядом
# (распакуй туда tar с nodejs.org так, чтобы был runtime/node/bin/node),
# иначе — системный node (нужен 18+).
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$DIR/runtime/node/bin/node" ]; then
  NODE="$DIR/runtime/node/bin/node"
else
  NODE=node
fi
exec "$NODE" "$DIR/server.js" "$@"
