#!/usr/bin/env bash
# Build a release archive for QUEUE.
#
#   scripts/package.sh [output.tar.gz]
#
# The archive contains source, docs, public proof, and media. It excludes the
# team's working notes (handoff, submission draft, post drafts),
# secrets, runtime state, dependencies, and build output.
# A secret scan runs over the staged tree before the archive is written.
#
# This script never commits, pushes, deploys, or publishes anything.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-dist/queue-release.tar.gz}"
case "$OUT" in
  /*) ;;
  *) OUT="$PWD/$OUT" ;;
esac

if ! command -v tar >/dev/null 2>&1; then
  echo "package: tar is required" >&2
  exit 1
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/queue-package.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

DEST="$STAGE/queue"
mkdir -p "$DEST"

EXCLUDES=(
  ".env"
  ".env.*"
  ".testnet"
  ".testnet/*"
  "*/.testnet/*"
  "build"
  "build/*"
  "coverage"
  "coverage/*"
  ".playwright"
  ".playwright/*"
  "node_modules"
  "node_modules/*"
  "data/queue.db"
  "data/queue.db-*"
  "dist"
  "dist/*"
  "dist-pages"
  "dist-pages/*"
  "*.tsbuildinfo"
  "target"
  "target/*"
  ".git"
  ".git/*"
  "*.log"
  "HANDOFF.md"
  "docs/SUBMISSION.md"
  "docs/X_POST.md"
  "docs/VOICEOVER.md"
  "docs/media/voiceover.mp3"
  "comparison.recomputed.json"
  ".DS_Store"
)

# Prefer tracked files when the folder is a git repository; otherwise copy the
# tree with explicit exclusions.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "package: source = git tracked files"
  while IFS= read -r -d '' file; do
    skip=0
    # .env.example is a public template and must ship; other .env files must not.
    if [ "$file" = ".env.example" ]; then skip=0; else
      for pattern in "${EXCLUDES[@]}"; do
        case "$file" in
          $pattern) skip=1; break ;;
        esac
      done
    fi
    [ "$skip" -eq 1 ] && continue
    mkdir -p "$DEST/$(dirname "$file")"
    cp -p "$file" "$DEST/$file"
  done < <(git ls-files -z)
else
  echo "package: source = working tree (no git repository)"
  if ! command -v rsync >/dev/null 2>&1; then
    echo "package: rsync is required when there is no git repository" >&2
    exit 1
  fi
  RSYNC_EXCLUDES=()
  for pattern in "${EXCLUDES[@]}"; do
    RSYNC_EXCLUDES+=(--exclude "$pattern")
  done
  # Include the public template before the .env.* exclusion.
  rsync -a --include '.env.example' "${RSYNC_EXCLUDES[@]}" ./ "$DEST/"
fi

# Fail closed if a key, secret field, or runtime database is in the stage.
echo "package: scanning staged tree for secrets"
violations=0
FORBIDDEN_FILES="$(find "$DEST" \( -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) -o -name 'queue.db*' -o -name '*.pem' -o -name '*.key' \) -print)"
if [ -n "$FORBIDDEN_FILES" ]; then
  echo "package: FAIL — forbidden file name in stage" >&2
  echo "$FORBIDDEN_FILES" >&2
  violations=1
fi
if [ -n "$(find "$DEST" -type d -name .testnet -print -quit)" ]; then
  echo "package: FAIL — a .testnet/ directory is present in stage" >&2
  violations=1
fi

# Prefer the project scanner, pointed at the staged copy so it can only see
# what will ship. It distinguishes a public base58 key from secret material.
if [ -f "$DEST/scripts/secret-scan.mjs" ]; then
  if ! node "$DEST/scripts/secret-scan.mjs"; then
    echo "package: FAIL — secret scan rejected the staged tree" >&2
    violations=1
  fi
else
  # Fallback: narrow value-level patterns, not prose that merely names a field.
  SECRET_HITS="$(grep -rIlE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----|"secret_?key"[[:space:]]*:[[:space:]]*"[^"]{8,}"|PRIVATE_KEY[[:space:]]*[=:][[:space:]]*"?[A-Za-z0-9+/=_-]{16,}|ed25519:[0-9a-fA-F]{64}|ed25519:[1-9A-HJ-NP-Za-km-z]{80,}|sk-[A-Za-z0-9_-]{20,}|NEAR_AI_API_KEY[[:space:]]*[=:][[:space:]]*\"?[A-Za-z0-9_-]{8,}' "$DEST" 2>/dev/null || true)"
  if [ -n "$SECRET_HITS" ]; then
    echo "package: FAIL — possible key material in:" >&2
    echo "$SECRET_HITS" >&2
    violations=1
  fi
fi

if [ "$violations" -ne 0 ]; then
  echo "package: refusing to write archive" >&2
  exit 1
fi
echo "package: secret scan clean"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
COPYFILE_DISABLE=1 tar -czf "$OUT" -C "$STAGE" queue

BYTES="$(wc -c < "$OUT" | tr -d ' ')"
HASH="$(shasum -a 256 "$OUT" | awk '{print $1}')"
echo "package: wrote $OUT"
echo "package: bytes $BYTES"
echo "package: sha256 $HASH"
echo "package: not committed, not pushed, not published"
