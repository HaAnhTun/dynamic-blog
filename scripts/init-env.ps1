<#
.SYNOPSIS
  Writes .env from .env.example with fresh random secrets. Never overwrites an existing .env.

.DESCRIPTION
  .\scripts\init-env.ps1
  .\scripts\init-env.ps1 -SiteUrl https://example.com -SitePort 3000 -DefaultLocale vi

  Without the parameters the environment variables SITE_URL, SITE_PORT and DEFAULT_LOCALE are used, then the defaults
  (http://localhost:3000, 3000, en). ADMIN_PASSWORD, SETUP_TOKEN, ADMIN_GITHUB_ID, MFA_ENROLLMENT_TOKEN, MFA_RESET_EMAIL and
  MFA_RESET_TOKEN stay empty: a fresh install is claimed at <SiteUrl>/setup with the setup code the backend writes to
  /data/setup-code. MFA_ENCRYPTION_KEY is generated (base64 of 32 random bytes). No secret is printed.

  The file is made private before a secret is written to it: on Windows inheritance is switched off and only the current user has
  access (every other account of the machine is locked out, as mode 600 does for init-env.sh); on PowerShell 7 elsewhere it is
  chmod 600. It is written under a temporary name and moved into place, so .env never exists with the permissions of its folder.
#>
[CmdletBinding()]
param(
  [string]$SiteUrl,
  [string]$SitePort,
  [string]$DefaultLocale
)

$ErrorActionPreference = 'Stop'

function Get-Setting([string]$Value, [string]$EnvName, [string]$Default) {
  if (-not [string]::IsNullOrEmpty($Value)) { return $Value }
  $fromEnv = [Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrEmpty($fromEnv)) { return $fromEnv }
  return $Default
}

function Fail([string]$Message) {
  [Console]::Error.WriteLine("init-env: $Message")
  exit 1
}

# $Bytes random bytes as base64 (44 characters for 32 bytes), the format of MFA_ENCRYPTION_KEY.
function New-RandomBase64([int]$Bytes) {
  $buffer = New-Object 'byte[]' $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($buffer)
}

# $Bytes random bytes as 2*N hex characters.
function New-RandomHex([int]$Bytes) {
  $buffer = New-Object 'byte[]' $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '')
}

# Owner-only access to a file. Windows: no inherited rules, one rule, FullControl for the current user. Elsewhere: mode 600.
function Set-OwnerOnly([string]$Path) {
  $onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($null -ne $IsWindows -and $IsWindows)
  if ($onWindows) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
  } else {
    & chmod 600 $Path
    if ($LASTEXITCODE -ne 0) { Fail "chmod 600 failed for $Path" }
  }
}

$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root '.env.example'
$target = Join-Path $root '.env'

if (Test-Path -LiteralPath $target) { Fail "$target already exists; refusing to overwrite it. Move it away first." }
if (-not (Test-Path -LiteralPath $template)) { Fail "$template not found." }

$siteUrl = (Get-Setting $SiteUrl 'SITE_URL' 'http://localhost:3000').TrimEnd('/')
$sitePort = Get-Setting $SitePort 'SITE_PORT' '3000'
$locale = Get-Setting $DefaultLocale 'DEFAULT_LOCALE' 'en'

if ($siteUrl -notmatch '^https?://') { Fail 'SiteUrl must start with http:// or https:// (got a value without a scheme).' }
if ($siteUrl -notmatch '^[A-Za-z0-9:/._-]+$') { Fail 'SiteUrl contains characters that are not allowed here.' }
if ($sitePort -notmatch '^[0-9]+$') { Fail 'SitePort must be a number.' }
if ($locale -notin @('en', 'vi')) { Fail 'DefaultLocale must be en or vi.' }

$values = [ordered]@{
  DB_PASSWORD       = New-RandomHex 24
  DB_OWNER_PASSWORD = New-RandomHex 24
  DB_ADMIN_PASSWORD = New-RandomHex 24
  JWT_SECRET        = New-RandomHex 48
  MFA_ENCRYPTION_KEY = New-RandomBase64 32
  VIEWS_TOKEN       = New-RandomHex 32
  CLIENT_IP_TOKEN   = New-RandomHex 32
  NEWSLETTER_SECRET = New-RandomHex 48
  MEILI_MASTER_KEY  = New-RandomHex 32
  SITE_URL          = $siteUrl
  SITE_PORT         = $sitePort
  DEFAULT_LOCALE    = $locale
}

$lines = [System.IO.File]::ReadAllLines($template)
$seen = @{}
$out = foreach ($line in $lines) {
  $replaced = $false
  foreach ($key in $values.Keys) {
    if ($line.StartsWith("$key=")) {
      "$key=$($values[$key])"
      $seen[$key] = $true
      $replaced = $true
      break
    }
  }
  if (-not $replaced) { $line }
}
foreach ($key in $values.Keys) {
  if (-not $seen.ContainsKey($key)) { Fail "$key is missing from .env.example; .env was not written." }
}

# UTF-8 without BOM, LF line endings, the way Docker Compose reads it on every platform. A temporary file next to the target is
# created empty and made private first, then filled and moved into place (a rename keeps its access rules).
$temporary = Join-Path $root (".env." + [System.IO.Path]::GetRandomFileName())
try {
  New-Item -ItemType File -Path $temporary | Out-Null
  Set-OwnerOnly $temporary
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($temporary, (($out -join "`n") + "`n"), $utf8)
  Move-Item -LiteralPath $temporary -Destination $target
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}

Write-Host "init-env: wrote $target (owner-only access) from .env.example."
Write-Host '  random secrets: DB_PASSWORD, DB_OWNER_PASSWORD, DB_ADMIN_PASSWORD, JWT_SECRET, MFA_ENCRYPTION_KEY, VIEWS_TOKEN, CLIENT_IP_TOKEN, NEWSLETTER_SECRET, MEILI_MASTER_KEY (not shown)'
Write-Host "  SITE_URL=$siteUrl  SITE_PORT=$sitePort  DEFAULT_LOCALE=$locale"
Write-Host "  left empty: ADMIN_PASSWORD, SETUP_TOKEN, ADMIN_GITHUB_ID (claim the site at $siteUrl/setup)"
Write-Host 'Next: docker compose up -d --build'
Write-Host "Then open $siteUrl/setup and read the setup code with: docker compose exec backend sh -c 'cat /data/setup-code'"
