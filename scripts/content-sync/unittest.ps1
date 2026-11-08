<#
.SYNOPSIS
  Checks of the trust logic of the content package (signature, archive entries, restore list) without a database or Docker.

.DESCRIPTION
  package-trust.ps1 decides whether a content package may be restored: its HMAC-SHA256 signature (made with a shared secret that is
  never inside the package), the entries of the ZIP, and the list of objects inside content.dump (`pg_restore -l`). This script
  runs those functions on small made-up packages and lists. selftest.ps1 proves the same on two real databases.
  Run by `python scripts/test_content_sync.py` (CI) or directly: pwsh -NoProfile -File scripts/content-sync/unittest.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'package-trust.ps1')
. (Join-Path $here 'docker-stream.ps1')

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('cs-unittest-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failures = 0
function Check([string]$What, $Actual, $Expected) {
    if ("$Actual" -eq "$Expected") { Write-Host "  PASS  $What" }
    else { Write-Host "  FAIL  $What (expected '$Expected', got '$Actual')"; $script:failures++ }
}
function Throws([scriptblock]$Block) {
    try { & $Block | Out-Null; return $false } catch { return $true }
}

# A package the way export-content.ps1 makes it: manifest.json, content.dump and, when signed, signature.txt.
function New-Package([string]$Name, [byte[]]$Key, [string]$DumpText = 'pretend dump bytes') {
    $dir = Join-Path $tmp $Name
    New-Item -ItemType Directory -Path $dir | Out-Null
    [IO.File]::WriteAllText((Join-Path $dir 'content.dump'), $DumpText)
    $sha = (Get-FileHash (Join-Path $dir 'content.dump') -Algorithm SHA256).Hash
    $manifest = [ordered]@{ format = 'blog-content-sync/1'; flywayVersion = 44; tables = [ordered]@{ posts = 3 }; dumpSha256 = $sha }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $dir 'manifest.json') -Encoding utf8
    if ($Key) {
        Set-Content -Path (Join-Path $dir 'signature.txt') -Value (Get-PackageSignature $Key (Join-Path $dir 'manifest.json') (Join-Path $dir 'content.dump')) -Encoding ascii -NoNewline
    }
    return $dir
}

$keyA = [Text.Encoding]::UTF8.GetBytes('0123456789abcdef0123456789abcdef-A')
$keyB = [Text.Encoding]::UTF8.GetBytes('0123456789abcdef0123456789abcdef-B')

Write-Host 'Signature'
$good = New-Package 'good' $keyA
Check 'a package signed with the key verifies' (Test-PackageSignature $keyA $good) 'True'
Check 'another key does not verify it' (Test-PackageSignature $keyB $good) 'False'
Check 'a package without signature.txt does not verify' (Test-PackageSignature $keyA (New-Package 'unsigned' $null)) 'False'

# The attack of the issue: replace the dump and recompute the checksum that the manifest holds. The checksum is only for damage.
$forged = New-Package 'forged' $keyA
[IO.File]::WriteAllText((Join-Path $forged 'content.dump'), 'COPY ... FROM PROGRAM')
$manifest = Get-Content (Join-Path $forged 'manifest.json') -Raw | ConvertFrom-Json
$manifest.dumpSha256 = (Get-FileHash (Join-Path $forged 'content.dump') -Algorithm SHA256).Hash
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $forged 'manifest.json') -Encoding utf8
Check 'a replaced dump with a recomputed dumpSha256 is refused' (Test-PackageSignature $keyA $forged) 'False'

$edited = New-Package 'edited' $keyA
(Get-Content (Join-Path $edited 'manifest.json') -Raw).Replace('"posts": 3', '"posts": 4') | Set-Content -Path (Join-Path $edited 'manifest.json') -Encoding utf8
Check 'an edited manifest is refused' (Test-PackageSignature $keyA $edited) 'False'

$swapped = New-Package 'swapped' $keyA 'a different dump'
Copy-Item (Join-Path $good 'signature.txt') (Join-Path $swapped 'signature.txt') -Force
Check 'the signature of another package is refused' (Test-PackageSignature $keyA $swapped) 'False'
Check 'a signature with garbage in it is refused, not thrown' (Test-PackageSignature $keyA (New-Package 'garbage' $null)) 'False'
Set-Content -Path (Join-Path $tmp 'garbage' 'signature.txt') -Value 'not hex at all' -Encoding ascii
Check 'a non-hex signature is refused, not thrown' (Test-PackageSignature $keyA (Join-Path $tmp 'garbage')) 'False'

Write-Host 'Key'
Set-Content -Path (Join-Path $tmp 'key.txt') -Value ('k' * 40) -Encoding ascii
Check 'a key file is read' ([Text.Encoding]::UTF8.GetString((Read-SyncKey (Join-Path $tmp 'key.txt')))) ('k' * 40)
Set-Content -Path (Join-Path $tmp 'short.txt') -Value 'short' -Encoding ascii
Check 'a key under 32 characters is refused' (Throws { Read-SyncKey (Join-Path $tmp 'short.txt') }) 'True'
$env:CONTENT_SYNC_KEY = 'e' * 40
Check 'the environment variable is read when no file is given' ([Text.Encoding]::UTF8.GetString((Read-SyncKey ''))) ('e' * 40)
Remove-Item Env:CONTENT_SYNC_KEY
Check 'no file and no variable gives no key' ($null -eq (Read-SyncKey '')) 'True'

