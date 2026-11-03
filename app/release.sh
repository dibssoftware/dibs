#!/bin/sh
# Builds the Mac app for people to download: signed with the Developer ID,
# notarized by Apple, stapled, in a DMG, with the latest.json the app's daily
# update check reads. It uploads nothing; the last lines say what goes where.
#
#   dibs run xcode-build -m "mac release" -- app/release.sh
#   app/release.sh --notes "Schedule shows every machine."   # the line Settings shows with the update
#
# Settings, all optional:
#   DIBS_IDENTITY         signing identity (default "Developer ID Application").
#                         "-" signs ad hoc and skips Apple, to try the steps on
#                         a Mac without the certificate. Never ship that DMG.
#   DIBS_TEAM             your Apple Developer team id (required unless ad hoc)
#   DIBS_NOTARY_PROFILE   notarytool keychain profile (default dibs-notary)
#   DIBS_KEYCHAIN         the keychain codesign signs from (default
#                         ~/Library/Keychains/dibs-signing.keychain-db; "" for
#                         the login keychain, which may stop on a password prompt)
#   DIBS_DOWNLOAD_BASE    where the DMG will live (default https://dibs.cc/mac)
#   DIBS_DIST             where the DMG and latest.json go (default app/dist)
#   DIBS_ALLOW_DIRTY=1    build with uncommitted changes
#
# One-time setup on the Mac that releases:
#   1. The "Developer ID Application" certificate and its key in a keychain of
#      their own, so codesign never stops on a login keychain prompt (an
#      unattended build waited 1h33m on one, 2026-11-03):
#        security add-generic-password -s dibs-signing-keychain -a dibs -w <new password>
#        security create-keychain -p <it> ~/Library/Keychains/dibs-signing.keychain-db
#        security set-keychain-settings ~/Library/Keychains/dibs-signing.keychain-db
#        security import <key> -k <that keychain> -T /usr/bin/codesign -T /usr/bin/productsign
#        security import <cert> -k <that keychain>
#        security set-key-partition-list -S apple-tool:,apple: -s -k <it> <that keychain>
#      This script unlocks it with the password from the login keychain item.
#   2. xcrun notarytool store-credentials dibs-notary \
#        --key <AuthKey_XXXX.p8> --key-id <key id> --issuer <issuer id>
#      The App Store Connect key then lives in the keychain, and this script
#      only names the profile.
set -eu

IDENTITY="${DIBS_IDENTITY:-Developer ID Application}"
TEAM="${DIBS_TEAM:-}"
PROFILE="${DIBS_NOTARY_PROFILE:-dibs-notary}"
KEYCHAIN="${DIBS_KEYCHAIN-$HOME/Library/Keychains/dibs-signing.keychain-db}"
BASE="${DIBS_DOWNLOAD_BASE:-https://dibs.cc/mac}"
NOTES=""

say() { printf '%s\n' "$*"; }
fail() { printf 'release: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --notes) [ $# -ge 2 ] || fail "--notes needs a sentence"; NOTES="$2"; shift 2 ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
    *) fail "unknown option $1 (app/release.sh --help)" ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="${DIBS_DIST:-$HERE/dist}"
VERSION="$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([0-9.]*\)"\{0,1\} *$/\1/p' "$HERE/project.yml" | head -n 1)"
[ -n "$VERSION" ] || fail "no MARKETING_VERSION in app/project.yml"

if [ -z "${DIBS_ALLOW_DIRTY:-}" ] && [ -n "$(git -C "$HERE" status --porcelain -- . 2>/dev/null)" ]; then
  fail "app/ has uncommitted changes, so the DMG wouldn't match any commit. Commit first, or DIBS_ALLOW_DIRTY=1."
fi

ADHOC=""
if [ "$IDENTITY" = "-" ]; then
  ADHOC=1
  say "Ad hoc signing: this DMG is for trying the steps only. Gatekeeper will block it on other Macs."
else
  [ -n "$TEAM" ] || fail "set DIBS_TEAM to your Apple Developer team id."
  if [ -n "$KEYCHAIN" ]; then
    [ -f "$KEYCHAIN" ] || fail "no signing keychain at $KEYCHAIN. Make it (the one-time setup in this file), or DIBS_KEYCHAIN= to sign from the login keychain."
    pw="$(security find-generic-password -s dibs-signing-keychain -a dibs -w 2>/dev/null)" ||
      fail "no dibs-signing-keychain password in the login keychain (the one-time setup in this file)"
    security unlock-keychain -p "$pw" "$KEYCHAIN" || fail "couldn't unlock $KEYCHAIN with the stored password"
    pw=""
  fi
  security find-identity -v -p codesigning ${KEYCHAIN:+"$KEYCHAIN"} | grep -q "$IDENTITY" ||
    fail "no \"$IDENTITY\" certificate in ${KEYCHAIN:-the keychain}. Create it at developer.apple.com (Account Holder only), then import it (the one-time setup in this file)."
  xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 ||
    fail "no notarytool profile \"$PROFILE\". Run: xcrun notarytool store-credentials $PROFILE --key <.p8> --key-id <id> --issuer <issuer>"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dibs-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

