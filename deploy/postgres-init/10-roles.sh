#!/bin/sh
# Runs once, when the postgres image creates a new data directory (it executes the scripts of /docker-entrypoint-initdb.d as the
# bootstrap superuser, POSTGRES_USER). It makes the owner role and the runtime role of roles.psql, which sits next to it.
#
# A single-role install (OWNER_DB_USER empty, which is what docker-compose.yml passes when DB_OWNER_USERNAME is not set in .env)
# has nothing to do here: the one role stays the superuser it has always been. Moving such an install to the three roles later is a
# step of docs/UPGRADING.md. The variables come from the compose file; the passwords stay in the environment and are never arguments.
#
# The image runs a script that is not executable by sourcing it into its own shell, so this one neither exits nor uses `set -u` or
# `exec`: it must behave the same when executed and when sourced.

if [ -z "${OWNER_DB_USER:-}" ]; then
  echo "postgres-init: OWNER_DB_USER is empty: single-role install, no roles created."
else
  psql -X -q -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/roles.psql
fi
