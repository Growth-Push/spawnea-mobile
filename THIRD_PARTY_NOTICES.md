# Third-Party Notices & Asset Attribution

This document records the source, license, and usage conditions for every brand mark and third-party icon included in **Spawnea Mobile**.

## First-Party & Upstream Project Marks

| Asset | Usage | Source | License / Conditions |
|---|---|---|---|
| **Spawnea mark** | Launcher (`ic_launcher`, `ic_launcher_round`, `ic_launcher_foreground`, `ic_launcher_monochrome`), splash (`ic_splash_logo`), and `SpawneaMarkIcon` | Vectorized faithfully from `spawnea/docs/assets/spawnea-logo.png` (`#009ebb`, `#6a5bfd`, `#c3e71c`) | Apache License 2.0 (`spawnea` repository `LICENSE`). Preserves original shapes and colors without reinterpretation. |
| **Growth Push mark** | Splash branding (`ic_splash_branding`; **shown only on Android 12+ / API 31+**, see below) and Settings footer signature (`by Growth Push`) | Growth Push logo (approved first-party SVG) | First-party Growth Push brand asset. Original colors (`#00A7C2`, `#6D5DFC`, `#C6F432`), shown at a symbol size of at least 32 px with clear space around the mark. |

**Trademarks.** The Apache License 2.0 that covers this repository's code (Section 6) does not grant permission to use the Growth Push or Spawnea names, logos or marks, which are reserved to their owners, except for reasonable and customary descriptive use. Forks should replace the launcher icon, splash and "by Growth Push" signature with their own branding.

## Splash signature availability

The splash uses `androidx.core:core-splashscreen` (minSdk 24). The «by Growth Push» signature is supplied through `android:windowSplashScreenBrandingImage`, which only exists in the platform splash of **Android 12 / API 31 and above**. On API 24-30 the compat splash shows the Spawnea mark on the dark background **without** the signature. The signature in Settings is shown on every API level.

## Agent / Harness Icons (`src/dashboard/DashboardIcons.tsx`)

Detection mirrors `spawnea/apps/desktop/src/renderer/src/components/AgentIcon.tsx` (`detectProviderType`) but matches whole tokens of the harness id/name and the executable basename of the command, not substrings of the full command line. Unrecognized values, interactive shells (`none`, `terminal`, `zsh`, ...) and any provider without a verified source render the local `[>_]` glyph.

**Verification method.** Every vector path copied from `AgentIcon.tsx` / `OsIcon.tsx` was compared, after number normalization, against all SVGs of the npm packages `simple-icons` and `@lobehub/icons-static-svg`, downloaded to a temporary directory outside the repo (not dependencies of this project; paths are copied into `src/dashboard/iconPaths.ts`). Only exact path matches are kept; they are listed with package, version, slug and license. Colors are this app's palette; geometry is the upstream path. Fills below 3:1 contrast on the dark surfaces (`#0d1117`, `#111620`, `#161b22`, `#181b22`, `#232c38`) are replaced by the monochrome `color` prop (a test checks every fixed color). The licenses cover the SVG files, not the trademarks: brand marks belong to their owners and are shown only to identify the harness.

