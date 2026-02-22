#!/usr/bin/env bash
set -euo pipefail

APP="sazen"
REPO_OWNER="Soyuz0"
REPO_NAME="Sazen"
DEFAULT_BRANCH="master"

MUTED=$'\033[0;2m'
RED=$'\033[0;31m'
ORANGE=$'\033[38;5;214m'
GREEN=$'\033[0;32m'
NC=$'\033[0m'

requested_version="${VERSION:-}"
binary_path=""
no_modify_path=false
skip_browser_install=false
install_root="${SAZEN_INSTALL_DIR:-$HOME/.sazen}"

install_dir=""
app_dir=""
os=""
arch=""

usage() {
  cat <<'EOF'
Sazen Installer

Usage: install.sh [options]

Options:
  -h, --help                Show this help message
  -v, --version <version>   Install a specific release tag or branch
  -b, --binary <path>       Install from a local executable path
      --install-dir <path>  Override install root (default: ~/.sazen)
      --no-modify-path      Do not modify shell rc files
      --skip-browser-install Skip Playwright Chromium installation

Examples:
  curl -fsSL https://raw.githubusercontent.com/Soyuz0/Sazen/refs/heads/master/scripts/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/Soyuz0/Sazen/refs/heads/master/scripts/install.sh | bash -s -- --version v0.1.0
  ./scripts/install.sh --binary ./sazen --no-modify-path
EOF
}

print_message() {
  local level="$1"
  local message="$2"
  local color="$NC"

  case "$level" in
    info) color="$NC" ;;
    warning) color="$ORANGE" ;;
    error) color="$RED" ;;
    success) color="$GREEN" ;;
  esac

  printf "%b%s%b\n" "$color" "$message" "$NC" >&2
}

fail() {
  print_message error "$1"
  exit 1
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Required command '$cmd' is not installed"
  fi
}

detect_platform() {
  local raw_os
  raw_os="$(uname -s 2>/dev/null || echo unknown)"
  case "$raw_os" in
    Darwin*) os="darwin" ;;
    Linux*) os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) os="unknown" ;;
  esac

  local raw_arch
  raw_arch="$(uname -m 2>/dev/null || echo unknown)"
  case "$raw_arch" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l) arch="armv7" ;;
    *) arch="$raw_arch" ;;
  esac

  if [[ "$os" == "unknown" ]]; then
    fail "Unsupported operating system '$raw_os'"
  fi
}

normalize_paths() {
  install_dir="$install_root/bin"
  app_dir="$install_root/app"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      -v|--version)
        if [[ -n "${2:-}" ]]; then
          requested_version="$2"
          shift 2
        else
          fail "--version requires a value"
        fi
        ;;
      -b|--binary)
        if [[ -n "${2:-}" ]]; then
          binary_path="$2"
          shift 2
        else
          fail "--binary requires a path"
        fi
        ;;
      --install-dir)
        if [[ -n "${2:-}" ]]; then
          install_root="$2"
          shift 2
        else
          fail "--install-dir requires a path"
        fi
        ;;
      --no-modify-path)
        no_modify_path=true
        shift
        ;;
      --skip-browser-install)
        skip_browser_install=true
        shift
        ;;
      *)
        print_message warning "Unknown option '$1' ignored"
        shift
        ;;
    esac
  done
}

github_codeload_url() {
  local ref="$1"
  printf "https://codeload.github.com/%s/%s/tar.gz/%s" "$REPO_OWNER" "$REPO_NAME" "$ref"
}

detect_latest_release_tag() {
  require_command curl

  local api_url
  api_url="https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest"

  local response
  response="$(curl -fsSL "$api_url" 2>/dev/null || true)"
  if [[ -z "$response" ]]; then
    return 1
  fi

  local tag
  tag="$(printf "%s\n" "$response" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [[ -z "$tag" ]]; then
    return 1
  fi

  printf "%s" "$tag"
}

