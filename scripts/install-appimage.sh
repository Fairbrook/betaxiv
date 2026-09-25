#!/bin/sh
# Install (or remove) the betaxiv AppImage for the current user, without extra tools
# like AppImageLauncher: copies it to ~/.local/share/betaxiv and adds a launcher entry.
#
#   sh scripts/install-appimage.sh [path/to/betaxiv.AppImage]
#   sh scripts/install-appimage.sh --uninstall
set -eu

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/betaxiv"
DESKTOP_FILE="$DATA_HOME/applications/betaxiv.desktop"
ICON_FILE="$DATA_HOME/icons/hicolor/512x512/apps/betaxiv.png"

refresh() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$APP_DIR" "$DESKTOP_FILE" "$ICON_FILE"
  refresh
  echo "betaxiv removed (your library in ~/.config/betaxiv was kept)."
  exit 0
fi

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC=$(ls -t dist/*.AppImage 2>/dev/null | head -n 1 || true)
fi
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "No AppImage found. Build one first with: npm run dist:linux" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$APP_DIR" "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
cp "$SRC" "$APP_DIR/betaxiv.AppImage"
chmod +x "$APP_DIR/betaxiv.AppImage"
cp "$SCRIPT_DIR/../build/icon.png" "$ICON_FILE"

cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=betaxiv
Comment=Research assistant for arXiv papers
Exec="$APP_DIR/betaxiv.AppImage" %U
Icon=betaxiv
Terminal=false
Categories=Education;Science;
StartupWMClass=betaxiv
DESKTOP

refresh
echo "Installed betaxiv to $APP_DIR — it's now in your app launcher."
if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
  echo "Note: no fusermount found, so the AppImage will extract itself on each start (slower)."
  echo "      Installing your distro's 'fuse3' package (not the deprecated libfuse2) avoids that."
fi
