# Releasing

How a version reaches people: dibs.cc, npm, GitHub and the plugin marketplaces. The steps in AGENTS.md (suite twice, version bumps, CHANGELOG) come first; this is what happens after.

## Where a release goes

| where | what | how people get it |
|---|---|---|
| `https://dibs.cc/install.sh` | install.sh with the release's sha256 written in | `curl -fsSL https://dibs.cc/install.sh \| sh` |
| `https://dibs.cc/install.ps1` | install.ps1, the same for native Windows | `irm https://dibs.cc/install.ps1 \| iex` |
| `https://dibs.cc/releases/` | `dibs-vX.tar.gz`, `dibs-vX.tar.gz.sha256`, `install-vX.sh`, `install-vX.ps1` | install.sh and install.ps1 download the tarball and always check its sum |
| `https://dibs.cc/mac/` | the signed, notarized `dibs-X.dmg` and `latest.json` | `/mac/` redirects to the newest DMG; the app checks `latest.json` daily |
| npm | `@dibssoftware/dibs` | `npm i -g @dibssoftware/dibs` |
| GitHub | the tag, and a release with GitHub's own tarball (`.github/workflows/release.yml`) | the repo, and the Claude Code and Codex plugin marketplaces |

The dibs.cc files live in the R2 bucket `dibs-releases`; the `dibs-waitlist` Worker serves `/install.sh`, `/install.ps1`, `/releases/*` and `/mac/*` from it.

## Steps

From the public repo, after the AGENTS.md steps and with the version bumped everywhere (test/version.test.mjs checks):

1. Each change in the release lands in the public repo as a commit of its own, with its own message, authored and committed by `dibs maintainers <licensing@dibs.cc>`. Never one squashed commit per release, and never a rewrite of what's already public. `release.sh` refuses a tag with any other author since the last tag.
2. `git tag vX && git push origin main vX`. The release workflow runs the suite on macOS and Linux, makes the GitHub release, and publishes `@dibssoftware/dibs` to npm through trusted publishing: no npm token anywhere, and npm shows the package's provenance as that workflow run. package.json has no dependencies and no scripts, so nothing runs on anyone's machine at install.
3. `sh release.sh` uploads the tarball, its sum, install.sh and install.ps1 to dibs.cc, then downloads each back and compares bytes. `DIBS_DRY_RUN=1` builds and checks without uploading.
4. The Mac app: `dibs run xcode-build -m "mac release" -- app/release.sh`, then `sh release.sh --mac` to upload the DMG and, last, `latest.json`.
5. Plugin users get the new version once the `version` in `.claude-plugin/plugin.json` changes and their marketplace refreshes (`claude plugin marketplace update dibs`).

The tarball is `git archive` of the tag through `gzip -n`, so the same tag always gives the same bytes and the same sum.
