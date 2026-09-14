#!/bin/sh
set -e

settings_file="${METEOR_SETTINGS_FILE:-/app/settings.json}"

if [ -z "${METEOR_SETTINGS:-}" ] && [ -f "$settings_file" ]; then
	METEOR_SETTINGS="$(cat "$settings_file")"
	export METEOR_SETTINGS
fi

exec "$@"
