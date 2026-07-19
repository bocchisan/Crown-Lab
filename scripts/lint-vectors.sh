#!/usr/bin/env bash
# The lab holds its own copy of the factory's salt and PDA vectors, because
# the byte formats they pin are reimplemented here in TypeScript. A copy that
# silently drifts from the factory would pin the drift instead of catching it,
# so the copy must stay byte-identical to the source that owns it.
#
# Usage: scripts/lint-vectors.sh
set -euo pipefail
cd "$(dirname "$0")/.."

FACTORY=${FACTORY_REPO:-../Crown-Factory}
RAW=https://raw.githubusercontent.com/bocchisan/Crown-Factory/main/vectors

status=0
for name in stream-salt.json solana.json; do
    reference="$FACTORY/vectors/$name"
    if [ ! -f "$reference" ]; then
        # No working tree next door (CI, a fresh clone): fall back to the
        # published file rather than skipping the check.
        reference=$(mktemp)
        curl -fsSL "$RAW/$name" -o "$reference" || {
            echo "FAIL: no reference for $name (neither $FACTORY nor $RAW)" >&2
            exit 1
        }
    fi
    if cmp -s "vectors/$name" "$reference"; then
        echo "ok: vectors/$name matches the factory"
    else
        echo "FAIL: vectors/$name drifted from $reference" >&2
        status=1
    fi
done

exit $status
