#!/bin/sh
# Apply migrations, then serve. Safe on every start and on concurrent boots:
# the runner holds a transaction-scoped advisory lock and applies only what is
# pending. set -e aborts the boot rather than serving against a schema the code
# does not understand.
set -e

node src/db/migrate.js

exec node src/server.js
