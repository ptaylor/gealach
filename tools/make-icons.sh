#!/bin/sh
set -eu
# Rasterise the flat icon SVGs into the PNG sizes the manifest and iOS need.
# Requires ImageMagick (`magick`). The art is flat on purpose: this build has
# no librsvg delegate, and MSVG silently drops gradients, dashes and filters.
#
# Icon sources drawn with an AI coding assistant.
# Assisted-by: GitHub Copilot (DeepSeek V4 Pro)

cd "$(dirname "$0")/.."
mkdir -p icons

# -background none must come BEFORE the input file, or transparency is lost
# and a white square appears behind the rounded icon. The maskable/apple-touch
# variant carries its own full-bleed ground and must stay opaque (iOS renders
# transparent apple-touch icons as black). -strip drops the date:create/
# date:modify timestamps ImageMagick embeds, so the output is deterministic
# and re-running the script never churns git with identical-looking PNGs.
magick -background none icons/icon.svg          -strip -resize 512x512 icons/icon-512.png
magick -background none icons/icon.svg          -strip -resize 192x192 icons/icon-192.png
magick -background none icons/icon-maskable.svg -strip -resize 180x180 icons/icon-180.png
magick -background none icons/icon-maskable.svg -strip -resize 512x512 icons/icon-512-maskable.png

# Verify transparency survived on the rounded icon: the corner must be
# srgba(0,0,0,0) and the minimum alpha must be 0.
magick -background none icons/icon-192.png \
  -format 'icon-192 corner %[pixel:p{2,2}] min-alpha %[fx:minima.a]\n' info:
