#!/usr/bin/env bash
# install-minimax-skills.sh — deploy the five MiniMax skills into a
# snaca global-skills directory and install everything they need to
# run on this host.
#
# Bundled in the snaca tarball (see scripts/package.sh). Operators run
# this once after unpacking a release; idempotent on re-run.
#
# What it deploys (clones https://github.com/MiniMax-AI/skills.git):
#   <dest>/minimax-pdf       — reportlab/pypdf/matplotlib + Playwright
#   <dest>/minimax-docx      — .NET 8 SDK + OpenXML (built in-place)
#   <dest>/minimax-xlsx      — pandas/openpyxl/lxml + optional LibreOffice
#   <dest>/pptx-generator    — pptxgenjs + markitdown[pptx]
#   <dest>/pptx-plugin       — same deps as pptx-generator; snaca's
#                              recursive skill loader picks up the
#                              nested SKILL.md files automatically.
#
# Usage:
#   install-minimax-skills.sh [--dest DIR] [--ref REF] [--source-dir DIR]
#                             [--skip-deps] [--minimal] [--skip SKILL]...
#                             [--yes] [-h|--help]
#
# After it finishes, point your snaca.toml at the dest directory:
#   [skills]
#   global_dir = "<absolute dest>"

set -euo pipefail

# ── Defaults ───────────────────────────────────────────────────────────────────
DEFAULT_REPO="https://github.com/MiniMax-AI/skills.git"
DEFAULT_REF="main"
DEFAULT_DEST="./skills-global"

DEST="$DEFAULT_DEST"
REF="$DEFAULT_REF"
REPO="$DEFAULT_REPO"
SOURCE_DIR=""
SKIP_DEPS=0
MINIMAL=0
ASSUME_YES=0
SKIPS=()

# Skills to stage. `key:src_subpath` — src is relative to the cloned repo root.
SKILLS=(
  "minimax-pdf:skills/minimax-pdf"
  "minimax-docx:skills/minimax-docx"
  "minimax-xlsx:skills/minimax-xlsx"
  "pptx-generator:skills/pptx-generator"
  "pptx-plugin:plugins/pptx-plugin"
)

# ── Output helpers ─────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[0;33m'
  C_BLU=$'\033[0;34m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_BLD=""; C_RST=""
fi

log()  { printf '%s[OK]%s   %s\n'   "$C_GRN" "$C_RST" "$*"; }
info() { printf '%s[INFO]%s %s\n'   "$C_BLU" "$C_RST" "$*"; }
warn() { printf '%s[WARN]%s %s\n'   "$C_YEL" "$C_RST" "$*" >&2; }
fail() { printf '%s[FAIL]%s %s\n'   "$C_RED" "$C_RST" "$*" >&2; }
step() { printf '\n%s=== %s ===%s\n' "$C_BLD" "$*" "$C_RST"; }

die()  { fail "$*"; exit 1; }

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ── Argument parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)        DEST="${2:?--dest needs a path}"; shift 2 ;;
    --ref)         REF="${2:?--ref needs a value}"; shift 2 ;;
    --repo)        REPO="${2:?--repo needs a URL}"; shift 2 ;;
    --source-dir)  SOURCE_DIR="${2:?--source-dir needs a path}"; shift 2 ;;
    --skip)        SKIPS+=("${2:?--skip needs a skill name}"); shift 2 ;;
    --skip-deps)   SKIP_DEPS=1; shift ;;
    --minimal)     MINIMAL=1;   shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    -h|--help)     usage ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

skip_skill() {
  local k="$1" s
  for s in "${SKIPS[@]+"${SKIPS[@]}"}"; do
    [[ "$s" == "$k" ]] && return 0
  done
  return 1
}

# ── Platform detection ─────────────────────────────────────────────────────────
detect_platform() {
  OS="unknown"; PKG_MGR="unknown"; ARCH="$(uname -m)"
  case "$(uname -s)" in
    Darwin)
      OS="macos"
      command -v brew >/dev/null && PKG_MGR="brew" || PKG_MGR="none"
      ;;
    Linux)
      OS="linux"
      if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        case "${ID:-}" in
          ubuntu|debian|linuxmint|pop|raspbian) PKG_MGR="apt" ;;
          fedora|rhel|centos|rocky|alma)        PKG_MGR="dnf" ;;
          arch|manjaro|endeavouros)             PKG_MGR="pacman" ;;
          opensuse*|sles)                       PKG_MGR="zypper" ;;
          alpine)                               PKG_MGR="apk" ;;
        esac
      fi
      grep -qi microsoft /proc/version 2>/dev/null && OS="wsl"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      OS="windows-bash"; PKG_MGR="none"
      ;;
  esac
  info "Platform: $OS ($ARCH), package manager: $PKG_MGR"
}

