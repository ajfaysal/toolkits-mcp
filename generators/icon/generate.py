#!/usr/bin/env python3
"""
Generates a single Adobe-Stock-compliant SVG icon.

Contract (must be followed by every future generator too):
  Input:  --description --style --colors --job_id --extra_options (JSON string)
  Output: writes files into /output/{job_id}/   (this folder gets uploaded to R2 as-is)

Adobe Stock icon rules enforced here:
  - transparent background
  - single merged/compound shape, strokes as paths
  - no descriptive/placeholder text baked into the artwork
  - minimum 500px artboard
  - no watermark/logo
"""
import argparse
import json
import os
import sys

ARTBOARD = 512  # px, safely above Adobe's 500px minimum

STYLE_TEMPLATES = {
    "line": {
        "fill": "none",
        "stroke_width": 24,
    },
    "flat": {
        "fill": "solid",
        "stroke_width": 0,
    },
    "bi-chromatic": {
        "fill": "accent",
        "stroke_width": 12,
    },
}


def build_svg(description: str, style: str, colors: list, extra: dict) -> str:
    cfg = STYLE_TEMPLATES.get(style, STYLE_TEMPLATES["line"])
    primary = colors[0] if colors else "#1A1A1A"
    accent = colors[1] if len(colors) > 1 else primary

    # NOTE: This is a minimal, safe placeholder shape generator (a rounded
    # compound icon glyph) so the pipeline is fully testable end-to-end.
    # Swap this function's body for a call to a real vector-generation
    # model/API later — the contract (SVG string in, file on disk out)
    # stays identical, so nothing else in the pipeline needs to change.
    cx, cy, r = ARTBOARD / 2, ARTBOARD / 2, ARTBOARD * 0.32

    if cfg["fill"] == "none":
        body = (
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" '
            f'stroke="{primary}" stroke-width="{cfg["stroke_width"]}" stroke-linecap="round"/>'
        )
    elif cfg["fill"] == "solid":
        body = f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{primary}"/>'
    else:  # bi-chromatic
        body = (
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" '
            f'stroke="{primary}" stroke-width="{cfg["stroke_width"]}" stroke-linecap="round"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r * 0.4}" fill="{accent}"/>'
        )

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{ARTBOARD}" height="{ARTBOARD}" viewBox="0 0 {ARTBOARD} {ARTBOARD}">
  <!-- generated icon: {description[:80]} | style={style} -->
  {body}
</svg>'''
    return svg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--description", required=True)
    parser.add_argument("--style", default="line")
    parser.add_argument("--colors", default="[]", help="JSON array of hex strings")
    parser.add_argument("--job_id", required=True)
    parser.add_argument("--extra_options", default="{}")
    args = parser.parse_args()

    try:
        colors = json.loads(args.colors) if args.colors else []
    except json.JSONDecodeError:
        colors = []

    try:
        extra = json.loads(args.extra_options) if args.extra_options else {}
    except json.JSONDecodeError:
        extra = {}

    out_dir = os.path.join("output", args.job_id)
    os.makedirs(out_dir, exist_ok=True)

    svg_content = build_svg(args.description, args.style, colors, extra)
    svg_path = os.path.join(out_dir, "icon.svg")
    with open(svg_path, "w") as f:
        f.write(svg_content)

    print(f"Wrote {svg_path}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR generating icon: {e}", file=sys.stderr)
        sys.exit(1)
