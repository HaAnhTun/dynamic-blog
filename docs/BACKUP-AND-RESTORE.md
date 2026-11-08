# Backup and restore

Everything the site owns lives in one PostgreSQL database, **uploaded images included**. One `pg_dump` is a full backup of the
content. This page shows how to take one, schedule it, restore it, and prove that it works before you need it.

## Contents

- [What to back up](#what-to-back-up)
- [Take a backup](#take-a-backup)
- [Back up every day](#back-up-every-day)
- [Restore from a backup](#restore-from-a-backup)
- [Restore drill](#restore-drill)
- [Newsletter when restoring an older copy](#newsletter-when-restoring-an-older-copy)
- [Images: unlisted, not private](#images-unlisted-not-private)
- [Clearing the optimized image cache](#clearing-the-optimized-image-cache)

## What to back up

| What | Where it lives | Backed up by |
|---|---|---|
| Posts, comments, likes, users, site content (profile, about, blogroll, ...), newsletter data, view counts | PostgreSQL | `pg_dump` |
| Uploaded images (cover images, gallery, body images, the avatar) | PostgreSQL (`bytea`), **not on disk** | `pg_dump` |
| Secrets and settings, **including `MFA_ENCRYPTION_KEY`** | `.env` | a copy of the file, kept as safely as the dump, and **apart from it** (see below) |
| Search index (only with the optional Meilisearch service) | the `meili_data` volume | nothing: rebuild it with a reindex |
| First-run setup code | the `backend_data` volume, deleted when setup completes | nothing |

The backend container runs as a non-root user and has no volume for uploads, and free hosting disks are lost on every deploy, so
there is no upload directory to back up separately.

Keep a copy of `.env`, and a copy of `MFA_ENCRYPTION_KEY` **in a different place than the dump** (a password manager). The dump
holds the two-step verification secrets only in encrypted form; the key that opens them is not in the database on purpose, so
that someone who steals a backup does not get both. The cost: a database restored onto a server whose `.env` has another
`MFA_ENCRYPTION_KEY` cannot read any enrollment. Put the saved key back before you start the backend; if it is lost, every enrolled
administrator signs in with a recovery code or needs the operator reset
([Configuration](CONFIGURATION.md#changing-mfa_encryption_key)). A new `JWT_SECRET` is easy to make, but without the original `NEWSLETTER_SECRET` every unsubscribe link
already sent and every suppression row stops working
([Newsletter when restoring an older copy](#newsletter-when-restoring-an-older-copy)), and the other values (database password,
GitHub OAuth secret, SMTP password) are painful to recover.

## Take a backup

From the directory that contains `docker-compose.yml`:

```bash
umask 077   # for this shell: the dump is created readable by you only (mode 0600)
docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > blog-$(date +%F).dump
```

- `umask 077` comes first because the shell creates the file for the redirection with the default umask, usually 022, which makes
  it readable by every local user (0644).
- `-T` turns off the TTY. Through a TTY the binary stream has its newline characters rewritten and the dump is corrupted.
- The `$POSTGRES_*` variables are read inside the container, so the command does not need `.env` in your shell.
- The dump weighs about the sum of the posts and `media.byte_size`. JPEG and PNG are already compressed, so `-Fc` can hardly
  shrink them. When images are deleted, autovacuum reuses the free space, but PostgreSQL's data files do not shrink.
- The current image size:

  ```bash
  docker compose exec postgres sh -c \
    'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c "SELECT count(*), pg_size_pretty(sum(byte_size)) FROM media"'
  ```

**The dump contains personal data**: the email addresses of newsletter subscribers (pending and confirmed), the one-way
suppression hashes of people who unsubscribed, the `contact_messages` table (visitors' names, email addresses and messages), reader accounts (GitHub login, display name, avatar URL), the Argon2id hash of the admin password, the hashes of live sign-in tokens, and per-day view counts for
each post. Treat the backup like `.env`: the file is mode 0600 inside a folder of mode 0700, so only its owner can read it. Copy it to another machine only over an encrypted channel, and if that machine or the object storage is not yours alone, encrypt the dump before it leaves this host (`age` or `gpg` on the file, or a backup tool such as `restic` or `borg`, which encrypt by design) and keep the key somewhere other than the VPS.

## Back up every day

A backup that sits on the VPS is lost together with the VPS. This cron script dumps into `/var/backups/blog`, keeps the last 14
days, and copies the folder to another machine:

```sh
#!/bin/sh
# /usr/local/bin/blog-backup
set -eu
umask 077                     # every file is created 0600 and every folder 0700: the dump holds personal data and password hashes
cd /opt/blog                  # the directory containing docker-compose.yml and .env
dir=/var/backups/blog
install -d -m 700 "$dir"
chmod 700 "$dir"              # a folder made earlier with the default umask is 0755: close it
file="$dir/blog-$(date +%F).dump"
docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$file.part"
mv "$file.part" "$file"       # a dump broken halfway does not become today's backup
chmod 600 "$dir"/blog-*.dump  # and the dumps an earlier version of this script made as 0644
find "$dir" -name 'blog-*' -mtime +13 -delete
rsync -a --chmod=D700,F600 "$dir/" "backup@<other-machine>:blog-backups/"
```

```bash
sudo chmod 700 /usr/local/bin/blog-backup
echo '30 3 * * * root /usr/local/bin/blog-backup >> /var/log/blog-backup.log 2>&1' \
  | sudo tee /etc/cron.d/blog-backup
```

- `set -eu` stops at the first failing command, and the `.part` file keeps a half-written dump from replacing a good one.
- `umask 077` makes the folder 0700 and each dump 0600. A cron job starts with the umask 022 of root, which would leave the folder
  open to every local user; without the umask `rsync -a` would also copy those modes to the other machine. `--chmod=D700,F600`
  makes the copies private there whatever the source says. The folder `blog-backups/` on the other machine must be 0700 as well
  (`rsync` creates it with `D700`, but a folder that already exists keeps its mode: check it once with `ls -ld`).
- `rsync` needs root's SSH key to the other machine and has no `--delete`: the other side keeps even the copies deleted here and
  cleans up by its own retention. You can replace that line with `rclone copy` to object storage, and encrypt the dump first if the
  storage is shared (see [Take a backup](#take-a-backup)).
- Each copy weighs about the total image size, so 14 copies need about 14 times that number. Using the whole default quota
  (`MEDIA_MAX_TOTAL_SIZE=1GB`) is about 14 GB of backups.
- Check the log of the job now and then, and do the [restore drill](#restore-drill). A backup you never restored is a hope.

## Restore from a backup

This replaces the whole database with a dump. Everything written after that copy is lost: posts, comments, likes, views, images,
newsletter subscriptions, and the sign-in sessions opened afterwards. From the directory that contains `docker-compose.yml`:

```bash
docker compose stop backend   # closes every connection to the database; the site shows errors until the last step
docker compose exec postgres sh -c \
  'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c \
  'pg_restore --no-owner --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < /var/backups/blog/blog-<date>.dump
docker compose exec -T postgres sh /docker-entrypoint-initdb.d/10-roles.sh   # three database roles: see below; otherwise it does nothing
docker compose start backend
docker compose up -d --force-recreate frontend   # drops Next's data cache: it still holds the content from before the restore
```

- **The three database roles.** `pg_restore --no-owner` gives what it restores to the role that runs it (the administration role), so
  the owner role and the runtime role lose their rights. `10-roles.sh` (the line before `start backend`) gives the ownership back and
  grants the runtime role again; on a single-role install it prints that there is nothing to do. Without it the backend answers
  "permission denied for table ..." ([Upgrading](UPGRADING.md#moving-to-the-three-database-roles)).
- `--single-transaction`: an error anywhere means nothing is written. In that case **do not start the backend**: the database is
  empty, and Flyway would build a brand-new schema on it, that is an empty site that looks healthy. Read the error, fix it, and
  run the restore again.
- If the dump is older than the running image, the backend applies the migrations the dump does not have yet when it starts.
  That is normal. A dump taken by a **newer** version than the image you run is not supported: use the image of the version
  that took the dump ([Upgrading](UPGRADING.md#rolling-back)).
- On a completed install the restored database also carries `setup_completed`, so `/setup` stays closed. If you restore a dump
  of a database that was never claimed, `/setup` is open again (see [First run](FIRST-RUN.md)).
- With the Meilisearch service enabled, run a reindex afterwards (the index is a copy, rebuilt from PostgreSQL).
- Then run the [checks after an upgrade](UPGRADING.md#checks-after-every-upgrade).

## Move only the content to another install

A full restore replaces everything, including what readers did on the live site. To publish new posts, images, About and the
other site content from another machine without erasing comments, likes, accounts and subscribers, use the scripts in
[scripts/content-sync](../scripts/content-sync/README.md): `export-content.ps1` on the machine with the content,
`import-content.ps1 -DryRun` and then `import-content.ps1 -Update` on the live one. They never delete and never touch reader data.
The package is signed with a shared key (`-KeyFile`, or `CONTENT_SYNC_KEY`) and the import refuses one it cannot verify, because
restoring a dump runs its SQL on the live database ([Security](SECURITY.md#what-is-not-protected)).

## Restore drill

Restore into a scratch database on the same server, look at the numbers, and drop it. The live database is not touched. Do this
once after you set up the cron job, and again after any major upgrade.

```bash
docker compose exec postgres sh -c 'createdb -U "$POSTGRES_USER" blog_drill'
docker compose exec -T postgres sh -c \
  'pg_restore --no-owner --single-transaction -U "$POSTGRES_USER" -d blog_drill' \
  < /var/backups/blog/blog-<date>.dump
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" blog_drill -c "
  SELECT (SELECT count(*) FROM posts) AS posts,
         (SELECT count(*) FROM media) AS images,
         (SELECT count(*) FROM users) AS users,
         (SELECT version FROM flyway_schema_history WHERE success ORDER BY installed_rank DESC LIMIT 1) AS schema_version"'
docker compose exec postgres sh -c 'dropdb -U "$POSTGRES_USER" blog_drill'
```

The counts should match what the admin shows (allowing for what happened since the dump), and `schema_version` should be the last
migration of the version that took the dump. A restore that stops with an error here is a backup you could not have used: find out
why today. The scratch database needs room for a second copy of the images, so check the free disk first.

## Newsletter when restoring an older copy

Derived from the code, not tried on a real mail provider:

- People who unsubscribed after the dump's date become confirmed subscribers again, and their suppression rows are lost too, so
  new-post mail reaches them again. Before restoring, export the `newsletter_suppressions` table of the running database, then
  insert it back after restoring. The worker does not send to an address that has a suppression row, as long as
  `NEWSLETTER_SECRET` has not changed.
- A post first published after that date is unpublished or absent in the dump (`published_at` empty), so publishing it again, or
  recreating and publishing it, sends mail again to everyone confirmed.
- People who subscribed after that date lose their subscription, and the link in the confirmation mail they received no longer works.

## Images: unlisted, not private

Each image has exactly one URL, `/media/<uuid>.jpg` or `.png`, with a random UUID v4, and **anyone with the URL can view it**,
including the cover image of a draft post and a hidden gallery image. "Hidden" means not appearing on any page, not that it
cannot be reached. The admin reminds you of this at the cover image of an unpublished post and at the visibility box of a gallery
image. Do not upload an image if a leaked URL would become an incident. Images are decoded and re-encoded, so EXIF and GPS data
are gone; the original file name is visible to the admin only.

Deleting an image (removing a cover image, deleting a gallery image, deleting a post) removes it from the database and from every
page at once. But the optimized copy under `/_next/image?url=/media/<uuid>...` stays in Next's image cache, and anyone holding
exactly that URL can still download it until the cache is cleared.

## Clearing the optimized image cache

```bash
docker compose restart frontend
```

The `/_next/image` cache is a tmpfs of the frontend container (`/app/.next/cache/images`): memory, at most 64 MB per
`images.maximumDiskCacheSize`, on a 96 MB mount in `docker-compose.yml`. A tmpfs is empty every time the container starts, so a restart
clears it (`docker compose up -d --force-recreate frontend` does too), and nothing of it survives a stop, an update or a reboot: an image
is encoded again the next time it is asked for, and when the 64 MB are full Next deletes the images used least. (In a version before the
containers were hardened the cache sat in the container's write layer, 500 MB, and `restart` kept it.) On Vercel, clear the image cache in
the dashboard.

You normally do not need to do this. Every upload gets a new UUID, so the cache never returns an old image in place of a new one.
It is only needed when a deleted image must really disappear.
