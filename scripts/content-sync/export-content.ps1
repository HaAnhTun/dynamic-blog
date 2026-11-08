<#
.SYNOPSIS
  Packs the CONTENT of a blog database (posts, images, series, categories, tags, gallery, site content) into one ZIP.

.DESCRIPTION
  Reader data is never exported: users, comments, likes, bookmarks, views, newsletter subscribers, notifications and contact
  messages stay where they are. The ZIP holds content.dump (a pg_dump of a throw-away schema) and manifest.json. Copy it to the
  other machine and apply it with import-content.ps1. Needs Docker and the PostgreSQL container of the source blog.

  The package is signed (HMAC-SHA256, signature.txt) with a shared secret that is never inside it: a file given with -KeyFile or
  the CONTENT_SYNC_KEY variable, at least 32 characters (openssl rand -hex 32). The import refuses a package it cannot verify. The
  checksum in manifest.json only detects damage; the signature is what stops a changed package from being restored.

.EXAMPLE
  # -User: DB_OWNER_USERNAME on an install with the three database roles, DB_USERNAME on a single-role install (never the runtime role).
  .\export-content.ps1 -Container blog-pg -Database blog -User blog_owner -KeyFile .\content-sync.key
  .\export-content.ps1 -Container blog-pg -KeyFile .\content-sync.key
  .\export-content.ps1 -Container blog-pg -OnlyPublished -WithRevisions -Out .\transfer\content.zip
#>
[CmdletBinding()]
param(
    # Name of the PostgreSQL container (docker ps); for a compose install: docker compose ps -q postgres
    [Parameter(Mandatory)][string]$Container,
    [string]$Database = 'blog',
    # The owner role of a three-role install (DB_OWNER_USERNAME), or DB_USERNAME of a single-role install. The runtime role cannot stage the copy.
    [string]$User = 'blog',
    # Export only published posts (drafts stay behind).
    [switch]$OnlyPublished,
    # Also export the saved revisions of the posts (larger package).
    [switch]$WithRevisions,
    [string]$Out = '',
    # File that holds the shared secret that signs the package (else the CONTENT_SYNC_KEY variable). Never pass the secret itself
    # on the command line: other users of the machine can read the process list.
    [string]$KeyFile = '',
    # Make a package without signature. The import refuses it unless it is run with -AllowUnsigned.
    [switch]$Unsigned
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'package-trust.ps1')
. (Join-Path $here 'docker-stream.ps1')
$key = Read-SyncKey $KeyFile
if (-not $key -and -not $Unsigned) {
    throw 'Give the shared key to sign the package: -KeyFile <file> or the CONTENT_SYNC_KEY variable (at least 32 characters). Use -Unsigned only for a package that the import will accept with -AllowUnsigned.'
}
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
if ($Out -eq '') { $Out = Join-Path (Get-Location) "content-export-$stamp.zip" }
$work = Join-Path ([IO.Path]::GetTempPath()) "cs-export-$stamp"
New-Item -ItemType Directory -Path $work | Out-Null

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker $($args -join ' ') failed with exit code $LASTEXITCODE" }
}
function Invoke-Psql {
    param([string[]]$PsqlArgs, [string]$InFile = '')
    # A script (-f -) arrives on the standard input: nothing is copied into the container, whose root is read-only.
    $result = Invoke-DockerStream -DockerArgs (@('exec', '-i', $Container, 'psql', '-U', $User, '-d', $Database, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1') + $PsqlArgs) -InFile $InFile
    if ($result.Stderr) { [Console]::Error.Write($result.Stderr) }
    if ($result.ExitCode -ne 0) { throw "psql failed with exit code $($result.ExitCode)" }
    return @($result.Stdout -split "?
" | Where-Object { $_ -ne '' })
}

try {
    Invoke-Docker exec $Container pg_isready -U $User -d $Database | Out-Null
    $flyway = (Invoke-Psql -PsqlArgs @('-c', 'SELECT max(version::int) FROM flyway_schema_history WHERE success')) | Select-Object -First 1

    $published = if ($OnlyPublished) { 'on' } else { 'off' }
    $revisions = if ($WithRevisions) { 'on' } else { 'off' }
    $lines = Invoke-Psql -PsqlArgs @('-v', "only_published=$published", '-v', "with_revisions=$revisions", '-f', '-') -InFile (Join-Path $here 'export-content.sql')

    $tables = [ordered]@{}
    foreach ($line in $lines) {
        if ($line -match '^([a-z_]+)\|(\d+)$') { $tables[$Matches[1]] = [int]$Matches[2] }
    }
    if ($tables.Count -eq 0) { throw 'The export staged no tables.' }

    # The dump leaves on the standard output and is written to the host as bytes; nothing is staged in the container.
    $dump = Invoke-DockerStream -DockerArgs @('exec', $Container, 'pg_dump', '-U', $User, '-d', $Database, '-n', 'export_content', '-Fc', '--no-owner') -OutFile (Join-Path $work 'content.dump')
    if ($dump.Stderr) { [Console]::Error.Write($dump.Stderr) }
    if ($dump.ExitCode -ne 0) { throw "pg_dump failed with exit code $($dump.ExitCode)" }
    $sha = (Get-FileHash (Join-Path $work 'content.dump') -Algorithm SHA256).Hash

    $manifest = [ordered]@{
        format        = 'blog-content-sync/1'
        createdUtc    = (Get-Date).ToUniversalTime().ToString('o')
        sourceDb      = $Database
        flywayVersion = [int]$flyway
        onlyPublished = [bool]$OnlyPublished
        withRevisions = [bool]$WithRevisions
        tables        = $tables
        dumpSha256    = $sha
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $work 'manifest.json') -Encoding utf8

    $files = @((Join-Path $work 'content.dump'), (Join-Path $work 'manifest.json'))
    if ($key) {
        $signature = Get-PackageSignature $key (Join-Path $work 'manifest.json') (Join-Path $work 'content.dump')
        Set-Content -Path (Join-Path $work 'signature.txt') -Value $signature -Encoding ascii -NoNewline
        $files += Join-Path $work 'signature.txt'
    }
    if (Test-Path $Out) { Remove-Item $Out -Force }
    Compress-Archive -Path $files -DestinationPath $Out
    Write-Host ''
    Write-Host "Content package: $Out ($([math]::Round((Get-Item $Out).Length / 1MB, 1)) MB, schema version V$flyway)"
    $tables.GetEnumerator() | ForEach-Object { Write-Host ('  {0,-20} {1,6}' -f $_.Key, $_.Value) }
    Write-Host 'Reader data (users, comments, likes, subscribers, views...) is not in the package.'
    if ($key) { Write-Host 'Signed with the shared key (HMAC-SHA256): the import needs the same key.' }
    else { Write-Host 'NOT SIGNED: the import refuses this package unless it is run with -AllowUnsigned.' }
} finally {
    # The staging schema never stays behind, also when something failed above (the container holds no temporary file).
    & docker exec $Container psql -U $User -d $Database -X -q -c 'DROP SCHEMA IF EXISTS export_content CASCADE' 2>$null | Out-Null
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
