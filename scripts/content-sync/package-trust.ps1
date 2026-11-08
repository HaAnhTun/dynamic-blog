# Trust checks for a content package (dot-sourced by export-content.ps1, import-content.ps1 and unittest.ps1).
#
# A package is a ZIP with content.dump (a pg_dump of a throw-away schema), manifest.json and, when it is signed, signature.txt.
# pg_restore runs the SQL of a dump as the database user of the target, so an unauthenticated package is a way to run SQL there.
# The dumpSha256 of the manifest only detects damage: whoever changes the dump changes the manifest with it. What authenticates a
# package is the HMAC-SHA256 below, made with a shared secret that is never inside the package (a file or CONTENT_SYNC_KEY).
# Defence in depth on top of it: the ZIP may hold only the three files, and `pg_restore -l` of the dump may list only the schema
# export_content and its content tables. docs/SECURITY.md ("What is not protected") states the trust model.

$script:SignatureLabel = 'blog-content-sync/1 signature'
$script:PackageFiles = @('content.dump', 'manifest.json', 'signature.txt')

function Read-SyncKey {
    # The shared secret as bytes: from a key file when one is given, else from CONTENT_SYNC_KEY, else $null.
    # Never a command-line value: another local user could read it in the process list.
    param([string]$KeyFile)
    $text = $null
    if ($KeyFile) {
        if (-not (Test-Path -LiteralPath $KeyFile)) { throw "Key file not found: $KeyFile" }
        $text = (Get-Content -LiteralPath $KeyFile -Raw)
    } elseif ($env:CONTENT_SYNC_KEY) {
        $text = $env:CONTENT_SYNC_KEY
    }
    if ($null -eq $text) { return $null }
    $text = $text.Trim()
    if ($text.Length -lt 32) { throw 'The shared key must have at least 32 characters (for example: openssl rand -hex 32).' }
    return , [Text.Encoding]::UTF8.GetBytes($text)
}

function Get-FileSha256Bytes([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { return , $sha.ComputeHash($stream) } finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Get-PackageSignature {
    # Lower-case hex HMAC-SHA256 over a label, the SHA-256 of manifest.json and the SHA-256 of content.dump.
    param([byte[]]$Key, [string]$ManifestPath, [string]$DumpPath)
    $label = [Text.Encoding]::UTF8.GetBytes($script:SignatureLabel)
    $message = New-Object byte[] ($label.Length + 1 + 64)
    [Array]::Copy($label, 0, $message, 0, $label.Length)
    [Array]::Copy((Get-FileSha256Bytes $ManifestPath), 0, $message, $label.Length + 1, 32)
    [Array]::Copy((Get-FileSha256Bytes $DumpPath), 0, $message, $label.Length + 33, 32)
    $hmac = New-Object Security.Cryptography.HMACSHA256 -ArgumentList (, $Key)
    try { return -join ($hmac.ComputeHash($message) | ForEach-Object { $_.ToString('x2') }) } finally { $hmac.Dispose() }
}

function Test-PackageSignature {
    # $true only when signature.txt in the folder is the HMAC of its manifest.json and content.dump under the key. Never throws.
    param([byte[]]$Key, [string]$Directory)
    try {
        $signaturePath = Join-Path $Directory 'signature.txt'
        if (-not (Test-Path -LiteralPath $signaturePath)) { return $false }
        $given = (Get-Content -LiteralPath $signaturePath -Raw).Trim().ToLowerInvariant()
        if ($given -notmatch '^[0-9a-f]{64}$') { return $false }
        $expected = Get-PackageSignature $Key (Join-Path $Directory 'manifest.json') (Join-Path $Directory 'content.dump')
        return [Security.Cryptography.CryptographicOperations]::FixedTimeEquals(
            [Text.Encoding]::ASCII.GetBytes($given), [Text.Encoding]::ASCII.GetBytes($expected))
    } catch {
        return $false
    }
}

function Get-PackageEntryProblems {
    # The entries of the ZIP that are not one of the three files of a package (a path, another name, a directory).
    param([string]$ZipPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $problems = @()
        foreach ($entry in $zip.Entries) {
            if ($script:PackageFiles -cnotcontains $entry.FullName) { $problems += "unexpected entry '$($entry.FullName)'" }
        }
        return $problems
    } finally { $zip.Dispose() }
}

function Get-ContentTableNames {
    # The tables export-content.sql stages: the one list of what a package may hold.
    param([string]$ExportSqlPath)
    $sql = Get-Content -LiteralPath $ExportSqlPath -Raw
    return @([regex]::Matches($sql, "cs_copy\('([a-z_]+)'") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
}

function Get-DumpTocProblems {
    # The lines of `pg_restore -l content.dump` that are not the schema export_content or one of its content tables (the table
    # definition and its data). A function, an extension, an event trigger, an ACL, a comment, a table elsewhere: all refused.
    param([string[]]$Lines, [string]$ExportSqlPath)
    $names = (Get-ContentTableNames $ExportSqlPath) -join '|'
    if (-not $names) { throw "No content tables found in $ExportSqlPath." }
    $problems = @()
    $objects = 0
    foreach ($line in $Lines) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith(';')) { continue }
        $objects++
        if ($line -notmatch '^\d+; \d+ \d+ (?<rest>.+)$') { $problems += 'a line of the restore list that does not parse'; continue }
        $rest = $Matches['rest']
        if ($rest -match '^SCHEMA - export_content(?: \S.*)?$') { continue }
        if ($rest -match "^TABLE export_content ($names)(?: \S.*)?$") { continue }
        if ($rest -match "^TABLE DATA export_content ($names)(?: \S.*)?$") { continue }
        $kind = ($rest -split ' ' | Select-Object -First 2) -join ' '
        $problems += "not allowed in a content package: $kind"
    }
    if ($objects -eq 0) { $problems += 'the dump lists no objects' }
    return $problems
}
