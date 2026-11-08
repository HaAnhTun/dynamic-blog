# Content sync: move posts, images, About and the rest of the site's content between two installs

Two PowerShell scripts that copy the **content** of one blog database into another, without touching what readers did there.
Use them when you write on one machine (for example your laptop) and publish on another, and the published site already has
comments, likes, accounts and subscribers that a full database restore would erase.

| Moves                                                                                                                                                                                                                                  | Never moves                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| posts (with their tags, series, category, cover and old addresses), images, categories, tags, series, gallery photos, site content (profile, About, contact, case studies... in every language), optionally the revisions of the posts | users, comments, comment likes, likes, bookmarks, post views, newsletter subscribers and issues, notifications, contact messages, sessions, import logs, the first-run flag |

Scripts: `export-content.ps1` (source), `import-content.ps1` (target), `merge-content.sql` (the merge itself),
`export-content.sql` (the staging copy), `package-trust.ps1` (signature and restore-list checks), `docker-stream.ps1` (files travel on
stdin and stdout, see below), `selftest.ps1` (proof on a throw-away hardened container), `unittest.ps1` (the trust checks without a
database). They need Docker, PowerShell 7 and the
PostgreSQL container of each side. They are written for a Windows laptop; on Linux install PowerShell 7 (`pwsh`).

## The shared key (once)

`pg_restore` runs the SQL that is inside a dump, as the database user of the target (a superuser in the stock compose file). A ZIP
that was changed on the way would therefore run its own SQL on your live database, and the checksum inside the package cannot tell:
whoever changes the dump changes the checksum with it. So the package is **signed** with a secret that only you hold, and the import
refuses a package whose signature it cannot verify.

```bash
openssl rand -hex 32 > content-sync.key        # once; copy the file to both machines by a channel you trust, keep it private
```

Put the key in a file (`-KeyFile .\content-sync.key`) or in the variable `CONTENT_SYNC_KEY` (at least 32 characters). Never type the
key on a command line: other users of the machine can read it in the process list. Treat it like `.env`.

## Use

On the machine with the content:

```powershell
.\scripts\content-sync\export-content.ps1 -Container <source postgres container> -Database blog -User <DB_OWNER_USERNAME, or DB_USERNAME without the three roles> -KeyFile .\content-sync.key
```

It writes `content-export-<time>.zip` (`content.dump`, `manifest.json`, `signature.txt`) and lists the rows per table. Add `-OnlyPublished` to leave
drafts behind and `-WithRevisions` to include the saved revisions. Copy the ZIP to the other machine (it holds your posts and
images, so use a channel you trust).

On the machine that serves the site:

```powershell
# 1. Look first: runs the whole merge, prints the report, rolls everything back.
.\scripts\content-sync\import-content.ps1 -Package content-export-....zip -Container <target postgres container> -Database blog -User <the same role> -KeyFile .\content-sync.key -Update -DryRun
# 2. Apply. Writes a backup of the target database first.
.\scripts\content-sync\import-content.ps1 -Package content-export-....zip -Container <target postgres container> -Database blog -User <the same role> -KeyFile .\content-sync.key -Update
# 3. Show the new content (the frontend caches pages).
docker compose up -d --force-recreate frontend
```

The container name of a compose install is `docker compose ps -q postgres`; the database is the `DB_NAME` of its `.env`.

**Which `-User`.** On an install with the three database roles (`DB_OWNER_USERNAME` in `.env`) give `-User` the **owner** role,
`DB_OWNER_USERNAME`: it owns the database and the tables, which is what `CREATE SCHEMA export_content` (the staging copy) and the
restore need, and it is not a superuser, so what a hostile dump can do is narrower than with the administration role. Not the runtime
role `DB_USERNAME`: it can only read and write rows and the export and the import fail with `permission denied for database`. On a
single-role install (no `DB_OWNER_USERNAME`) it is `DB_USERNAME`, the one role it has. The password is not needed: the scripts run
`psql` and `pg_dump` inside the container, over its local socket.

**Nothing is copied into the container.** The postgres container of the compose file has a read-only root file system, so `docker cp`
does not work on it. The scripts send a file on the standard input of the command that reads it (`psql -f -`, `pg_restore`,
`pg_restore -l`) and take the dump from the standard output of `pg_dump -Fc`, as bytes (`docker-stream.ps1`), so the container stages
nothing, not even in its `/tmp`. A package of an earlier version of the tool is unchanged: it is the same ZIP. Without `-Update` only **new** rows are added and nothing existing is replaced (the safest first run).

