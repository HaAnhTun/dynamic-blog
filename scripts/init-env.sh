#!/usr/bin/env bash
# Writes .env from .env.example with fresh random secrets. Never overwrites an existing .env.
#
#   ./scripts/init-env.sh
#   SITE_URL=https://example.com SITE_PORT=3000 DEFAULT_LOCALE=vi ./scripts/init-env.sh
#
# Inputs (environment variables): SITE_URL (default http://localhost:3000), SITE_PORT (default 3000),
# DEFAULT_LOCALE (en or vi, default en). ADMIN_PASSWORD, SETUP_TOKEN, ADMIN_GITHUB_ID, MFA_ENROLLMENT_TOKEN, MFA_RESET_EMAIL and
# MFA_RESET_TOKEN stay empty: a fresh install is claimed at <SITE_URL>/setup with the setup code the backend writes to
# /data/setup-code. MFA_ENCRYPTION_KEY is generated (base64 of 32 random bytes).
# No secret is printed, and none is ever an argument of a process: another local user could read it in /proc/<pid>/cmdline or `ps`
# while the process runs. The values stay in shell variables and reach sed through a script file written by the `printf` builtin
# (mode 600, removed on exit). .env is created with mode 600 as well.
# Needs bash, sed, mv and one of openssl, python3 or /dev/urandom with od.
set -euo pipefail
umask 077

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template="$root/.env.example"
target="$root/.env"

if [ -e "$target" ]; then
  echo "init-env: $target already exists; refusing to overwrite it. Move it away first." >&2
  exit 1
fi
if [ ! -f "$template" ]; then
  echo "init-env: $template not found." >&2
  exit 1
fi

site_url="${SITE_URL:-http://localhost:3000}"
site_port="${SITE_PORT:-3000}"
default_locale="${DEFAULT_LOCALE:-en}"

site_url="${site_url%/}"
case "$site_url" in
  http://* | https://*) ;;
  *) echo "init-env: SITE_URL must start with http:// or https:// (got a value without a scheme)." >&2; exit 1 ;;
esac
case "$site_url" in
  *[!A-Za-z0-9:/._-]*) echo "init-env: SITE_URL contains characters that are not allowed here." >&2; exit 1 ;;
esac
case "$site_port" in
  '' | *[!0-9]*) echo "init-env: SITE_PORT must be a number." >&2; exit 1 ;;
esac
case "$default_locale" in
  en | vi) ;;
  *) echo "init-env: DEFAULT_LOCALE must be en or vi." >&2; exit 1 ;;
esac

# $1 = number of random bytes; prints 2*N hex characters.
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets, sys; print(secrets.token_hex(int(sys.argv[1])))' "$1"
  else
    od -An -vtx1 -N "$1" /dev/urandom | tr -d ' \n'
    echo
  fi
}

tmp="$(mktemp "$root/.env.XXXXXX")"
sed_script="$(mktemp "$root/.env.sed.XXXXXX")"
trap 'rm -f "$tmp" "$sed_script"' EXIT
chmod 600 "$tmp" "$sed_script"

# $1 = number of random bytes; prints them as base64 (44 characters for 32 bytes: letters, digits, +, / and =).
random_base64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import base64, os, sys; print(base64.b64encode(os.urandom(int(sys.argv[1]))).decode())' "$1"
  else
    head -c "$1" /dev/urandom | base64 | tr -d '\n'
    echo
  fi
}

# One substitution per line of the sed script: $1 = key, $2 = value. printf is a builtin, so the value is not in the argument
# list of any process. Hex values only, except MFA_ENCRYPTION_KEY (base64, which the key format requires): none of these
# characters needs quoting in a .env file, and none is special in a sed replacement with the | delimiter.
substitute() {
  printf 's|^%s=.*|%s=%s|\n' "$1" "$1" "$2" >>"$sed_script"
}

substitute DB_PASSWORD "$(random_hex 24)"
substitute DB_OWNER_PASSWORD "$(random_hex 24)"
substitute DB_ADMIN_PASSWORD "$(random_hex 24)"
substitute JWT_SECRET "$(random_hex 48)"
substitute MFA_ENCRYPTION_KEY "$(random_base64 32)"
substitute VIEWS_TOKEN "$(random_hex 32)"
substitute CLIENT_IP_TOKEN "$(random_hex 32)"
substitute NEWSLETTER_SECRET "$(random_hex 48)"
substitute MEILI_MASTER_KEY "$(random_hex 32)"
substitute SITE_URL "$site_url"
substitute SITE_PORT "$site_port"
substitute DEFAULT_LOCALE "$default_locale"

sed -f "$sed_script" "$template" >"$tmp"
rm -f "$sed_script"

# Every key must now have a value, or the template changed under this script.
for key in DB_PASSWORD DB_OWNER_PASSWORD DB_ADMIN_PASSWORD JWT_SECRET MFA_ENCRYPTION_KEY VIEWS_TOKEN CLIENT_IP_TOKEN NEWSLETTER_SECRET MEILI_MASTER_KEY SITE_URL SITE_PORT DEFAULT_LOCALE; do
  if ! grep -q "^$key=." "$tmp"; then
    echo "init-env: $key is missing from .env.example; .env was not written." >&2
    exit 1
  fi
done

mv "$tmp" "$target"
trap - EXIT

echo "init-env: wrote $target (mode 600) from .env.example."
echo "  random secrets: DB_PASSWORD, DB_OWNER_PASSWORD, DB_ADMIN_PASSWORD, JWT_SECRET, MFA_ENCRYPTION_KEY, VIEWS_TOKEN, CLIENT_IP_TOKEN, NEWSLETTER_SECRET, MEILI_MASTER_KEY (not shown)"
echo "  SITE_URL=$site_url  SITE_PORT=$site_port  DEFAULT_LOCALE=$default_locale"
echo "  left empty: ADMIN_PASSWORD, SETUP_TOKEN, ADMIN_GITHUB_ID (claim the site at $site_url/setup)"
echo "Next: docker compose up -d --build"
echo "Then open $site_url/setup and read the setup code with: docker compose exec backend sh -c 'cat /data/setup-code'"