# Hardened runtime and a secure timestamp are what notarization requires.
# Ad hoc signatures can't carry a timestamp.
# --keychain keeps codesign off the login keychain's copy of the key, and its prompt.
SIGN_FLAGS="--timestamp${KEYCHAIN:+ --keychain $KEYCHAIN}"
[ -n "$ADHOC" ] && SIGN_FLAGS=""

say "Building dibs $VERSION (Release)..."
xcodebuild -project "$HERE/Dibs.xcodeproj" -scheme dibs -configuration Release \
  -derivedDataPath "$WORK/dd" -quiet \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$IDENTITY" DEVELOPMENT_TEAM="$( [ -n "$ADHOC" ] || echo "$TEAM")" \
  ENABLE_HARDENED_RUNTIME=YES CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
  OTHER_CODE_SIGN_FLAGS="$SIGN_FLAGS" \
  build

APP="$WORK/dd/Build/Products/Release/dibs.app"
[ -d "$APP" ] || fail "the build finished without $APP"
BUILT="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[ "$BUILT" = "$VERSION" ] || fail "built version $BUILT, expected $VERSION. Run xcodegen in app/ and try again."
codesign --verify --deep --strict "$APP" || fail "the app's signature doesn't verify"

# Sends a file to Apple and waits. notarytool exits 0 even when Apple rejects
# the file, so the status line decides, and a rejection prints Apple's log.
notarize() {
  say "Notarizing $(basename "$1") (usually 1 to 5 minutes)..."
  xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait --timeout 30m >"$WORK/notary.txt" 2>&1 || true
  if ! grep -q "status: Accepted" "$WORK/notary.txt"; then
    cat "$WORK/notary.txt" >&2
    id="$(sed -n 's/^ *id: *//p' "$WORK/notary.txt" | head -n 1)"
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2 || true
    fail "Apple didn't accept $(basename "$1")"
  fi
}

# The app is notarized and stapled first, so the copy people drag out of the
# DMG opens offline too. Then the DMG itself.
if [ -z "$ADHOC" ]; then
  ditto -c -k --keepParent "$APP" "$WORK/dibs.zip"
  notarize "$WORK/dibs.zip"
  xcrun stapler staple -q "$APP"
fi

say "Making the DMG..."
mkdir -p "$WORK/stage" "$DIST"
ditto "$APP" "$WORK/stage/dibs.app"
ln -s /Applications "$WORK/stage/Applications"
DMG="$DIST/dibs-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -quiet -volname "dibs $VERSION" -srcfolder "$WORK/stage" -fs HFS+ -format UDZO -ov "$DMG"

if [ -z "$ADHOC" ]; then
  codesign --sign "$IDENTITY" $SIGN_FLAGS "$DMG"
  notarize "$DMG"
  xcrun stapler staple -q "$DMG"
  spctl --assess --type open --context context:primary-signature "$DMG" ||
    fail "Gatekeeper rejects the DMG even after notarizing"
fi

SHA="$(shasum -a 256 "$DMG" | cut -d ' ' -f 1)"
SIZE="$(du -h "$DMG" | cut -f 1 | tr -d ' ')"
VERSION="$VERSION" URL="$BASE/dibs-$VERSION.dmg" SHA="$SHA" NOTES="$NOTES" node -e '
  const e = process.env
  const feed = { version: e.VERSION, url: e.URL, sha256: e.SHA }
  if (e.NOTES) feed.notes = e.NOTES
  process.stdout.write(JSON.stringify(feed, null, 2) + "\n")
' >"$DIST/latest.json"

say ""
say "dibs $VERSION: $DMG ($SIZE)"
say "sha256 $SHA"
if [ -n "$ADHOC" ]; then
  say "Ad hoc build: don't publish it."
else
  say "To publish, upload both files from $DIST to $BASE/:"
  say "  dibs-$VERSION.dmg   the download"
  say "  latest.json         tells installed apps about it (upload this one last)"
fi
