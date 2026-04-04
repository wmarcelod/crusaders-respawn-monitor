#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build/classes"
LIB_DIR="${ROOT_DIR}/lib"

if [[ ! -d "${BUILD_DIR}" ]]; then
  "${ROOT_DIR}/scripts/build.sh"
fi

mapfile -t LIBS < <(find "${LIB_DIR}" -maxdepth 1 -name '*.jar' | sort)
CLASSPATH="${BUILD_DIR}"
if [[ ${#LIBS[@]} -gt 0 ]]; then
  CLASSPATH="${BUILD_DIR}:$(IFS=:; echo "${LIBS[*]}")"
fi

cd "${ROOT_DIR}"
exec java -cp "${CLASSPATH}" com.crusaders.bridge.TS3Bridge
