<#
.SYNOPSIS
  Applies a content package made by export-content.ps1 to a blog database, without touching reader data.

.DESCRIPTION
  New posts, images, series, categories, tags, gallery photos and site content are added. With -Update, a row that already exists
  is replaced only when the package's copy is newer (updated_at). Nothing is ever deleted, and users, comments, likes, bookmarks,
  views, subscribers and notifications are never read or written. The merge is one transaction: any conflict (for example a slug
  already used by a different post) rolls everything back and names the row.

  Order: check the package, check the schema version, back up the target database, merge, remove the staging schema.
  Use -DryRun first: it runs the whole merge and rolls it back, and prints what would change.

  Trust: pg_restore runs the SQL of the dump as the database user, so the package is authenticated first. Its HMAC-SHA256
  signature (signature.txt) must match the shared secret of -KeyFile or CONTENT_SYNC_KEY (the one export-content.ps1 signed with);
  the ZIP may hold only content.dump, manifest.json and signature.txt; and `pg_restore -l` of the dump may list only the schema
  export_content and its content tables. All three checks run before anything is restored, also with -DryRun. A package that cannot
  be verified is refused unless -AllowUnsigned says that you accept it as it is (the checksum of the manifest only detects damage).

.EXAMPLE
  # -User: DB_OWNER_USERNAME on an install with the three database roles, DB_USERNAME on a single-role install (never the runtime role).
  .\import-content.ps1 -Package content-export.zip -Container blog-prod-postgres-1 -Database blog -User blog_owner -KeyFile .\content-sync.key -DryRun
  .\import-content.ps1 -Package content-export.zip -Container blog-prod-postgres-1 -User blog_owner -KeyFile .\content-sync.key -Update -Yes
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Package,
    [Parameter(Mandatory)][string]$Container,
    [string]$Database = 'blog',
    # The owner role of a three-role install (DB_OWNER_USERNAME), or DB_USERNAME of a single-role install. The runtime role cannot restore.
    [string]$User = 'blog',
    # Replace existing rows when the package's copy is newer. Without it only new rows are added.
    [switch]$Update,
    # Run the merge and roll it back; prints the report and changes nothing.
    [switch]$DryRun,
    # Do not ask for confirmation.
    [switch]$Yes,
    # Where the pre-import backup of the target database is written.
    [string]$BackupDir = '.\content-import-backups',
    # File that holds the shared secret the package was signed with (else the CONTENT_SYNC_KEY variable).
    [string]$KeyFile = '',
    # Accept a package whose signature cannot be verified (unsigned, or no key at hand). A signature that is present and wrong is
    # always refused.
    [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'package-trust.ps1')
