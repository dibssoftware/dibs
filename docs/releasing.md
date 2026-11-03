# Releasing

How a version reaches people: dibs.cc, npm, GitHub and the plugin marketplaces. The steps in AGENTS.md (suite twice, version bumps, CHANGELOG) come first; this is what happens after.

## Where a release goes

| where | what | how people get it |
|---|---|---|
| `https://dibs.cc/install.sh` | install.sh with the release's sha256 written in | `curl -fsSL https://dibs.cc/install.sh \| sh` |
| `https://dibs.cc/releases/` | `dibs-vX.tar.gz`, `dibs-vX.tar.gz.sha256`, `install-vX.sh` | install.sh downloads the tarball and always checks its sum |
| `https://dibs.cc/mac/` | the signed, notarized `dibs-X.dmg` and `latest.json` | `/mac/` redirects to the newest DMG (a 404 until the first one is uploaded); the app checks `latest.json` daily |
| npm | `@dibssoftware/dibs` | `npm i -g @dibssoftware/dibs` |
| GitHub | the tag, and a release with GitHub's own tarball (`.github/workflows/release.yml`) | the repo, and the Claude Code and Codex plugin marketplaces |

The dibs.cc files live in the R2 bucket `dibs-releases`; the `dibs-waitlist` Worker serves `/install.sh`, `/releases/*` and `/mac/*` from it.

## Steps

From the public repo, after the AGENTS.md steps and with the version bumped everywhere (test/version.test.mjs checks):

1. `git tag vX && git push origin main vX`. The release workflow runs the suite on macOS and Linux and makes the GitHub release.
2. `sh release.sh` uploads the tarball, its sum and install.sh to dibs.cc, then downloads each back and compares bytes. `DIBS_DRY_RUN=1` builds and checks without uploading.
3. The Mac app: `dibs run xcode-build -m "mac release" -- app/release.sh`, then `sh release.sh --mac` to upload the DMG and, last, `latest.json`.
4. `npm publish` from the same checkout (in `dibs run deploy`). package.json has no dependencies and no scripts, so nothing runs on anyone's machine at install.
5. Plugin users get the new version once the `version` in `.claude-plugin/plugin.json` changes and their marketplace refreshes (`claude plugin marketplace update dibs`).

The tarball is `git archive` of the tag through `gzip -n`, so the same tag always gives the same bytes and the same sum.