download_source_archive() {
  local output_archive="$1"
  local selected_ref=""

  local refs=()
  if [[ -n "$requested_version" ]]; then
    local version_no_v
    version_no_v="${requested_version#v}"
    refs+=("refs/tags/v$version_no_v")
    refs+=("refs/tags/$version_no_v")
    refs+=("refs/heads/$requested_version")
    refs+=("refs/heads/$version_no_v")
  else
    local latest_tag
    latest_tag="$(detect_latest_release_tag || true)"
    if [[ -n "$latest_tag" ]]; then
      refs+=("refs/tags/$latest_tag")
      refs+=("refs/tags/v${latest_tag#v}")
    fi
    refs+=("refs/heads/$DEFAULT_BRANCH")
  fi

  for ref in "${refs[@]}"; do
    local url
    url="$(github_codeload_url "$ref")"
    print_message info "${MUTED}Trying source ref:${NC} $ref"
    if curl -fL --progress-bar "$url" -o "$output_archive"; then
      selected_ref="$ref"
      break
    fi
  done

  if [[ -z "$selected_ref" ]]; then
    if [[ -n "$requested_version" ]]; then
      fail "Could not find requested version '$requested_version' as a release tag or branch"
    fi
    fail "Failed to download source archive from GitHub"
  fi

  printf "%s" "$selected_ref"
}

resolve_extracted_source_dir() {
  local base_dir="$1"
  local dir
  dir="$(find "$base_dir" -mindepth 1 -maxdepth 1 -type d | sed -n '1p')"
  if [[ -z "$dir" ]]; then
    fail "Failed to locate extracted source directory"
  fi
  printf "%s" "$dir"
}

install_from_binary() {
  if [[ ! -f "$binary_path" ]]; then
    fail "Binary not found at '$binary_path'"
  fi

  mkdir -p "$install_dir"
  cp "$binary_path" "$install_dir/$APP"
  chmod 755 "$install_dir/$APP"

  print_message success "Installed '$APP' from local binary"
}

install_from_source() {
  require_command curl
  require_command tar
  require_command node
  require_command npm

  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/sazen-install.XXXXXX")"
  local archive_path="$tmp_dir/source.tar.gz"
  local selected_ref
  local extracted_dir
  local app_new_dir="$install_root/app.new"

  selected_ref="$(download_source_archive "$archive_path")"
  print_message info "${MUTED}Downloaded:${NC} $selected_ref"

  tar -xzf "$archive_path" -C "$tmp_dir"
  extracted_dir="$(resolve_extracted_source_dir "$tmp_dir")"

  mkdir -p "$install_root"
  rm -rf "$app_new_dir"
  mv "$extracted_dir" "$app_new_dir"

  print_message info "${MUTED}Installing npm dependencies...${NC}"
  if [[ -f "$app_new_dir/dist/cli.js" ]]; then
    (cd "$app_new_dir" && npm install --omit=dev --no-audit --no-fund)
  else
    (cd "$app_new_dir" && npm install --no-audit --no-fund && npm run build)
  fi

  if [[ "$skip_browser_install" != "true" ]]; then
    print_message info "${MUTED}Installing Playwright Chromium...${NC}"
    if [[ -f "$app_new_dir/node_modules/playwright/cli.js" ]]; then
      node "$app_new_dir/node_modules/playwright/cli.js" install chromium
    else
      fail "Playwright CLI not found after install"
    fi
  else
    print_message warning "Skipped browser install (--skip-browser-install). Run this later:"
    print_message info "  node \"$app_dir/node_modules/playwright/cli.js\" install chromium"
  fi

  mkdir -p "$install_dir"

  local launcher_path="$install_dir/$APP"
  cat > "$launcher_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "$app_dir/dist/cli.js" "\$@"
EOF
  chmod 755 "$launcher_path"

  rm -rf "$app_dir"
  mv "$app_new_dir" "$app_dir"

  rm -rf "$tmp_dir"

  print_message success "Installed '$APP' from GitHub source"
}

