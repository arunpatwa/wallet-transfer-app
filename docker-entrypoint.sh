#!/bin/sh
# Apply migrations, then serve.
#
# Safe to run on every container start and with several containers starting at
# once: the runner takes a transaction-scoped advisory lock and applies only
# what is pending, so concurrent boots serialise rather than collide.
#
# set -e means a failed migration aborts the boot rather than starting a server
# against a schema it does not understand.
set -e

node src/db/migrate.js

exec node src/server.js
