#!/usr/bin/env bash
# Create a new private, standalone GitHub repo (not a fork) and push this project.
# Run locally with your own GitHub CLI auth: gh auth login
set -euo pipefail

OWNER="${REPO_OWNER:-plexflixplus}"
NAME="${REPO_NAME:-opencharacters}"
DESCRIPTION="${REPO_DESCRIPTION:-Private OpenCharacters deployment with server-side sync, free models, Perchance bridge, and web-page character generation}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI: https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Run: gh auth login" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if gh repo view "${OWNER}/${NAME}" >/dev/null 2>&1; then
  echo "Repository ${OWNER}/${NAME} already exists."
  if git remote get-url origin 2>/dev/null | grep -q "${OWNER}/${NAME}"; then
    echo "Origin already points at ${OWNER}/${NAME}. Pushing branches..."
    git push -u origin main
    git push origin gh-pages 2>/dev/null || true
    exit 0
  fi
  echo "Add it as origin manually, or set REPO_NAME to a different name." >&2
  exit 1
fi

HAD_OLD_ORIGIN=false
if git remote get-url origin 2>/dev/null | grep -qi 'OpenCharacterss'; then
  HAD_OLD_ORIGIN=true
fi

echo "Creating private standalone repo ${OWNER}/${NAME}..."
if ! gh repo create "${OWNER}/${NAME}" \
  --private \
  --description "${DESCRIPTION}" \
  --source=. \
  --remote=origin-new \
  --push; then
  echo "Failed to create ${OWNER}/${NAME}. Run this script on a machine with repo admin access (gh auth login)." >&2
  git remote remove origin-new 2>/dev/null || true
  exit 1
fi

if [[ "$HAD_OLD_ORIGIN" == true ]]; then
  echo "Switching origin to the new private repo..."
  git remote rename origin old-origin
fi
git remote rename origin-new origin

echo ""
echo "Done. New private repo: https://github.com/${OWNER}/${NAME}"
echo ""
echo "Optional cleanup of the old public fork:"
echo "  gh repo delete plexflixplus/OpenCharacterss --yes"
echo ""
echo "Run the app:"
echo "  npm install"
echo "  node daemon.js"
