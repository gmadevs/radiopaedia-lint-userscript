#!/usr/bin/env bash
#
# Tag and publish a release straight from the userscript header.
#
# @version is the number that matters: it is what Tampermonkey compares against
# to decide whether to update, so the tag is derived from it rather than typed
# again here. Bump @version in the script, commit, run this.
#
#   ./release.sh        # asks before it pushes anything
#   ./release.sh -y     # no questions
#
set -euo pipefail

cd "$(dirname "$0")"
SCRIPT=radiopaedia-lint.user.js
# Shipped alongside, though the script fetches it from `main` rather than from a
# release: a release that carries the canon says which canon it was built against.
CANON=article-structure.json

version=$(sed -n 's|^// @version[[:space:]]*||p' "$SCRIPT" | head -1 | tr -d '[:space:]')
[ -n "$version" ] || { echo "no @version line in $SCRIPT" >&2; exit 1; }
tag="v$version"

# The release asset is the file as it sits on disk: a dirty tree would ship
# something that is in no commit.
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty — commit before releasing:" >&2
  git status --short >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists — bump @version in $SCRIPT first" >&2
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)

if [ "${1:-}" != "-y" ]; then
  echo "about to publish $tag from $branch ($(git rev-parse --short HEAD))"
  read -r -p "go ahead? [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "nothing done"; exit 1; }
fi

git tag -a "$tag" -m "$tag"
git push origin "$branch" "$tag"
gh release create "$tag" --title "$tag" --generate-notes "$SCRIPT" "$CANON"