add_to_path() {
  local config_file="$1"
  local path_line="$2"

  if [[ -f "$config_file" ]] && grep -Fxq "$path_line" "$config_file"; then
    print_message info "${MUTED}PATH entry already exists in ${NC}$config_file"
    return
  fi

  if [[ -f "$config_file" && ! -w "$config_file" ]]; then
    print_message warning "Cannot write to $config_file"
    print_message info "Add this manually: $path_line"
    return
  fi

  if [[ ! -f "$config_file" ]]; then
    mkdir -p "$(dirname "$config_file")"
    touch "$config_file"
  fi

  {
    printf "\n# %s\n" "$APP"
    printf "%s\n" "$path_line"
  } >> "$config_file"

  print_message success "Added '$APP' to PATH in $config_file"
}

update_shell_path() {
  if [[ "$no_modify_path" == "true" ]]; then
    print_message info "Skipped PATH modification (--no-modify-path)"
    return
  fi

  if [[ ":$PATH:" == *":$install_dir:"* ]]; then
    return
  fi

  local xdg_config_home
  xdg_config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  local current_shell
  current_shell="$(basename "${SHELL:-sh}")"

  local config_candidates=()
  case "$current_shell" in
    fish)
      config_candidates=("$HOME/.config/fish/config.fish")
      ;;
    zsh)
      config_candidates=(
        "${ZDOTDIR:-$HOME}/.zshrc"
        "${ZDOTDIR:-$HOME}/.zshenv"
        "$xdg_config_home/zsh/.zshrc"
        "$xdg_config_home/zsh/.zshenv"
      )
      ;;
    bash)
      config_candidates=(
        "$HOME/.bashrc"
        "$HOME/.bash_profile"
        "$HOME/.profile"
        "$xdg_config_home/bash/.bashrc"
        "$xdg_config_home/bash/.bash_profile"
      )
      ;;
    *)
      config_candidates=("$HOME/.profile" "$HOME/.bashrc")
      ;;
  esac

  local config_file=""
  local candidate
  for candidate in "${config_candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      config_file="$candidate"
      break
    fi
  done
  if [[ -z "$config_file" ]]; then
    config_file="${config_candidates[0]}"
  fi

  case "$current_shell" in
    fish)
      add_to_path "$config_file" "fish_add_path \"$install_dir\""
      ;;
    *)
      add_to_path "$config_file" "export PATH=\"$install_dir:\$PATH\""
      ;;
  esac
}

print_success_banner() {
  echo
  print_message success "Sazen installed"
  echo -e "${MUTED}  ____    _    ______ _____ _   _${NC}"
  echo -e "${MUTED} / ___|  / \\  |__  / | ____| \\ | |${NC}"
  echo -e "${MUTED} \\___ \\ / _ \\   / /  |  _| |  \\| |${NC}"
  echo -e "${MUTED}  ___) / ___ \\ / /_  | |___| |\\  |${NC}"
  echo -e "${MUTED} |____/_/   \\_/____| |_____|_| \\_|${NC}"
  print_message info "${MUTED}The agent first broswer${NC}"
  print_message info "${MUTED}Platform:${NC} $os/$arch"
  print_message info "${MUTED}Install root:${NC} $install_root"
  print_message info "${MUTED}Binary path:${NC} $install_dir/$APP"
  echo
  print_message info "Next steps:"
  print_message info "  1) Open a new shell (or run: export PATH=\"$install_dir:\$PATH\")"
  print_message info "  2) Run: $APP --help"
  print_message info "  3) Run: $APP open https://example.com"
  echo
}

main() {
  parse_args "$@"
  normalize_paths
  detect_platform

  if [[ -n "$binary_path" ]]; then
    install_from_binary
  else
    install_from_source
  fi

  update_shell_path

  if [[ "${GITHUB_ACTIONS:-}" == "true" && -n "${GITHUB_PATH:-}" ]]; then
    printf "%s\n" "$install_dir" >> "$GITHUB_PATH"
    print_message info "Added $install_dir to GITHUB_PATH"
  fi

  print_success_banner
}

main "$@"
