#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/start.sh" --window "$@"