# ── sudo helper ─────────────────────────────────────────────────────────────────
# Wraps system-package installs. Skips the prompt if we're already root
# or if --yes was passed (and sudo supports -n).
SUDO=""
init_sudo() {
  if [[ $EUID -eq 0 ]]; then
    SUDO=""; return
  fi
  if command -v sudo >/dev/null; then
    # sudo always prompts interactively if needed — even with --yes,
    # because that flag is about *our* prompts, not sudo's. Operators
    # who want fully non-interactive runs should pre-cache creds with
    # `sudo -v` before invoking, or run as root.
    SUDO="sudo"
  else
    SUDO=""
    warn "no sudo on PATH; system-package steps will be skipped if not root"
  fi
}

pkg_install() {
  # pkg_install <pkg> [<pkg> …] — install via the detected manager.
  # Silently no-ops if the manager is unknown; the caller logs.
  case "$PKG_MGR" in
    brew)   brew install "$@" ;;
    apt)    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$@" ;;
    dnf)    $SUDO dnf install -y "$@" ;;
    pacman) $SUDO pacman -S --noconfirm --needed "$@" ;;
    zypper) $SUDO zypper install -y "$@" ;;
    apk)    $SUDO apk add --no-cache "$@" ;;
    *)      return 1 ;;
  esac
}

# ── Source acquisition ─────────────────────────────────────────────────────────
SRC_ROOT=""        # absolute path to the repo checkout we'll copy from
SRC_TMP=""         # set if we cloned to a tmp dir (cleaned on exit)

cleanup() {
  # Always exit 0 — this runs from an EXIT trap and its return code
  # becomes the script's exit code if the main body succeeded.
  if [[ -n "$SRC_TMP" && -d "$SRC_TMP" ]]; then
    rm -rf "$SRC_TMP"
  fi
  return 0
}
trap cleanup EXIT

acquire_source() {
  step "Acquiring MiniMax skills source"
  if [[ -n "$SOURCE_DIR" ]]; then
    [[ -d "$SOURCE_DIR" ]] || die "--source-dir does not exist: $SOURCE_DIR"
    SRC_ROOT="$(cd "$SOURCE_DIR" && pwd)"
    log "using local source: $SRC_ROOT"
    return
  fi
  command -v git >/dev/null || die "git not found; install git or pass --source-dir"
  SRC_TMP="$(mktemp -d -t minimax-skills.XXXXXX)"
  info "cloning $REPO@$REF → $SRC_TMP"
  git clone --depth 1 --branch "$REF" "$REPO" "$SRC_TMP" \
    || die "git clone failed"
  SRC_ROOT="$SRC_TMP"
  log "cloned $(cd "$SRC_ROOT" && git rev-parse --short HEAD)"
}

# ── Stage the five skills ──────────────────────────────────────────────────────
stage_skills() {
  step "Staging skills → $DEST"
  mkdir -p "$DEST"
  DEST="$(cd "$DEST" && pwd)"        # resolve to absolute for the summary
  local entry name sub src dst staged=0
  for entry in "${SKILLS[@]}"; do
    name="${entry%%:*}"
    sub="${entry#*:}"
    if skip_skill "$name"; then
      warn "skipping $name (--skip)"
      continue
    fi
    src="$SRC_ROOT/$sub"
    dst="$DEST/$name"
    if [[ ! -d "$src" ]]; then
      fail "source missing: $sub (upstream layout changed?)"
      continue
    fi
    info "staging $name"
    rm -rf "$dst"
    # Prefer rsync for an atomic-feeling sync; fall back to cp -a.
    if command -v rsync >/dev/null; then
      rsync -a --delete "$src"/ "$dst"/
    else
      cp -a "$src" "$dst"
    fi
    if [[ ! -f "$dst/SKILL.md" && "$name" != "pptx-plugin" ]]; then
      warn "$name: no SKILL.md at top level (snaca may not pick it up)"
    fi
    log "$name → $dst"
    staged=$((staged + 1))
  done
  [[ $staged -gt 0 ]] || die "no skills were staged"
}

