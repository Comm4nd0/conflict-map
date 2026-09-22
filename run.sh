#!/usr/bin/env bash
cd "$(dirname "$0")"
exec uv run uvicorn app.server:app --host 127.0.0.1 --port "${PORT:-8765}"
