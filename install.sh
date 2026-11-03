#!/bin/sh
# Install or upgrade dibs for this user, without sudo.
#
#   curl -fsSL https://dibs.cc/install.sh | sh
#   sh install.sh                      # from a clone
#
# Everything below is one function, called on the last line, so a download cut
# off halfway runs nothing at all.
#
# Puts one release in ~/.dibs-cli and links ~/.local/bin/dibs to it. Running it
# again with the same version changes nothing; with a new version it swaps the
# folder in place, so services and hooks that point into ~/.dibs-cli keep working.
# Your queue and settings live in ~/.dibs and are never touched.
#
# Settings, all optional:
#   DIBS_VERSION   release tag to install (default below)
#   DIBS_BASE      where release tarballs live (default https://dibs.cc/releases)
#   DIBS_REPO      a git URL to fetch the release from instead (GitHub, a mirror)
#   DIBS_SOURCE    a local dibs folder to install instead of downloading
#   DIBS_SHA256    expected sha256 of the release tarball. From DIBS_BASE the
#                  sum is always checked: this, else the one dibs.cc's copy of
#                  this script carries, else the .sha256 file beside the tarball
#   DIBS_PREFIX    where the release goes (default ~/.dibs-cli)
#   DIBS_BIN_DIR   where the dibs link goes (default ~/.local/bin)
#   DIBS_FORCE=1   replace a dibs in DIBS_BIN_DIR that this script didn't make
set -eu

