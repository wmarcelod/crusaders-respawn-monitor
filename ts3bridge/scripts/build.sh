#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS3J_SRC="${ROOT_DIR}/vendor/ts3j-src/src/main/java"
SRC_DIR="${ROOT_DIR}/src/main/java"
BUILD_DIR="${ROOT_DIR}/build/classes"
LIB_DIR="${ROOT_DIR}/lib"

"${ROOT_DIR}/scripts/fetch-deps.sh"

mkdir -p "${BUILD_DIR}"

mapfile -t LIBS < <(find "${LIB_DIR}" -maxdepth 1 -name '*.jar' | sort)
if [[ ${#LIBS[@]} -eq 0 ]]; then
  echo "no jars found in ${LIB_DIR}" >&2
  exit 1
fi

CLASSPATH="$(IFS=:; echo "${LIBS[*]}")"

mapfile -t JAVA_FILES < <(find "${TS3J_SRC}" "${SRC_DIR}" -type f -name '*.java' | sort)
if [[ ${#JAVA_FILES[@]} -eq 0 ]]; then
  echo "no java files found to compile" >&2
  exit 1
fi

javac -encoding UTF-8 -cp "${CLASSPATH}" -d "${BUILD_DIR}" "${JAVA_FILES[@]}"

echo "build complete -> ${BUILD_DIR}"