. (Join-Path $here 'docker-stream.ps1')
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$work = Join-Path ([IO.Path]::GetTempPath()) "cs-import-$stamp"
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
    if (-not (Test-Path $Package)) { throw "Package not found: $Package" }
    $entryProblems = @(Get-PackageEntryProblems $Package)
    if ($entryProblems.Count -gt 0) { throw "The package holds more than content.dump, manifest.json and signature.txt: $($entryProblems -join '; '). Refused." }
    Expand-Archive -Path $Package -DestinationPath $work -Force
    $manifestPath = Join-Path $work 'manifest.json'
    $dumpPath = Join-Path $work 'content.dump'
    $signaturePath = Join-Path $work 'signature.txt'
    if (-not (Test-Path $manifestPath) -or -not (Test-Path $dumpPath)) { throw 'The package needs manifest.json and content.dump.' }

    # Authenticate before anything is parsed, copied or restored. No docker command has run yet.
    $key = Read-SyncKey $KeyFile
    if ($key -and (Test-PackageSignature $key $work)) {
        Write-Host 'Signature verified (HMAC-SHA256 with the shared key).'
    } elseif ($key -and (Test-Path $signaturePath)) {
        throw 'The signature of the package does not match the shared key: the package was changed or signed with another key. Refused.'
    } elseif ($AllowUnsigned) {
        Write-Host 'WARNING: the package is not authenticated (-AllowUnsigned). Anyone who could change the file could change what is restored.'
    } elseif ($key) {
        throw 'The package has no signature. Make it with export-content.ps1 and the shared key, or accept it as it is with -AllowUnsigned.'
    } else {
        throw 'No shared key to verify the package: give -KeyFile <file> (or set CONTENT_SYNC_KEY), or accept an unverified package with -AllowUnsigned.'
    }
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.format -ne 'blog-content-sync/1') { throw "Unknown package format: $($manifest.format)" }
    if ((Get-FileHash $dumpPath -Algorithm SHA256).Hash -ne $manifest.dumpSha256) { throw 'content.dump does not match its checksum: the package is damaged.' }

    Invoke-Docker exec $Container pg_isready -U $User -d $Database | Out-Null
    $target = [int]((Invoke-Psql -PsqlArgs @('-c', 'SELECT max(version::int) FROM flyway_schema_history WHERE success')) | Select-Object -First 1)
    if ($target -lt [int]$manifest.flywayVersion) {
        throw "The target database is at V$target but the package was made at V$($manifest.flywayVersion). Start the newer backend on the target first so it migrates."
    }

    # The objects inside the dump, before anything is restored (also with -DryRun): only the schema export_content and its content
    # tables. `pg_restore -l` reads the table of contents and runs no SQL.
    # The dump is sent on the standard input of `pg_restore -l`: the postgres container is read-only, so nothing is copied into it.
    $listing = Invoke-DockerStream -DockerArgs @('exec', '-i', $Container, 'pg_restore', '-l') -InFile $dumpPath
    if ($listing.ExitCode -ne 0) { throw 'pg_restore could not read content.dump: the package is not a valid dump. Refused.' }
    $toc = @($listing.Stdout -split "?
")
    $tocProblems = @(Get-DumpTocProblems $toc (Join-Path $here 'export-content.sql'))
    if ($tocProblems.Count -gt 0) { throw "content.dump lists objects that a content package never holds ($($tocProblems -join '; ')). Refused before anything was restored." }

    Write-Host "Package: $Package (made $($manifest.createdUtc), schema V$($manifest.flywayVersion), target V$target)"
    $manifest.tables.PSObject.Properties | ForEach-Object { Write-Host ('  {0,-20} {1,6}' -f $_.Name, $_.Value) }
    $mode = if ($Update) { 'add new rows and update rows the package has newer' } else { 'add new rows only' }
    if ($DryRun) { $mode += ' (DRY RUN: rolled back)' }
    Write-Host "Mode: $mode"
    if (-not $DryRun -and -not $Yes) {
        if ((Read-Host 'Type YES to apply to the target database') -ne 'YES') { throw 'Cancelled.' }
    }

    if (-not $DryRun) {
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        $backup = Join-Path $BackupDir "pre-content-import-$stamp.dump"
        $backupRun = Invoke-DockerStream -DockerArgs @('exec', $Container, 'pg_dump', '-U', $User, '-d', $Database, '-Fc') -OutFile $backup
        if ($backupRun.Stderr) { [Console]::Error.Write($backupRun.Stderr) }
        if ($backupRun.ExitCode -ne 0) { throw "The backup of the target failed (pg_dump exit code $($backupRun.ExitCode)); nothing was changed." }
        Write-Host "Backup of the target before the merge: $backup"
    }

    # A leftover staging schema from an earlier failed run is removed first; then the package is restored into it.
    Invoke-Psql -PsqlArgs @('-c', 'DROP SCHEMA IF EXISTS export_content CASCADE') | Out-Null
    # Restored from the standard input (a custom-format dump is read in order, which is all pg_restore needs without -j).
    $restore = Invoke-DockerStream -DockerArgs @('exec', '-i', $Container, 'pg_restore', '-U', $User, '-d', $Database, '--no-owner', '--no-privileges', '--exit-on-error') -InFile $dumpPath
    if ($restore.Stderr) { [Console]::Error.Write($restore.Stderr) }
    if ($restore.ExitCode -ne 0) { throw "pg_restore failed with exit code $($restore.ExitCode)" }

    $updateMode = if ($Update) { 'on' } else { 'off' }
    $finish = if ($DryRun) { 'ROLLBACK' } else { 'COMMIT' }
    $merge = Invoke-DockerStream -DockerArgs @('exec', '-i', $Container, 'psql', '-U', $User, '-d', $Database, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', "update_mode=$updateMode", '-v', "finish=$finish", '-f', '-') -InFile (Join-Path $here 'merge-content.sql')
    if ($merge.Stdout) { Write-Host $merge.Stdout.TrimEnd() }
    if ($merge.Stderr) { [Console]::Error.Write($merge.Stderr) }
    if ($merge.ExitCode -ne 0) { throw 'The merge failed and was rolled back; nothing changed (see the message above).' }

    if ($DryRun) {
        Write-Host 'Dry run finished: nothing was changed.'
    } else {
        Write-Host 'Content merged. Next: restart the frontend so its page cache shows the new content (docker compose up -d --force-recreate frontend); with Meilisearch enabled, run a reindex.'
    }
} finally {
    & docker exec $Container psql -U $User -d $Database -X -q -c 'DROP SCHEMA IF EXISTS export_content CASCADE' 2>$null | Out-Null
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
