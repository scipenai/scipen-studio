#!/usr/bin/env bash
# scripts/package.sh — bundle release artifacts into a tarball.
#
# Assumes `make build` (or `make release`) has already produced the
# release binaries. The script only stages + tars what it finds; it
# does NOT trigger any cargo / npm build itself. This keeps the
# packaging step fast, predictable, and re-runnable without rebuilds.
#
# Output:
#   dist/snaca-<version>-<target-triple>.tar.gz
#   dist/snaca-<version>-<target-triple>.tar.gz.sha256
#
# Layout inside the tarball:
#   snaca-<version>-<target-triple>/
#   ├── bin/
#   │   ├── snaca-server          (required)
#   │   ├── snaca-plugin-lark     (optional — skipped if not built)
#   │   └── snaca-cli             (optional — skipped if not built)
#   ├── snaca.toml.example
#   ├── README.md                 (if present at repo root)
#   ├── LICENSE                   (if present at repo root)
#   ├── docs/                     (markdown manuals)
#   ├── examples/skills/          (bundled reference skills, e.g. office-extract)
#   ├── scripts/                  (deployment helpers, e.g. install-minimax-skills.sh)
#   └── SHA256SUMS                (per-file checksums for the staged tree)
#
# Env overrides (all optional):
#   ROOT          repo root (default: git toplevel)
#   TARGET_DIR    where the release binaries live (default: $ROOT/target/release)
#   DIST_DIR      where to write the tarball   (default: $ROOT/dist)
#   VERSION       version string in the artifact name (default: workspace version)
#   TARGET_TRIPLE rust target triple in the name (default: rustc host triple)
#   STRIP         set to 0 to skip stripping binaries (default: 1)

set -euo pipefail

ROOT="${ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
TARGET_DIR="${TARGET_DIR:-${ROOT}/target/release}"
DIST_DIR="${DIST_DIR:-${ROOT}/dist}"
STRIP="${STRIP:-1}"

if [[ -z "${VERSION:-}" ]]; then
  # Read `version = "x.y.z"` from the workspace [package] section. The
  # [workspace.package] block in Cargo.toml inherits to every member.
  VERSION="$(awk -F'"' '/^version = "/ {print $2; exit}' "${ROOT}/Cargo.toml")"
fi
if [[ -z "${VERSION}" ]]; then
  echo "error: could not infer version from ${ROOT}/Cargo.toml" >&2
  exit 1
fi

if [[ -z "${TARGET_TRIPLE:-}" ]]; then
  if command -v rustc >/dev/null 2>&1; then
    # Don't `exit` inside awk here — it triggers SIGPIPE on rustc and
    # `set -o pipefail` then bubbles 141 out of the script. Use `sed`
    # which scans to EOF and exits 0 cleanly.
    TARGET_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
  fi
fi
if [[ -z "${TARGET_TRIPLE:-}" ]]; then
  echo "error: rustc not on PATH and TARGET_TRIPLE not set" >&2
  exit 1
fi

PKG_NAME="snaca-${VERSION}-${TARGET_TRIPLE}"
STAGE_DIR="${DIST_DIR}/${PKG_NAME}"
TARBALL="${DIST_DIR}/${PKG_NAME}.tar.gz"

# Required: the main server binary. If this is missing the user hasn't
# actually built anything — bail loudly.
if [[ ! -x "${TARGET_DIR}/snaca-server" ]]; then
  echo "error: ${TARGET_DIR}/snaca-server missing or not executable" >&2
  echo "       run \`make build\` (or \`make release\`) first" >&2
  exit 1
fi

# Soft warn when the admin SPA wasn't built. The binary still runs;
# /api/v1 works; only the embedded UI is missing.
if [[ ! -f "${ROOT}/web/dist/index.html" ]]; then
  echo "warn: web/dist/index.html missing — admin UI not embedded in this build" >&2
fi

mkdir -p "${DIST_DIR}"
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}/bin" "${STAGE_DIR}/examples"

# --- binaries -----------------------------------------------------------
install -m 0755 "${TARGET_DIR}/snaca-server" "${STAGE_DIR}/bin/snaca-server"

stage_optional_bin() {
  local name="$1"
  if [[ -x "${TARGET_DIR}/${name}" ]]; then
    install -m 0755 "${TARGET_DIR}/${name}" "${STAGE_DIR}/bin/${name}"
  else
    echo "note: ${name} not built — skipping" >&2
  fi
}
stage_optional_bin snaca-plugin-lark
stage_optional_bin snaca-cli

if [[ "${STRIP}" == "1" ]] && command -v strip >/dev/null 2>&1; then
  # Stripping shrinks the binary ~30-60%. Failures are non-fatal —
  # some platforms (e.g. mac arm64) need a different invocation; we
  # just warn and continue rather than refuse to ship.
  for b in "${STAGE_DIR}"/bin/*; do
    strip "$b" 2>/dev/null || echo "warn: strip failed for $b" >&2
  done
fi

# --- ancillary files ----------------------------------------------------
install -m 0644 "${ROOT}/snaca.toml.example" "${STAGE_DIR}/snaca.toml.example"

for f in README.md README.zh-CN.md CONTRIBUTING.md CONTRIBUTING.zh-CN.md SECURITY.md SECURITY.zh-CN.md LICENSE LICENSE.md LICENSE.txt; do
  [[ -f "${ROOT}/${f}" ]] && install -m 0644 "${ROOT}/${f}" "${STAGE_DIR}/${f}"
done

if [[ -d "${ROOT}/docs" ]]; then
  cp -R "${ROOT}/docs" "${STAGE_DIR}/docs"
fi

if [[ -d "${ROOT}/examples/skills" ]]; then
  cp -R "${ROOT}/examples/skills" "${STAGE_DIR}/examples/skills"
fi

# Deployment helpers. install-minimax-skills.sh provisions the five
# MiniMax skills (pdf/docx/xlsx/pptx-generator/pptx-plugin) and their
# runtime deps on a target host — operators run it post-unpack.
if [[ -f "${ROOT}/scripts/install-minimax-skills.sh" ]]; then
  mkdir -p "${STAGE_DIR}/scripts"
  install -m 0755 "${ROOT}/scripts/install-minimax-skills.sh" \
                  "${STAGE_DIR}/scripts/install-minimax-skills.sh"
fi

# --- checksum manifest --------------------------------------------------
# Deterministic order so reruns produce byte-identical manifests when
# the staged tree is unchanged.
(
  cd "${STAGE_DIR}"
  find . -type f ! -name SHA256SUMS -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum \
    > SHA256SUMS
)

# --- tarball ------------------------------------------------------------
# Use a sorted listing + fixed mtime so the tarball is closer to
# reproducible. Not bit-perfect (gzip header carries timestamp by
# default), but consistent enough for diffing across rebuilds.
(
  cd "${DIST_DIR}"
  rm -f "${PKG_NAME}.tar.gz" "${PKG_NAME}.tar.gz.sha256"
  tar --sort=name \
      --owner=0 --group=0 --numeric-owner \
      --mtime='UTC 2020-01-01' \
      -czf "${PKG_NAME}.tar.gz" "${PKG_NAME}"
  sha256sum "${PKG_NAME}.tar.gz" > "${PKG_NAME}.tar.gz.sha256"
)

echo "packaged ${TARBALL}"
ls -lh "${TARBALL}" "${TARBALL}.sha256"