# ── Dependency installers ──────────────────────────────────────────────────────
need_python_pkgs=(reportlab pypdf matplotlib pandas openpyxl lxml "markitdown[pptx]")
need_node_pkgs=(playwright pptxgenjs)

ensure_system_tools() {
  step "Checking system tools (python3, pip, node, npm, git, zip)"
  local missing=()
  for t in python3 node npm git unzip zip curl; do
    command -v "$t" >/dev/null || missing+=("$t")
  done
  # On Debian/Ubuntu python3-pip is a separate package — `python3` being
  # on PATH doesn't mean `python3 -m pip` works. Treat missing pip as a
  # missing tool so the apt/dnf branch below installs it.
  if command -v python3 >/dev/null && ! python3 -m pip --version >/dev/null 2>&1; then
    missing+=("python3-pip")
  fi
  if [[ ${#missing[@]} -eq 0 ]]; then
    log "all base tools present"
    return
  fi
  info "missing: ${missing[*]}"
  case "$PKG_MGR" in
    apt)
      # python3-pip & python3-venv: Debian/Ubuntu split pip out of the base package.
      pkg_install python3 python3-pip python3-venv nodejs npm git zip unzip curl \
        || warn "apt install failed; you may need to install these manually"
      ;;
    dnf)
      pkg_install python3 python3-pip nodejs npm git zip unzip curl \
        || warn "dnf install failed"
      ;;
    pacman)
      pkg_install python python-pip nodejs npm git zip unzip curl || warn "pacman install failed"
      ;;
    zypper)
      pkg_install python3 python3-pip nodejs npm git zip unzip curl || warn "zypper install failed"
      ;;
    apk)
      pkg_install python3 py3-pip nodejs npm git zip unzip curl || warn "apk install failed"
      ;;
    brew)
      pkg_install python node git || warn "brew install failed"
      ;;
    *)
      warn "no known package manager; install manually: ${missing[*]}"
      ;;
  esac
}

ensure_python_pkgs() {
  step "Installing Python packages"
  command -v python3 >/dev/null || { warn "python3 still missing; skipping pip step"; return; }
  # Externally-managed envs (PEP 668) require --break-system-packages on Debian/Ubuntu;
  # try the polite path first, fall back loudly.
  local pip_args=(--user --upgrade)
  if python3 -m pip install "${pip_args[@]}" "${need_python_pkgs[@]}" 2>/dev/null; then
    log "pip --user install succeeded"
  elif python3 -m pip install --break-system-packages --upgrade "${need_python_pkgs[@]}"; then
    log "pip --break-system-packages install succeeded"
  else
    fail "pip install failed for: ${need_python_pkgs[*]}"
    warn "retry manually: python3 -m pip install --user ${need_python_pkgs[*]}"
  fi
}

ensure_node_pkgs() {
  step "Installing Node packages (global)"
  if ! command -v npm >/dev/null; then
    warn "npm missing; skipping node packages"
    return
  fi
  # `npm install -g` writes to a system prefix on many Linux distros.
  # If that needs root and we don't have it, fall through to a per-user prefix.
  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || echo "")"
  if [[ -n "$npm_prefix" && ! -w "$npm_prefix/lib" && -z "$SUDO" ]]; then
    warn "global npm prefix $npm_prefix not writable; falling back to per-user prefix"
    mkdir -p "$HOME/.npm-global"
    npm config set prefix "$HOME/.npm-global"
    # shellcheck disable=SC2016
    info 'add $HOME/.npm-global/bin to PATH to use the binaries'
  fi
  if [[ -n "$SUDO" && -n "$npm_prefix" && ! -w "$npm_prefix/lib" ]]; then
    $SUDO npm install -g --silent "${need_node_pkgs[@]}" || warn "global npm install failed"
  else
    npm install -g --silent "${need_node_pkgs[@]}" || warn "global npm install failed"
  fi
  log "npm packages installed: ${need_node_pkgs[*]}"

  # Playwright needs a Chromium binary; fetch it once. Playwright only
  # ships prebuilt browsers for a fixed set of host OS versions — if the
  # OS is newer than what the installed Playwright knows about, the
  # download errors out. Tell the operator clearly rather than silently
  # passing it off as a generic warning.
  if npx --no-install playwright --version >/dev/null 2>&1; then
    info "installing Playwright Chromium (may take a minute)"
    if ! npx --yes playwright install chromium; then
      warn "Playwright Chromium download failed."
      warn "  Most common cause: host OS newer than this Playwright build supports."
      warn "  Workaround: \`npx playwright install --with-deps chromium\` from inside"
      warn "  the minimax-pdf skill, or upgrade Playwright globally:"
      warn "    npm install -g playwright@latest && npx playwright install chromium"
      warn "  minimax-pdf cover rendering needs this — skill still installs, runtime will fail."
    fi
  fi
}

