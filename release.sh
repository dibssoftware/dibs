#!/bin/sh
# Publishes a release on dibs.cc, from a clean checkout of the public repo at
# the release tag:
#
#   sh release.sh                 # the tarball, its sum and install.sh
#   sh release.sh --mac           # also the DMG and latest.json app/release.sh built
#
# Uploads to the R2 bucket the dibs.cc Worker serves:
#   releases/dibs-vX.tar.gz         bin, src, docs, skills and the docs at the root
#   releases/dibs-vX.tar.gz.sha256
#   releases/install-vX.sh          install.sh for that version, its sum written in
#   install.sh                      the same, for curl -fsSL https://dibs.cc/install.sh | sh
#   mac/dibs-X.dmg, mac/latest.json (--mac; latest.json last, so no app hears of
#                                   a DMG that isn't there yet)
# Then downloads each one back and checks it.
#
# Settings, all optional:
#   DIBS_BUCKET   R2 bucket (default dibs-releases)
#   DIBS_SITE     where the Worker serves it (default https://dibs.cc)
#   DIBS_DIST     where app/release.sh left the DMG (default app/dist)
#   DIBS_DRY_RUN=1  build and check everything, upload nothing
set -eu

BUCKET="${DIBS_BUCKET:-dibs-releases}"
SITE="${DIBS_SITE:-https://dibs.cc}"
MAC=""

say() { printf '%s\n' "$*"; }
fail() { printf 'release: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mac) MAC=1; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) fail "unknown option $1 (sh release.sh --help)" ;;
  esac
done

cd "$(dirname "$0")"
VERSION=$(sed -n "s/^export const VERSION = '\([0-9.]*\)';$/\1/p" src/version.mjs)
[ -n "$VERSION" ] || fail "no VERSION in src/version.mjs"
TAG="v$VERSION"
DIST="${DIBS_DIST:-app/dist}"

[ -z "$(git status --porcelain)" ] || fail "the checkout has uncommitted changes, so the tarball wouldn't match the tag. Commit or stash first."
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$TAG^{commit}" 2>/dev/null)" ] || fail "HEAD isn't the tag $TAG. Tag the release (git tag $TAG) or check it out first."
grep -q "^DEFAULT_VERSION=\"$TAG\"$" install.sh || fail "install.sh's DEFAULT_VERSION isn't $TAG"
# Everything public is written as the project, never as a person's own address.
prev=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)
others=$(git log --format='%an <%ae>%n%cn <%ce>' ${prev:+"$prev.."}"$TAG" | sort -u | grep -vx 'dibs maintainers <licensing@dibs.cc>' || true)
[ -z "$others" ] || fail "commits since ${prev:-the start} are by someone other than dibs maintainers <licensing@dibs.cc>: $others"
command -v cf >/dev/null 2>&1 || fail "needs the cf CLI, logged in to the account that owns $BUCKET"

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

# git archive of the tag, gzip without a name or time: the same tag always gives the same bytes.
tarball="dibs-$TAG.tar.gz"
git archive --format=tar --prefix="dibs-$TAG/" "$TAG" bin src docs skills LICENSE README.md CHANGELOG.md | gzip -n -9 > "$out/$tarball"
sum=$(shasum -a 256 "$out/$tarball" | cut -d' ' -f1)
printf '%s  %s\n' "$sum" "$tarball" > "$out/$tarball.sha256"
sed "s/^DEFAULT_SHA256=\"\"$/DEFAULT_SHA256=\"$sum\"/" install.sh > "$out/install.sh"
grep -q "^DEFAULT_SHA256=\"$sum\"$" "$out/install.sh" || fail "couldn't write the sum into install.sh (is DEFAULT_SHA256=\"\" still in it?)"
say "dibs $TAG: $tarball, sha256 $sum"

if [ -n "$MAC" ]; then
  dmg="$DIST/dibs-$VERSION.dmg"
  [ -f "$dmg" ] && [ -f "$DIST/latest.json" ] || fail "no $dmg and latest.json. Build them first: dibs run xcode-build -m \"mac release\" -- app/release.sh"
  grep -q "\"version\": *\"$VERSION\"" "$DIST/latest.json" || fail "$DIST/latest.json isn't for $VERSION"
fi

put() { # key, file, content type
  if [ -n "${DIBS_DRY_RUN:-}" ]; then say "would upload $1"; return; fi
  cf r2 buckets objects upload "$1" --bucket-name "$BUCKET" --file "$2" --content-type "$3" -q >/dev/null || fail "uploading $1 failed"
  say "uploaded $1"
}
put "releases/$tarball" "$out/$tarball" application/gzip
put "releases/$tarball.sha256" "$out/$tarball.sha256" text/plain
put "releases/install-$TAG.sh" "$out/install.sh" text/plain
put install.sh "$out/install.sh" text/plain
if [ -n "$MAC" ]; then
  put "mac/dibs-$VERSION.dmg" "$dmg" application/x-apple-diskimage
  put mac/latest.json "$DIST/latest.json" application/json
fi
[ -n "${DIBS_DRY_RUN:-}" ] && exit 0

# What people will download, byte for byte.
check() { # url, local file
  curl -fsSL "$1" -o "$out/check" || fail "$1 doesn't download"
  cmp -s "$out/check" "$2" || fail "$1 isn't what was uploaded (a cache? try again in a minute)"
  say "checked $1"
}
check "$SITE/releases/$tarball" "$out/$tarball"
check "$SITE/releases/$tarball.sha256" "$out/$tarball.sha256"
check "$SITE/install.sh" "$out/install.sh"
if [ -n "$MAC" ]; then
  check "$SITE/mac/dibs-$VERSION.dmg" "$dmg"
  check "$SITE/mac/latest.json" "$DIST/latest.json"
fi