Write-Host 'Archive entries'
$zip = Join-Path $tmp 'ok.zip'
Compress-Archive -Path (Join-Path $good 'content.dump'), (Join-Path $good 'manifest.json'), (Join-Path $good 'signature.txt') -DestinationPath $zip
Check 'the three expected entries are accepted' (@(Get-PackageEntryProblems $zip).Count) '0'
$extra = Join-Path $tmp 'extra.zip'
Set-Content -Path (Join-Path $tmp 'evil.txt') -Value 'x'
Compress-Archive -Path (Join-Path $good 'content.dump'), (Join-Path $good 'manifest.json'), (Join-Path $tmp 'evil.txt') -DestinationPath $extra
Check 'an unexpected entry is a problem' (@(Get-PackageEntryProblems $extra).Count) '1'

Write-Host 'Restore list (pg_restore -l)'
# The lines are what pg_restore -l prints for a dump of the export_content schema, made with the PostgreSQL 18 client.
$clean = @(
    ';',
    '; Archive created at 2026-10-24 15:00:00 UTC',
    ';     dbname: blog',
    ';     TOC Entries: 6',
    ';     Compression: gzip',
    ';',
    '; Selected TOC Entries:',
    ';',
    '10; 2615 16500 SCHEMA - export_content blog',
    '220; 1259 16501 TABLE export_content posts blog',
    '221; 1259 16502 TABLE export_content site_content blog',
    '3400; 0 16501 TABLE DATA export_content posts blog',
    '3401; 0 16502 TABLE DATA export_content site_content blog'
)
Check 'the list of a normal package is accepted' (@(Get-DumpTocProblems $clean (Join-Path $here 'export-content.sql')).Count) '0'
$bad = @{
    'a function'                = '300; 1255 16510 FUNCTION public cs_evil() blog'
    'an extension'              = '301; 3079 16511 EXTENSION - dblink '
    'an event trigger'          = '302; 3466 16512 EVENT TRIGGER - on_ddl blog'
    'a table in another schema' = '303; 1259 16513 TABLE public users blog'
    'a table that is not content' = '304; 1259 16514 TABLE export_content users blog'
    'an ACL'                    = '305; 0 0 ACL export_content posts blog'
    'a default ACL'             = '306; 826 16515 DEFAULT ACL export_content DEFAULT PRIVILEGES FOR TABLES blog'
    'a comment'                 = '307; 0 0 COMMENT - SCHEMA export_content blog'
    'a constraint'              = '308; 2606 16516 CONSTRAINT export_content posts posts_pkey blog'
    'a second schema'           = '309; 2615 16517 SCHEMA - other blog'
    'a trigger'                 = '310; 2620 16518 TRIGGER export_content posts t blog'
    'a publication'             = '311; 6104 16519 PUBLICATION - everything blog'
}
foreach ($case in $bad.GetEnumerator() | Sort-Object Name) {
    $problems = @(Get-DumpTocProblems ($clean + $case.Value) (Join-Path $here 'export-content.sql'))
    Check "$($case.Key) is refused" $problems.Count '1'
}
Check 'a line that does not parse is refused too' (@(Get-DumpTocProblems ($clean + 'garbage line') (Join-Path $here 'export-content.sql')).Count) '1'
Check 'an empty list (no objects at all) is refused' (@(Get-DumpTocProblems @(';', '; nothing') (Join-Path $here 'export-content.sql')).Count) '1'

# ---- Invoke-DockerStream (the replacement of `docker cp`): bytes in and out of a command, with a stand-in program instead of docker.
$pwsh = (Get-Process -Id $PID).Path
$allBytes = [byte[]]::new(256 * 4096)
for ($i = 0; $i -lt $allBytes.Length; $i++) { $allBytes[$i] = $i % 256 }
$inFile = Join-Path $tmp 'stream-in.bin'
[IO.File]::WriteAllBytes($inFile, $allBytes)
$copy = '[Console]::OpenStandardInput().CopyTo([Console]::OpenStandardOutput())'
$outFile = Join-Path $tmp 'stream-out.bin'
$r = Invoke-DockerStream -Program $pwsh -DockerArgs @('-NoProfile', '-NonInteractive', '-Command', $copy) -InFile $inFile -OutFile $outFile
Check 'a stream through a command exits 0' $r.ExitCode '0'
Check 'every byte value (a binary dump) survives the stream unchanged' ((Get-FileHash $inFile -Algorithm SHA256).Hash -eq (Get-FileHash $outFile -Algorithm SHA256).Hash) 'True'
$r = Invoke-DockerStream -Program $pwsh -DockerArgs @('-NoProfile', '-NonInteractive', '-Command', 'Write-Output hello; [Console]::Error.WriteLine("oops"); exit 3')
Check 'the exit code of the command is returned' $r.ExitCode '3'
Check 'its output is returned as text without an -OutFile' $r.Stdout.Trim() 'hello'
Check 'its error output is returned' $r.Stderr.Trim() 'oops'
$r = Invoke-DockerStream -Program $pwsh -DockerArgs @('-NoProfile', '-NonInteractive', '-Command', 'exit 4') -InFile $inFile
Check 'a command that never reads its input (a refusal) does not hang or throw' $r.ExitCode '4'

# ---- The scripts never use `docker cp` or a file staged in the container (the postgres container is read-only).
foreach ($name in 'export-content.ps1', 'import-content.ps1', 'selftest.ps1') {
    $text = Get-Content (Join-Path $here $name) -Raw
    Check "$name has no docker cp" ($text -match '(?m)^[^#\r\n]*\bdocker(\.exe)?\s+cp\b|Invoke-Docker\s+cp\b') 'False'
    Check "$name stages nothing under /tmp of the container" ($text -match '/tmp/cs-') 'False'
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($failures -gt 0) { Write-Host "$failures check(s) FAILED"; exit 1 }
Write-Host 'All checks passed.'