| Provider | Source | Package @ version | Slug | License | Result |
|---|---|---|---|---|---|
| Claude | Lobe Icons | `@lobehub/icons-static-svg@1.103.0` | `claude` | MIT | Exact match, keep. Fill `#D97757` |
| Antigravity | Lobe Icons | `@lobehub/icons-static-svg@1.103.0` | `antigravity` | MIT | Exact match, keep |
| DeepSeek | Lobe Icons | `@lobehub/icons-static-svg@1.103.0` | `deepseek` | MIT | Exact match, keep |
| Kimi | Lobe Icons | `@lobehub/icons-static-svg@1.103.0` | `kimi` | MIT | Exact match, keep |
| Ollama | Lobe Icons | `@lobehub/icons-static-svg@1.103.0` | `ollama` | MIT | Exact match, keep |
| Gemini | Lobe Icons | `@lobehub/icons-static-svg@1.103.0` | `gemini` | MIT | Exact match, keep |
| Cursor | Lobe Icons | `@lobehub/icons-static-svg@1.103.0` | `cursor` | MIT | Exact match, keep |
| GitHub Copilot | Simple Icons | `simple-icons@16.38.0` | `githubcopilot` | CC0-1.0 | Exact match, keep |
| Mistral AI | Simple Icons | `simple-icons@16.38.0` | `mistralai` | CC0-1.0 | Exact match, keep |
| Qwen | Simple Icons | `simple-icons@16.38.0` | `qwen` | CC0-1.0 | Exact match, keep. Fixed `#6950EF` is 2.68:1, so it renders in the monochrome prop color |
| Llama (Meta) | Simple Icons | `simple-icons@16.38.0` | `meta` | CC0-1.0 | Exact match, keep. Fixed `#0467DF` is 2.69:1, so it renders in the monochrome prop color |
| Codex / OpenAI | Simple Icons | `simple-icons@15.22.0` (also 13.21.0, 14.15.0) | `openai` | CC0-1.0 | Exact match to the version that still shipped the mark; removed from `simple-icons@16.x`. Keep, pinned to that version here |
| Grok (xAI) | Official favicon `https://grok.com/images/favicon.svg` | n/a | n/a | xAI brand guidelines (`https://x.ai/legal/brand-guidelines`) | All 3 paths found verbatim in the file fetched on 2026-11-17. Kept unchanged (own `#050505` tile, so no contrast rule applies) |
| Hermes | Lobe Icons | `@lobehub/icons-static-svg@1.103.0` | `hermesagent` | MIT | Three paths copied verbatim (monochrome source). Fill `#F59E0B` is this app's accent (6.57:1 on the dark surfaces); no match with the globe in `AgentIcon.tsx`, which is no longer used |

## Host / Operating System Icons (`src/dashboard/DashboardIcons.tsx`, paths in `src/dashboard/iconPaths.ts`)

Detection mirrors `OsIcon.tsx` (`detectOsType`) with whole-token matching (`Local · Arch` is Arch; `search`, `archive`, `machine`, `unix` are not). The artwork in `OsIcon.tsx` has no verified source, so it is **not used**; the marks below come from **`simple-icons@16.38.0`, license CC0-1.0**, pinned to that version and copied (not a dependency). Brand marks belong to their owners and are shown only to identify the host OS. Fills use the official brand hex from the package data when it reaches 3:1 on the dark surfaces (`#0d1117`, `#111620`, `#161b22`, `#181b22`, `#232c38`); otherwise the monochrome `color` prop (`#8b949e` on host rows) is used. A test checks every color.

| Detected OS | Slug | Brand hex | Min contrast on dark | Rendered fill |
|---|---|---|---|---|
| Arch | `archlinux` | `#1793D1` | 4.12 | brand |
| Ubuntu | `ubuntu` | `#E95420` | 3.86 | brand |
| Debian | `debian` | `#A81D33` | 1.94 | monochrome |
| Raspberry Pi OS | `raspberrypi` | `#A22846` | 1.97 | monochrome |
| Fedora | `fedora` | `#51A2DA` | 5.06 | brand |
| Red Hat | `redhat` | `#EE0000` | 3.11 | brand |
| CentOS | `centos` | `#262577` | 1.08 | monochrome |
| Rocky Linux | `rockylinux` | `#10B981` | 5.56 | brand |
| AlmaLinux | `almalinux` | `#000000` | 1.11 | monochrome |
| Alpine Linux | `alpinelinux` | `#0D597F` | 1.85 | monochrome |
| NixOS | `nixos` | `#5277C3` | 3.21 | brand |
| openSUSE | `opensuse` | `#73BA25` | 5.90 | brand |
| macOS | `apple` | `#000000` | 1.11 | monochrome |
| Linux | `linux` | `#FCC624` | 8.89 | brand |
| FreeBSD | `freebsd` | `#AB2B28` | 2.09 | monochrome |
| Windows, Gentoo, Void, Kali, unknown | n/a | n/a | n/a | **Generic monitor glyph**: no approved verified source |