ensure_dotnet() {
  step "Checking .NET 8 SDK (for minimax-docx)"
  if skip_skill "minimax-docx"; then
    info "minimax-docx skipped; .NET SDK not required"
    return
  fi
  if command -v dotnet >/dev/null; then
    local ver major
    ver="$(dotnet --version 2>/dev/null || echo 0)"
    major="${ver%%.*}"
    if [[ "$major" =~ ^[0-9]+$ ]] && [[ "$major" -ge 8 ]]; then
      log "dotnet $ver (>= 8.0 OK)"
      return
    fi
    warn "dotnet $ver < 8.0; will install side-by-side"
  fi

  # Try the package manager first (system-wide, easier to upgrade).
  case "$PKG_MGR" in
    dnf)
      pkg_install dotnet-sdk-8.0 && command -v dotnet >/dev/null && { log "dotnet via dnf"; return; }
      ;;
    pacman)
      pkg_install dotnet-sdk && command -v dotnet >/dev/null && { log "dotnet via pacman"; return; }
      ;;
    zypper)
      pkg_install dotnet-sdk-8.0 && command -v dotnet >/dev/null && { log "dotnet via zypper"; return; }
      ;;
    brew)
      pkg_install --cask dotnet-sdk && command -v dotnet >/dev/null && { log "dotnet via brew"; return; }
      ;;
  esac

  # Fallback: Microsoft's per-user installer. Doesn't need sudo.
  info "using Microsoft's dotnet-install.sh → \$HOME/.dotnet"
  local installer="/tmp/dotnet-install.$$.sh"
  if command -v curl >/dev/null; then
    curl -sSL "https://dot.net/v1/dotnet-install.sh" -o "$installer"
  elif command -v wget >/dev/null; then
    wget -q "https://dot.net/v1/dotnet-install.sh" -O "$installer"
  else
    warn "no curl/wget; cannot fetch dotnet-install.sh"
    return
  fi
  chmod +x "$installer"
  "$installer" --channel 8.0 --install-dir "$HOME/.dotnet" || { warn ".NET install failed"; rm -f "$installer"; return; }
  rm -f "$installer"
  export PATH="$HOME/.dotnet:$PATH"
  # Persist the PATH change. Write to whichever rc files exist so we don't
  # silently fail for zsh-only users.
  local line='export PATH="$HOME/.dotnet:$PATH"  # added by snaca install-minimax-skills.sh'
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$rc" ]] && ! grep -qF '$HOME/.dotnet:$PATH' "$rc" 2>/dev/null; then
      printf '\n%s\n' "$line" >> "$rc"
    fi
  done
  command -v dotnet >/dev/null && log "dotnet $(dotnet --version) installed" \
    || warn "dotnet not on PATH after install; open a new shell and re-run"
}

build_docx_dotnet() {
  step "Building minimax-docx .NET project"
  if skip_skill "minimax-docx"; then
    info "skipped"
    return
  fi
  local proj_dir="$DEST/minimax-docx/scripts/dotnet"
  # Target Cli.csproj directly. It has a ProjectReference to Core, so
  # restoring/building Cli pulls Core in. We avoid `dotnet restore .`
  # because the directory ships a `.slnx` (new XML solution format)
  # which only .NET 9.0.200+ recognizes — older SDKs (we install 8.0)
  # bail with "Specify a project or solution file".
  local proj="$proj_dir/MiniMaxAIDocx.Cli/MiniMaxAIDocx.Cli.csproj"
  if [[ ! -f "$proj" ]]; then
    warn "$proj not found; skipping build (upstream layout changed?)"
    return
  fi
  if ! command -v dotnet >/dev/null; then
    warn "dotnet not on PATH; open a new shell (PATH was added to ~/.bashrc / ~/.zshrc) then re-run with --skip-deps to just rebuild"
    return
  fi
  DOTNET_CLI_UI_LANGUAGE=en dotnet restore "$proj" --verbosity quiet \
    || die "dotnet restore failed"
  DOTNET_CLI_UI_LANGUAGE=en dotnet build   "$proj" --verbosity quiet --no-restore -c Release \
    || die "dotnet build failed"
  log "minimax-docx built (Release)"
}

