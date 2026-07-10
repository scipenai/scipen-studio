#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'SDK boundary check failed: %s\n' "$1" >&2
  exit 1
}

tree_contains() {
  local package="$1"
  local needle="$2"
  cargo tree -p "$package" -e normal | grep -q "$needle"
}

cargo check -p snaca-tools --no-default-features >/dev/null
cargo check -p snaca-tools --no-default-features --features fs-read,web-fetch >/dev/null
cargo check -p snaca-sdk --features channel-protocol,channel-host >/dev/null

if tree_contains snaca-tools 'snaca-engine v'; then
  fail 'snaca-tools must not depend on snaca-engine'
fi

if tree_contains snaca-sdk 'snaca-server v'; then
  fail 'snaca-sdk must not depend on snaca-server'
fi

if tree_contains snaca-sdk 'snaca-channel-host v'; then
  fail 'snaca-sdk default dependency tree must not include snaca-channel-host'
fi

for crate in \
  snaca-engine \
  snaca-tools \
  snaca-llm \
  snaca-mcp \
  snaca-skills \
  snaca-workspace \
  snaca-state \
  snaca-memory \
  snaca-channel-host \
  snaca-server
do
  if tree_contains snaca-agent-api "$crate v"; then
    fail "snaca-agent-api must not depend on $crate"
  fi
done

for crate in \
  snaca-agent-api \
  snaca-sdk \
  snaca-tools-api \
  snaca-llm \
  snaca-tools \
  snaca-mcp \
  snaca-skills \
  snaca-workspace \
  snaca-state \
  snaca-memory \
  snaca-engine \
  snaca-channel-protocol \
  snaca-channel-host \
  snaca-server
do
  if tree_contains snaca-core "$crate v"; then
    fail "snaca-core must not depend on $crate"
  fi
done

printf 'SDK boundary checks passed.\n'
