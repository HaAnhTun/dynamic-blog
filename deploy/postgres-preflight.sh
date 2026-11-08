#!/bin/sh
# The entrypoint of the postgres service (docker-compose.yml): checks the database roles that .env names, then hands over to the image's
# own docker-entrypoint.sh with the same arguments. It runs before initdb, so a half-filled .env stops here and no data directory is
# made: a data directory whose first-run script failed is never initialised again (docs/TROUBLESHOOTING.md).
#
# This is the "all or nothing" rule of the three database roles (docs/SECURITY.md, "Containers and networks"). It is a script and not
# a `${VAR:?message}` in the compose file because Docker Compose before v2.40 evaluates the default and the alternative text of a
# variable eagerly, so a required variable inside the default of another one fails on an install that never set the first
# (scripts/test_container_hardening.py keeps the compose file free of that shape).
#
# Environment (all passed by the compose file, empty when not set in .env):
#   OWNER_DB_USER, OWNER_DB_PASSWORD   the owner role (DB_OWNER_USERNAME, DB_OWNER_PASSWORD)
#   ADMIN_DB_USER_GIVEN, ADMIN_DB_PASSWORD_GIVEN   the administration role as written in .env (DB_ADMIN_USERNAME, DB_ADMIN_PASSWORD)
#   APP_DB_USER, APP_DB_PASSWORD       the runtime role (DB_USERNAME, DB_PASSWORD)
# A message names the variable of .env, never a value.

fail() {
  echo "postgres-preflight: $1" >&2
  exit 1
}

if [ -n "${OWNER_DB_USER:-}" ]; then
  [ -n "${OWNER_DB_PASSWORD:-}" ] || fail "set DB_OWNER_PASSWORD in .env (DB_OWNER_USERNAME is set)"
  [ -n "${ADMIN_DB_USER_GIVEN:-}" ] || fail "set DB_ADMIN_USERNAME in .env (DB_OWNER_USERNAME is set)"
  [ -n "${ADMIN_DB_PASSWORD_GIVEN:-}" ] || fail "set DB_ADMIN_PASSWORD in .env (DB_OWNER_USERNAME is set)"
  [ "${APP_DB_USER:-}" != "$OWNER_DB_USER" ] && [ "${APP_DB_USER:-}" != "$ADMIN_DB_USER_GIVEN" ] \
    && [ "$OWNER_DB_USER" != "$ADMIN_DB_USER_GIVEN" ] \
    || fail "DB_USERNAME, DB_OWNER_USERNAME and DB_ADMIN_USERNAME must be three different roles"
  [ "${APP_DB_PASSWORD:-}" != "$OWNER_DB_PASSWORD" ] && [ "${APP_DB_PASSWORD:-}" != "$ADMIN_DB_PASSWORD_GIVEN" ] \
    && [ "$OWNER_DB_PASSWORD" != "$ADMIN_DB_PASSWORD_GIVEN" ] \
    || fail "DB_PASSWORD, DB_OWNER_PASSWORD and DB_ADMIN_PASSWORD must be three different passwords"
elif [ -n "${ADMIN_DB_USER_GIVEN:-}${ADMIN_DB_PASSWORD_GIVEN:-}" ]; then
  # An administration role without an owner role would be the superuser while the runtime role is never created.
  fail "DB_ADMIN_USERNAME or DB_ADMIN_PASSWORD is set without DB_OWNER_USERNAME: set the owner pair too, or remove the administration pair"
fi

exec docker-entrypoint.sh "$@"
