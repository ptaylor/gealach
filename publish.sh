#!/usr/bin/env bash
set -euo pipefail

# Publish Gealach to GitHub Pages.
#
# `main` is the working branch and is never published directly — a push to
# main does not touch the live site. This script stamps the version <meta> in
# index.html, tags the release on main, and publishes a fixed whitelist of
# static site files to a separate `public` branch (so tools/, test/, docs/
# and .github/ never reach the web).
#
#   Settings → Pages → Build and deployment → Source: Deploy from a branch
#   Branch: public, /(root)
#
# Usage:
#   ./publish.sh --no-push   # show the next version and URL without touching git
#   ./publish.sh             # stamp version, tag it, push main + tag + gh-pages

NO_PUSH=false
[[ "${1:-}" == "--no-push" ]] && NO_PUSH=true

URL="https://ptaylor.github.io/gealach/"
PAGES_BRANCH="public"

# Everything the browser loads at run time. `data/` is included so the vendored
# station snapshot is published once it exists; until then it is empty and
# simply skipped.
SITE_FILES=(
  index.html
  manifest.webmanifest
  sw.js
  js
  vendor
  icons
  data
)

# --- Next version from the latest tag ---
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
  echo "Would stamp ${NEXT_VERSION}, tag it, and publish ${PAGES_BRANCH} → ${URL}"
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean — commit or stash before publishing." >&2
  exit 1
fi

# --- Stamp the version into the page (the about overlay reads it) ---
sed -i.bak "s|content=\"v[0-9][0-9.]*\"|content=\"${NEXT_VERSION}\"|" index.html
rm -f index.html.bak
if ! git diff --quiet index.html; then
  git add index.html
  git commit -m "Bump version to ${NEXT_VERSION}"
fi

git tag -a "$NEXT_VERSION" -m "Release ${NEXT_VERSION}"

# --- Publish the site files as a fresh snapshot on gh-pages ---
# Stage only SITE_FILES into a throwaway index and commit that tree, so the
# published branch holds the site and nothing else.
TMP_INDEX="$(mktemp)"
trap 'rm -f "$TMP_INDEX"' EXIT
GIT_INDEX_FILE="$TMP_INDEX" git read-tree --empty

for f in "${SITE_FILES[@]}"; do
  if [[ -f "$f" ]]; then
    GIT_INDEX_FILE="$TMP_INDEX" git add "$f"
  elif [[ -d "$f" && -n "$(find "$f" -type f -print -quit)" ]]; then
    GIT_INDEX_FILE="$TMP_INDEX" git add "$f"
  fi
done

TREE=$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)
PARENT=""
if git rev-parse --verify "origin/${PAGES_BRANCH}" >/dev/null 2>&1; then
  PARENT="-p $(git rev-parse origin/${PAGES_BRANCH})"
fi
COMMIT=$(git commit-tree "$TREE" $PARENT -m "Publish ${NEXT_VERSION}")

git push origin "$COMMIT:refs/heads/${PAGES_BRANCH}"
git push
git push origin "$NEXT_VERSION"

echo ""
echo "Published ${NEXT_VERSION} → ${URL}"
