# Spawnea Mobile

Android companion client for the private Spawnea Mobile HTTP API, built with React Native and TypeScript.

## Prerequisites

- Node.js `>= 22.11.0` and npm
- JDK (`javac` required for Gradle)
- Android SDK (compileSdk `37`, targetSdk `36`, build-tools `37.0.0`, NDK `27.1.12297006`)
- Set `JAVA_HOME`, `ANDROID_HOME`, and `ANDROID_SDK_ROOT` in your shell environment.

## Install Dependencies

```bash
npm install --ignore-scripts
```

## Verification Checks

```bash
npm run typecheck
npm run lint
npm test -- --watchAll=false
cd android && ./gradlew :app:testDebugUnitTest
```

## Building Android APKs

### Debug APK (bundled JavaScript for standalone device testing)

```bash
cd android && ./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

### Release APK (bundled JavaScript)

To build an unsigned release APK for verification or external signing:

```bash
cd android && ./gradlew assembleRelease
```

Output (unsigned): `android/app/build/outputs/apk/release/app-release-unsigned.apk`

To build a signed release APK, provide all four release signing settings via environment variables or Gradle properties (for example, in a private `~/.gradle/gradle.properties` or `-P` flags) and keep keystores and passwords outside version control:

- `SPAWNEA_RELEASE_STORE_FILE`: Path to your private release keystore file (absolute, or relative to `android/`)
- `SPAWNEA_RELEASE_STORE_PASSWORD`: Keystore password
- `SPAWNEA_RELEASE_KEY_ALIAS`: Signing key alias
- `SPAWNEA_RELEASE_KEY_PASSWORD`: Signing key password

```bash
cd android && \
  SPAWNEA_RELEASE_STORE_FILE=/path/to/release.keystore \
  SPAWNEA_RELEASE_STORE_PASSWORD=... \
  SPAWNEA_RELEASE_KEY_ALIAS=... \
  SPAWNEA_RELEASE_KEY_PASSWORD=... \
  ./gradlew assembleRelease
```

Output (signed): `android/app/build/outputs/apk/release/app-release.apk`

> Note: Never commit release keystores or signing credentials to the repository. Providing only a subset of the four signing variables fails the build rather than falling back to the debug keystore.

## Transport & Credential Security

- **HTTPS enforcement**: Release builds disallow cleartext HTTP traffic (`usesCleartextTraffic="false"`). Debug builds restrict cleartext traffic via `android/app/src/debug/res/xml/network_security_config.xml` exclusively to `127.0.0.1` and `localhost` for local ADB-reversed testing.
- **Backup prohibition**: `android:allowBackup="false"` is set in `android/app/src/main/AndroidManifest.xml` so application storage is excluded from Android backups.
- **Protected key storage**: API keys are encrypted and stored exclusively by the custom native `SpawneaKeystore` Android module (`AES/GCM/NoPadding`, 256-bit key in `AndroidKeyStore`) with `setUserAuthenticationRequired(true)`, per-use biometric authentication (`0` validity + `AUTH_BIOMETRIC_STRONG` on API 30+, validity `-1` below API 30), and `setInvalidatedByBiometricEnrollment(true)`.
  - **Strong biometrics only (no PIN fallback)**: Every save and unlock uses `BiometricPrompt` with `BIOMETRIC_STRONG` and a `CryptoObject`; device credential (PIN/pattern/password) fallback is disabled, and missing returned `CryptoObject`/`Cipher` instances fail closed.
  - **Atomic credential replacement**: Server URL and active encrypted key slot metadata are persisted together in one durable native record with two-slot Keystore alias rotation and rollback on commit failure, with three outcomes: success; failure with a verified rollback, which keeps the previous valid URL+key pair; or an uncertain outcome (`E_COMMIT_UNCERTAIN`) when the rollback cannot be verified, in which case the previous configuration is not guaranteed to be kept. A cancelled replacement or a failure with a verified rollback leaves the previous configuration in place. On an uncertain outcome the app shows the fixed message "Could not confirm which configuration is saved. Test the connection or re-enter the key." At startup the app recovers whichever saved metadata references an existing key; Keystore aliases are removed only by an explicit Delete or when the next save regenerates the inactive slot.
  - **Lockout & re-link behavior**: Repeated failed fingerprint attempts trigger `E_BIOMETRIC_LOCKOUT` / `E_BIOMETRIC_LOCKOUT_PERMANENT` with no PIN fallback. Adding or changing biometric enrollments permanently invalidates the Keystore key (`KeyPermanentlyInvalidatedException` -> `E_AUTH_INVALIDATED`), requiring the user to re-link the key in Settings.
  - **Foreground-session in-memory polling unlock**: Because Android Keystore requires `BIOMETRIC_STRONG` per cryptographic use (`0` validity), background-paused Dashboard polling unlocks the API key via `BiometricPrompt` once per active foreground session into a memory-only JavaScript cache (`SessionCredentialCache`), bound to the API client's credential generation. It is never persisted to disk, `AsyncStorage`, logs, or UI state; pending unlocks are invalidated if the app leaves foreground or the credential generation changes, and the cached reference plus any terminal-auth state is cleared centrally when leaving the foreground (`background` / `inactive`), on biometric lockout or key invalidation, on missing credentials, and on Settings save, commit, or delete outcomes. (`Settings -> Test connection` still prompts per explicit check, and note that JavaScript strings in Hermes/V8 are immutable so clearing drops the in-memory reference for garbage collection while native Keystore buffers are zeroed immediately.)
  - Keys are never persisted in `AsyncStorage` or displayed after saving, and decrypted plaintext buffers in native code are zeroed immediately after use.
- **Inspector redaction**: Spawnea API HTTP calls run through the native `SpawneaHttp` OkHttp module rather than React Native's `NetworkingModule`, preventing `Authorization` headers from being forwarded to DevTools/CDP network inspection in debug builds.
