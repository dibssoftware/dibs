# Install or upgrade dibs for this user on Windows, without admin rights.
#
#   irm https://dibs.cc/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install.ps1     # from a clone
#
# install.sh does the same on macOS, Linux and WSL. Everything below is one
# function, called on the last line, so a download cut off halfway doesn't
# parse and runs nothing at all.
#
# Puts one release in ~\.dibs-cli and two small launchers in ~\.local\bin:
# dibs.cmd for PowerShell and cmd, and dibs for Git Bash, where Claude Code runs
# its commands on Windows. Running it again with the same version changes
# nothing; with a new version it swaps the folder in whole, so hooks that point
# into ~\.dibs-cli keep working. Your queue and settings live in ~\.dibs and are
# never touched.
#
# Settings, all optional, as environment variables:
#   DIBS_VERSION   release tag to install (default below)
#   DIBS_BASE      where release tarballs live (default https://dibs.cc/releases)
#   DIBS_SOURCE    a local dibs folder to install instead of downloading
#   DIBS_SHA256    expected sha256 of the release tarball. From DIBS_BASE the
#                  sum is always checked: this, else the one dibs.cc's copy of
#                  this script carries, else the .sha256 file beside the tarball
#   DIBS_PREFIX    where the release goes (default ~\.dibs-cli)
#   DIBS_BIN_DIR   where the launchers go (default ~\.local\bin)
#   DIBS_FORCE=1   replace a dibs.cmd in DIBS_BIN_DIR that this script didn't make

