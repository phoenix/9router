# pack-and-deploy.ps1 — Build the 9router CLI tarball, verify it, then act via a menu.
# Designed for a public repo: no secrets, no hardcoded hosts, risky actions are explicit menu choices.
# Last-used server is remembered in %USERPROFILE%\.9router\deploy-target.txt (outside this repo).
#
# Usage:
#   .\scripts\pack-and-deploy.ps1            build + verify + interactive menu (default)
#   .\scripts\pack-and-deploy.ps1 -SkipBuild skip rebuild, verify existing tarball + menu
# Non-interactive (same actions as menu, for automation):
#   .\scripts\pack-and-deploy.ps1 -InstallLocally
#   .\scripts\pack-and-deploy.ps1 -Server user@host
param(
  [switch]$InstallLocally,
  [string]$Server = $env:9ROUTER_DEPLOY_TARGET,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  [..] $msg" }

# ---------- Phase 1: pre-flight ----------
Write-Host "`n=== Phase 1: pre-flight ===" -ForegroundColor Cyan

Info "Local changes that will be baked into this tarball:"
$dirty = git status --short
if ($dirty) { $dirty | ForEach-Object { Write-Host "        $_" -ForegroundColor Yellow } }
else { Write-Host "        (clean tree)" }

# nft patch: pnpm install resets node_modules and reinstates the recursive-symlink crash.
$nextEntry = Get-ChildItem "node_modules\.pnpm" -Directory -Filter "next@*" | Select-Object -First 1
if (-not $nextEntry) { Fail "next package not found under node_modules\.pnpm — run pnpm install first" }
$nftPath = Join-Path $nextEntry.FullName "node_modules\next\dist\compiled\@vercel\nft\index.js"
if (-not (Test-Path $nftPath)) { Fail "nft tracing file not found: $nftPath" }
$nftRaw = [System.IO.File]::ReadAllText($nftPath)
$throwNeedle = 'if(s.has(e))throw new Error("Recursive symlink detected resolving "+e);'
if ($nftRaw.Contains($throwNeedle)) {
  [System.IO.File]::WriteAllText($nftPath, $nftRaw.Replace($throwNeedle, 'if(s.has(e))return e;'))
  Ok "nft recursive-symlink patch re-applied (was reset by a previous pnpm install)"
} elseif ($nftRaw.Contains('if(s.has(e))return e;')) {
  Ok "nft recursive-symlink patch already in place"
} else {
  Fail "nft index.js does not match the known patch anchors (next updated?) — patch manually"
}

# cli/ deps (esbuild for MITM bundling). Root workspace swallows a plain install, hence --ignore-workspace.
if (-not (Test-Path "cli\node_modules\esbuild")) {
  Info "cli/ dependencies missing — installing (pnpm install --ignore-workspace)..."
  Push-Location cli
  try { pnpm install --ignore-workspace } finally { Pop-Location }
  if (-not (Test-Path "cli\node_modules\esbuild")) { Fail "esbuild still missing after cli install" }
}
Ok "cli/ build dependencies present"

# ---------- Phase 2: build ----------
if (-not $SkipBuild) {
  Write-Host "`n=== Phase 2: build (Turbopack) ===" -ForegroundColor Cyan
  pnpm run cli:pack
  if ($LASTEXITCODE -ne 0) { Fail "cli:pack exited with $LASTEXITCODE" }
} else {
  Write-Host "`n=== Phase 2: build skipped (-SkipBuild) ===" -ForegroundColor DarkCyan
}

# ---------- Phase 3: verify tarball ----------
Write-Host "`n=== Phase 3: verify tarball ===" -ForegroundColor Cyan
$cliPkg = Get-Content "cli\package.json" -Raw | ConvertFrom-Json
$tarName = "$($cliPkg.name)-$($cliPkg.version).tgz"
$tarPath = Join-Path $repo $tarName
if (-not (Test-Path $tarPath)) { Fail "tarball not found: $tarPath" }
$tarItem = Get-Item $tarPath
if ($tarItem.LastWriteTime -lt (Get-Date).AddHours(-2)) {
  Fail "tarball is stale (built $($tarItem.LastWriteTime)) — rebuild without -SkipBuild"
}
$list = tar -tzf $tarPath
if (-not $list) { Fail "could not list tarball contents" }
$tarMB = [math]::Round($tarItem.Length / 1MB, 1)
Ok "tarball $tarName ($tarMB MB, built $($tarItem.LastWriteTime.ToString('HH:mm:ss')))"

# 3a. critical runtime files
$critical = @(
  "package/cli.js",
  "package/app/.next-cli-build/server/app/api/v1/chat/completions/route.js",
  "package/app/.next-cli-build/server/app/api/v1/messages/route.js",
  "package/app/.next-cli-build/static/chunks",
  "package/app/src/mitm",
  "package/app/custom-server.js",
  "package/hooks/postinstall.js"
)
$missing = @()
foreach ($c in $critical) {
  $hit = $false
  foreach ($e in $list) { if ($e -eq $c -or $e.StartsWith($c + "/")) { $hit = $true; break } }
  if (-not $hit) { $missing += $c }
}
if ($missing.Count -gt 0) { Fail ("missing critical files in tarball:`n        " + ($missing -join "`n        ")) }
Ok "critical runtime files present (routes, static, MITM, hooks)"

# 3b. secret scan — anything sensitive that leaked into the archive aborts the run
$secretPatterns = '\.env$', '\.env\.[^e]', '\.pem$', '\.key$', '\.p12$', '\.pfx$', '\.npmrc$', 'id_rsa', 'id_ed25519', 'credentials\.json$', '\.ssh\/'
$leaks = @()
foreach ($e in $list) {
  foreach ($p in $secretPatterns) { if ($e -match $p) { $leaks += "$e  (matches $p)"; break } }
}
if ($leaks.Count -gt 0) { Fail ("possible secrets in tarball — NOT shipping:`n        " + ($leaks -join "`n        ")) }
Ok "secret scan clean (no .env/.pem/.key/.npmrc/ssh keys in archive)"

# 3c. platform purity — native binaries must not ship; runtime installs per-platform copies
$nativeBins = $list | Where-Object { $_ -match '\.node$' }
if ($nativeBins) { Fail ("native .node binaries in tarball (win32 leftovers?):`n        " + (($nativeBins | Select-Object -First 10) -join "`n        ")) }
$sharpPkgs = $list | Where-Object { $_ -match '@img' }
if ($sharpPkgs) { Fail ("sharp platform packages in tarball:`n        " + (($sharpPkgs | Select-Object -First 5) -join "`n        ")) }
Ok "platform-pure: no native binaries, no @img/sharp packages"

# ---------- Actions ----------
function Install-Locally {
  Write-Host "`n--- local global install ---" -ForegroundColor Cyan
  pnpm remove -g 9router 2>$null
  pnpm add -g $tarPath
  if ($LASTEXITCODE -ne 0) { Fail "local global install failed" }
  Ok "installed globally — verify with: 9router --version"
}

function Deploy-Server([string]$target) {
  Write-Host "`n--- deploy to $target ---" -ForegroundColor Cyan
  if (-not $target) { Write-Host "  no server given, skipping" -ForegroundColor Yellow; return }
  Info "uploading $tarName to ${target}:/tmp/ ..."
  scp $tarPath "${target}:/tmp/$tarName"
  if ($LASTEXITCODE -ne 0) { Fail "scp upload failed" }
  Info "installing on server (pnpm remove old + add new, absolute path)..."
  ssh $target "pnpm remove -g 9router 2>/dev/null; pnpm add -g /tmp/$tarName && 9router --version"
  if ($LASTEXITCODE -ne 0) { Fail "server install failed" }
  Ok "server install verified"
  $targetFile = Join-Path $env:USERPROFILE ".9router\deploy-target.txt"
  New-Item -ItemType Directory -Force -Path (Split-Path $targetFile) | Out-Null
  Set-Content -Path $targetFile -Value $target
  Write-Host "  remembered server in $targetFile (outside the repo) — next time just press 3"
}

if ($InstallLocally -or $Server) {
  # non-interactive mode
  if ($InstallLocally) { Install-Locally }
  if ($Server) { Deploy-Server $Server }
  Write-Host "`n=== DONE ===" -ForegroundColor Green
  exit 0
}

# interactive menu (default mode) — Enter is always the safe exit
$targetFile = Join-Path $env:USERPROFILE ".9router\deploy-target.txt"
while ($true) {
  $lastTarget = ""
  if (Test-Path $targetFile) { $lastTarget = (Get-Content $targetFile -First 1).Trim() }
  Write-Host ""
  Write-Host "tarball ready: $tarName ($tarMB MB)" -ForegroundColor Green
  Write-Host "  [Enter] exit"
  Write-Host "  [1]     exit"
  Write-Host "  [2]     install on this machine (pnpm add -g)"
  if ($lastTarget) { Write-Host "  [3]     deploy to server (Enter = $lastTarget, or type a new user@host)" }
  else { Write-Host "  [3]     deploy to server (user@host)" }
  $choice = (Read-Host "choose").Trim()
  if ($choice -eq "" -or $choice -eq "1") { break }
  elseif ($choice -eq "2") { Install-Locally }
  elseif ($choice -eq "3") {
    $target = $lastTarget
    if ($target) {
      $sub = (Read-Host "server [Enter = $lastTarget, or type a new user@host]").Trim()
      if ($sub) { $target = $sub }
    } else {
      $target = (Read-Host "server user@host").Trim()
    }
    if (-not $target) { Write-Host "  no server given" -ForegroundColor Yellow }
    else { Deploy-Server $target }
  }
  else { Write-Host "  unknown choice" -ForegroundColor Yellow }
}
Write-Host "`nbye." -ForegroundColor Green
