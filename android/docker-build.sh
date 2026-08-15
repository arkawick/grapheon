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

# Every node_modules is MASKED by a named volume rather than shared with the
# host, and this is a correctness fix, not a speed one. The host tree is
# Windows: it holds @esbuild/win32-x64/esbuild.exe and friends. Bind-mounting
# it meant `npm ci` first tried to delete those binaries (EIO: unlink over the
# Windows mount, which is how this surfaced) and, had that succeeded, would
# have replaced the host's install with Linux binaries — breaking `npm run dev`
# on the host as a side effect of building an APK.
#
# Named, not anonymous, so the install survives between runs; `docker volume rm`
# on these is the way to force a clean install.
#
# One volume per workspace: npm hoists most packages to the root, but each
# workspace still gets a node_modules (at minimum a .bin), and an unmasked one
# would put Windows binaries back on the container's PATH.
VOLUMES=(
  -v grapheon-android-nm-root:/work/node_modules
  -v grapheon-android-nm-web:/work/web/node_modules
  -v grapheon-android-nm-extract:/work/extract/node_modules
  -v grapheon-android-nm-pipeline:/work/pipeline/node_modules
  # Gradle's distribution and dependency cache. Without this every run
  # re-downloads Gradle itself plus the whole AGP dependency graph.
  -e GRADLE_USER_HOME=/gradle-home
  -v grapheon-android-gradle:/gradle-home
)

echo "==> running build"
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "${HOST_PWD}:/work" \
  "${VOLUMES[@]}" \
  grapheon-android-build

echo "==> done:"
ls -la android/app/build/outputs/apk/release/
