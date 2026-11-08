<#
.SYNOPSIS
  End-to-end check of export-content.ps1 and import-content.ps1 on two throw-away databases.

.DESCRIPTION
  Without -Container it starts its own throw-away PostgreSQL container with the settings of the compose file (read-only root file
  system, a tmpfs at /tmp, every capability dropped but the five the entrypoint needs, the three roles of deploy/postgres-init), builds
  the blog schema in it by applying the Flyway migrations as the owner role, and runs export and import as that owner role, which
  is how an operator of a compose install runs them (-User is DB_OWNER_USERNAME there). So a script that copies a file into the
  container, or that needs a right the owner role does not have (CREATE SCHEMA export_content is allowed to it, not to the runtime
  role), fails here. The container and its volume are removed at the end. Needs Docker and the images of the compose file.

  With -Container it uses a container that already exists instead (then -TemplateDb names a database that has the blog schema, and
  -User and -AdminUser the roles to use; AdminUser creates and drops the throw-away databases and defaults to User).

  Creates cs_src and cs_dst from the template database (no open connections), seeds both with the
  same baseline, changes the source (a new post with an image, an edited post, a gallery photo, site content) and the target (a
  post only there, a newer edit, a like and a contact message), then proves: a dry run changes nothing; the add-only import adds
  but never overwrites; -Update replaces only what is newer; reader data and target-only posts survive; a second run is a no-op.
  It also proves the trust checks on a real database: a package whose dump was replaced (with its checksum recomputed) is refused
  by the signature, a correctly signed package whose dump lists a function is refused by the `pg_restore -l` allow-list, also with
  -DryRun, and in both cases the target is left as it was; an unsigned package needs -AllowUnsigned.
  Both databases are dropped at the end. Run it before trusting a new version of the scripts or after a schema change.

.EXAMPLE
  .\selftest.ps1
  .\selftest.ps1 -Container blog-pg -User blog -TemplateDb blog_e2e
