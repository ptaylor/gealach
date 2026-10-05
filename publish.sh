#!/usr/bin/env bash
set -euo pipefail

# Publish Gealach to GitHub Pages.
#
# This repo is already a static site at the repo root — there is no build step,
# no version injection and no output directory, so "publishing" is just a
# version tag plus a push. GitHub Pages must be pointed at the main branch root
# once, in the repository settings:
#
#   Settings → Pages → Build and deployment → Source: Deploy from a branch
#   Branch: main, /(root)
#
# Usage:
#   ./publish.sh --no-push   # show the next version and URL without touching git
#   ./publish.sh             # tag vX.(Y+1), push main and the tag

NO_PUSH=false
if [[ "${1:-}" == "--no-push" ]]; then
  NO_PUSH=true
fi

URL="https://ptaylor.github.io/gealach/"

# --- Determine the next version from the latest tag ---
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0")
if [[ "$LATEST_TAG" =~ ^v([0-9]+)\.([0-9]+)$ ]]; then
  MAJOR="${BASH_REMATCH[1]}"
  MINOR="${BASH_REMATCH[2]}"
  NEXT_VERSION="v${MAJOR}.$((MINOR + 1))"
else
  NEXT_VERSION="v1.0"
fi

if $NO_PUSH; then
  echo "Next version: ${NEXT_VERSION}"
  echo "Would tag ${NEXT_VERSION}, push main and the tag, then publish to ${URL}"
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean — commit or stash before publishing." >&2
  exit 1
fi

git tag -a "$NEXT_VERSION" -m "Release ${NEXT_VERSION}"
git push
git push origin --tags
echo ""
echo "Published ${NEXT_VERSION} → ${URL}"