## Session status glyphs (`src/dashboard/StatusGlyphs.tsx`)

The seven status glyphs reproduce the canonical mapping of Spawnea Desktop's `StatusBadge.tsx` (verified against its code, which matches its comments): starting → Loader2, working → Radio, needs_input → MessageSquare, done → CheckCircle2, error → AlertCircle, disconnected → Unplug, idle → Clock. The geometries are copied (not a dependency) from **`lucide-react@1.70.0`, license ISC** (© Lucide Icons and Contributors), and drawn with `react-native-svg` (24×24 viewBox, stroke, round caps and joins). Unknown statuses use an explicit fallback glyph, also from lucide.

| Status | Glyph shown | lucide icon file (alias) |
|---|---|---|
| starting | Loader2 | `loader-circle` (`loader-2`) |
| working | Radio | `radio` |
| needs_input | MessageSquare | `message-square` |
| done | CheckCircle2 | `circle-check` (`check-circle-2`) |
| error | AlertCircle | `circle-exclamation-point` (`alert-circle`) |
| disconnected | Unplug | `unplug` |
| idle | Clock | `clock` |
| unknown status | question-mark circle (fallback) | `circle-question-mark` |

ISC License. Copyright (c) 2026 Lucide Icons and Contributors. Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.

### Feather-derived glyphs (MIT)

`lucide-react@1.70.0` ships a `LICENSE` that lists the icons below as derived from the Feather project, under the MIT License, Copyright (c) 2013-present Cole Bemis. Four of the glyphs in `StatusGlyphs.tsx` are on that list:

| Status | lucide icon (alias in the Feather-derived list) |
|---|---|
| working | `radio` |
| idle | `clock` |
| error | `circle-exclamation-point` (`alert-circle`) |
| unknown status (fallback) | `circle-question-mark` (`help-circle`) |

The MIT License (MIT) (for the icons listed above). Copyright (c) 2013-present Cole Bemis. Permission is hereby granted, free of charge, to any person obtaining a copy of the Software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Lobe Icons (MIT)

The Claude, Antigravity, DeepSeek, Kimi, Ollama, Gemini, Cursor and Hermes marks in `src/dashboard/iconPaths.ts` are copied from `@lobehub/icons-static-svg@1.103.0` (<https://github.com/lobehub/lobe-icons>), distributed under the MIT License:

> MIT License
>
> Copyright (c) 2023 LobeHub
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The CC0-1.0 marks from Simple Icons require no attribution; they are listed above for traceability.

## Runtime and build dependencies

Dependencies are **not vendored** in this repository; they are installed from the registries named in `package-lock.json` and the Gradle build. License metadata recorded in `package-lock.json` (891 packages, of which 251 are not dev-only) is permissive throughout:

- Production packages: MIT (212), ISC (18), BSD-2-Clause (8), BSD-3-Clause (5), Apache-2.0 (2 plus 1 dual MIT/Apache-2.0), CC0-1.0, BlueOak-1.0.0, 0BSD, a dual MIT/CC0-1.0, and `caniuse-lite` (CC-BY-4.0 browser-data; build-time only, not shipped in the APK).
- No GPL, AGPL, LGPL or other copyleft packages are present. One development-only package (`exit`) carries no `license` field in the lock file; its published manifest declares MIT.
- Android native dependencies pulled by Gradle (React Native, Hermes, OkHttp, AndroidX Biometric, AndroidX Core SplashScreen) are MIT or Apache-2.0.

Anyone distributing a built APK is responsible for bundling the notices those licenses require (for example an open-source licenses screen); this repository ships source only.
