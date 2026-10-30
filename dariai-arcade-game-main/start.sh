#!/bin/sh
cd "$(dirname "$0")"
python3 app.py &
sleep 1
( command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:8765/" ) || \
( command -v open >/dev/null && open "http://127.0.0.1:8765/" ) || \
echo "Open http://127.0.0.1:8765/ in your browser."
