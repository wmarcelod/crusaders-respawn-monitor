#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR="${ROOT_DIR}/lib"
mkdir -p "${LIB_DIR}"

download_if_missing() {
  local url="$1"
  local file="$2"

  if [[ -f "${LIB_DIR}/${file}" ]]; then
    echo "exists ${file}"
    return 0
  fi

  echo "download ${file}"
  curl -fsSL "${url}" -o "${LIB_DIR}/${file}"
}

download_if_missing "https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk15on/1.67/bcprov-jdk15on-1.67.jar" "bcprov-jdk15on-1.67.jar"
download_if_missing "https://repo1.maven.org/maven2/commons-lang/commons-lang/2.6/commons-lang-2.6.jar" "commons-lang-2.6.jar"
download_if_missing "https://repo1.maven.org/maven2/dnsjava/dnsjava/2.1.8/dnsjava-2.1.8.jar" "dnsjava-2.1.8.jar"
download_if_missing "https://repo1.maven.org/maven2/org/ini4j/ini4j/0.5.1/ini4j-0.5.1.jar" "ini4j-0.5.1.jar"
download_if_missing "https://repo1.maven.org/maven2/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar" "gson-2.10.1.jar"

echo "deps ready in ${LIB_DIR}"
