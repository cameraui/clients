#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PACKAGES="browser transport logger"

resolve_pkg() {
  case "$1" in
    browser)   DIR="clients/browser";    NAME="@camera.ui/browser" ;;
    transport) DIR="packages/transport"; NAME="@camera.ui/transport" ;;
    logger)    DIR="packages/logger";    NAME="@camera.ui/logger" ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<EOF
Usage: scripts/release.sh <package> <version|major|minor|patch> [--yes] [--skip-checks]

Packages: $PACKAGES

Examples:
  scripts/release.sh browser 0.0.112
  scripts/release.sh transport patch

Pushes a tag <package>-v<version>; the release workflow then builds the whole
chain (externals + deps) and publishes that package to npm via OIDC.

Options:
  --yes, -y       Push without the confirmation prompt.
  --skip-checks   Skip the local build/test pre-flight.
EOF
  exit 1
}

PKG="${1:-}"
SPEC="${2:-}"
YES=false
SKIP_CHECKS=false
for arg in "${@:3}"; do
  case "$arg" in
    --yes | -y) YES=true ;;
    --skip-checks) SKIP_CHECKS=true ;;
    *) echo "Unknown option: $arg"; usage ;;
  esac
done

[ -z "$PKG" ] && usage
[ -z "$SPEC" ] && usage
resolve_pkg "$PKG" || { echo -e "${RED}Unknown package '$PKG'. Known: $PACKAGES${NC}"; exit 1; }

cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo -e "${RED}Working tree not clean - commit or stash first.${NC}"
  exit 1
fi
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo -e "${RED}Not on main (on '$branch').${NC}"
  exit 1
fi
git fetch -q origin main || true
if [ -n "$(git rev-list HEAD..origin/main 2>/dev/null)" ]; then
  echo -e "${RED}Local main is behind origin/main - pull first.${NC}"
  exit 1
fi

cur="$(node -p "require('./$DIR/package.json').version")"

bump() {
  local IFS='.'
  read -r ma mi pa <<<"$1"
  case "$2" in
    major) echo "$((ma + 1)).0.0" ;;
    minor) echo "$ma.$((mi + 1)).0" ;;
    patch) echo "$ma.$mi.$((pa + 1))" ;;
  esac
}

case "$SPEC" in
  major | minor | patch) NEW="$(bump "$cur" "$SPEC")" ;;
  *) NEW="$SPEC" ;;
esac

if ! echo "$NEW" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo -e "${RED}Invalid version '$NEW' (expected X.Y.Z).${NC}"
  exit 1
fi

TAG="$PKG-v$NEW"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo -e "${RED}Tag $TAG already exists.${NC}"
  exit 1
fi

echo -e "${CYAN}Releasing $NAME ($DIR): $cur -> $NEW (tag $TAG)${NC}"

if [ "$SKIP_CHECKS" = false ]; then
  echo -e "${YELLOW}Pre-flight: build (full ordered chain) + lint + test for $NAME...${NC}"
  npm run build
  npm run lint -w "$NAME" --if-present
  npm run test -w "$NAME" --if-present
fi

node -e "const f='./$DIR/package.json'; const p=require(f); p.version='$NEW'; require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n')"
git add "$DIR/package.json" package-lock.json
git commit -q -m "release($PKG): v$NEW"
echo -e "${GREEN}Committed version bump.${NC}"

git tag "$TAG"
echo -e "${GREEN}Created tag $TAG.${NC}"

if [ "$YES" = false ]; then
  printf "Push main + %s and trigger the release? [y/N] " "$TAG"
  read -r ans
  case "$ans" in
    y | Y | yes) ;;
    *)
      git tag -d "$TAG" >/dev/null
      git reset -q --hard HEAD~1
      echo "Aborted - tag and bump commit were undone locally."
      exit 0
      ;;
  esac
fi

git push -q origin main
git push -q origin "$TAG"
echo -e "${GREEN}Pushed. Watch the release workflow under the repo's Actions tab.${NC}"
