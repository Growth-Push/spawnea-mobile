# Security Policy

## Supported versions

Spawnea Mobile is early-stage software (`0.0.x`). Only the latest commit on the default branch is supported.

## Reporting a vulnerability

Please do not open a public issue for security problems, especially anything involving API key storage, biometric handling, the native network module, or transport security.

Report privately through [GitHub Security Advisories](https://github.com/Growth-Push/spawnea-mobile/security/advisories/new) for this repository.

Include, when possible:

- the affected commit or version;
- reproduction steps and the Android version/device or emulator used;
- the impact you observed;
- logs or screenshots with secrets, server URLs and API keys removed.

## What not to commit

Never commit release keystores, signing passwords, API keys, server URLs of real deployments, or logs. The only keystore in this repository is the standard public Android debug key used for debug builds.

See [`docs/security-design.md`](docs/security-design.md) for how the app handles transport and credentials.