#>
[CmdletBinding()]
param(
    # An existing PostgreSQL container. Without it a hardened throw-away container is started and removed.
    [string]$Container = '',
    # The role that runs export and import: the owner role of a three-role install (DB_OWNER_USERNAME). Without -Container: cs_owner.
    [string]$User = '',
    # The role that creates and drops the throw-away databases. Defaults to -User (without -Container: cs_admin, a superuser).
    [string]$AdminUser = '',
    [string]$TemplateDb = 'blog_e2e'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("cs-selftest-" + (Get-Date).ToString('yyyyMMddHHmmss'))
New-Item -ItemType Directory -Path $tmp | Out-Null
. (Join-Path $here 'package-trust.ps1')
. (Join-Path $here 'docker-stream.ps1')
$repoRoot = (Resolve-Path (Join-Path $here '..\..')).Path
$startedContainer = ''
$ownContainer = ($Container -eq '')
if ($ownContainer) {
    if ($User -eq '') { $User = 'cs_owner' }
    if ($AdminUser -eq '') { $AdminUser = 'cs_admin' }
    $TemplateDb = 'cs_template'
} else {
    if ($User -eq '') { $User = 'blog' }
    if ($AdminUser -eq '') { $AdminUser = $User }
}
# A throw-away shared key for this run.
$keyFile = Join-Path $tmp 'sync.key'
Set-Content -Path $keyFile -Value ((1..48 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) -join '') -Encoding ascii -NoNewline
$failures = 0

# Runs as the administration role: it creates and drops the throw-away databases and seeds them. Export and import run as $User.
function Q([string]$Database, [string]$Sql) {
    $out = & docker exec $Container psql -U $AdminUser -d $Database -X -q -At -v ON_ERROR_STOP=1 -c $Sql
    if ($LASTEXITCODE -ne 0) { throw "SQL failed in ${Database}: $Sql" }
    return ($out | Out-String).Trim()
}
function Check([string]$What, $Actual, $Expected) {
    if ("$Actual" -eq "$Expected") { Write-Host "  PASS  $What" }
    else { Write-Host "  FAIL  $What (expected '$Expected', got '$Actual')" -ForegroundColor Red; $script:failures++ }
}

$P1 = '00000000-0000-4000-8000-000000000001'; $P2 = '00000000-0000-4000-8000-000000000002'
$P3 = '00000000-0000-4000-8000-000000000003'; $P4 = '00000000-0000-4000-8000-000000000004'
$P5 = '00000000-0000-4000-8000-000000000005'; $U1 = '00000000-0000-4000-8000-0000000000f1'
$C1 = '00000000-0000-4000-8000-0000000000c1'; $T1 = '00000000-0000-4000-8000-0000000000a1'; $T2 = '00000000-0000-4000-8000-0000000000a2'
$S1 = '00000000-0000-4000-8000-0000000000e1'; $M2 = '00000000-0000-4000-8000-0000000000b2'; $M3 = '00000000-0000-4000-8000-0000000000b3'; $G1 = '00000000-0000-4000-8000-0000000000d1'
$admin = "(SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1)"

function New-Password { -join ((1..40) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) }

# The throw-away container: the postgres service of docker-compose.yml, with its three roles, and a template database made by the
# migrations (the way Flyway applies them, as the owner role).
function Start-HardenedPostgres {
    $name = 'cs-selftest-pg-' + (Get-Date).ToString('yyyyMMddHHmmss')
    $envFile = Join-Path $tmp 'pg.env'
    $lines = @(
        'POSTGRES_DB=blog', "POSTGRES_USER=$AdminUser", "POSTGRES_PASSWORD=$(New-Password)",
        'APP_DB_USER=cs_app', "APP_DB_PASSWORD=$(New-Password)", "OWNER_DB_USER=$User", "OWNER_DB_PASSWORD=$(New-Password)")
    Set-Content -Path $envFile -Value $lines -Encoding ascii
    $image = (Select-String -Path (Join-Path $repoRoot 'docker-compose.yml') -Pattern '^\s+image:\s*(postgres:\S+)').Matches[0].Groups[1].Value
    $initDir = Join-Path $repoRoot 'deploy/postgres-init'
    & docker run -d --name $name --read-only --tmpfs /tmp:size=64m --tmpfs /run/postgresql:mode=1777,size=1m `
        --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER --cap-add DAC_OVERRIDE `
        --security-opt no-new-privileges:true -v /var/lib/postgresql -v "${initDir}:/docker-entrypoint-initdb.d:ro" `
        --env-file $envFile $image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the throw-away postgres container.' }
    $script:startedContainer = $name
    $script:Container = $name
    # The image starts a temporary server (sockets only) while it runs the init scripts: only the final one answers on TCP.
    for ($i = 0; $i -lt 90; $i++) {
        & docker exec $name pg_isready -h 127.0.0.1 -U $AdminUser -d blog 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    throw "The throw-away postgres container did not become ready: $(& docker logs $name 2>&1 | Select-Object -Last 5)"
}
function Build-TemplateFromMigrations {
    Q 'postgres' "CREATE DATABASE $TemplateDb OWNER $User" | Out-Null
    $migrations = Get-ChildItem (Join-Path $repoRoot 'backend/src/main/resources/db/migration') -Filter 'V*__*.sql' |
        Sort-Object { [int]($_.Name -replace '^V(\d+)__.*$', '$1') }
    $sql = Join-Path $tmp 'migration.sql'
    foreach ($file in $migrations) {
        # The one placeholder of the migrations (application.yml: flyway.placeholders.defaultLocale).
        (Get-Content $file.FullName -Raw).Replace('${defaultLocale}', 'en') | Set-Content -Path $sql -Encoding utf8 -NoNewline
        $r = Invoke-DockerStream -DockerArgs @('exec', '-i', $Container, 'psql', '-U', $User, '-d', $TemplateDb, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-') -InFile $sql
        if ($r.ExitCode -ne 0) { throw "Migration $($file.Name) failed as the owner role: $($r.Stderr)" }
    }
    # The scripts read only the highest successful version of Flyway's table.
    $latest = [int]($migrations[-1].Name -replace '^V(\d+)__.*$', '$1')
    Q $TemplateDb "CREATE TABLE flyway_schema_history (version varchar(50), success boolean NOT NULL); INSERT INTO flyway_schema_history VALUES ('$latest', true)" | Out-Null
    # Like Flyway's own table, it belongs to the owner role (the runtime role may read and write it, nothing else).
    Q $TemplateDb "ALTER TABLE flyway_schema_history OWNER TO $User" | Out-Null
}

try {
    if ($ownContainer) {
        Write-Host 'Starting a throw-away postgres container (read-only root, tmpfs /tmp, the three roles)'
        Start-HardenedPostgres
        $state = (& docker inspect $Container --format '{{.HostConfig.ReadonlyRootfs}}').Trim()
        Check 'the target container has a read-only root file system' $state 'true'
        Check 'the export and import role is not a superuser' (Q 'postgres' "SELECT rolsuper FROM pg_roles WHERE rolname = '$User'") 'f'
        Build-TemplateFromMigrations
    }
    foreach ($db in 'cs_src', 'cs_dst') { Q 'postgres' "DROP DATABASE IF EXISTS $db WITH (FORCE)" | Out-Null }
    Q 'postgres' "CREATE DATABASE cs_src TEMPLATE $TemplateDb OWNER $User" | Out-Null

    # Baseline shared by both sides: one category, one tag, two published posts.
    Q 'cs_src' @"
INSERT INTO categories (id, name, slug) VALUES ('$C1', 'Cat A', 'cat-a');
INSERT INTO tags (id, name, slug) VALUES ('$T1', 'tag-a', 'tag-a');
INSERT INTO posts (id, title, slug, content, status, author_id, category_id, published_at, created_at, updated_at) VALUES
 ('$P1', 'Post one', 'post-one', 'body one', 'PUBLISHED', $admin, '$C1', '2026-01-01', '2026-01-01', '2026-01-01'),
 ('$P4', 'Post four', 'post-four', 'body four', 'PUBLISHED', $admin, '$C1', '2026-01-01', '2026-01-01', '2026-01-01');
INSERT INTO post_tags (post_id, tag_id) VALUES ('$P1', '$T1'), ('$P4', '$T1');
DELETE FROM site_content WHERE key = 'now' AND locale = 'en';
"@ | Out-Null
    # Post one is featured and belongs to a series (position 1, part 1), post four is its second part: a post in a series cannot
    # have its position cleared on its own (chk_posts_series_membership), the case that once made a real merge fail.
    Q 'cs_src' @"
INSERT INTO series (id, title, slug) VALUES ('$S1', 'Series A', 'series-a');
UPDATE posts SET series_id = '$S1', series_position = 1, featured = true, featured_rank = 99 WHERE id = '$P1';
UPDATE posts SET series_id = '$S1', series_position = 2 WHERE id = '$P4';
DO `$`$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'series_part') THEN
    UPDATE posts SET series_part = series_position WHERE id IN ('$P1', '$P4');
  END IF;
END `$`$;
"@ | Out-Null
    Q 'postgres' "CREATE DATABASE cs_dst TEMPLATE cs_src OWNER $User" | Out-Null

    $aboutVi = [int](Q 'cs_src' "SELECT count(*) FROM site_content WHERE key = 'about' AND locale = 'vi'")

    # Source changes: an edited post, a newer edit of post four, a new tagged post with a cover image, a gallery photo, site content.
    Q 'cs_src' @"
UPDATE posts SET title = 'Post one EDITED', updated_at = '2026-06-01' WHERE id = '$P1';
UPDATE posts SET title = 'Post four SRC', updated_at = '2026-03-01' WHERE id = '$P4';
INSERT INTO tags (id, name, slug) VALUES ('$T2', 'tag-b', 'tag-b');
INSERT INTO media (id, content_type, width, height, byte_size, sha256) VALUES
 ('$M2', 'image/png', 1, 1, 4, repeat('a', 64)), ('$M3', 'image/png', 1, 1, 4, repeat('b', 64));
INSERT INTO media_content (media_id, data) VALUES ('$M2', '\x89504e47'), ('$M3', '\x89504e47');
INSERT INTO posts (id, title, slug, content, status, author_id, category_id, cover_media_id, published_at, created_at, updated_at)
 VALUES ('$P2', 'Post two', 'post-two', 'body two', 'PUBLISHED', $admin, '$C1', '$M2', '2026-07-01', '2026-07-01', '2026-07-01');
INSERT INTO post_tags (post_id, tag_id) VALUES ('$P2', '$T2');
INSERT INTO gallery_photos (id, media_id, caption, sort_order) VALUES ('$G1', '$M3', 'a photo', 1);
INSERT INTO site_content (key, locale, schema_version, data, updated_at) VALUES ('now', 'en', 1, '{"from":"source"}', '2026-07-01');
UPDATE site_content SET data = '{"from":"source"}', updated_at = '2099-01-01' WHERE key = 'about' AND locale = 'vi';
"@ | Out-Null

    # A post that its AUTHOR deleted (schema V49: hidden as ARCHIVED, deleted_at and deleted_by set) by an author that only the source has.
    # posts.deleted_by is a foreign key to users: the merge has to treat it like author_id, or the whole transaction fails on it.
    $hasHidden = (Q 'cs_src' "SELECT count(*) FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'deleted_by'") -eq '1'
    if ($hasHidden) {
        Q 'cs_src' @"
INSERT INTO users (id, email, password_hash, display_name, role, public_slug) VALUES ('$U1', 'source-only-author@example.test', 'x', 'Source only', 'AUTHOR', 'source-only');
INSERT INTO posts (id, title, slug, content, status, author_id, category_id, created_at, updated_at, deleted_at, deleted_by)
 VALUES ('$P5', 'Post five hidden', 'post-five-hidden', 'body five', 'ARCHIVED', '$U1', '$C1', '2026-07-02', '2026-07-02', '2026-07-03', '$U1');
"@ | Out-Null
    }

    # Target changes: a post only there, a NEWER edit of post four, and reader data that must survive.
    Q 'cs_dst' @"
UPDATE posts SET title = 'Post four DST', updated_at = '2026-09-01' WHERE id = '$P4';
INSERT INTO posts (id, title, slug, content, status, author_id, category_id, published_at, created_at, updated_at)
 VALUES ('$P3', 'Post three', 'post-three', 'body three', 'PUBLISHED', $admin, '$C1', '2026-08-01', '2026-08-01', '2026-08-01');
INSERT INTO post_likes (post_id, user_id) VALUES ('$P1', $admin);
"@ | Out-Null
    # The contact inbox exists from schema V42; an older template database simply skips that part of the check.
    $hasContact = (Q 'cs_dst' "SELECT to_regclass('contact_messages') IS NOT NULL") -eq 't'
    if ($hasContact) {
        Q 'cs_dst' "INSERT INTO contact_messages (id, name, email, message) VALUES ('$G1', 'Visitor', 'visitor@example.com', 'hello from a visitor')" | Out-Null
    }

    $dstPosts = [int](Q 'cs_dst' 'SELECT count(*) FROM posts')
    $dstGallery = [int](Q 'cs_dst' 'SELECT count(*) FROM gallery_photos')
    $dstLikes = [int](Q 'cs_dst' 'SELECT count(*) FROM post_likes')
    $dstContact = if ($hasContact) { [int](Q 'cs_dst' 'SELECT count(*) FROM contact_messages') } else { 0 }

    Write-Host 'Export from cs_src'
    $zip = Join-Path $tmp 'content.zip'
    & (Join-Path $here 'export-content.ps1') -Container $Container -Database cs_src -User $User -Out $zip -KeyFile $keyFile | Out-Null
    Check 'the package exists' (Test-Path $zip) 'True'

    Write-Host 'Dry run with -Update'
    & (Join-Path $here 'import-content.ps1') -Package $zip -Container $Container -Database cs_dst -User $User -Update -DryRun -KeyFile $keyFile | Out-Null
    Check 'a dry run adds no post' (Q 'cs_dst' 'SELECT count(*) FROM posts') $dstPosts
    Check 'a dry run leaves no staging schema' (Q 'cs_dst' "SELECT count(*) FROM pg_namespace WHERE nspname = 'export_content'") '0'

    Write-Host 'Add-only import'
    & (Join-Path $here 'import-content.ps1') -Package $zip -Container $Container -Database cs_dst -User $User -Yes -KeyFile $keyFile -BackupDir (Join-Path $tmp 'bk') | Out-Null
    Check 'new post added' (Q 'cs_dst' "SELECT count(*) FROM posts WHERE id = '$P2'") '1'
    if ($hasHidden) {
        Check 'a post its author deleted arrives hidden' (Q 'cs_dst' "SELECT status || '/' || (deleted_at IS NOT NULL) FROM posts WHERE id = '$P5'") 'ARCHIVED/true'
        Check 'its deleted_by, an author the target does not have, is empty and its author is the first ADMIN' (Q 'cs_dst' "SELECT (deleted_by IS NULL) || '/' || (author_id = $admin) FROM posts WHERE id = '$P5'") 'true/true'
    }
    Check 'edited post NOT overwritten without -Update' (Q 'cs_dst' "SELECT title FROM posts WHERE id = '$P1'") 'Post one'
    Check 'newer target edit kept' (Q 'cs_dst' "SELECT title FROM posts WHERE id = '$P4'") 'Post four DST'
    Check 'target-only post kept' (Q 'cs_dst' "SELECT count(*) FROM posts WHERE id = '$P3'") '1'
    Check 'new tag list of the new post' (Q 'cs_dst' "SELECT string_agg(t.slug, ',') FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = '$P2'") 'tag-b'
    Check 'cover image linked' (Q 'cs_dst' "SELECT cover_media_id FROM posts WHERE id = '$P2'") $M2
    Check 'image bytes arrived' (Q 'cs_dst' "SELECT length(data) FROM media_content WHERE media_id = '$M2'") '4'
    Check 'gallery photo arrived' (Q 'cs_dst' 'SELECT count(*) FROM gallery_photos') ($dstGallery + 1)
    Check 'new site content row arrived' (Q 'cs_dst' "SELECT data->>'from' FROM site_content WHERE key = 'now' AND locale = 'en'") 'source'
    Check 'existing site content NOT overwritten without -Update' (Q 'cs_dst' "SELECT count(*) FROM site_content WHERE data->>'from' = 'source'") '1'
    Check 'likes survived' (Q 'cs_dst' 'SELECT count(*) FROM post_likes') $dstLikes
    if ($hasContact) { Check 'contact messages survived' (Q 'cs_dst' 'SELECT count(*) FROM contact_messages') $dstContact }
    Check 'a backup was written' ((Get-ChildItem (Join-Path $tmp 'bk') -Filter *.dump | Measure-Object).Count) '1'

    Write-Host 'Import with -Update'
    & (Join-Path $here 'import-content.ps1') -Package $zip -Container $Container -Database cs_dst -User $User -Update -Yes -KeyFile $keyFile -BackupDir (Join-Path $tmp 'bk') | Out-Null
    Check 'newer site content applied with -Update' (Q 'cs_dst' "SELECT count(*) FROM site_content WHERE data->>'from' = 'source'") (1 + $aboutVi)
    Check 'newer source edit applied' (Q 'cs_dst' "SELECT title FROM posts WHERE id = '$P1'") 'Post one EDITED'
    Check 'a post in a series keeps its series, position and rank after the update' (Q 'cs_dst' "SELECT series_id || '/' || series_position || '/' || featured_rank FROM posts WHERE id = '$P1'") "$S1/1/99"
    Check 'newer target edit still kept' (Q 'cs_dst' "SELECT title FROM posts WHERE id = '$P4'") 'Post four DST'
    Check 'target-only post still kept' (Q 'cs_dst' "SELECT count(*) FROM posts WHERE id = '$P3'") '1'
    Check 'likes still there' (Q 'cs_dst' 'SELECT count(*) FROM post_likes') $dstLikes
    Check 'posts total: the target ones plus the new posts' (Q 'cs_dst' 'SELECT count(*) FROM posts') ($dstPosts + 1 + [int]$hasHidden)

    Write-Host 'Second run changes nothing'
    $before = Q 'cs_dst' "SELECT md5(string_agg(id::text || title || updated_at::text, ',' ORDER BY id)) FROM posts"
    & (Join-Path $here 'import-content.ps1') -Package $zip -Container $Container -Database cs_dst -User $User -Update -Yes -KeyFile $keyFile -BackupDir (Join-Path $tmp 'bk') | Out-Null
    Check 'posts unchanged by the second run' (Q 'cs_dst' "SELECT md5(string_agg(id::text || title || updated_at::text, ',' ORDER BY id)) FROM posts") $before

    # ---- Trust: nothing that fails a check may reach pg_restore or change the target.
    function Get-TargetState {
        Q 'cs_dst' "SELECT (SELECT count(*) FROM posts) || '/' || (SELECT count(*) FROM site_content) || '/' || (SELECT count(*) FROM media) || '/' || (SELECT count(*) FROM pg_namespace WHERE nspname = 'export_content') || '/' || (SELECT count(*) FROM pg_proc WHERE proname = 'cs_evil')"
    }
    function Get-ImportError([scriptblock]$Run) {
        try { & $Run | Out-Null; return '' } catch { return $_.Exception.Message }
    }
    $stateBefore = Get-TargetState
    $zipDir = Join-Path $tmp 'unzipped'
    Expand-Archive -Path $zip -DestinationPath $zipDir -Force

    Write-Host 'A package whose dump was replaced and whose checksum was recomputed'
    # The attack of issue 060: the dumpSha256 of the manifest is only a checksum, so the forger recomputes it. Nothing is signed again.
    $forgedDir = Join-Path $tmp 'forged'
    Copy-Item $zipDir $forgedDir -Recurse
    Q 'postgres' 'DROP DATABASE IF EXISTS cs_evil WITH (FORCE)' | Out-Null
    Q 'postgres' 'CREATE DATABASE cs_evil TEMPLATE template0' | Out-Null
    Q 'cs_evil' @"
CREATE SCHEMA export_content;
CREATE TABLE export_content.posts AS SELECT 1 AS id;
CREATE FUNCTION public.cs_evil() RETURNS int LANGUAGE sql AS 'SELECT 1';
"@ | Out-Null
    $evilDump = Invoke-DockerStream -DockerArgs @('exec', $Container, 'pg_dump', '-U', $AdminUser, '-d', 'cs_evil', '-Fc', '--no-owner') -OutFile (Join-Path $forgedDir 'content.dump')
    if ($evilDump.ExitCode -ne 0) { throw "pg_dump of the throw-away evil database failed: $($evilDump.Stderr)" }
    $manifest = Get-Content (Join-Path $forgedDir 'manifest.json') -Raw | ConvertFrom-Json
    $manifest.dumpSha256 = (Get-FileHash (Join-Path $forgedDir 'content.dump') -Algorithm SHA256).Hash
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $forgedDir 'manifest.json') -Encoding utf8
    $forgedZip = Join-Path $tmp 'forged.zip'
    Compress-Archive -Path (Join-Path $forgedDir '*') -DestinationPath $forgedZip
    # The container name does not exist: if the refusal came after a docker command, the message would be about docker.
    $message = Get-ImportError { & (Join-Path $here 'import-content.ps1') -Package $forgedZip -Container 'no-such-container' -Database cs_dst -User $User -KeyFile $keyFile -Yes }
    Check 'the forged package is refused by its signature, before any docker command' ($message -like '*signature*does not match*') 'True'
    $message = Get-ImportError { & (Join-Path $here 'import-content.ps1') -Package $forgedZip -Container $Container -Database cs_dst -User $User -KeyFile $keyFile -DryRun }
    Check 'the forged package is refused also with -DryRun' ($message -like '*signature*does not match*') 'True'
    Check 'the target is unchanged by the refused packages' (Get-TargetState) $stateBefore

    Write-Host 'A correctly signed package whose dump lists a function'
    # Signed with the right key, so the signature passes: the allow-list of `pg_restore -l` is the check that stops it.
    $evilDir = Join-Path $tmp 'evil'
    Copy-Item $forgedDir $evilDir -Recurse
    Set-Content -Path (Join-Path $evilDir 'signature.txt') -Value (Get-PackageSignature (Read-SyncKey $keyFile) (Join-Path $evilDir 'manifest.json') (Join-Path $evilDir 'content.dump')) -Encoding ascii -NoNewline
    $evilZip = Join-Path $tmp 'evil.zip'
    Compress-Archive -Path (Join-Path $evilDir '*') -DestinationPath $evilZip
    $message = Get-ImportError { & (Join-Path $here 'import-content.ps1') -Package $evilZip -Container $Container -Database cs_dst -User $User -KeyFile $keyFile -DryRun }
    Check 'the dump with a function is refused by the restore list under -DryRun' ($message -like '*never holds*FUNCTION*') 'True'
    $message = Get-ImportError { & (Join-Path $here 'import-content.ps1') -Package $evilZip -Container $Container -Database cs_dst -User $User -KeyFile $keyFile -Yes -BackupDir (Join-Path $tmp 'bk') }
    Check 'the dump with a function is refused by the restore list on a real import' ($message -like '*never holds*FUNCTION*') 'True'
    Check 'the target is still unchanged (no staging schema, no function)' (Get-TargetState) $stateBefore
    Check 'no backup was taken for a refused package' ((Get-ChildItem (Join-Path $tmp 'bk') -Filter *.dump | Measure-Object).Count) '3'

    Write-Host 'Keys and unsigned packages'
    $otherKey = Join-Path $tmp 'other.key'
    Set-Content -Path $otherKey -Value ('z' * 48) -Encoding ascii -NoNewline
    $message = Get-ImportError { & (Join-Path $here 'import-content.ps1') -Package $zip -Container $Container -Database cs_dst -User $User -KeyFile $otherKey -DryRun }
    Check 'another key does not open a signed package' ($message -like '*signature*does not match*') 'True'
    $unsignedZip = Join-Path $tmp 'unsigned.zip'
    & (Join-Path $here 'export-content.ps1') -Container $Container -Database cs_src -User $User -Out $unsignedZip -Unsigned | Out-Null
    $message = Get-ImportError { & (Join-Path $here 'import-content.ps1') -Package $unsignedZip -Container $Container -Database cs_dst -User $User -KeyFile $keyFile -DryRun }
    Check 'an unsigned package is refused even with a key' ($message -like '*no signature*') 'True'
    $message = Get-ImportError { & (Join-Path $here 'import-content.ps1') -Package $zip -Container $Container -Database cs_dst -User $User -DryRun }
    Check 'no key and no -AllowUnsigned: refused' ($message -like '*No shared key*') 'True'
    $message = Get-ImportError { & (Join-Path $here 'import-content.ps1') -Package $unsignedZip -Container $Container -Database cs_dst -User $User -AllowUnsigned -DryRun }
    Check 'an unsigned package is accepted with -AllowUnsigned (dry run)' $message ''
    Check 'the target is unchanged after these too' (Get-TargetState) $stateBefore
} finally {
    if ($Container -ne '') {
        foreach ($db in 'cs_src', 'cs_dst', 'cs_evil') { & docker exec $Container psql -U $AdminUser -d postgres -X -q -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" 2>$null | Out-Null }
    }
    # Only a container this run started is ever removed, with its anonymous data volume.
    if ($startedContainer -ne '') { & docker rm -f -v $startedContainer 2>$null | Out-Null }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures -gt 0) { Write-Host "$failures check(s) FAILED" -ForegroundColor Red; exit 1 }
Write-Host 'All checks passed.'