## The rules the merge follows

1. **Nothing is deleted.** A post that exists only on the target stays. A tag, image or gallery photo removed on the source stays on
   the target. The one exception is the tag list of a post that the merge itself updates: it becomes the source's list.
2. **Newer wins, only with `-Update`.** A row that exists on both sides is replaced only when the package's `updated_at` is later.
   A post you edited on the target after the export keeps your target edit. Tags and images are insert-only (an image never changes).
3. **One transaction.** A conflict (a slug already used by a different post, a featured rank or series position in use, a translation
   of the same language already there) rolls the whole merge back and names the constraint. Nothing is half-applied.
4. **People are not copied.** An author or uploader that is not a user of the target becomes the target's first ADMIN
   (or stays empty where the column allows it: the person who deleted a hidden post, `deleted_by`, included). Create the author on the target first if the post should belong to them.
5. **Same or newer schema.** The target must be at the package's Flyway version or newer, never older. A package made at V41 applies
   to a V42 target; the other way round is refused with a message.
6. **Search.** The PostgreSQL search vector is rebuilt by the database. With Meilisearch enabled, run a reindex afterwards.

## What the import checks before it restores anything

All of this runs before `pg_restore`, also with `-DryRun`, and a failure changes nothing on the target:

1. **The ZIP holds only `content.dump`, `manifest.json` and `signature.txt`.**
2. **The signature matches** (HMAC-SHA256 over the manifest and the dump, under your key). A wrong signature is always refused. A package
   with no signature, or an import with no key, is refused unless you pass `-AllowUnsigned`, which says that you accept the package as
   it is (for example a package from your own disk that you have just made with `-Unsigned`). The checksum in `manifest.json` is for
   damage only.
3. **`pg_restore -l` lists only the schema `export_content` and its content tables** (the tables `export-content.sql` stages). A function,
   an extension, an event trigger, an ACL, a comment or a table anywhere else stops the import. Then the dump is restored with
   `--no-owner --no-privileges`.

What this does not give you: the key is the trust. Anyone who has it can make a package that passes all three checks, because the list
checks object names and not the SQL text of a table definition. Never import a package from a source you do not control
([SECURITY.md](../../docs/SECURITY.md#what-is-not-protected)).

## When this is not the right tool

- Going live the first time, with no readers yet: restore a full dump instead ([BACKUP-AND-RESTORE.md](../../docs/BACKUP-AND-RESTORE.md)).
- Moving one article or a few: the post ZIP package in the admin (`Admin > Posts > Import posts`) is simpler.
- Two-way sync: there is none. Pick one machine as the place where readers' data lives (the live site), and move content to it.

## Prove it

`selftest.ps1` starts a throw-away PostgreSQL container with the settings of the compose file (read-only root file system, tmpfs
`/tmp`, capabilities dropped, the three roles of `deploy/postgres-init`), builds the blog schema in it from the Flyway migrations of
this checkout, builds two throw-away databases from it, changes both sides, runs export and import **as the owner role** in every mode
and checks: a dry run changes nothing; add-only adds but does not
overwrite; `-Update` replaces only newer rows; target-only posts, likes and contact messages survive; a second run is a no-op; a package
whose dump was replaced (with its checksum recomputed) is refused by the signature; a correctly signed package whose dump lists a
function is refused by the restore list, also with `-DryRun`, and the target is left as it was.

```powershell
.\scripts\content-sync\selftest.ps1
```

It needs Docker and the `postgres` image of the compose file, takes about half a minute, and removes its container and volume. With
`-Container <postgres container> -User <role> -TemplateDb <a database with the blog schema>` it uses a container you already have
instead (`-AdminUser` is the role that creates and drops the throw-away databases; it defaults to `-User`).

Run it after changing a script or the schema (a new content table needs a line in `export-content.sql` and `merge-content.sql`).

`unittest.ps1` runs the trust checks (signature, ZIP entries, restore list) on made-up packages, and the byte stream of
`docker-stream.ps1` (every byte value through a command), with no database; it needs only PowerShell 7 and runs in CI through
`python scripts/test_content_sync.py`.
