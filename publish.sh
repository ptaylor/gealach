#!/usr/bin/env bash
set -euo pipefail

# Publish Gealach to GitHub Pages.
#
# This repo is already a static site at the repo root — there is no build step
# and no output directory, so "publishing" is a version tag plus a push. The
# only stamped value is the version <meta> in index.html, which the about
# overlay reads; publish.sh bumps it to match the tag.
#
#   Settings → Pages → Build and deployment → Source: Deploy from a branch
#   Branch: main, /(root)
#
# Usage:
#   ./publish.sh --no-push   # show the next version and URL without touching git
#   ./publish.sh             # stamp version, tag vX.(Y+1), push main and the tag

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

# Stamp the version into the page so the about overlay can show it.
sed -i.bak "s|content=\"v[0-9][0-9.]*\"|content=\"${NEXT_VERSION}\"|" index.html
rm -f index.html.bak
if ! git diff --quiet index.html; then
  git add index.html
  git commit -m "Bump version to ${NEXT_VERSION}"
fi

git tag -a "$NEXT_VERSION" -m "Release ${NEXT_VERSION}"
git push
git push origin --tags
echo ""
echo "Published ${NEXT_VERSION} → ${URL}"
