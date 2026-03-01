#!/usr/bin/env bash
set -euo pipefail

REPO_URL_DEFAULT="https://github.com/AchilleasDrakou/agent-recorder.git"
INSTALL_HOME_DEFAULT="${HOME}/.agent-recorder"
BIN_DIR_DEFAULT="${HOME}/.local/bin"

REPO_URL="${REPO_URL:-$REPO_URL_DEFAULT}"
INSTALL_HOME="${INSTALL_HOME:-$INSTALL_HOME_DEFAULT}"
BIN_DIR="${BIN_DIR:-$BIN_DIR_DEFAULT}"
SKIP_DEPS="${SKIP_DEPS:-0}"
YES="${YES:-0}"

usage() {
  cat <<'USAGE'
Agent Recorder installer

Usage:
  ./install.sh [options]
  curl -fsSL <raw-install-url> | bash

Options:
  --repo-url URL      Git repo URL (default: upstream GitHub URL)
  --home DIR          Install home (default: ~/.agent-recorder)
  --bin-dir DIR       Bin dir for installed commands (default: ~/.local/bin)
  --skip-deps         Skip dependency auto-install attempts
  --yes               Non-interactive mode (best effort)
  -h, --help          Show this help

Installed commands:
  agent-recorder
  agent-proof
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url) REPO_URL="${2:-}"; shift 2 ;;
    --home) INSTALL_HOME="${2:-}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:-}"; shift 2 ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

print_step() {
  echo
  echo "==> $*"
}

warn() {
  echo "[warn] $*" >&2
}

ask() {
  local prompt="$1"
  if [[ "$YES" == "1" ]]; then
    return 0
  fi
  read -r -p "${prompt} [Y/n] " reply
  reply="${reply:-Y}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

ensure_rust() {
  if have_cmd cargo && have_cmd rustup; then
    return 0
  fi
  if [[ "$SKIP_DEPS" == "1" ]]; then
    warn "Rust toolchain missing (cargo/rustup). Install Rust and re-run."
    return 1
  fi
  print_step "Installing Rust toolchain (rustup)"
  if ! have_cmd curl; then
    warn "curl is required to install rustup. Please install curl first."
    return 1
  fi
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1090
  source "${HOME}/.cargo/env"
}

install_ffmpeg() {
  if have_cmd ffmpeg; then
    return 0
  fi
  if [[ "$SKIP_DEPS" == "1" ]]; then
    warn "ffmpeg not found. Install ffmpeg and re-run."
    return 1
  fi

  print_step "Installing ffmpeg"
  case "$(uname -s)" in
    Darwin)
      if have_cmd brew; then
        brew install ffmpeg
      else
        warn "Homebrew not found. Install Homebrew then run: brew install ffmpeg"
        return 1
      fi
      ;;
    Linux)
      if have_cmd apt-get; then
        sudo apt-get update
        sudo apt-get install -y ffmpeg
      elif have_cmd dnf; then
        sudo dnf install -y ffmpeg
      elif have_cmd pacman; then
        sudo pacman -Sy --noconfirm ffmpeg
      else
        warn "No supported package manager found for auto-installing ffmpeg."
        return 1
      fi
      ;;
    *)
      warn "Unsupported OS for auto ffmpeg install."
      return 1
      ;;
  esac
}

detect_chrome_path() {
  local candidates=(
    "/tmp/puppeteer-browsers/chromium/mac_arm-1591460/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/usr/bin/chromium"
    "/usr/bin/chromium-browser"
    "/snap/bin/chromium"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  if have_cmd chromium; then
    command -v chromium
    return 0
  fi
  if have_cmd google-chrome; then
    command -v google-chrome
    return 0
  fi
  return 1
}

install_chrome_if_missing() {
  if detect_chrome_path >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$SKIP_DEPS" == "1" ]]; then
    warn "Chrome/Chromium not found. Install one and re-run."
    return 1
  fi

  print_step "Attempting to install Chromium"
  case "$(uname -s)" in
    Darwin)
      if have_cmd brew; then
        if ask "Install Chromium via Homebrew cask?"; then
          brew install --cask chromium
        else
          warn "Skipping Chromium install."
          return 1
        fi
      else
        warn "Homebrew not found. Install Chrome/Chromium manually."
        return 1
      fi
      ;;
    Linux)
      if have_cmd apt-get; then
        sudo apt-get update
        sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium
      elif have_cmd dnf; then
        sudo dnf install -y chromium
      elif have_cmd pacman; then
        sudo pacman -Sy --noconfirm chromium
      else
        warn "No supported package manager found for Chromium auto-install."
        return 1
      fi
      ;;
    *)
      warn "Unsupported OS for auto Chromium install."
      return 1
      ;;
  esac
}

sync_repo() {
  local cwd_repo=0
  if [[ -f "./Cargo.toml" && -f "./src/main.rs" ]]; then
    cwd_repo=1
  fi

  mkdir -p "$INSTALL_HOME"

  if [[ "$cwd_repo" == "1" ]]; then
    print_step "Using current repository checkout"
    REPO_DIR="$(pwd)"
    return 0
  fi

  REPO_DIR="${INSTALL_HOME}/repo"
  if [[ -d "${REPO_DIR}/.git" ]]; then
    print_step "Updating existing repo at ${REPO_DIR}"
    git -C "$REPO_DIR" fetch --all --prune
    git -C "$REPO_DIR" checkout main
    git -C "$REPO_DIR" pull --ff-only
  else
    print_step "Cloning repo into ${REPO_DIR}"
    git clone "$REPO_URL" "$REPO_DIR"
  fi
}

build_release() {
  print_step "Building Rust release binary"
  (cd "$REPO_DIR" && cargo build --release -q)
}

install_commands() {
  print_step "Installing commands into ${BIN_DIR}"
  mkdir -p "$BIN_DIR"

  cp "${REPO_DIR}/target/release/agent-recorder" "${BIN_DIR}/agent-recorder"
  chmod +x "${BIN_DIR}/agent-recorder"

  cat > "${BIN_DIR}/agent-proof" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${REPO_DIR}/scripts/agent-proof.mjs" "\$@"
EOF
  chmod +x "${BIN_DIR}/agent-proof"

}

print_post_install() {
  local chrome_path
  chrome_path="$(detect_chrome_path || true)"
  echo
  echo "Install complete."
  echo
  echo "Commands:"
  echo "  agent-recorder"
  echo "  agent-proof"
  echo
  echo "Suggested first run:"
  echo "  agent-proof --url \"http://localhost:3000\" --mode after --name smoke"
  echo
  if [[ -n "$chrome_path" ]]; then
    echo "Detected Chrome/Chromium: ${chrome_path}"
  else
    echo "Chrome/Chromium was not detected. Pass --chrome <path> to commands."
  fi
  echo
  if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
    echo "Add this to your shell profile:"
    echo "  export PATH=\"${BIN_DIR}:\$PATH\""
  fi
}

main() {
  print_step "Starting agent-recorder install"

  if ! have_cmd git; then
    echo "git is required but not installed." >&2
    exit 1
  fi
  if ! have_cmd node; then
    if [[ "$SKIP_DEPS" == "1" ]]; then
      echo "node is required but not installed." >&2
      exit 1
    fi
    warn "Node.js is required for agent wrapper (agent-proof)."
    warn "Install Node.js 20+ and re-run."
    exit 1
  fi

  ensure_rust
  install_ffmpeg
  install_chrome_if_missing || true
  sync_repo
  build_release
  install_commands
  print_post_install
}

main "$@"
