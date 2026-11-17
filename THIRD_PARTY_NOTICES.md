# Third-Party Notices & Asset Attribution

This document records the source, license, and usage conditions for every brand mark and third-party icon included in **Spawnea Mobile**.

## First-Party & Upstream Project Marks

| Asset | Usage | Source | License / Conditions |
|---|---|---|---|
| **Spawnea mark** | Launcher (`ic_launcher`, `ic_launcher_round`, `ic_launcher_foreground`, `ic_launcher_monochrome`), splash (`ic_splash_logo`), and `SpawneaMarkIcon` | Vectorized faithfully from `spawnea/docs/assets/spawnea-logo.png` (`#009ebb`, `#6a5bfd`, `#c3e71c`) | Apache License 2.0 (`spawnea` repository `LICENSE`). Preserves original shapes and colors without reinterpretation. |
| **Growth Push mark** | Splash branding (`ic_splash_branding`; **shown only on Android 12+ / API 31+**, see below) and Settings footer signature (`by Growth Push`) | `growth-push-runbook/customers/growth-push/p2_landing_site/assets/growth-push-logo.svg` (`approved_v1`) | First-party Growth Push brand asset. Used per `brand_identity.md`: symbol minimum size >= 32 px, clear space >= green node diameter (~17% of symbol width), original colors (`#00A7C2`, `#6D5DFC`, `#C6F432`). |

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