install_optional() {
  [[ $MINIMAL -eq 1 ]] && { info "--minimal: skipping optional deps"; return; }
  step "Optional deps (LibreOffice, CJK fonts, pandoc)"

  # LibreOffice (xlsx formula recalc, .doc → .docx conversion).
  if command -v soffice >/dev/null || command -v libreoffice >/dev/null; then
    log "libreoffice already present"
  else
    case "$PKG_MGR" in
      apt)    pkg_install libreoffice-core libreoffice-calc libreoffice-writer || warn "libreoffice install failed (optional)" ;;
      dnf)    pkg_install libreoffice-core libreoffice-calc libreoffice-writer || warn "libreoffice install failed (optional)" ;;
      pacman) pkg_install libreoffice-still || warn "libreoffice install failed (optional)" ;;
      zypper) pkg_install libreoffice || warn "libreoffice install failed (optional)" ;;
      apk)    pkg_install libreoffice || warn "libreoffice install failed (optional)" ;;
      brew)   pkg_install --cask libreoffice || warn "libreoffice install failed (optional)" ;;
      *)      warn "unknown pkg manager; skip libreoffice" ;;
    esac
  fi

  # CJK fonts (Chinese/Japanese/Korean docs render correctly).
  case "$PKG_MGR" in
    apt)    pkg_install fonts-noto-cjk fonts-liberation || true ;;
    dnf)    pkg_install google-noto-sans-cjk-fonts liberation-fonts || true ;;
    pacman) pkg_install noto-fonts-cjk ttf-liberation || true ;;
    zypper) pkg_install noto-sans-cjk-fonts liberation-fonts || true ;;
    apk)    pkg_install font-noto-cjk || true ;;
    brew)   true ;;  # macOS has CJK fonts built in
    *)      true ;;
  esac

  # pandoc (docx content preview).
  if ! command -v pandoc >/dev/null; then
    case "$PKG_MGR" in
      apt|dnf|zypper|apk|brew) pkg_install pandoc || true ;;
      pacman) pkg_install pandoc-cli || true ;;
    esac
  fi
}

# ── Summary ────────────────────────────────────────────────────────────────────
print_summary() {
  step "Done"
  printf '  Skills directory : %s\n' "$DEST"
  printf '  Skills installed :'
  local entry name
  for entry in "${SKILLS[@]}"; do
    name="${entry%%:*}"
    if skip_skill "$name"; then continue; fi
    [[ -d "$DEST/$name" ]] && printf ' %s' "$name"
  done
  printf '\n\n'
  cat <<EOF
  Add this to your snaca.toml:

    [skills]
    global_dir = "$DEST"

  Then restart snaca. The five skills appear in the registry on next load.
EOF
  if [[ $SKIP_DEPS -eq 0 ]]; then
    cat <<'EOF'

  If you just installed the .NET SDK via dotnet-install.sh, open a new
  shell (or `source ~/.bashrc`) so `dotnet` is on PATH for snaca's
  subprocess invocations.
EOF
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  printf '%s========================================%s\n' "$C_BLD" "$C_RST"
  printf '%s  snaca · install-minimax-skills%s\n' "$C_BLD" "$C_RST"
  printf '%s  %s%s\n' "$C_BLD" "$(date '+%Y-%m-%d %H:%M:%S')" "$C_RST"
  printf '%s========================================%s\n' "$C_BLD" "$C_RST"

  detect_platform
  init_sudo
  acquire_source
  stage_skills

  if [[ $SKIP_DEPS -eq 1 ]]; then
    info "--skip-deps: not touching system packages, pip, npm, or dotnet"
  else
    ensure_system_tools
    ensure_python_pkgs
    ensure_node_pkgs
    ensure_dotnet
    install_optional
    build_docx_dotnet
  fi

  print_summary
}

main "$@"
