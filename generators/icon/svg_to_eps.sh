#!/usr/bin/env bash
# Converts output/{job_id}/icon.svg -> output/{job_id}/icon.eps using headless Inkscape.
# Fails loudly (non-zero exit) if the conversion doesn't produce a valid file.

set -euo pipefail

JOB_ID="$1"
IN_FILE="output/${JOB_ID}/icon.svg"
OUT_FILE="output/${JOB_ID}/icon.eps"

if [ ! -f "$IN_FILE" ]; then
  echo "ERROR: input SVG not found at $IN_FILE" >&2
  exit 1
fi

inkscape "$IN_FILE" --export-type=eps --export-filename="$OUT_FILE"

if [ ! -s "$OUT_FILE" ]; then
  echo "ERROR: EPS conversion produced an empty or missing file at $OUT_FILE" >&2
  exit 1
fi

echo "Converted $IN_FILE -> $OUT_FILE"
