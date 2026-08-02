#!/usr/bin/env bash
# Build the signed release APK inside Docker.
#
#   ./android/docker-build.sh          # from the repo root, git-bash or WSL
#
# First run builds the toolchain image (~5 min, downloads JDK + Android SDK);
# after that it's cached. The repo is volume-mounted, so the keystore
# (android/keystore/, gitignored) is available to gradle without ever being
# baked into an image layer, and the APK lands in the normal output path:
#
#   android/app/build/outputs/apk/release/app-release.apk
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root, wherever this is invoked from

if [ ! -f android/keystore.properties ]; then
  echo "WARNING: android/keystore.properties missing - the release will be UNSIGNED." >&2
fi

echo "==> building toolchain image (cached after first run)"
docker build -t grapheon-android-build android/docker

# git-bash mangles /work into C:/...; pwd -W gives a path Docker Desktop
# accepts. On real POSIX shells pwd -W doesn't exist and plain pwd is right.
HOST_PWD="$(pwd -W 2>/dev/null || pwd)"

echo "==> running build"
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "${HOST_PWD}:/work" \
  grapheon-android-build

echo "==> done:"
ls -la android/app/build/outputs/apk/release/
