#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
SCENARIO=${1:-interactive}
OUTPUT=${2:-"$ROOT/terminal-e2e-recordings/${SCENARIO}.webm"}

for command_name in wezterm agg ffmpeg; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "record:tui requires $command_name" >&2
    if [[ "$command_name" == "agg" ]]; then
      echo "Install it with: brew install agg" >&2
    fi
    exit 1
  fi
done

FFMPEG_ENCODERS=$(ffmpeg -hide_banner -encoders 2>/dev/null)
if [[ "$FFMPEG_ENCODERS" != *"libvpx-vp9"* ]]; then
  echo "record:tui requires ffmpeg with the libvpx-vp9 encoder" >&2
  exit 1
fi

mkdir -p "$(dirname -- "$OUTPUT")"
CAPTURE_DIR=$(mktemp -d)
GIF_FILE="$CAPTURE_DIR/render.gif"
NORMALIZED_CAST_FILE="$CAPTURE_DIR/normalized.cast"
trap 'rm -rf "$CAPTURE_DIR"' EXIT INT TERM

echo "Recording deterministic scenario: $SCENARIO"
TMPDIR="$CAPTURE_DIR" wezterm record --cwd "$ROOT" -- \
  node "$ROOT/tests/terminal-e2e/recording/cinematic-demo.mjs" "$SCENARIO"

CAST_FILE=$(find "$CAPTURE_DIR" -type f \
  \( -name '*.cast' -o -name '*.cast.txt' \) -print -quit)
if [[ -z "$CAST_FILE" ]]; then
  echo "wezterm finished without producing an asciicast" >&2
  exit 1
fi

node --input-type=module - "$CAST_FILE" "$NORMALIZED_CAST_FILE" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);
const source = readFileSync(inputPath, "utf8");
const newlineIndex = source.indexOf("\n");
if (newlineIndex < 0) throw new Error("asciicast header is missing");
const header = JSON.parse(source.slice(0, newlineIndex));
if (header.version !== 2) throw new Error("expected asciicast v2 output");
header.width = 100;
header.height = 32;
writeFileSync(
  outputPath,
  `${JSON.stringify(header)}${source.slice(newlineIndex)}`,
  "utf8",
);
NODE

echo "Rendering asciicast with agg"
agg --cols 100 --rows 32 --idle-time-limit 4 \
  "$NORMALIZED_CAST_FILE" "$GIF_FILE"

echo "Encoding VP9 WebM with ffmpeg"
ffmpeg -hide_banner -loglevel error -y \
  -i "$GIF_FILE" \
  -an -c:v libvpx-vp9 -crf 32 -b:v 0 -pix_fmt yuv420p \
  "$OUTPUT"

printf 'WebM written to %s\n' "$OUTPUT"
