#!/usr/bin/env bash
# Home pipeline + local viewer. Pushes the database to the public viewer after every refresh.
cd "$(dirname "$0")"
export PUSH_TARGET="${PUSH_TARGET-luma:/root/conflict-map/data}"
exec uv run uvicorn app.server:app --host 127.0.0.1 --port "${PORT:-8765}"