main() {
# Release settings. DEFAULT_VERSION is set at each release; release.sh writes
# DEFAULT_SHA256 into the copy dibs.cc serves.
DEFAULT_VERSION="v0.0.178"
DEFAULT_SHA256=""
DEFAULT_BASE="https://dibs.cc/releases"
# Node 20 is the oldest that has every built-in dibs uses.
MIN_NODE=20

VERSION="${DIBS_VERSION:-$DEFAULT_VERSION}"
BASE="${DIBS_BASE:-$DEFAULT_BASE}"
REPO="${DIBS_REPO:-}"
PREFIX="${DIBS_PREFIX:-$HOME/.dibs-cli}"
BIN_DIR="${DIBS_BIN_DIR:-$HOME/.local/bin}"
LINK="$BIN_DIR/dibs"
TARGET="$PREFIX/bin/dibs.mjs"

say() { printf '%s\n' "$*"; }
fail() { printf 'dibs install: %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" = 0 ] && [ -z "${DIBS_ALLOW_ROOT:-}" ]; then
  fail "don't run this as root. dibs installs per user, in your home folder. (DIBS_ALLOW_ROOT=1 if you mean it)"
fi

command -v node >/dev/null 2>&1 || fail "dibs needs Node $MIN_NODE or newer, and node isn't on your PATH. Install it (https://nodejs.org) and run this again."
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge "$MIN_NODE" ] || fail "dibs needs Node $MIN_NODE or newer; this is Node $(node -v). Upgrade it and run this again."
# CVE-2026-111497 (Brotli decoder, 2026-10-21): fixed in 22.23.4, 24.22.1, 26.12.1; other lines before 27 get none.
hole=$(node -e 'const v=process.versions.node.split(".").map(Number),f={22:[23,4],24:[22,1],26:[12,1]}[v[0]];const ok=v[0]>=27||(f&&(v[1]>f[0]||(v[1]===f[0]&&v[2]>=f[1])));if(!ok)console.log(v.join("."))')
[ -z "$hole" ] || [ -n "${DIBS_ALLOW_UNPATCHED:-}" ] || fail "Node $hole has the Brotli hole CVE-2026-111497. Install Node 22.23.4, 24.22.1, 26.12.1 or newer and run this again. (DIBS_ALLOW_UNPATCHED=1 if you mean it)"

# A link we didn't make is someone's own dibs: leave it unless told otherwise.
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  current=$(readlink "$LINK" 2>/dev/null || true)
  if [ "$current" != "$TARGET" ] && [ -z "${DIBS_FORCE:-}" ]; then
    fail "$LINK already exists and points at ${current:-a file, not a link}. Remove it, or run with DIBS_FORCE=1 to replace it."
  fi
fi

installed=""
[ -f "$PREFIX/.dibs-release" ] && installed=$(cat "$PREFIX/.dibs-release")
want="$VERSION"
[ -n "${DIBS_SOURCE:-}" ] && want="local:$(cd "$DIBS_SOURCE" && pwd)"

# A local folder may have changed since last time, so it's always copied again.
if [ -z "${DIBS_SOURCE:-}" ] && [ "$installed" = "$want" ] && [ -f "$TARGET" ]; then
  say "dibs $VERSION is already in $PREFIX"
else
  mkdir -p "$(dirname "$PREFIX")"
  stage=$(mktemp -d "${PREFIX}.new.XXXXXX")
  trap 'rm -rf "$stage"' EXIT

  if [ -n "${DIBS_SOURCE:-}" ]; then
    [ -f "$DIBS_SOURCE/bin/dibs.mjs" ] || fail "$DIBS_SOURCE doesn't look like dibs (no bin/dibs.mjs)"
    say "copying dibs from $DIBS_SOURCE"
    for f in bin src docs skills LICENSE README.md CHANGELOG.md; do
      [ -e "$DIBS_SOURCE/$f" ] && cp -R "$DIBS_SOURCE/$f" "$stage/"
    done
  elif [ -z "$REPO" ] || [ -n "${DIBS_SHA256:-}" ] || ! command -v git >/dev/null 2>&1; then
    # A tarball: from dibs.cc by default, or a git host's archive of the tag.
    command -v curl >/dev/null 2>&1 || fail "need curl to download dibs (or git, with DIBS_REPO)"
    if [ -z "$REPO" ]; then
      url="$BASE/dibs-$VERSION.tar.gz"
      want_sum="${DIBS_SHA256:-}"
      [ -n "$want_sum" ] || { [ -z "${DIBS_VERSION:-}" ] && [ -z "${DIBS_BASE:-}" ] && want_sum="$DEFAULT_SHA256"; }
      if [ -z "$want_sum" ]; then
        want_sum=$(curl -fsSL "$url.sha256" 2>/dev/null | cut -d' ' -f1) || true
        [ -n "$want_sum" ] || fail "couldn't get the checksum $url.sha256. Check your connection and DIBS_VERSION. Nothing was installed."
      fi
    else
      url="${REPO%.git}/archive/refs/tags/$VERSION.tar.gz"
      want_sum="${DIBS_SHA256:-}"
    fi
    say "downloading $url"
    code=$(curl -sSL -w '%{http_code}' "$url" -o "$stage/release.tar.gz") || fail "couldn't reach $url. Check your connection. Nothing was installed."
    [ "$code" = 404 ] && fail "there's no release $VERSION at ${REPO:-$BASE} (404). Check DIBS_VERSION. Nothing was installed."
    [ "$code" = 200 ] || fail "downloading $url failed (HTTP $code). Nothing was installed."
    if [ -n "$want_sum" ]; then
      if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$stage/release.tar.gz" | cut -d' ' -f1)
      else got=$(sha256sum "$stage/release.tar.gz" | cut -d' ' -f1); fi
      [ "$got" = "$want_sum" ] || fail "checksum mismatch for $url: expected $want_sum, got $got. Nothing was installed."
      say "checksum ok: $got"
    fi
    tar -xzf "$stage/release.tar.gz" -C "$stage" --strip-components 1
    rm -f "$stage/release.tar.gz"
  else
    say "fetching dibs $VERSION from $REPO"
    if ! GIT_TERMINAL_PROMPT=0 git clone --quiet --depth 1 --branch "$VERSION" "$REPO" "$stage/src.git" 2>/dev/null; then
      GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO" >/dev/null 2>&1 || fail "couldn't reach $REPO: it doesn't exist or you're offline. Check DIBS_REPO and your connection. Nothing was installed."
      fail "$REPO has no release $VERSION. Check DIBS_VERSION. Nothing was installed."
    fi
    for f in bin src docs skills LICENSE README.md CHANGELOG.md; do
      [ -e "$stage/src.git/$f" ] && cp -R "$stage/src.git/$f" "$stage/"
    done
    rm -rf "$stage/src.git"
  fi

  [ -f "$stage/bin/dibs.mjs" ] || fail "the download has no bin/dibs.mjs; nothing was installed"
  chmod +x "$stage/bin/dibs.mjs" "$stage/bin/dibs-guard.mjs" 2>/dev/null || true
  printf '%s\n' "$want" > "$stage/.dibs-release"

  # Swap the folder in whole, so nothing ever runs half an upgrade.
  if [ -d "$PREFIX" ]; then
    old="${PREFIX}.old.$$"
    mv "$PREFIX" "$old"
    mv "$stage" "$PREFIX"
    rm -rf "$old"
  else
    mv "$stage" "$PREFIX"
  fi
  trap - EXIT
  say "installed dibs $(node "$TARGET" --version 2>/dev/null || echo "$VERSION") in $PREFIX"
fi

mkdir -p "$BIN_DIR"
if [ "$(readlink "$LINK" 2>/dev/null || true)" != "$TARGET" ]; then
  ln -sf "$TARGET" "$LINK"
  say "linked $LINK"
fi

say ""
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "$BIN_DIR isn't on your PATH. Add this to your shell profile:"
     say "  export PATH=\"$BIN_DIR:\$PATH\""
     say "" ;;
esac
say "Next:"
say "  dibs                                      the board (empty until an agent runs something)"
say "  dibs run sim -m \"why\" -- ./your-ui-test.sh  take a turn on the simulator"
say ""
say "So agents can't skip the line, add the guard hook. From this terminal (not from inside an agent):"
say "  dibs guard install"
say "or as a Claude Code plugin, in a session:"
say "  /plugin marketplace add dibssoftware/dibs"
say "  /plugin install dibs@dibs"
say "Then tell your agents about dibs (see the README's \"Tell your agents\" section)."
}

main "$@"