function Install-Dibs {
  $ErrorActionPreference = 'Stop'
  # Release settings. DefaultVersion is set at each release; release.sh writes
  # DefaultSha256 into the copy dibs.cc serves.
  $DefaultVersion = 'v0.0.181'
  $DefaultSha256 = ''
  $DefaultBase = 'https://dibs.cc/releases'
  # Node 20 is the oldest that has every built-in dibs uses.
  $MinNode = 20

  $version = if ($env:DIBS_VERSION) { $env:DIBS_VERSION } else { $DefaultVersion }
  $base = if ($env:DIBS_BASE) { $env:DIBS_BASE } else { $DefaultBase }
  $prefix = if ($env:DIBS_PREFIX) { $env:DIBS_PREFIX } else { Join-Path $HOME '.dibs-cli' }
  $binDir = if ($env:DIBS_BIN_DIR) { $env:DIBS_BIN_DIR } else { Join-Path $HOME '.local\bin' }
  $target = Join-Path $prefix 'bin\dibs.mjs'
  $cmdShim = Join-Path $binDir 'dibs.cmd'
  $shShim = Join-Path $binDir 'dibs'
  $mark = 'rem made by dibs install.ps1'

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "dibs needs Node $MinNode or newer, and node isn't on your PATH. Install it (https://nodejs.org) and run this again."
  }
  # Read here, not in node -e: Windows PowerShell drops the double quotes inside a native command's arguments.
  $nodeVersion = (& node -v).Trim().TrimStart('v')
  $v = [int[]]($nodeVersion.Split('.')[0..2])
  if ($v[0] -lt $MinNode) { throw "dibs needs Node $MinNode or newer; this is Node $nodeVersion. Upgrade it and run this again." }
  # CVE-2026-111497 (Brotli decoder, 2026-10-21): fixed in 22.23.4, 24.22.1, 26.12.1; other lines before 27 get none.
  $fixed = @{ 22 = @(23, 4); 24 = @(22, 1); 26 = @(12, 1) }[$v[0]]
  $patched = $v[0] -ge 27 -or ($fixed -and ($v[1] -gt $fixed[0] -or ($v[1] -eq $fixed[0] -and $v[2] -ge $fixed[1])))
  if (-not $patched -and -not $env:DIBS_ALLOW_UNPATCHED) {
    throw "Node $nodeVersion has the Brotli hole CVE-2026-111497. Install Node 22.23.4, 24.22.1, 26.12.1 or newer and run this again. (DIBS_ALLOW_UNPATCHED=1 if you mean it)"
  }

  # A dibs.cmd we didn't make is someone's own dibs: leave it unless told otherwise.
  if ((Test-Path $cmdShim) -and -not (Select-String -Path $cmdShim -SimpleMatch $mark -Quiet) -and -not $env:DIBS_FORCE) {
    throw "$cmdShim already exists and this script didn't make it. Remove it, or run with DIBS_FORCE=1 to replace it."
  }

  $installed = ''
  $releaseFile = Join-Path $prefix '.dibs-release'
  if (Test-Path $releaseFile) { $installed = (Get-Content $releaseFile -Raw).Trim() }
  $want = $version
  if ($env:DIBS_SOURCE) { $want = 'local:' + (Resolve-Path $env:DIBS_SOURCE).Path }

  # A local folder may have changed since last time, so it's always copied again.
  if (-not $env:DIBS_SOURCE -and $installed -eq $want -and (Test-Path $target)) {
    Write-Output "dibs $version is already in $prefix"
  } else {
    $parent = Split-Path $prefix -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $stage = Join-Path $parent ('.dibs-cli.new.' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
      if ($env:DIBS_SOURCE) {
        if (-not (Test-Path (Join-Path $env:DIBS_SOURCE 'bin\dibs.mjs'))) { throw "$($env:DIBS_SOURCE) doesn't look like dibs (no bin\dibs.mjs)" }
        Write-Output "copying dibs from $($env:DIBS_SOURCE)"
        foreach ($f in 'bin', 'src', 'docs', 'skills', 'LICENSE', 'README.md', 'CHANGELOG.md') {
          $from = Join-Path $env:DIBS_SOURCE $f
          if (Test-Path $from) { Copy-Item -Recurse -Path $from -Destination $stage }
        }
      } else {
        $url = "$base/dibs-$version.tar.gz"
        $wantSum = $env:DIBS_SHA256
        if (-not $wantSum -and -not $env:DIBS_VERSION -and -not $env:DIBS_BASE) { $wantSum = $DefaultSha256 }
        if (-not $wantSum) {
          try { $wantSum = ((Invoke-RestMethod -UseBasicParsing "$url.sha256") -split '\s+')[0] } catch { $wantSum = '' }
          if (-not $wantSum) { throw "couldn't get the checksum $url.sha256. Check your connection and DIBS_VERSION. Nothing was installed." }
        }
        Write-Output "downloading $url"
        $tarball = Join-Path $stage 'release.tar.gz'
        try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tarball }
        catch {
          $code = $_.Exception.Response.StatusCode.value__
          if ($code -eq 404) { throw "there's no release $version at $base (404). Check DIBS_VERSION. Nothing was installed." }
          if ($code) { throw "downloading $url failed (HTTP $code). Nothing was installed." }
          throw "couldn't reach $url. Check your connection. Nothing was installed."
        }
        $got = (Get-FileHash -Algorithm SHA256 -Path $tarball).Hash.ToLower()
        if ($got -ne $wantSum.ToLower()) { throw "checksum mismatch for ${url}: expected $wantSum, got $got. Nothing was installed." }
        Write-Output "checksum ok: $got"
        # Windows' own tar (10 1803 and later), by its full path: Git's GNU tar, often
        # first on PATH, reads C: in a path as a host to connect to.
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $tarball -C $stage --strip-components 1
        if ($LASTEXITCODE -ne 0) { throw "couldn't unpack $url. Nothing was installed." }
        Remove-Item -Force $tarball
      }
      if (-not (Test-Path (Join-Path $stage 'bin\dibs.mjs'))) { throw 'the download has no bin\dibs.mjs; nothing was installed' }
      Set-Content -Path (Join-Path $stage '.dibs-release') -Value $want -Encoding ascii

      # Swap the folder in whole, so nothing ever runs half an upgrade.
      if (Test-Path $prefix) {
        $old = "$prefix.old.$PID"
        Move-Item -Path $prefix -Destination $old
        Move-Item -Path $stage -Destination $prefix
        Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue
      } else {
        Move-Item -Path $stage -Destination $prefix
      }
    } finally {
      if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
    }
    $shown = & node $target --version 2>$null
    if (-not $shown) { $shown = $version }
    Write-Output "installed dibs $shown in $prefix"
  }

  # Windows has no links an ordinary user may make, and runs no .mjs by name:
  # two launchers that start node on it instead.
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $cmdText = "@echo off`r`n$mark`r`nnode `"$target`" %*`r`n"
  $shText = "#!/bin/sh`n# made by dibs install.ps1, for Git Bash`nexec node `"$($target -replace '\\', '/')`" `"`$@`"`n"
  $same = (Test-Path $cmdShim) -and ((Get-Content $cmdShim -Raw) -eq $cmdText) -and (Test-Path $shShim)
  if (-not $same) {
    [IO.File]::WriteAllText($cmdShim, $cmdText)
    [IO.File]::WriteAllText($shShim, $shText)
    Write-Output "made $cmdShim and $shShim"
  }

  Write-Output ''
  $onPath = ($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }
  if (-not $onPath) {
    Write-Output "$binDir isn't on your PATH. Add it for your user, then open a new terminal:"
    Write-Output "  [Environment]::SetEnvironmentVariable('Path', `"$binDir;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
    Write-Output ''
  }
  Write-Output 'Next:'
  Write-Output '  dibs                                      the board (empty until an agent runs something)'
  Write-Output '  dibs run test -m "why" -- npm test        take a turn on the test runner'
  Write-Output ''
  Write-Output 'So agents can''t skip the line, add the guard hook. From this terminal (not from inside an agent):'
  Write-Output '  dibs guard install'
  Write-Output 'or as a Claude Code plugin, in a session:'
  Write-Output '  /plugin marketplace add dibssoftware/dibs'
  Write-Output '  /plugin install dibs@dibs'
  Write-Output 'Then tell your agents about dibs (see the README''s "Tell your agents" section).'
}

try { Install-Dibs } catch {
  [Console]::Error.WriteLine("dibs install: $($_.Exception.Message)")
  # From a file, a failure is exit 1; under irm | iex, exit would close the window.
  if ($PSCommandPath) { exit 1 }
}
