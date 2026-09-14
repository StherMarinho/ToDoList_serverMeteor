#!/bin/sh
set -e

if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
	echo "Instalando/atualizando dependencias npm..."
	meteor npm install
fi

exec "$@"
