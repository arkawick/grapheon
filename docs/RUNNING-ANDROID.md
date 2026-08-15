# Running the Android app

How to build, sign, install and debug Grapheon on Android — and the traps that
cost real time, each of which is here because it actually happened.

**The short version:** `./android/docker-build.sh` produces a signed release
APK with nothing Android-related installed on your machine. Everything else is
detail.

---

## Contents

- [What the Android app actually is](#what-the-android-app-actually-is)
- [Prerequisites](#prerequisites)
- [Route 1 — Signed release APK in Docker (recommended)](#route-1--signed-release-apk-in-docker-recommended)
- [Route 2 — Debug APK on the host](#route-2--debug-apk-on-the-host)
- [Installing on a device](#installing-on-a-device)
- [Signing and the keystore](#signing-and-the-keystore)
- [Verifying a build](#verifying-a-build)
- [Debugging the app on a phone](#debugging-the-app-on-a-phone)
- [What differs on mobile](#what-differs-on-mobile)
- [Icons and branding](#icons-and-branding)
- [Troubleshooting](#troubleshooting)

---

## What the Android app actually is

A **Capacitor shell around `web/dist`**. There is no separate mobile codebase,
no React Native, no duplicated UI. The identical static build that nginx serves
is copied into the APK and loaded by a WebView.

```
web/dist  ──(npx cap sync android)──▶  android/app/src/main/assets/public/  ──▶  WebView
```

This means extraction runs **on the device**, in the WebView's Web Worker,
using the same WASM tree-sitter grammars. Nothing is uploaded; the app works in
airplane mode. It also means **any web fix is a mobile fix** — rebuild and
re-sync, no porting.

`android/` sits at the **repo root**, deliberately separated from `web/`.
`web/` never references `android/`; the only thing crossing the boundary is
`web/dist`. Capacitor's config lives at the root
(`capacitor.config.json`, `webDir: "web/dist"`).

| Setting | Value |
|---|---|
| Application id | `app.grapheon` |
| App name | Grapheon |
| minSdk | 24 (Android 7.0) |
| compileSdk / targetSdk | 36 (Android 16) |
| Capacitor | 8 |
| Gradle / AGP | 8.14.3 / 8.13.0 |
| JDK | 21 (Temurin) |

---

## Prerequisites

### For the Docker route (recommended)

Docker. That is the entire list. The toolchain image carries Node 22, Temurin
JDK 21 and Android SDK 36, so **nothing Android-related is installed on your
machine**.

### For the host route

- JDK **21** — `JAVA_HOME` → e.g. `C:/Program Files/Java/jdk-21`
- Android SDK with platform 36 and build-tools 36.0.0 — `ANDROID_HOME` → e.g.
  `%LOCALAPPDATA%/Android/Sdk`
- Node 22+

---

## Route 1 — Signed release APK in Docker (recommended)

```bash
./android/docker-build.sh
```

From the repo root, in git-bash or WSL. Output:

```
android/app/build/outputs/apk/release/app-release.apk
```

### What it does, step by step

1. **Builds the toolchain image** (`android/docker/Dockerfile`), cached after
   the first run. ~5 minutes initially: it downloads Temurin JDK 21, the
   Android command-line tools, accepts the SDK licences, and installs
   platform-tools, `platforms;android-36` and `build-tools;36.0.0`.
2. **Runs the container** with the repo bind-mounted at `/work`, executing:
   `npm ci` → `npm run build` → `npx cap sync android` → `gradlew assembleRelease`.
3. **Signs** the APK, if `android/keystore.properties` exists.

### Timings measured on this project

| | Cold | Warm |
|---|---|---|
| Toolchain image | ~5 min | cached |
| Full build | **12 min 31 s** | **4 min 30 s** |

Most of the time is Gradle working over a Windows bind mount. The warm figure
comes from named Docker volumes caching npm and Gradle; 57 of 164 Gradle tasks
come back up-to-date.

### The `node_modules` trap

The script masks **every workspace's `node_modules`** with a named Docker
volume rather than sharing the host's. This is a correctness measure, not an
optimisation, and it is worth understanding before you edit the script.

The repo is bind-mounted from Windows, so `/work/node_modules` contains
`@esbuild/win32-x64/esbuild.exe` and other Windows binaries. `npm ci` **deletes
`node_modules` before installing**. Inside a Linux container that means:

- it fails with `EIO: unlink` on the Windows-mounted `.exe`, and
- before failing, it has already removed `node_modules/esbuild` — **breaking
  `npm run build` on the host**, as a side effect of building an APK.

Had the unlink succeeded, it would have replaced the entire host install with
Linux binaries.

If your host toolchain ever breaks right after an APK build, repair it with:

```bash
npm install          # from the repo root
```

Volumes are **named**, not anonymous, so npm and Gradle caches survive between
runs. To force a genuinely clean install:

```bash
docker volume rm grapheon-android-nm-root grapheon-android-nm-web \
                 grapheon-android-nm-extract grapheon-android-nm-pipeline \
                 grapheon-android-gradle
```

### Why the repo is mounted rather than copied into the image

So that **signing material never enters an image layer**. The keystore is read
from the mount at build time; an image push can never leak it, because it was
never in the image.

---

## Route 2 — Debug APK on the host

Useful for quick iteration if you already have the Android toolchain.

```bash
npm run sync:android                  # production web build + cap sync
cd android
./gradlew assembleDebug               # gradlew.bat on cmd/PowerShell
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

A debug APK is signed with Android's universal debug key. It installs on any
device with developer mode on, but **cannot be published** and cannot upgrade
an installed release build — the signatures differ.

To build a *release* on the host, the same `./gradlew assembleRelease` works
provided `android/keystore.properties` is present.

---

## Installing on a device

### Over USB (adb)

```bash
adb devices                                   # confirm the device is listed
adb install -r app-release.apk                # -r replaces an existing install
```

Enable **Developer options → USB debugging** on the phone first. If `adb
devices` shows `unauthorized`, accept the RSA prompt on the phone's screen.

### Without adb

Copy the `.apk` to the device and open it with a file manager. Android will ask
you to allow installs from that app; this is expected for any APK not from the
Play Store.

### Upgrading an existing install

Android accepts an update **only if it is signed with the same key**. A
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` error means the signatures differ —
usually you are installing a debug build over a release one or vice versa.
Uninstall first, or install the matching variant.

---

## Signing and the keystore

Release signing reads `android/keystore.properties`, which points at a keystore
under `android/keystore/`. **Both are gitignored**, deliberately:

```
android/keystore/                 # the private key
android/keystore.properties       # its path, alias, and PASSWORDS in plain text
```

`android/app/build.gradle` applies the signing config **only when
`keystore.properties` exists**. When it is absent — a fresh clone, CI without
secrets — the build still **succeeds** and produces an **unsigned** APK rather
than failing.

> That behaviour is intentional (a contributor without the key can still build)
> but it means **a lost key does not announce itself**. Always confirm a
> release with `apksigner verify`, below.

### These two files are the app's identity

Android accepts an update only if it carries the same signature. Lose the
keystore and you can never ship another version of `app.grapheon` to any device
that already has it, and you cannot publish an update on Play. There is no
reset, no recovery and nobody who can issue a replacement — the only path
forward is a new application id and every user reinstalling from scratch.

**Back both files up off this machine.** A copy on the same disk protects
against a bad `git clean` and nothing else; a drive failure or a stolen laptop
takes both at once. Reasonable options: a password manager with file
attachments, or a 7-Zip AES-256 archive on a USB stick kept elsewhere. Do not
commit them anywhere, and do not email them unencrypted — `keystore.properties`
holds the passwords in the clear.

### Creating a keystore from scratch

Only if you are starting a *new* app identity — this does not recover a lost
one.

```bash
keytool -genkeypair -v \
  -keystore android/keystore/grapheon-release.keystore \
  -alias grapheon -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Grapheon, OU=Dev, O=Grapheon, C=IN"
```

Then write `android/keystore.properties`:

```properties
storeFile=keystore/grapheon-release.keystore
storePassword=<your password>
keyAlias=grapheon
keyPassword=<your password>
```

`storeFile` is resolved relative to `android/`.

---

## Verifying a build

### Is it signed, and by whom?

```bash
apksigner verify --verbose --print-certs app-release.apk
```

Expected for this project:

```
Verifies
Verified using v2 scheme (APK Signature Scheme v2): true
Number of signers: 1
Signer #1 certificate DN: CN=Grapheon, OU=Dev, O=Grapheon, C=IN
Signer #1 key algorithm: RSA
Signer #1 key size (bits): 2048
```

Via Docker, without installing build-tools:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/work" -w /work \
  grapheon-android-build \
  bash -c '$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs \
           android/app/build/outputs/apk/release/app-release.apk'
```

> Use `bash -c`, **not** `bash -lc`. A login shell re-sources `/etc/profile`,
> which *replaces* the PATH the image set — `$JAVA_HOME/bin` disappears and you
> get `exec: java: not found`. The Gradle build survives this because it finds
> java through `JAVA_HOME`, which is exactly why the bug hid for so long.

### Does it contain the build I think it does?

```bash
unzip -l app-release.apk | grep assets/public
```

Or extract and grep for a string you know is in the current build. The APK
should contain `assets/public/` with `index.html`, the hashed JS bundles, and
`data/` holding the shipped corpora.

Currently v3 signing is **not** enabled, so the APK is v2-only. v3 is what
supports key rotation; worth enabling if the keystore might ever need to
change.

---

## Debugging the app on a phone

The app is a WebView, so **Chrome DevTools works on it directly**:

1. Connect the phone over USB with USB debugging on.
2. Open `chrome://inspect/#devices` on the desktop.
3. Click **inspect** under the Grapheon WebView.

You get the full console, network tab, and element inspector against the real
device. This is by far the fastest way to diagnose anything mobile-specific.

**Assume the test browser is more modern than your users'.** Playwright's
bundled Chromium is newer than most real browsers and than many Android
WebViews. A feature can pass every test and still be missing on a real device —
this happened here with `Uint8Array.prototype.toHex()`, an ES2025 method that
pdf.js's default build calls, which crashed PDF import for the user while CI
stayed green. The fix was the **legacy** pdf.js build; the drive now deletes
`toHex` before parsing so the check can actually catch that class of bug.

---

## What differs on mobile

The web app adapts rather than forking, but several behaviours change below
720px or on touch devices:

- **No folder picker.** Mobile WebViews ignore `webkitdirectory` and silently
  degrade to a single-file picker. The zip path is the only working ingestion
  route, and the sidebar hides the folder button on touch rather than offering
  something broken.
- **The header is a drawer, not a row.** Laid out flat, the bar needed 504px
  inside a 390px screen: nav, Files, Search and two upload buttons overlapped,
  and *"Open a repo .zip…"* was pushed entirely off-screen. The phone build
  could not load a repo at all, and nothing reported an error because the
  element existed. The drive now asserts the zip button is **on screen**, not
  merely present in the DOM.
- **The code viewer is a full-screen overlay** with wrap on by default —
  without it, one file needed 706px of horizontal scroll in a 390px viewport.
- **The Android back button** dismisses the command palette, then the drawer,
  then the code pane, then the selection, before exiting. Registered as a stack
  in `web/src/lib/backButton.js` so future overlays can join it.
- **The command palette** is reachable from the drawer's *Search everything*
  button, since a phone has no ⌘ key, and sits higher on screen so the
  on-screen keyboard doesn't cover its results.

---

## Icons and branding

All launcher icons are generated from one source file, `86.svg` at the repo
root:

```bash
node scripts/make-logo.mjs      # then rebuild the APK
```

That writes `web/public/logo.svg`, `web/public/icon.svg` and every
`android/…/mipmap-*` launcher PNG including the adaptive foreground.
Rasterisation uses the Playwright Chromium that is already installed — one
fewer dependency, and the same engine that renders the app.

The mark is 1.545:1 and every icon slot is 1:1, so square variants centre and
inset it. Adaptive foregrounds get a much larger margin (0.46 vs 0.74) because
launchers crop to a circle inside the 108dp square.

---

## Troubleshooting

### `npm error EIO: i/o error, unlink … esbuild.exe`

The host's `node_modules` is visible to the container. See
[the node_modules trap](#the-node_modules-trap). If you have modified
`docker-build.sh`, restore the named-volume masking.

### The host's `npm run build` broke right after an APK build

Same cause. Repair with `npm install` from the repo root.

### Every `docker` command hangs

Docker Desktop's engine is wedged — processes alive for days, WSL distro
`Running`, CLI hanging. Kill Docker Desktop and `com.docker.backend`, run
`wsl -t docker-desktop`, relaunch. **Never `wsl --shutdown`**; it kills your
other distros too. Confirm `docker info` responds before blaming a Dockerfile —
a wedged engine makes healthy images look broken, which is exactly how the
"sdkmanager step is broken" theory arose here. It wasn't.

### `exec: java: not found`

You used `bash -lc` instead of `bash -c`. See
[Verifying a build](#verifying-a-build).

### The APK installed but shows a blank white screen

`web/dist` was empty or stale when `cap sync` ran. Rebuild:

```bash
npm run sync:android
```

Then inspect the running WebView via `chrome://inspect` for the real error.

### `cap sync` reports no plugins

Look for the `Found N Capacitor plugins` line. **Capacitor plugins must be
declared in the ROOT `package.json`**, not in `web/`. The CLI reads the root
manifest to register native plugins; a plugin installed in a workspace syncs
with no warning and no such line — the JS import still resolves via hoisting,
so it looks fine on the web and silently does nothing on the device. Check that
line after any plugin change.

### A build or drive takes tens of seconds scanning files

`cap sync` copies the built `dist` into `android/app/src/main/assets/public` —
megabytes of minified one-line JS **inside the repo tree**. Any corpus walk
that doesn't skip `android/` feeds those bundles back into the parser. The
skip lists in `extract/node.mjs`, `web/src/lib/corpus.js` and `web/_drive.mjs`
all exclude it, and `corpus.js` additionally guards on `looksMinified`
(>400 chars per line on average). Keep those lists in step.

### Moving or deleting `web/android` fails with "Device or resource busy"

A running Vite dev server holds watcher handles on the whole `web/` tree. Find
the process **by listening port** and kill that one. Do not kill `node.exe`
blindly — Claude Code itself runs on node.

### Gradle can't find the SDK on the host route

Set `ANDROID_HOME` (and `JAVA_HOME` → JDK 21). Or sidestep it entirely and use
the Docker route, which is why it exists.

---

## See also

- [RUNNING-WEB.md](RUNNING-WEB.md) — the web app the shell wraps
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pipeline works
- [CONTRACT.md](CONTRACT.md) — the JSON shapes
