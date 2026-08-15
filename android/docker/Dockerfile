# Toolchain image for the Grapheon Android build.
#
# Contains ONLY tools — Node 22 (web build + Capacitor sync), Temurin JDK 21,
# and the Android SDK. The repo is volume-mounted at build time, which keeps
# the keystore and its passwords out of image layers entirely: an image push
# can never leak signing material because it was never in the image.
#
# Versions pinned to what the project actually uses:
#   AGP 8.13 / Gradle 8.14 (wrapper) / compileSdk 36 / JDK 21

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/opt/java/temurin-21

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl unzip ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Temurin JDK 21 (Adoptium GA archive; apt repo adds moving parts for no gain)
RUN curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" \
      -o /tmp/jdk.tar.gz \
    && mkdir -p "$JAVA_HOME" \
    && tar -xzf /tmp/jdk.tar.gz -C "$JAVA_HOME" --strip-components=1 \
    && rm /tmp/jdk.tar.gz

ENV PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Android SDK: command-line tools, then the pieces AGP 8.13 needs for sdk 36.
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
       -o /tmp/clt.zip \
    && unzip -q /tmp/clt.zip -d "$ANDROID_HOME/cmdline-tools" \
    && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
    && rm /tmp/clt.zip \
    && yes | sdkmanager --licenses \
    && sdkmanager --install \
       "platform-tools" \
       "platforms;android-36" \
       "build-tools;36.0.0"

WORKDIR /work

# The whole chain: web build -> capacitor sync -> signed release APK.
# gradlew is invoked via sh because a Windows-mounted volume loses exec bits.
#
# `bash -c`, NOT `bash -lc`: a login shell re-sources /etc/profile, which
# REPLACES the PATH this image set — so $JAVA_HOME/bin and the SDK tools vanish
# and anything calling `java` directly dies with "exec: java: not found". The
# build itself survived that (gradle finds java via JAVA_HOME) which is exactly
# why it stayed hidden; apksigner, run the same way, did not.
CMD ["bash", "-c", "npm ci && npm run build && npx cap sync android && cd android && sh gradlew assembleRelease --console=plain"]
