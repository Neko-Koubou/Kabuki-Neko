# Third-party notices — Kabuki Neko

Inventory captured 2026-10-31 (Asia/Jakarta), from the pinned manifests, lockfile and installed package metadata. Third-party components retain their own licenses; the project LICENSE does not relicense them.

## Product license and policy gap

The project LICENSE contains the complete [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) plus the official [Commons Clause v1.0](https://commonsclause.com/), with only the application identification fields filled in. Copyright holder label: Kabuki Neko contributors.

Commons Clause restricts selling software/services whose value derives entirely or substantially from the software. It is not a blanket prohibition of every commercial use or every value-added derivative product. Its FAQ expressly describes permitted value-added commercial products. Consequently the broader “strictly non-commercial / all modified-code resale / all monetization” wording in PRD §1.4 is not automatically implemented by these standard texts. No additional legal clause has been invented. Owner review of this scope difference is an open US-19/release requirement; the application must not promise broader restrictions than the actual license.

Source integrity:

- Apache source SHA-256: `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.
- Commons Clause [upstream HTML source](https://github.com/fossas/commons-clause/blob/master/src/index.html) SHA-256: `cbe974904942fc88a9445c25adb00166d9cb585b99e8023ab2419fcc16ec2e54`; substantive paragraphs are copied verbatim.

## Distribution obligations and pending assets

- Preserve upstream license/copyright/NOTICE files in distributions. This inventory is not a replacement for those texts. TASK-174/181 must verify the actual production bundles and target-platform native libraries.
- DiceBear code and avatar artwork have separate terms, including CC-BY-4.0 for several collections. Attribution, source and license links for the six offered styles are in “DiceBear avatar artwork” below; the avatar component (TASK-123) must add any artwork modification it applies there. Installing the aggregate collection does not grant a new license to its artwork.
- Sharp includes libvips under LGPL-3.0-or-later. Preserve its license/source and applicable relinking obligations; validate the actual Linux image contents at release.
- MPL-2.0 packages (including axe and Lightning CSS) retain their file-level licensing requirements. CC-BY data such as caniuse-lite retains attribution requirements.
- Test services are independent processes: PostgreSQL16, MySQL8, Redis7 and MinIO. MinIO test source is [official commit 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a](https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a), AGPL-3.0; the test image retains its LICENSE and source provenance. Production service images and Go/base-image inventories remain release checks.
- Brand assets were added in TASK-113 (see “Kabuki Neko brand assets” below). The self-hosted Noto Sans font (TASK-115) is under OFL-1.1; see “Noto Sans font” below, which includes the full license text that must accompany it.
- Legal texts ship with the web app: `pnpm exec tsx scripts/package-assets.ts` verifies the assets and checksums listed in this file and copies `LICENSE` and this file byte-for-byte to `/legal/LICENSE.txt` and `/legal/THIRD-PARTY-NOTICES.txt`.
- Audio assets: see “Audio assets (third-party, release-unverified)” below. Their distribution rights are not yet confirmed.
- `pause@0.0.1` has no package.json license field, so pnpm reports Unknown. Its installed Readme.md includes the full MIT license and copyright (c) 2012 TJ Holowaychuk. The inventory below records this inspected MIT evidence.

## Audio assets (third-party, release-unverified)

The 20 supplied audio files in `audio-assets/kabuki-neko-audio/` (10 BGM, 10 SFX) and the 40 WebM/MP3 files generated from them by `pnpm audio:optimize` are **not** covered by the project LICENSE. Copyright stays with the individual composers/creators who publish them on OpenTracks (formerly DOVA-SYNDROME) under the [OpenTracks Audio Source Usage License](https://opentracks.com/en/help/articles/license/) plus any creator-specific conditions. Per-track titles, composers and source links are in the [audio credits](audio-assets/kabuki-neko-audio/CREDITS.md) (copied byte-for-byte to `/audio/CREDITS.md`), and per-file SHA-256, duration, outputs and verification evidence are in [`docs/audio-provenance.json`](docs/audio-provenance.json).

Checked on 2026-11-08 against the official license page and each BGM source page:

- Seven BGM tracks match their source page title and composer; `bgm-lobby-neko8bit` matches after correcting the supplied title typo (“ICat sonata” → “Cat sonata - 8bit”). Two malformed source links (`hhttps://`, `https://https://`), the stale license link and the SFX library link were repaired.
- `bgm-lobby-matcha` (#13513) and `bgm-think-sprint` (#3300) do not match their source pages (title/composer); the asset owner must confirm the correct source. The ten SFX only have a general library link, with no per-file source or creator.
- The OpenTracks license permits format conversion and editing, but asks tool apps/platforms to consult site management before embedding audio and licensing it to their users, and prohibits distributing the audio files themselves or using them where end users can easily access and copy the audio files.

**Release status: release-unverified.** No written permission exists yet for embedding these files in a self-hostable platform, storing them in this repository, or serving them as downloadable files. Until that permission is obtained, or the assets are replaced by audio whose terms allow it, do not treat the audio as cleared for release or redistribution. This notice records evidence; it is not legal advice.

## Kabuki Neko brand assets

Original artwork created for this project in TASK-113 (2026-11-08). No third-party artwork, fonts, templates or generated stock images were used, and no external references are embedded. The files are part of the repository and are covered by the project LICENSE (Apache License 2.0 with Commons Clause; copyright holder label: Kabuki Neko contributors).

| File                                | viewBox / intrinsic size | Purpose and accessibility                                                                                                                                                                                                                                                                              | SHA-256                                                            |
| ----------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `apps/web/public/brand/logo.svg`    | `0 0 400 96` (400×96)    | Informative logo: cat mark + “Kabuki Neko” wordmark, `role="img"` with `<title>`. Wordmark switches ink `#18181B` / `#FAFAFA` (and accent `#D9381E` / `#FF8A75`) with `prefers-color-scheme`; use at ≥ 32 px height so the wordmark stays legible. Text uses the app font stack with system fallbacks. | `209f0c42fd929aad2a297b34bf9835700b45304cd8739ffcc5010d67829fb1a5` |
| `apps/web/public/brand/mascot.svg`  | `0 0 320 320` (320×320)  | Decorative kabuki cat mascot (crimson kumadori, gold crest, neutral friendly expression), `aria-hidden="true"`; never conveys information on its own.                                                                                                                                                  | `328cb58de046efe3c98744d5312824c16a97f3936cf232c15fb7ecab7e052e8d` |
| `apps/web/public/brand/favicon.svg` | `0 0 32 32` (32×32)      | Favicon/app icon: bold cat head on a crimson tile, no text, recognizable at 16 px; `role="img"` with `<title>`.                                                                                                                                                                                        | `cfee39309787335adc54ba9bd8d83607fb78169a6121fb61b11aecea429989e7` |

Verified 2026-11-08 in Chromium: each file decodes at 16, 32, 128 and 320 px on light (`#FAFAF9`) and dark (`#18181B`) canvases; contains no `script`, `foreignObject`, `image`, `use`, links, event attributes or `url()` references; the logo wordmark computes to `rgb(24, 24, 27)` in light and `rgb(250, 250, 250)` in dark color schemes. Palette: Kumadori Crimson `#D9381E`, Kabuki Gold `#F59E0B`, Sumi Ink `#18181B`, face paint `#FFF8F0`.

## Noto Sans font

The web app self-hosts one Noto Sans file. It is used unmodified (byte-identical to the file published upstream); subsetting and WOFF2 compression were done by Google Fonts/Fontsource. It is not sold on its own, no Reserved Font Name is declared in its copyright notice, and it remains under the SIL Open Font License 1.1 reproduced below.

| File                                          | Upstream font                                                                                                                                                                  | Packaged from                                                                                                                                                                                                                                                                       | Coverage                                                                                                                                                             | Bytes  | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `apps/web/public/fonts/noto-sans-latin.woff2` | Noto Sans (Google Fonts v42, font version 2.015), Copyright 2022 The Noto Project Authors, [notofonts/latin-greek-cyrillic](https://github.com/notofonts/latin-greek-cyrillic) | [`@fontsource-variable/noto-sans@5.3.0`](https://www.npmjs.com/package/@fontsource-variable/noto-sans/v/5.3.0), file `files/noto-sans-latin-wght-normal.woff2`; tarball integrity `sha512-e3ZuxzY9AL2psXPZlhwhnYrHUHv6PMoyK9MQ7croF0CUgURLqu9EMjW7q2FgVLwij1tjLsIHQrnwQ8aUcg4BiA==` | Latin subset (232 code points: Basic Latin, Latin-1, Œœ, general punctuation, €, ™ and arrows); variable `wght` axis 100–900, used for weights 400, 600, 700 and 800 | 35,820 | `51ca196f49a33e79e7870ff88ebd2829a3f627a51e7d690986618f0e7ad2b52d` |

Verified 2026-11-08: the npm tarball matches its registry integrity; the file decodes as WOFF2 with a `wght` 100–900 axis; every character used by the `en`, `id`, `es` and `fr` catalogs is mapped. `globals.css` declares it with `font-display: swap` and the upstream Latin `unicode-range`, so Japanese and Chinese text uses the system CJK font (`system-ui, sans-serif`) and no CJK font is shipped. The license below is the package `LICENSE` file, SHA-256 `54ec7b5a35310ad66f9f3091426f7028484cbf9ae1ab5da30122ee412a3009e1`.

```text
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) NotoSans-Italic[wdth,wght].ttf: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## DiceBear avatar artwork

Avatars are generated in the browser by `@dicebear/core@9.4.3` and `@dicebear/collection@9.4.3` (code: MIT, Copyright (c) 2024 Florian Körner). Only the six styles in `AVATAR_STYLES` (`packages/shared/src/constants/game.ts`) are offered. Each style's artwork has its own license, separate from the code, as stated in that package's `LICENSE` file:

| Style        | Package                      | Artwork source                                                           | Designer                                                              | Artwork license                                                                  | Package `LICENSE` SHA-256                                          |
| ------------ | ---------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `bottts`     | `@dicebear/bottts@9.4.3`     | [Bottts](https://bottts.com/)                                            | Pablo Stanley ([@pablostanley](https://twitter.com/pablostanley))     | “Free for personal and commercial use” ([bottts.com](https://bottts.com/))       | `acd6f6ef6023dfaea0bdb807c8fd2dba1fdd57bf0b4392e590a34783f172da65` |
| `adventurer` | `@dicebear/adventurer@9.4.3` | [Adventurer](https://www.figma.com/community/file/1184595184137881796)   | Lisa Wischofsky ([lischi_art](https://www.instagram.com/lischi_art/)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)                        | `70d3a4720b200e07345ebd0094abec1136a4929f7ddf44914ad12f5711068e3b` |
| `fun-emoji`  | `@dicebear/fun-emoji@9.4.3`  | [Fun Emoji Set](https://www.figma.com/community/file/968125295144990435) | Davis Uche ([davedirect3](https://www.instagram.com/davedirect3/))    | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)                        | `e261c5aefb2c9809304478fc583922e20d0b45276730813d83fa0f6e1ff31a6a` |
| `pixel-art`  | `@dicebear/pixel-art@9.4.3`  | [Pixel Art](https://www.figma.com/community/file/1198754108850888330)    | DiceBear ([dicebear.com](https://www.dicebear.com))                   | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)                    | `00c3ee5db6054cecade0208802a41ad1a0fb3d12c7ea152e104bac39cf1e8a2c` |
| `lorelei`    | `@dicebear/lorelei@9.4.3`    | [Lorelei](https://www.figma.com/community/file/1198749693280469639)      | Lisa Wischofsky ([lischi_art](https://www.instagram.com/lischi_art/)) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)                    | `30c2142af0c739cea924365f6223654c1ffea79f166d6c591258466a53908a5e` |
| `avataaars`  | `@dicebear/avataaars@9.4.3`  | [Avataaars](https://avataaars.com/)                                      | Pablo Stanley ([@pablostanley](https://twitter.com/pablostanley))     | “Free for personal and commercial use” ([avataaars.com](https://avataaars.com/)) | `61af36b4a3c6c9c3e4b0f66f484eacec0190c4d9bbcd01e39d9e1e230d6c1897` |

- CC BY 4.0 attribution: “Adventurer” by Lisa Wischofsky and “Fun Emoji Set” by Davis Uche, licensed under CC BY 4.0, rendered through DiceBear. The project draws the artwork through DiceBear with options chosen from each player's seed and does not edit it. If the avatar component (TASK-123) applies an option that changes the artwork (background, colors, flip, rotation, clipping), it must be listed here as a modification.
- “Free for personal and commercial use” is the designer's own wording as recorded by the package, not a standard license; no broader terms are inferred from it.
- `@dicebear/collection` also installs the other DiceBear styles (see the inventory below). They are not offered by the app, and their artwork licenses are not covered by this section.

## Direct dependencies

Versions are exact. “dev” identifies tooling/harness usage, not a production dependency claim.

| Package                                                                                                         | Version  | License metadata | Used by                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [@aws-sdk/client-s3](https://www.npmjs.com/package/@aws-sdk/client-s3/v/3.1160.0)                               | 3.1160.0 | Apache-2.0       | kabuki-neko (dev); @kabuki-neko/api (runtime)                                                                             |
| [@aws-sdk/s3-request-presigner](https://www.npmjs.com/package/@aws-sdk/s3-request-presigner/v/3.1160.0)         | 3.1160.0 | Apache-2.0       | @kabuki-neko/api (runtime)                                                                                                |
| [@axe-core/playwright](https://www.npmjs.com/package/@axe-core/playwright/v/4.14.0)                             | 4.14.0   | MPL-2.0          | kabuki-neko (dev)                                                                                                         |
| [@dicebear/collection](https://www.npmjs.com/package/@dicebear/collection/v/9.4.3)                              | 9.4.3    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [@dicebear/core](https://www.npmjs.com/package/@dicebear/core/v/9.4.3)                                          | 9.4.3    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [@dnd-kit/core](https://www.npmjs.com/package/@dnd-kit/core/v/6.3.1)                                            | 6.3.1    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [@dnd-kit/sortable](https://www.npmjs.com/package/@dnd-kit/sortable/v/10.0.0)                                   | 10.0.0   | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [@dnd-kit/utilities](https://www.npmjs.com/package/@dnd-kit/utilities/v/3.2.2)                                  | 3.2.2    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [@eslint/js](https://www.npmjs.com/package/@eslint/js/v/10.0.1)                                                 | 10.0.1   | MIT              | kabuki-neko (dev)                                                                                                         |
| [@formatjs/icu-messageformat-parser](https://www.npmjs.com/package/@formatjs/icu-messageformat-parser/v/3.5.22) | 3.5.22   | MIT              | kabuki-neko (dev); @kabuki-neko/api (runtime); @kabuki-neko/web (runtime)                                                 |
| [@hookform/resolvers](https://www.npmjs.com/package/@hookform/resolvers/v/6.0.2)                                | 6.0.2    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [@nestjs/cli](https://www.npmjs.com/package/@nestjs/cli/v/11.0.24)                                              | 11.0.24  | MIT              | @kabuki-neko/api (dev)                                                                                                    |
| [@nestjs/common](https://www.npmjs.com/package/@nestjs/common/v/11.2.8)                                         | 11.2.8   | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [@nestjs/core](https://www.npmjs.com/package/@nestjs/core/v/11.2.8)                                             | 11.2.8   | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [@nestjs/jwt](https://www.npmjs.com/package/@nestjs/jwt/v/11.0.2)                                               | 11.0.2   | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [@nestjs/passport](https://www.npmjs.com/package/@nestjs/passport/v/11.0.5)                                     | 11.0.5   | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [@nestjs/platform-express](https://www.npmjs.com/package/@nestjs/platform-express/v/11.2.8)                     | 11.2.8   | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [@nestjs/platform-socket.io](https://www.npmjs.com/package/@nestjs/platform-socket.io/v/11.2.8)                 | 11.2.8   | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [@nestjs/testing](https://www.npmjs.com/package/@nestjs/testing/v/11.2.8)                                       | 11.2.8   | MIT              | @kabuki-neko/api (dev)                                                                                                    |
| [@nestjs/throttler](https://www.npmjs.com/package/@nestjs/throttler/v/6.7.1)                                    | 6.7.1    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [@nestjs/websockets](https://www.npmjs.com/package/@nestjs/websockets/v/11.2.8)                                 | 11.2.8   | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [@playwright/test](https://www.npmjs.com/package/@playwright/test/v/1.64.1)                                     | 1.64.1   | Apache-2.0       | kabuki-neko (dev)                                                                                                         |
| [@socket.io/redis-adapter](https://www.npmjs.com/package/@socket.io/redis-adapter/v/8.3.0)                      | 8.3.0    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [@tailwindcss/postcss](https://www.npmjs.com/package/@tailwindcss/postcss/v/4.3.3)                              | 4.3.3    | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@testcontainers/mysql](https://www.npmjs.com/package/@testcontainers/mysql/v/12.2.1)                           | 12.2.1   | MIT              | kabuki-neko (dev)                                                                                                         |
| [@testcontainers/postgresql](https://www.npmjs.com/package/@testcontainers/postgresql/v/12.2.1)                 | 12.2.1   | MIT              | kabuki-neko (dev)                                                                                                         |
| [@testcontainers/redis](https://www.npmjs.com/package/@testcontainers/redis/v/12.2.1)                           | 12.2.1   | MIT              | kabuki-neko (dev)                                                                                                         |
| [@testing-library/dom](https://www.npmjs.com/package/@testing-library/dom/v/10.4.2)                             | 10.4.2   | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@testing-library/jest-dom](https://www.npmjs.com/package/@testing-library/jest-dom/v/7.0.1)                    | 7.0.1    | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@testing-library/react](https://www.npmjs.com/package/@testing-library/react/v/16.3.3)                         | 16.3.3   | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@testing-library/user-event](https://www.npmjs.com/package/@testing-library/user-event/v/14.6.8)               | 14.6.8   | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@types/better-sqlite3](https://www.npmjs.com/package/@types/better-sqlite3/v/9.6.0)                            | 9.6.0    | MIT              | kabuki-neko (dev); @kabuki-neko/database (dev)                                                                            |
| [@types/canvas-confetti](https://www.npmjs.com/package/@types/canvas-confetti/v/1.9.0)                          | 1.9.0    | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@types/cookie-parser](https://www.npmjs.com/package/@types/cookie-parser/v/1.4.10)                             | 1.4.10   | MIT              | @kabuki-neko/api (dev)                                                                                                    |
| [@types/cors](https://www.npmjs.com/package/@types/cors/v/2.8.19)                                               | 2.8.19   | MIT              | @kabuki-neko/api (dev)                                                                                                    |
| [@types/express](https://www.npmjs.com/package/@types/express/v/5.0.6)                                          | 5.0.6    | MIT              | @kabuki-neko/api (dev)                                                                                                    |
| [@types/howler](https://www.npmjs.com/package/@types/howler/v/2.2.13)                                           | 2.2.13   | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@types/jest](https://www.npmjs.com/package/@types/jest/v/30.0.0)                                               | 30.0.0   | MIT              | kabuki-neko (dev); @kabuki-neko/api (dev)                                                                                 |
| [@types/multer](https://www.npmjs.com/package/@types/multer/v/2.3.0)                                            | 2.3.0    | MIT              | @kabuki-neko/api (dev)                                                                                                    |
| [@types/node](https://www.npmjs.com/package/@types/node/v/24.19.2)                                              | 24.19.2  | MIT              | kabuki-neko (dev); @kabuki-neko/api (dev); @kabuki-neko/web (dev); @kabuki-neko/shared (dev); @kabuki-neko/database (dev) |
| [@types/passport](https://www.npmjs.com/package/@types/passport/v/1.0.17)                                       | 1.0.17   | MIT              | @kabuki-neko/api (dev)                                                                                                    |
| [@types/passport-jwt](https://www.npmjs.com/package/@types/passport-jwt/v/4.0.1)                                | 4.0.1    | MIT              | @kabuki-neko/api (dev)                                                                                                    |
| [@types/pg](https://www.npmjs.com/package/@types/pg/v/8.23.1)                                                   | 8.23.1   | MIT              | kabuki-neko (dev); @kabuki-neko/database (dev)                                                                            |
| [@types/qrcode](https://www.npmjs.com/package/@types/qrcode/v/1.5.6)                                            | 1.5.6    | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@types/react](https://www.npmjs.com/package/@types/react/v/19.3.0)                                             | 19.3.0   | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@types/react-dom](https://www.npmjs.com/package/@types/react-dom/v/19.3.0)                                     | 19.3.0   | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@types/supertest](https://www.npmjs.com/package/@types/supertest/v/7.2.1)                                      | 7.2.1    | MIT              | kabuki-neko (dev); @kabuki-neko/api (dev)                                                                                 |
| [@vitejs/plugin-react](https://www.npmjs.com/package/@vitejs/plugin-react/v/6.1.2)                              | 6.1.2    | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [@zxing/browser](https://www.npmjs.com/package/@zxing/browser/v/0.2.1)                                          | 0.2.1    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [@zxing/library](https://www.npmjs.com/package/@zxing/library/v/0.23.0)                                         | 0.23.0   | Apache-2.0       | @kabuki-neko/web (runtime)                                                                                                |
| [argon2](https://www.npmjs.com/package/argon2/v/0.45.1)                                                         | 0.45.1   | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [axe-core](https://www.npmjs.com/package/axe-core/v/4.14.0)                                                     | 4.14.0   | MPL-2.0          | kabuki-neko (dev)                                                                                                         |
| [better-sqlite3](https://www.npmjs.com/package/better-sqlite3/v/12.11.1)                                        | 12.11.1  | MIT              | @kabuki-neko/database (runtime)                                                                                           |
| [better-sqlite3](https://www.npmjs.com/package/better-sqlite3/v/13.0.3)                                         | 13.0.3   | MIT              | kabuki-neko (dev)                                                                                                         |
| [canvas-confetti](https://www.npmjs.com/package/canvas-confetti/v/1.9.4)                                        | 1.9.4    | ISC              | @kabuki-neko/web (runtime)                                                                                                |
| [class-variance-authority](https://www.npmjs.com/package/class-variance-authority/v/0.7.1)                      | 0.7.1    | Apache-2.0       | @kabuki-neko/web (runtime)                                                                                                |
| [clsx](https://www.npmjs.com/package/clsx/v/2.1.1)                                                              | 2.1.1    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [cookie-parser](https://www.npmjs.com/package/cookie-parser/v/1.4.7)                                            | 1.4.7    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [cors](https://www.npmjs.com/package/cors/v/2.8.6)                                                              | 2.8.6    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [eslint](https://www.npmjs.com/package/eslint/v/10.13.0)                                                        | 10.13.0  | MIT              | kabuki-neko (dev)                                                                                                         |
| [eslint-config-prettier](https://www.npmjs.com/package/eslint-config-prettier/v/10.1.8)                         | 10.1.8   | MIT              | kabuki-neko (dev)                                                                                                         |
| [express](https://www.npmjs.com/package/express/v/5.3.0)                                                        | 5.3.0    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [fflate](https://www.npmjs.com/package/fflate/v/0.8.3)                                                          | 0.8.3    | MIT              | kabuki-neko (dev)                                                                                                         |
| [file-type](https://www.npmjs.com/package/file-type/v/22.3.0)                                                   | 22.3.0   | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [framer-motion](https://www.npmjs.com/package/framer-motion/v/14.9.0)                                           | 14.9.0   | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [helmet](https://www.npmjs.com/package/helmet/v/8.3.0)                                                          | 8.3.0    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [howler](https://www.npmjs.com/package/howler/v/2.2.4)                                                          | 2.2.4    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [intl-messageformat](https://www.npmjs.com/package/intl-messageformat/v/12.1.4)                                 | 12.1.4   | BSD-3-Clause     | kabuki-neko (dev); @kabuki-neko/api (runtime); @kabuki-neko/web (runtime)                                                 |
| [ioredis](https://www.npmjs.com/package/ioredis/v/5.11.1)                                                       | 5.11.1   | MIT              | kabuki-neko (dev); @kabuki-neko/api (runtime)                                                                             |
| [jest](https://www.npmjs.com/package/jest/v/30.5.2)                                                             | 30.5.2   | MIT              | kabuki-neko (dev); @kabuki-neko/api (dev)                                                                                 |
| [jsdom](https://www.npmjs.com/package/jsdom/v/30.1.3)                                                           | 30.1.3   | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [lucide-react](https://www.npmjs.com/package/lucide-react/v/1.65.0)                                             | 1.65.0   | ISC              | @kabuki-neko/web (runtime)                                                                                                |
| [multer](https://www.npmjs.com/package/multer/v/2.5.0)                                                          | 2.5.0    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [mysql2](https://www.npmjs.com/package/mysql2/v/3.24.6)                                                         | 3.24.6   | MIT              | kabuki-neko (dev); @kabuki-neko/database (runtime)                                                                        |
| [next](https://www.npmjs.com/package/next/v/16.4.3)                                                             | 16.4.3   | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [passport](https://www.npmjs.com/package/passport/v/0.7.0)                                                      | 0.7.0    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [passport-jwt](https://www.npmjs.com/package/passport-jwt/v/4.0.1)                                              | 4.0.1    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [pg](https://www.npmjs.com/package/pg/v/8.23.1)                                                                 | 8.23.1   | MIT              | kabuki-neko (dev); @kabuki-neko/database (runtime)                                                                        |
| [playwright-core](https://www.npmjs.com/package/playwright-core/v/1.64.1)                                       | 1.64.1   | Apache-2.0       | kabuki-neko (dev)                                                                                                         |
| [postcss](https://www.npmjs.com/package/postcss/v/8.5.32)                                                       | 8.5.32   | MIT              | @kabuki-neko/web (dev)                                                                                                    |
| [prettier](https://www.npmjs.com/package/prettier/v/3.9.10)                                                     | 3.9.10   | MIT              | kabuki-neko (dev)                                                                                                         |
| [qrcode](https://www.npmjs.com/package/qrcode/v/1.5.4)                                                          | 1.5.4    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [radix-ui](https://www.npmjs.com/package/radix-ui/v/1.8.1)                                                      | 1.8.1    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [react](https://www.npmjs.com/package/react/v/19.3.1)                                                           | 19.3.1   | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [react-dom](https://www.npmjs.com/package/react-dom/v/19.3.1)                                                   | 19.3.1   | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [react-hook-form](https://www.npmjs.com/package/react-hook-form/v/7.91.0)                                       | 7.91.0   | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [reflect-metadata](https://www.npmjs.com/package/reflect-metadata/v/0.2.2)                                      | 0.2.2    | Apache-2.0       | @kabuki-neko/api (runtime); @kabuki-neko/database (runtime)                                                               |
| [rxjs](https://www.npmjs.com/package/rxjs/v/7.8.2)                                                              | 7.8.2    | Apache-2.0       | @kabuki-neko/api (runtime)                                                                                                |
| [sharp](https://www.npmjs.com/package/sharp/v/0.35.5)                                                           | 0.35.5   | Apache-2.0       | @kabuki-neko/api (runtime)                                                                                                |
| [socket.io](https://www.npmjs.com/package/socket.io/v/4.8.4)                                                    | 4.8.4    | MIT              | @kabuki-neko/api (runtime)                                                                                                |
| [socket.io-client](https://www.npmjs.com/package/socket.io-client/v/4.8.4)                                      | 4.8.4    | MIT              | kabuki-neko (dev); @kabuki-neko/web (runtime)                                                                             |
| [supertest](https://www.npmjs.com/package/supertest/v/7.3.1)                                                    | 7.3.1    | MIT              | kabuki-neko (dev); @kabuki-neko/api (dev)                                                                                 |
| [tailwind-merge](https://www.npmjs.com/package/tailwind-merge/v/3.7.0)                                          | 3.7.0    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [tailwindcss](https://www.npmjs.com/package/tailwindcss/v/4.3.3)                                                | 4.3.3    | MIT              | @kabuki-neko/web (runtime)                                                                                                |
| [testcontainers](https://www.npmjs.com/package/testcontainers/v/12.2.1)                                         | 12.2.1   | MIT              | kabuki-neko (dev)                                                                                                         |
| [ts-jest](https://www.npmjs.com/package/ts-jest/v/29.4.15)                                                      | 29.4.15  | MIT              | kabuki-neko (dev); @kabuki-neko/api (dev)                                                                                 |
| [tsx](https://www.npmjs.com/package/tsx/v/4.23.15)                                                              | 4.23.15  | MIT              | kabuki-neko (dev)                                                                                                         |
| [turbo](https://www.npmjs.com/package/turbo/v/2.11.10)                                                          | 2.11.10  | MIT              | kabuki-neko (dev)                                                                                                         |
| [typeorm](https://www.npmjs.com/package/typeorm/v/0.3.31)                                                       | 0.3.31   | MIT              | @kabuki-neko/api (runtime); @kabuki-neko/database (runtime)                                                               |
| [typescript](https://www.npmjs.com/package/typescript/v/5.9.3)                                                  | 5.9.3    | Apache-2.0       | kabuki-neko (dev); @kabuki-neko/api (dev); @kabuki-neko/web (dev); @kabuki-neko/shared (dev); @kabuki-neko/database (dev) |
| [typescript-eslint](https://www.npmjs.com/package/typescript-eslint/v/8.72.1)                                   | 8.72.1   | MIT              | kabuki-neko (dev)                                                                                                         |
| [vite](https://www.npmjs.com/package/vite/v/8.3.5)                                                              | 8.3.5    | MIT              | kabuki-neko (dev); @kabuki-neko/web (dev)                                                                                 |
| [vitest](https://www.npmjs.com/package/vitest/v/5.0.5)                                                          | 5.0.5    | MIT              | kabuki-neko (dev); @kabuki-neko/web (dev); @kabuki-neko/shared (dev)                                                      |
| [yaml](https://www.npmjs.com/package/yaml/v/2.9.1)                                                              | 2.9.1    | ISC              | kabuki-neko (dev)                                                                                                         |
| [zod](https://www.npmjs.com/package/zod/v/4.6.7)                                                                | 4.6.7    | MIT              | kabuki-neko (dev); @kabuki-neko/api (runtime); @kabuki-neko/web (runtime); @kabuki-neko/shared (runtime)                  |
| [zustand](https://www.npmjs.com/package/zustand/v/5.0.16)                                                       | 5.0.16   | MIT              | @kabuki-neko/web (runtime)                                                                                                |

## Installed transitive inventory

Generated from `pnpm licenses list --json` on macOS arm64. Platform-specific dependencies for other deployment targets must be inventoried during packaging. Metadata is a discovery aid, not a legal audit or a declaration that the release gate has passed.

| Package                                                                                                                              | Installed versions      | License evidence                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ----------------------------------- |
| [@adobe/css-tools](https://www.npmjs.com/package/@adobe/css-tools)                                                                   | 4.5.0                   | MIT                                 |
| [@alloc/quick-lru](https://www.npmjs.com/package/@alloc/quick-lru)                                                                   | 5.3.0                   | MIT                                 |
| [@angular-devkit/core](https://www.npmjs.com/package/@angular-devkit/core)                                                           | 19.2.24, 19.2.27        | MIT                                 |
| [@angular-devkit/schematics](https://www.npmjs.com/package/@angular-devkit/schematics)                                               | 19.2.24, 19.2.27        | MIT                                 |
| [@angular-devkit/schematics-cli](https://www.npmjs.com/package/@angular-devkit/schematics-cli)                                       | 19.2.27                 | MIT                                 |
| [@asamuzakjp/css-color](https://www.npmjs.com/package/@asamuzakjp/css-color)                                                         | 7.1.9                   | MIT                                 |
| [@asamuzakjp/dom-selector](https://www.npmjs.com/package/@asamuzakjp/dom-selector)                                                   | 10.0.5                  | MIT                                 |
| [@aws-sdk/checksums](https://www.npmjs.com/package/@aws-sdk/checksums)                                                               | 3.1002.0                | Apache-2.0                          |
| [@aws-sdk/client-s3](https://www.npmjs.com/package/@aws-sdk/client-s3)                                                               | 3.1160.0                | Apache-2.0                          |
| [@aws-sdk/core](https://www.npmjs.com/package/@aws-sdk/core)                                                                         | 3.979.0                 | Apache-2.0                          |
| [@aws-sdk/credential-provider-env](https://www.npmjs.com/package/@aws-sdk/credential-provider-env)                                   | 3.972.79                | Apache-2.0                          |
| [@aws-sdk/credential-provider-http](https://www.npmjs.com/package/@aws-sdk/credential-provider-http)                                 | 3.972.81                | Apache-2.0                          |
| [@aws-sdk/credential-provider-ini](https://www.npmjs.com/package/@aws-sdk/credential-provider-ini)                                   | 3.973.24                | Apache-2.0                          |
| [@aws-sdk/credential-provider-login](https://www.npmjs.com/package/@aws-sdk/credential-provider-login)                               | 3.972.86                | Apache-2.0                          |
| [@aws-sdk/credential-provider-node](https://www.npmjs.com/package/@aws-sdk/credential-provider-node)                                 | 3.972.91                | Apache-2.0                          |
| [@aws-sdk/credential-provider-process](https://www.npmjs.com/package/@aws-sdk/credential-provider-process)                           | 3.972.79                | Apache-2.0                          |
| [@aws-sdk/credential-provider-sso](https://www.npmjs.com/package/@aws-sdk/credential-provider-sso)                                   | 3.973.23                | Apache-2.0                          |
| [@aws-sdk/credential-provider-web-identity](https://www.npmjs.com/package/@aws-sdk/credential-provider-web-identity)                 | 3.972.85                | Apache-2.0                          |
| [@aws-sdk/middleware-sdk-s3](https://www.npmjs.com/package/@aws-sdk/middleware-sdk-s3)                                               | 3.972.84                | Apache-2.0                          |
| [@aws-sdk/nested-clients](https://www.npmjs.com/package/@aws-sdk/nested-clients)                                                     | 3.997.53                | Apache-2.0                          |
| [@aws-sdk/s3-request-presigner](https://www.npmjs.com/package/@aws-sdk/s3-request-presigner)                                         | 3.1160.0                | Apache-2.0                          |
| [@aws-sdk/signature-v4-multi-region](https://www.npmjs.com/package/@aws-sdk/signature-v4-multi-region)                               | 3.996.50                | Apache-2.0                          |
| [@aws-sdk/token-providers](https://www.npmjs.com/package/@aws-sdk/token-providers)                                                   | 3.1160.0                | Apache-2.0                          |
| [@aws-sdk/types](https://www.npmjs.com/package/@aws-sdk/types)                                                                       | 3.975.0                 | Apache-2.0                          |
| [@aws-sdk/xml-builder](https://www.npmjs.com/package/@aws-sdk/xml-builder)                                                           | 3.972.42                | Apache-2.0                          |
| [@aws/lambda-invoke-store](https://www.npmjs.com/package/@aws/lambda-invoke-store)                                                   | 0.3.0                   | Apache-2.0                          |
| [@axe-core/playwright](https://www.npmjs.com/package/@axe-core/playwright)                                                           | 4.14.0                  | MPL-2.0                             |
| [@babel/code-frame](https://www.npmjs.com/package/@babel/code-frame)                                                                 | 7.29.7                  | MIT                                 |
| [@babel/compat-data](https://www.npmjs.com/package/@babel/compat-data)                                                               | 7.29.7                  | MIT                                 |
| [@babel/core](https://www.npmjs.com/package/@babel/core)                                                                             | 7.29.7                  | MIT                                 |
| [@babel/generator](https://www.npmjs.com/package/@babel/generator)                                                                   | 7.29.12                 | MIT                                 |
| [@babel/helper-compilation-targets](https://www.npmjs.com/package/@babel/helper-compilation-targets)                                 | 7.29.7                  | MIT                                 |
| [@babel/helper-globals](https://www.npmjs.com/package/@babel/helper-globals)                                                         | 7.29.7                  | MIT                                 |
| [@babel/helper-module-imports](https://www.npmjs.com/package/@babel/helper-module-imports)                                           | 7.29.7                  | MIT                                 |
| [@babel/helper-module-transforms](https://www.npmjs.com/package/@babel/helper-module-transforms)                                     | 7.29.7                  | MIT                                 |
| [@babel/helper-plugin-utils](https://www.npmjs.com/package/@babel/helper-plugin-utils)                                               | 7.29.7                  | MIT                                 |
| [@babel/helper-string-parser](https://www.npmjs.com/package/@babel/helper-string-parser)                                             | 7.29.11                 | MIT                                 |
| [@babel/helper-validator-identifier](https://www.npmjs.com/package/@babel/helper-validator-identifier)                               | 7.29.7                  | MIT                                 |
| [@babel/helper-validator-option](https://www.npmjs.com/package/@babel/helper-validator-option)                                       | 7.29.7                  | MIT                                 |
| [@babel/helpers](https://www.npmjs.com/package/@babel/helpers)                                                                       | 7.29.10                 | MIT                                 |
| [@babel/parser](https://www.npmjs.com/package/@babel/parser)                                                                         | 7.29.12                 | MIT                                 |
| [@babel/plugin-syntax-async-generators](https://www.npmjs.com/package/@babel/plugin-syntax-async-generators)                         | 7.8.4                   | MIT                                 |
| [@babel/plugin-syntax-bigint](https://www.npmjs.com/package/@babel/plugin-syntax-bigint)                                             | 7.8.3                   | MIT                                 |
| [@babel/plugin-syntax-class-properties](https://www.npmjs.com/package/@babel/plugin-syntax-class-properties)                         | 7.12.13                 | MIT                                 |
| [@babel/plugin-syntax-class-static-block](https://www.npmjs.com/package/@babel/plugin-syntax-class-static-block)                     | 7.14.5                  | MIT                                 |
| [@babel/plugin-syntax-import-attributes](https://www.npmjs.com/package/@babel/plugin-syntax-import-attributes)                       | 7.29.7                  | MIT                                 |
| [@babel/plugin-syntax-import-meta](https://www.npmjs.com/package/@babel/plugin-syntax-import-meta)                                   | 7.10.4                  | MIT                                 |
| [@babel/plugin-syntax-json-strings](https://www.npmjs.com/package/@babel/plugin-syntax-json-strings)                                 | 7.8.3                   | MIT                                 |
| [@babel/plugin-syntax-jsx](https://www.npmjs.com/package/@babel/plugin-syntax-jsx)                                                   | 7.29.7                  | MIT                                 |
| [@babel/plugin-syntax-logical-assignment-operators](https://www.npmjs.com/package/@babel/plugin-syntax-logical-assignment-operators) | 7.10.4                  | MIT                                 |
| [@babel/plugin-syntax-nullish-coalescing-operator](https://www.npmjs.com/package/@babel/plugin-syntax-nullish-coalescing-operator)   | 7.8.3                   | MIT                                 |
| [@babel/plugin-syntax-numeric-separator](https://www.npmjs.com/package/@babel/plugin-syntax-numeric-separator)                       | 7.10.4                  | MIT                                 |
| [@babel/plugin-syntax-object-rest-spread](https://www.npmjs.com/package/@babel/plugin-syntax-object-rest-spread)                     | 7.8.3                   | MIT                                 |
| [@babel/plugin-syntax-optional-catch-binding](https://www.npmjs.com/package/@babel/plugin-syntax-optional-catch-binding)             | 7.8.3                   | MIT                                 |
| [@babel/plugin-syntax-optional-chaining](https://www.npmjs.com/package/@babel/plugin-syntax-optional-chaining)                       | 7.8.3                   | MIT                                 |
| [@babel/plugin-syntax-private-property-in-object](https://www.npmjs.com/package/@babel/plugin-syntax-private-property-in-object)     | 7.14.5                  | MIT                                 |
| [@babel/plugin-syntax-top-level-await](https://www.npmjs.com/package/@babel/plugin-syntax-top-level-await)                           | 7.14.5                  | MIT                                 |
| [@babel/plugin-syntax-typescript](https://www.npmjs.com/package/@babel/plugin-syntax-typescript)                                     | 7.29.7                  | MIT                                 |
| [@babel/runtime](https://www.npmjs.com/package/@babel/runtime)                                                                       | 7.29.10                 | MIT                                 |
| [@babel/template](https://www.npmjs.com/package/@babel/template)                                                                     | 7.29.7                  | MIT                                 |
| [@babel/traverse](https://www.npmjs.com/package/@babel/traverse)                                                                     | 7.29.12                 | MIT                                 |
| [@babel/types](https://www.npmjs.com/package/@babel/types)                                                                           | 7.29.11                 | MIT                                 |
| [@balena/dockerignore](https://www.npmjs.com/package/@balena/dockerignore)                                                           | 1.0.2                   | Apache-2.0                          |
| [@bcoe/v8-coverage](https://www.npmjs.com/package/@bcoe/v8-coverage)                                                                 | 0.2.3                   | MIT                                 |
| [@borewit/text-codec](https://www.npmjs.com/package/@borewit/text-codec)                                                             | 0.2.3                   | MIT                                 |
| [@bramus/specificity](https://www.npmjs.com/package/@bramus/specificity)                                                             | 2.4.3                   | MIT                                 |
| [@cacheable/memory](https://www.npmjs.com/package/@cacheable/memory)                                                                 | 2.2.0                   | MIT                                 |
| [@cacheable/utils](https://www.npmjs.com/package/@cacheable/utils)                                                                   | 2.5.0                   | MIT                                 |
| [@colors/colors](https://www.npmjs.com/package/@colors/colors)                                                                       | 1.5.0                   | MIT                                 |
| [@csstools/color-helpers](https://www.npmjs.com/package/@csstools/color-helpers)                                                     | 6.1.2                   | MIT-0                               |
| [@csstools/css-calc](https://www.npmjs.com/package/@csstools/css-calc)                                                               | 3.4.3                   | MIT                                 |
| [@csstools/css-color-parser](https://www.npmjs.com/package/@csstools/css-color-parser)                                               | 4.2.7                   | MIT                                 |
| [@csstools/css-parser-algorithms](https://www.npmjs.com/package/@csstools/css-parser-algorithms)                                     | 4.0.2                   | MIT                                 |
| [@csstools/css-syntax-patches-for-csstree](https://www.npmjs.com/package/@csstools/css-syntax-patches-for-csstree)                   | 1.1.16                  | MIT-0                               |
| [@csstools/css-tokenizer](https://www.npmjs.com/package/@csstools/css-tokenizer)                                                     | 4.0.2                   | MIT                                 |
| [@dicebear/adventurer](https://www.npmjs.com/package/@dicebear/adventurer)                                                           | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/adventurer-neutral](https://www.npmjs.com/package/@dicebear/adventurer-neutral)                                           | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/avataaars](https://www.npmjs.com/package/@dicebear/avataaars)                                                             | 9.4.3                   | MIT                                 |
| [@dicebear/avataaars-neutral](https://www.npmjs.com/package/@dicebear/avataaars-neutral)                                             | 9.4.3                   | MIT                                 |
| [@dicebear/big-ears](https://www.npmjs.com/package/@dicebear/big-ears)                                                               | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/big-ears-neutral](https://www.npmjs.com/package/@dicebear/big-ears-neutral)                                               | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/big-smile](https://www.npmjs.com/package/@dicebear/big-smile)                                                             | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/bottts](https://www.npmjs.com/package/@dicebear/bottts)                                                                   | 9.4.3                   | MIT                                 |
| [@dicebear/bottts-neutral](https://www.npmjs.com/package/@dicebear/bottts-neutral)                                                   | 9.4.3                   | MIT                                 |
| [@dicebear/collection](https://www.npmjs.com/package/@dicebear/collection)                                                           | 9.4.3                   | MIT                                 |
| [@dicebear/core](https://www.npmjs.com/package/@dicebear/core)                                                                       | 9.4.3                   | MIT                                 |
| [@dicebear/croodles](https://www.npmjs.com/package/@dicebear/croodles)                                                               | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/croodles-neutral](https://www.npmjs.com/package/@dicebear/croodles-neutral)                                               | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/dylan](https://www.npmjs.com/package/@dicebear/dylan)                                                                     | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/fun-emoji](https://www.npmjs.com/package/@dicebear/fun-emoji)                                                             | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/glass](https://www.npmjs.com/package/@dicebear/glass)                                                                     | 9.4.3                   | MIT                                 |
| [@dicebear/icons](https://www.npmjs.com/package/@dicebear/icons)                                                                     | 9.4.3                   | MIT                                 |
| [@dicebear/identicon](https://www.npmjs.com/package/@dicebear/identicon)                                                             | 9.4.3                   | MIT                                 |
| [@dicebear/initials](https://www.npmjs.com/package/@dicebear/initials)                                                               | 9.4.3                   | MIT                                 |
| [@dicebear/lorelei](https://www.npmjs.com/package/@dicebear/lorelei)                                                                 | 9.4.3                   | MIT                                 |
| [@dicebear/lorelei-neutral](https://www.npmjs.com/package/@dicebear/lorelei-neutral)                                                 | 9.4.3                   | MIT                                 |
| [@dicebear/micah](https://www.npmjs.com/package/@dicebear/micah)                                                                     | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/miniavs](https://www.npmjs.com/package/@dicebear/miniavs)                                                                 | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/notionists](https://www.npmjs.com/package/@dicebear/notionists)                                                           | 9.4.3                   | MIT                                 |
| [@dicebear/notionists-neutral](https://www.npmjs.com/package/@dicebear/notionists-neutral)                                           | 9.4.3                   | MIT                                 |
| [@dicebear/open-peeps](https://www.npmjs.com/package/@dicebear/open-peeps)                                                           | 9.4.3                   | MIT                                 |
| [@dicebear/personas](https://www.npmjs.com/package/@dicebear/personas)                                                               | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dicebear/pixel-art](https://www.npmjs.com/package/@dicebear/pixel-art)                                                             | 9.4.3                   | MIT                                 |
| [@dicebear/pixel-art-neutral](https://www.npmjs.com/package/@dicebear/pixel-art-neutral)                                             | 9.4.3                   | MIT                                 |
| [@dicebear/rings](https://www.npmjs.com/package/@dicebear/rings)                                                                     | 9.4.3                   | MIT                                 |
| [@dicebear/shapes](https://www.npmjs.com/package/@dicebear/shapes)                                                                   | 9.4.3                   | MIT                                 |
| [@dicebear/thumbs](https://www.npmjs.com/package/@dicebear/thumbs)                                                                   | 9.4.3                   | MIT                                 |
| [@dicebear/toon-head](https://www.npmjs.com/package/@dicebear/toon-head)                                                             | 9.4.3                   | (MIT AND CC-BY-4.0)                 |
| [@dnd-kit/accessibility](https://www.npmjs.com/package/@dnd-kit/accessibility)                                                       | 3.1.1                   | MIT                                 |
| [@dnd-kit/core](https://www.npmjs.com/package/@dnd-kit/core)                                                                         | 6.3.1                   | MIT                                 |
| [@dnd-kit/sortable](https://www.npmjs.com/package/@dnd-kit/sortable)                                                                 | 10.0.0                  | MIT                                 |
| [@dnd-kit/utilities](https://www.npmjs.com/package/@dnd-kit/utilities)                                                               | 3.2.2                   | MIT                                 |
| [@epic-web/invariant](https://www.npmjs.com/package/@epic-web/invariant)                                                             | 1.0.0                   | MIT                                 |
| [@esbuild/darwin-arm64](https://www.npmjs.com/package/@esbuild/darwin-arm64)                                                         | 0.28.2                  | MIT                                 |
| [@eslint-community/eslint-utils](https://www.npmjs.com/package/@eslint-community/eslint-utils)                                       | 4.10.1                  | MIT                                 |
| [@eslint-community/regexpp](https://www.npmjs.com/package/@eslint-community/regexpp)                                                 | 4.12.2                  | MIT                                 |
| [@eslint/config-array](https://www.npmjs.com/package/@eslint/config-array)                                                           | 0.23.5                  | Apache-2.0                          |
| [@eslint/config-helpers](https://www.npmjs.com/package/@eslint/config-helpers)                                                       | 0.7.0                   | Apache-2.0                          |
| [@eslint/core](https://www.npmjs.com/package/@eslint/core)                                                                           | 1.2.1                   | Apache-2.0                          |
| [@eslint/js](https://www.npmjs.com/package/@eslint/js)                                                                               | 10.0.1                  | MIT                                 |
| [@eslint/object-schema](https://www.npmjs.com/package/@eslint/object-schema)                                                         | 3.0.5                   | Apache-2.0                          |
| [@eslint/plugin-kit](https://www.npmjs.com/package/@eslint/plugin-kit)                                                               | 0.7.3                   | Apache-2.0                          |
| [@exodus/bytes](https://www.npmjs.com/package/@exodus/bytes)                                                                         | 1.16.0                  | MIT                                 |
| [@floating-ui/core](https://www.npmjs.com/package/@floating-ui/core)                                                                 | 1.8.0                   | MIT                                 |
| [@floating-ui/dom](https://www.npmjs.com/package/@floating-ui/dom)                                                                   | 1.8.0                   | MIT                                 |
| [@floating-ui/react-dom](https://www.npmjs.com/package/@floating-ui/react-dom)                                                       | 2.1.9                   | MIT                                 |
| [@floating-ui/utils](https://www.npmjs.com/package/@floating-ui/utils)                                                               | 0.2.12                  | MIT                                 |
| [@formatjs/fast-memoize](https://www.npmjs.com/package/@formatjs/fast-memoize)                                                       | 3.1.7                   | MIT                                 |
| [@formatjs/icu-messageformat-parser](https://www.npmjs.com/package/@formatjs/icu-messageformat-parser)                               | 3.5.22                  | MIT                                 |
| [@formatjs/icu-skeleton-parser](https://www.npmjs.com/package/@formatjs/icu-skeleton-parser)                                         | 2.1.12                  | MIT                                 |
| [@grpc/grpc-js](https://www.npmjs.com/package/@grpc/grpc-js)                                                                         | 1.14.7                  | Apache-2.0                          |
| [@grpc/proto-loader](https://www.npmjs.com/package/@grpc/proto-loader)                                                               | 0.7.15, 0.8.1           | Apache-2.0                          |
| [@hookform/resolvers](https://www.npmjs.com/package/@hookform/resolvers)                                                             | 6.0.2                   | MIT                                 |
| [@humanfs/core](https://www.npmjs.com/package/@humanfs/core)                                                                         | 0.19.2                  | Apache-2.0                          |
| [@humanfs/node](https://www.npmjs.com/package/@humanfs/node)                                                                         | 0.16.8                  | Apache-2.0                          |
| [@humanfs/types](https://www.npmjs.com/package/@humanfs/types)                                                                       | 0.15.0                  | Apache-2.0                          |
| [@humanwhocodes/module-importer](https://www.npmjs.com/package/@humanwhocodes/module-importer)                                       | 1.0.1                   | Apache-2.0                          |
| [@humanwhocodes/retry](https://www.npmjs.com/package/@humanwhocodes/retry)                                                           | 0.4.3                   | Apache-2.0                          |
| [@img/colour](https://www.npmjs.com/package/@img/colour)                                                                             | 1.1.0                   | MIT                                 |
| [@img/sharp-darwin-arm64](https://www.npmjs.com/package/@img/sharp-darwin-arm64)                                                     | 0.35.5                  | Apache-2.0                          |
| [@img/sharp-libvips-darwin-arm64](https://www.npmjs.com/package/@img/sharp-libvips-darwin-arm64)                                     | 1.3.4                   | LGPL-3.0-or-later                   |
| [@inquirer/ansi](https://www.npmjs.com/package/@inquirer/ansi)                                                                       | 1.0.2                   | MIT                                 |
| [@inquirer/checkbox](https://www.npmjs.com/package/@inquirer/checkbox)                                                               | 4.3.2                   | MIT                                 |
| [@inquirer/confirm](https://www.npmjs.com/package/@inquirer/confirm)                                                                 | 5.1.21                  | MIT                                 |
| [@inquirer/core](https://www.npmjs.com/package/@inquirer/core)                                                                       | 10.3.2                  | MIT                                 |
| [@inquirer/editor](https://www.npmjs.com/package/@inquirer/editor)                                                                   | 4.2.23                  | MIT                                 |
| [@inquirer/expand](https://www.npmjs.com/package/@inquirer/expand)                                                                   | 4.0.23                  | MIT                                 |
| [@inquirer/external-editor](https://www.npmjs.com/package/@inquirer/external-editor)                                                 | 1.0.3                   | MIT                                 |
| [@inquirer/figures](https://www.npmjs.com/package/@inquirer/figures)                                                                 | 1.0.15                  | MIT                                 |
| [@inquirer/input](https://www.npmjs.com/package/@inquirer/input)                                                                     | 4.3.1                   | MIT                                 |
| [@inquirer/number](https://www.npmjs.com/package/@inquirer/number)                                                                   | 3.0.23                  | MIT                                 |
| [@inquirer/password](https://www.npmjs.com/package/@inquirer/password)                                                               | 4.0.23                  | MIT                                 |
| [@inquirer/prompts](https://www.npmjs.com/package/@inquirer/prompts)                                                                 | 7.3.2, 7.10.1           | MIT                                 |
| [@inquirer/rawlist](https://www.npmjs.com/package/@inquirer/rawlist)                                                                 | 4.1.11                  | MIT                                 |
| [@inquirer/search](https://www.npmjs.com/package/@inquirer/search)                                                                   | 3.2.2                   | MIT                                 |
| [@inquirer/select](https://www.npmjs.com/package/@inquirer/select)                                                                   | 4.4.2                   | MIT                                 |
| [@inquirer/type](https://www.npmjs.com/package/@inquirer/type)                                                                       | 3.0.10                  | MIT                                 |
| [@ioredis/commands](https://www.npmjs.com/package/@ioredis/commands)                                                                 | 1.10.0                  | MIT                                 |
| [@isaacs/cliui](https://www.npmjs.com/package/@isaacs/cliui)                                                                         | 8.0.2                   | ISC                                 |
| [@istanbuljs/load-nyc-config](https://www.npmjs.com/package/@istanbuljs/load-nyc-config)                                             | 1.1.0                   | ISC                                 |
| [@istanbuljs/schema](https://www.npmjs.com/package/@istanbuljs/schema)                                                               | 0.1.6                   | MIT                                 |
| [@jest/console](https://www.npmjs.com/package/@jest/console)                                                                         | 30.5.2                  | MIT                                 |
| [@jest/core](https://www.npmjs.com/package/@jest/core)                                                                               | 30.5.2                  | MIT                                 |
| [@jest/diff-sequences](https://www.npmjs.com/package/@jest/diff-sequences)                                                           | 30.5.0                  | MIT                                 |
| [@jest/environment](https://www.npmjs.com/package/@jest/environment)                                                                 | 30.5.2                  | MIT                                 |
| [@jest/expect](https://www.npmjs.com/package/@jest/expect)                                                                           | 30.5.2                  | MIT                                 |
| [@jest/expect-utils](https://www.npmjs.com/package/@jest/expect-utils)                                                               | 30.5.2                  | MIT                                 |
| [@jest/fake-timers](https://www.npmjs.com/package/@jest/fake-timers)                                                                 | 30.5.2                  | MIT                                 |
| [@jest/get-type](https://www.npmjs.com/package/@jest/get-type)                                                                       | 30.5.0                  | MIT                                 |
| [@jest/globals](https://www.npmjs.com/package/@jest/globals)                                                                         | 30.5.2                  | MIT                                 |
| [@jest/pattern](https://www.npmjs.com/package/@jest/pattern)                                                                         | 30.5.0                  | MIT                                 |
| [@jest/reporters](https://www.npmjs.com/package/@jest/reporters)                                                                     | 30.5.2                  | MIT                                 |
| [@jest/schemas](https://www.npmjs.com/package/@jest/schemas)                                                                         | 30.5.0                  | MIT                                 |
| [@jest/snapshot-utils](https://www.npmjs.com/package/@jest/snapshot-utils)                                                           | 30.5.1                  | MIT                                 |
| [@jest/source-map](https://www.npmjs.com/package/@jest/source-map)                                                                   | 30.5.2                  | MIT                                 |
| [@jest/test-result](https://www.npmjs.com/package/@jest/test-result)                                                                 | 30.5.2                  | MIT                                 |
| [@jest/test-sequencer](https://www.npmjs.com/package/@jest/test-sequencer)                                                           | 30.5.2                  | MIT                                 |
| [@jest/transform](https://www.npmjs.com/package/@jest/transform)                                                                     | 30.5.2                  | MIT                                 |
| [@jest/types](https://www.npmjs.com/package/@jest/types)                                                                             | 30.5.1                  | MIT                                 |
| [@jridgewell/gen-mapping](https://www.npmjs.com/package/@jridgewell/gen-mapping)                                                     | 0.3.13                  | MIT                                 |
| [@jridgewell/remapping](https://www.npmjs.com/package/@jridgewell/remapping)                                                         | 2.3.5                   | MIT                                 |
| [@jridgewell/resolve-uri](https://www.npmjs.com/package/@jridgewell/resolve-uri)                                                     | 3.1.2                   | MIT                                 |
| [@jridgewell/source-map](https://www.npmjs.com/package/@jridgewell/source-map)                                                       | 0.3.11                  | MIT                                 |
| [@jridgewell/sourcemap-codec](https://www.npmjs.com/package/@jridgewell/sourcemap-codec)                                             | 1.6.0                   | MIT                                 |
| [@jridgewell/trace-mapping](https://www.npmjs.com/package/@jridgewell/trace-mapping)                                                 | 0.3.31                  | MIT                                 |
| [@js-sdsl/ordered-map](https://www.npmjs.com/package/@js-sdsl/ordered-map)                                                           | 4.4.2                   | MIT                                 |
| [@keyv/bigmap](https://www.npmjs.com/package/@keyv/bigmap)                                                                           | 1.3.1                   | MIT                                 |
| [@keyv/serialize](https://www.npmjs.com/package/@keyv/serialize)                                                                     | 1.1.1                   | MIT                                 |
| [@kwsites/file-exists](https://www.npmjs.com/package/@kwsites/file-exists)                                                           | 1.1.1                   | MIT                                 |
| [@lukeed/csprng](https://www.npmjs.com/package/@lukeed/csprng)                                                                       | 1.1.0                   | MIT                                 |
| [@nestjs/cli](https://www.npmjs.com/package/@nestjs/cli)                                                                             | 11.0.24                 | MIT                                 |
| [@nestjs/common](https://www.npmjs.com/package/@nestjs/common)                                                                       | 11.2.8                  | MIT                                 |
| [@nestjs/core](https://www.npmjs.com/package/@nestjs/core)                                                                           | 11.2.8                  | MIT                                 |
| [@nestjs/jwt](https://www.npmjs.com/package/@nestjs/jwt)                                                                             | 11.0.2                  | MIT                                 |
| [@nestjs/passport](https://www.npmjs.com/package/@nestjs/passport)                                                                   | 11.0.5                  | MIT                                 |
| [@nestjs/platform-express](https://www.npmjs.com/package/@nestjs/platform-express)                                                   | 11.2.8                  | MIT                                 |
| [@nestjs/platform-socket.io](https://www.npmjs.com/package/@nestjs/platform-socket.io)                                               | 11.2.8                  | MIT                                 |
| [@nestjs/schematics](https://www.npmjs.com/package/@nestjs/schematics)                                                               | 11.1.0                  | MIT                                 |
| [@nestjs/testing](https://www.npmjs.com/package/@nestjs/testing)                                                                     | 11.2.8                  | MIT                                 |
| [@nestjs/throttler](https://www.npmjs.com/package/@nestjs/throttler)                                                                 | 6.7.1                   | MIT                                 |
| [@nestjs/websockets](https://www.npmjs.com/package/@nestjs/websockets)                                                               | 11.2.8                  | MIT                                 |
| [@next/env](https://www.npmjs.com/package/@next/env)                                                                                 | 16.4.3                  | MIT                                 |
| [@next/swc-darwin-arm64](https://www.npmjs.com/package/@next/swc-darwin-arm64)                                                       | 16.4.3                  | MIT                                 |
| [@noble/hashes](https://www.npmjs.com/package/@noble/hashes)                                                                         | 1.8.0                   | MIT                                 |
| [@oxc-project/types](https://www.npmjs.com/package/@oxc-project/types)                                                               | 0.156.0                 | MIT                                 |
| [@paralleldrive/cuid2](https://www.npmjs.com/package/@paralleldrive/cuid2)                                                           | 2.3.1                   | MIT                                 |
| [@parcel/watcher](https://www.npmjs.com/package/@parcel/watcher)                                                                     | 2.6.0                   | MIT                                 |
| [@parcel/watcher-darwin-arm64](https://www.npmjs.com/package/@parcel/watcher-darwin-arm64)                                           | 2.6.0                   | MIT                                 |
| [@phc/format](https://www.npmjs.com/package/@phc/format)                                                                             | 1.0.0                   | MIT                                 |
| [@pkgjs/parseargs](https://www.npmjs.com/package/@pkgjs/parseargs)                                                                   | 0.11.0                  | MIT                                 |
| [@pkgr/core](https://www.npmjs.com/package/@pkgr/core)                                                                               | 0.3.6                   | MIT                                 |
| [@playwright/test](https://www.npmjs.com/package/@playwright/test)                                                                   | 1.64.1                  | Apache-2.0                          |
| [@protobufjs/aspromise](https://www.npmjs.com/package/@protobufjs/aspromise)                                                         | 1.1.2                   | BSD-3-Clause                        |
| [@protobufjs/base64](https://www.npmjs.com/package/@protobufjs/base64)                                                               | 1.1.2                   | BSD-3-Clause                        |
| [@protobufjs/codegen](https://www.npmjs.com/package/@protobufjs/codegen)                                                             | 2.0.5                   | BSD-3-Clause                        |
| [@protobufjs/eventemitter](https://www.npmjs.com/package/@protobufjs/eventemitter)                                                   | 1.1.1                   | BSD-3-Clause                        |
| [@protobufjs/fetch](https://www.npmjs.com/package/@protobufjs/fetch)                                                                 | 1.1.1                   | BSD-3-Clause                        |
| [@protobufjs/float](https://www.npmjs.com/package/@protobufjs/float)                                                                 | 1.0.2                   | BSD-3-Clause                        |
| [@protobufjs/path](https://www.npmjs.com/package/@protobufjs/path)                                                                   | 1.1.2                   | BSD-3-Clause                        |
| [@protobufjs/pool](https://www.npmjs.com/package/@protobufjs/pool)                                                                   | 1.1.0                   | BSD-3-Clause                        |
| [@protobufjs/utf8](https://www.npmjs.com/package/@protobufjs/utf8)                                                                   | 1.1.2                   | BSD-3-Clause                        |
| [@radix-ui/number](https://www.npmjs.com/package/@radix-ui/number)                                                                   | 1.1.3                   | MIT                                 |
| [@radix-ui/primitive](https://www.npmjs.com/package/@radix-ui/primitive)                                                             | 1.2.0                   | MIT                                 |
| [@radix-ui/react-accessible-icon](https://www.npmjs.com/package/@radix-ui/react-accessible-icon)                                     | 1.2.0                   | MIT                                 |
| [@radix-ui/react-accordion](https://www.npmjs.com/package/@radix-ui/react-accordion)                                                 | 1.3.1                   | MIT                                 |
| [@radix-ui/react-alert-dialog](https://www.npmjs.com/package/@radix-ui/react-alert-dialog)                                           | 1.2.1                   | MIT                                 |
| [@radix-ui/react-arrow](https://www.npmjs.com/package/@radix-ui/react-arrow)                                                         | 1.1.17                  | MIT                                 |
| [@radix-ui/react-aspect-ratio](https://www.npmjs.com/package/@radix-ui/react-aspect-ratio)                                           | 1.2.0                   | MIT                                 |
| [@radix-ui/react-avatar](https://www.npmjs.com/package/@radix-ui/react-avatar)                                                       | 1.3.1                   | MIT                                 |
| [@radix-ui/react-checkbox](https://www.npmjs.com/package/@radix-ui/react-checkbox)                                                   | 1.4.1                   | MIT                                 |
| [@radix-ui/react-collapsible](https://www.npmjs.com/package/@radix-ui/react-collapsible)                                             | 1.2.1                   | MIT                                 |
| [@radix-ui/react-collection](https://www.npmjs.com/package/@radix-ui/react-collection)                                               | 1.2.0                   | MIT                                 |
| [@radix-ui/react-compose-refs](https://www.npmjs.com/package/@radix-ui/react-compose-refs)                                           | 1.1.5                   | MIT                                 |
| [@radix-ui/react-context](https://www.npmjs.com/package/@radix-ui/react-context)                                                     | 1.3.0                   | MIT                                 |
| [@radix-ui/react-context-menu](https://www.npmjs.com/package/@radix-ui/react-context-menu)                                           | 2.4.1                   | MIT                                 |
| [@radix-ui/react-dialog](https://www.npmjs.com/package/@radix-ui/react-dialog)                                                       | 1.3.1                   | MIT                                 |
| [@radix-ui/react-direction](https://www.npmjs.com/package/@radix-ui/react-direction)                                                 | 1.2.0                   | MIT                                 |
| [@radix-ui/react-dismissable-layer](https://www.npmjs.com/package/@radix-ui/react-dismissable-layer)                                 | 1.2.1                   | MIT                                 |
| [@radix-ui/react-dropdown-menu](https://www.npmjs.com/package/@radix-ui/react-dropdown-menu)                                         | 2.2.1                   | MIT                                 |
| [@radix-ui/react-focus-guards](https://www.npmjs.com/package/@radix-ui/react-focus-guards)                                           | 1.2.0                   | MIT                                 |
| [@radix-ui/react-focus-scope](https://www.npmjs.com/package/@radix-ui/react-focus-scope)                                             | 1.3.1                   | MIT                                 |
| [@radix-ui/react-form](https://www.npmjs.com/package/@radix-ui/react-form)                                                           | 0.3.0                   | MIT                                 |
| [@radix-ui/react-hover-card](https://www.npmjs.com/package/@radix-ui/react-hover-card)                                               | 1.2.1                   | MIT                                 |
| [@radix-ui/react-id](https://www.npmjs.com/package/@radix-ui/react-id)                                                               | 1.1.4                   | MIT                                 |
| [@radix-ui/react-label](https://www.npmjs.com/package/@radix-ui/react-label)                                                         | 2.1.17                  | MIT                                 |
| [@radix-ui/react-menu](https://www.npmjs.com/package/@radix-ui/react-menu)                                                           | 2.2.1                   | MIT                                 |
| [@radix-ui/react-menubar](https://www.npmjs.com/package/@radix-ui/react-menubar)                                                     | 1.2.1                   | MIT                                 |
| [@radix-ui/react-navigation-menu](https://www.npmjs.com/package/@radix-ui/react-navigation-menu)                                     | 1.4.1                   | MIT                                 |
| [@radix-ui/react-one-time-password-field](https://www.npmjs.com/package/@radix-ui/react-one-time-password-field)                     | 0.2.1                   | MIT                                 |
| [@radix-ui/react-password-toggle-field](https://www.npmjs.com/package/@radix-ui/react-password-toggle-field)                         | 0.2.1                   | MIT                                 |
| [@radix-ui/react-popover](https://www.npmjs.com/package/@radix-ui/react-popover)                                                     | 1.3.1                   | MIT                                 |
| [@radix-ui/react-popper](https://www.npmjs.com/package/@radix-ui/react-popper)                                                       | 1.4.0                   | MIT                                 |
| [@radix-ui/react-portal](https://www.npmjs.com/package/@radix-ui/react-portal)                                                       | 1.2.0                   | MIT                                 |
| [@radix-ui/react-presence](https://www.npmjs.com/package/@radix-ui/react-presence)                                                   | 1.1.11                  | MIT                                 |
| [@radix-ui/react-primitive](https://www.npmjs.com/package/@radix-ui/react-primitive)                                                 | 2.2.0                   | MIT                                 |
| [@radix-ui/react-progress](https://www.npmjs.com/package/@radix-ui/react-progress)                                                   | 1.2.1                   | MIT                                 |
| [@radix-ui/react-radio-group](https://www.npmjs.com/package/@radix-ui/react-radio-group)                                             | 1.5.1                   | MIT                                 |
| [@radix-ui/react-roving-focus](https://www.npmjs.com/package/@radix-ui/react-roving-focus)                                           | 1.2.1                   | MIT                                 |
| [@radix-ui/react-scroll-area](https://www.npmjs.com/package/@radix-ui/react-scroll-area)                                             | 1.4.0                   | MIT                                 |
| [@radix-ui/react-select](https://www.npmjs.com/package/@radix-ui/react-select)                                                       | 2.4.1                   | MIT                                 |
| [@radix-ui/react-separator](https://www.npmjs.com/package/@radix-ui/react-separator)                                                 | 1.2.0                   | MIT                                 |
| [@radix-ui/react-slider](https://www.npmjs.com/package/@radix-ui/react-slider)                                                       | 1.6.1                   | MIT                                 |
| [@radix-ui/react-slot](https://www.npmjs.com/package/@radix-ui/react-slot)                                                           | 1.5.0                   | MIT                                 |
| [@radix-ui/react-switch](https://www.npmjs.com/package/@radix-ui/react-switch)                                                       | 1.4.1                   | MIT                                 |
| [@radix-ui/react-tabs](https://www.npmjs.com/package/@radix-ui/react-tabs)                                                           | 1.2.1                   | MIT                                 |
| [@radix-ui/react-toast](https://www.npmjs.com/package/@radix-ui/react-toast)                                                         | 1.3.1                   | MIT                                 |
| [@radix-ui/react-toggle](https://www.npmjs.com/package/@radix-ui/react-toggle)                                                       | 1.2.1                   | MIT                                 |
| [@radix-ui/react-toggle-group](https://www.npmjs.com/package/@radix-ui/react-toggle-group)                                           | 1.2.1                   | MIT                                 |
| [@radix-ui/react-toolbar](https://www.npmjs.com/package/@radix-ui/react-toolbar)                                                     | 1.2.1                   | MIT                                 |
| [@radix-ui/react-tooltip](https://www.npmjs.com/package/@radix-ui/react-tooltip)                                                     | 1.4.1                   | MIT                                 |
| [@radix-ui/react-use-callback-ref](https://www.npmjs.com/package/@radix-ui/react-use-callback-ref)                                   | 1.1.5                   | MIT                                 |
| [@radix-ui/react-use-controllable-state](https://www.npmjs.com/package/@radix-ui/react-use-controllable-state)                       | 1.3.0                   | MIT                                 |
| [@radix-ui/react-use-effect-event](https://www.npmjs.com/package/@radix-ui/react-use-effect-event)                                   | 0.0.5                   | MIT                                 |
| [@radix-ui/react-use-escape-keydown](https://www.npmjs.com/package/@radix-ui/react-use-escape-keydown)                               | 1.1.6                   | MIT                                 |
| [@radix-ui/react-use-is-hydrated](https://www.npmjs.com/package/@radix-ui/react-use-is-hydrated)                                     | 0.1.3                   | MIT                                 |
| [@radix-ui/react-use-layout-effect](https://www.npmjs.com/package/@radix-ui/react-use-layout-effect)                                 | 1.1.4                   | MIT                                 |
| [@radix-ui/react-use-previous](https://www.npmjs.com/package/@radix-ui/react-use-previous)                                           | 1.1.4                   | MIT                                 |
| [@radix-ui/react-use-rect](https://www.npmjs.com/package/@radix-ui/react-use-rect)                                                   | 1.1.4                   | MIT                                 |
| [@radix-ui/react-use-size](https://www.npmjs.com/package/@radix-ui/react-use-size)                                                   | 1.1.5                   | MIT                                 |
| [@radix-ui/react-visually-hidden](https://www.npmjs.com/package/@radix-ui/react-visually-hidden)                                     | 1.2.13                  | MIT                                 |
| [@radix-ui/rect](https://www.npmjs.com/package/@radix-ui/rect)                                                                       | 1.1.3                   | MIT                                 |
| [@rolldown/binding-darwin-arm64](https://www.npmjs.com/package/@rolldown/binding-darwin-arm64)                                       | 1.2.16                  | MIT                                 |
| [@rolldown/pluginutils](https://www.npmjs.com/package/@rolldown/pluginutils)                                                         | 1.0.1                   | MIT                                 |
| [@sinclair/typebox](https://www.npmjs.com/package/@sinclair/typebox)                                                                 | 0.34.52                 | MIT                                 |
| [@sinonjs/commons](https://www.npmjs.com/package/@sinonjs/commons)                                                                   | 3.0.1                   | BSD-3-Clause                        |
| [@sinonjs/fake-timers](https://www.npmjs.com/package/@sinonjs/fake-timers)                                                           | 15.4.0                  | BSD-3-Clause                        |
| [@smithy/core](https://www.npmjs.com/package/@smithy/core)                                                                           | 3.38.0                  | Apache-2.0                          |
| [@smithy/credential-provider-imds](https://www.npmjs.com/package/@smithy/credential-provider-imds)                                   | 4.5.2                   | Apache-2.0                          |
| [@smithy/fetch-http-handler](https://www.npmjs.com/package/@smithy/fetch-http-handler)                                               | 5.8.0                   | Apache-2.0                          |
| [@smithy/node-http-handler](https://www.npmjs.com/package/@smithy/node-http-handler)                                                 | 4.14.0                  | Apache-2.0                          |
| [@smithy/signature-v4](https://www.npmjs.com/package/@smithy/signature-v4)                                                           | 5.7.5                   | Apache-2.0                          |
| [@smithy/types](https://www.npmjs.com/package/@smithy/types)                                                                         | 4.19.0                  | Apache-2.0                          |
| [@socket.io/component-emitter](https://www.npmjs.com/package/@socket.io/component-emitter)                                           | 3.1.2                   | MIT                                 |
| [@socket.io/redis-adapter](https://www.npmjs.com/package/@socket.io/redis-adapter)                                                   | 8.3.0                   | MIT                                 |
| [@sqltools/formatter](https://www.npmjs.com/package/@sqltools/formatter)                                                             | 1.2.5                   | MIT                                 |
| [@standard-schema/utils](https://www.npmjs.com/package/@standard-schema/utils)                                                       | 0.3.0                   | MIT                                 |
| [@swc/helpers](https://www.npmjs.com/package/@swc/helpers)                                                                           | 0.5.23                  | Apache-2.0                          |
| [@tailwindcss/node](https://www.npmjs.com/package/@tailwindcss/node)                                                                 | 4.3.3                   | MIT                                 |
| [@tailwindcss/oxide](https://www.npmjs.com/package/@tailwindcss/oxide)                                                               | 4.3.3                   | MIT                                 |
| [@tailwindcss/oxide-darwin-arm64](https://www.npmjs.com/package/@tailwindcss/oxide-darwin-arm64)                                     | 4.3.3                   | MIT                                 |
| [@tailwindcss/postcss](https://www.npmjs.com/package/@tailwindcss/postcss)                                                           | 4.3.3                   | MIT                                 |
| [@testcontainers/mysql](https://www.npmjs.com/package/@testcontainers/mysql)                                                         | 12.2.1                  | MIT                                 |
| [@testcontainers/postgresql](https://www.npmjs.com/package/@testcontainers/postgresql)                                               | 12.2.1                  | MIT                                 |
| [@testcontainers/redis](https://www.npmjs.com/package/@testcontainers/redis)                                                         | 12.2.1                  | MIT                                 |
| [@testing-library/dom](https://www.npmjs.com/package/@testing-library/dom)                                                           | 10.4.2                  | MIT                                 |
| [@testing-library/jest-dom](https://www.npmjs.com/package/@testing-library/jest-dom)                                                 | 7.0.1                   | MIT                                 |
| [@testing-library/react](https://www.npmjs.com/package/@testing-library/react)                                                       | 16.3.3                  | MIT                                 |
| [@testing-library/user-event](https://www.npmjs.com/package/@testing-library/user-event)                                             | 14.6.8                  | MIT                                 |
| [@tokenizer/inflate](https://www.npmjs.com/package/@tokenizer/inflate)                                                               | 0.4.1, 0.6.0            | MIT                                 |
| [@tokenizer/token](https://www.npmjs.com/package/@tokenizer/token)                                                                   | 0.3.0                   | MIT                                 |
| [@turbo/darwin-arm64](https://www.npmjs.com/package/@turbo/darwin-arm64)                                                             | 2.11.10                 | MIT                                 |
| [@types/aria-query](https://www.npmjs.com/package/@types/aria-query)                                                                 | 5.0.4                   | MIT                                 |
| [@types/babel__core](https://www.npmjs.com/package/@types/babel__core)                                                               | 7.20.5                  | MIT                                 |
| [@types/babel__generator](https://www.npmjs.com/package/@types/babel__generator)                                                     | 7.27.0                  | MIT                                 |
| [@types/babel__template](https://www.npmjs.com/package/@types/babel__template)                                                       | 7.4.4                   | MIT                                 |
| [@types/babel__traverse](https://www.npmjs.com/package/@types/babel__traverse)                                                       | 7.28.0                  | MIT                                 |
| [@types/better-sqlite3](https://www.npmjs.com/package/@types/better-sqlite3)                                                         | 9.6.0                   | MIT                                 |
| [@types/body-parser](https://www.npmjs.com/package/@types/body-parser)                                                               | 1.19.6                  | MIT                                 |
| [@types/canvas-confetti](https://www.npmjs.com/package/@types/canvas-confetti)                                                       | 1.9.0                   | MIT                                 |
| [@types/chai](https://www.npmjs.com/package/@types/chai)                                                                             | 5.2.3                   | MIT                                 |
| [@types/connect](https://www.npmjs.com/package/@types/connect)                                                                       | 3.4.38                  | MIT                                 |
| [@types/cookie-parser](https://www.npmjs.com/package/@types/cookie-parser)                                                           | 1.4.10                  | MIT                                 |
| [@types/cookiejar](https://www.npmjs.com/package/@types/cookiejar)                                                                   | 2.1.5                   | MIT                                 |
| [@types/cors](https://www.npmjs.com/package/@types/cors)                                                                             | 2.8.19                  | MIT                                 |
| [@types/deep-eql](https://www.npmjs.com/package/@types/deep-eql)                                                                     | 4.0.2                   | MIT                                 |
| [@types/docker-modem](https://www.npmjs.com/package/@types/docker-modem)                                                             | 3.0.6                   | MIT                                 |
| [@types/dockerode](https://www.npmjs.com/package/@types/dockerode)                                                                   | 4.0.2                   | MIT                                 |
| [@types/esrecurse](https://www.npmjs.com/package/@types/esrecurse)                                                                   | 4.3.1                   | MIT                                 |
| [@types/estree](https://www.npmjs.com/package/@types/estree)                                                                         | 1.0.10                  | MIT                                 |
| [@types/express](https://www.npmjs.com/package/@types/express)                                                                       | 5.0.6                   | MIT                                 |
| [@types/express-serve-static-core](https://www.npmjs.com/package/@types/express-serve-static-core)                                   | 5.1.3                   | MIT                                 |
| [@types/howler](https://www.npmjs.com/package/@types/howler)                                                                         | 2.2.13                  | MIT                                 |
| [@types/http-errors](https://www.npmjs.com/package/@types/http-errors)                                                               | 2.0.5                   | MIT                                 |
| [@types/istanbul-lib-coverage](https://www.npmjs.com/package/@types/istanbul-lib-coverage)                                           | 2.0.6                   | MIT                                 |
| [@types/istanbul-lib-report](https://www.npmjs.com/package/@types/istanbul-lib-report)                                               | 3.0.3                   | MIT                                 |
| [@types/istanbul-reports](https://www.npmjs.com/package/@types/istanbul-reports)                                                     | 3.0.4                   | MIT                                 |
| [@types/jest](https://www.npmjs.com/package/@types/jest)                                                                             | 30.0.0                  | MIT                                 |
| [@types/json-schema](https://www.npmjs.com/package/@types/json-schema)                                                               | 7.0.15                  | MIT                                 |
| [@types/jsonwebtoken](https://www.npmjs.com/package/@types/jsonwebtoken)                                                             | 9.0.10                  | MIT                                 |
| [@types/methods](https://www.npmjs.com/package/@types/methods)                                                                       | 1.1.4                   | MIT                                 |
| [@types/ms](https://www.npmjs.com/package/@types/ms)                                                                                 | 2.1.0                   | MIT                                 |
| [@types/multer](https://www.npmjs.com/package/@types/multer)                                                                         | 2.3.0                   | MIT                                 |
| [@types/node](https://www.npmjs.com/package/@types/node)                                                                             | 18.19.130, 24.19.2      | MIT                                 |
| [@types/passport](https://www.npmjs.com/package/@types/passport)                                                                     | 1.0.17                  | MIT                                 |
| [@types/passport-jwt](https://www.npmjs.com/package/@types/passport-jwt)                                                             | 4.0.1                   | MIT                                 |
| [@types/passport-strategy](https://www.npmjs.com/package/@types/passport-strategy)                                                   | 0.2.38                  | MIT                                 |
| [@types/pg](https://www.npmjs.com/package/@types/pg)                                                                                 | 8.23.1                  | MIT                                 |
| [@types/qrcode](https://www.npmjs.com/package/@types/qrcode)                                                                         | 1.5.6                   | MIT                                 |
| [@types/qs](https://www.npmjs.com/package/@types/qs)                                                                                 | 6.15.1                  | MIT                                 |
| [@types/range-parser](https://www.npmjs.com/package/@types/range-parser)                                                             | 1.2.7                   | MIT                                 |
| [@types/react](https://www.npmjs.com/package/@types/react)                                                                           | 19.3.0                  | MIT                                 |
| [@types/react-dom](https://www.npmjs.com/package/@types/react-dom)                                                                   | 19.3.0                  | MIT                                 |
| [@types/send](https://www.npmjs.com/package/@types/send)                                                                             | 1.2.1                   | MIT                                 |
| [@types/serve-static](https://www.npmjs.com/package/@types/serve-static)                                                             | 2.2.0                   | MIT                                 |
| [@types/ssh2](https://www.npmjs.com/package/@types/ssh2)                                                                             | 0.5.52, 1.15.6          | MIT                                 |
| [@types/ssh2-streams](https://www.npmjs.com/package/@types/ssh2-streams)                                                             | 0.1.13                  | MIT                                 |
| [@types/stack-utils](https://www.npmjs.com/package/@types/stack-utils)                                                               | 2.0.3                   | MIT                                 |
| [@types/superagent](https://www.npmjs.com/package/@types/superagent)                                                                 | 8.1.11                  | MIT                                 |
| [@types/supertest](https://www.npmjs.com/package/@types/supertest)                                                                   | 7.2.1                   | MIT                                 |
| [@types/ws](https://www.npmjs.com/package/@types/ws)                                                                                 | 8.18.2                  | MIT                                 |
| [@types/yargs](https://www.npmjs.com/package/@types/yargs)                                                                           | 17.0.35                 | MIT                                 |
| [@types/yargs-parser](https://www.npmjs.com/package/@types/yargs-parser)                                                             | 21.0.3                  | MIT                                 |
| [@typescript-eslint/eslint-plugin](https://www.npmjs.com/package/@typescript-eslint/eslint-plugin)                                   | 8.72.1                  | MIT                                 |
| [@typescript-eslint/parser](https://www.npmjs.com/package/@typescript-eslint/parser)                                                 | 8.72.1                  | MIT                                 |
| [@typescript-eslint/project-service](https://www.npmjs.com/package/@typescript-eslint/project-service)                               | 8.72.1                  | MIT                                 |
| [@typescript-eslint/scope-manager](https://www.npmjs.com/package/@typescript-eslint/scope-manager)                                   | 8.72.1                  | MIT                                 |
| [@typescript-eslint/tsconfig-utils](https://www.npmjs.com/package/@typescript-eslint/tsconfig-utils)                                 | 8.72.1                  | MIT                                 |
| [@typescript-eslint/type-utils](https://www.npmjs.com/package/@typescript-eslint/type-utils)                                         | 8.72.1                  | MIT                                 |
| [@typescript-eslint/types](https://www.npmjs.com/package/@typescript-eslint/types)                                                   | 8.72.1                  | MIT                                 |
| [@typescript-eslint/typescript-estree](https://www.npmjs.com/package/@typescript-eslint/typescript-estree)                           | 8.72.1                  | MIT                                 |
| [@typescript-eslint/utils](https://www.npmjs.com/package/@typescript-eslint/utils)                                                   | 8.72.1                  | MIT                                 |
| [@typescript-eslint/visitor-keys](https://www.npmjs.com/package/@typescript-eslint/visitor-keys)                                     | 8.72.1                  | MIT                                 |
| [@ungap/structured-clone](https://www.npmjs.com/package/@ungap/structured-clone)                                                     | 1.4.0                   | ISC                                 |
| [@unrs/resolver-binding-darwin-arm64](https://www.npmjs.com/package/@unrs/resolver-binding-darwin-arm64)                             | 1.12.2                  | MIT                                 |
| [@vitejs/plugin-react](https://www.npmjs.com/package/@vitejs/plugin-react)                                                           | 6.1.2                   | MIT                                 |
| [@vitest/mocker](https://www.npmjs.com/package/@vitest/mocker)                                                                       | 5.0.5                   | MIT                                 |
| [@vitest/spy](https://www.npmjs.com/package/@vitest/spy)                                                                             | 5.0.5                   | MIT                                 |
| [@webassemblyjs/ast](https://www.npmjs.com/package/@webassemblyjs/ast)                                                               | 1.14.1                  | MIT                                 |
| [@webassemblyjs/floating-point-hex-parser](https://www.npmjs.com/package/@webassemblyjs/floating-point-hex-parser)                   | 1.13.2                  | MIT                                 |
| [@webassemblyjs/helper-api-error](https://www.npmjs.com/package/@webassemblyjs/helper-api-error)                                     | 1.13.2                  | MIT                                 |
| [@webassemblyjs/helper-buffer](https://www.npmjs.com/package/@webassemblyjs/helper-buffer)                                           | 1.14.1                  | MIT                                 |
| [@webassemblyjs/helper-numbers](https://www.npmjs.com/package/@webassemblyjs/helper-numbers)                                         | 1.13.2                  | MIT                                 |
| [@webassemblyjs/helper-wasm-bytecode](https://www.npmjs.com/package/@webassemblyjs/helper-wasm-bytecode)                             | 1.13.2                  | MIT                                 |
| [@webassemblyjs/helper-wasm-section](https://www.npmjs.com/package/@webassemblyjs/helper-wasm-section)                               | 1.14.1                  | MIT                                 |
| [@webassemblyjs/ieee754](https://www.npmjs.com/package/@webassemblyjs/ieee754)                                                       | 1.13.2                  | MIT                                 |
| [@webassemblyjs/leb128](https://www.npmjs.com/package/@webassemblyjs/leb128)                                                         | 1.13.2                  | Apache-2.0                          |
| [@webassemblyjs/utf8](https://www.npmjs.com/package/@webassemblyjs/utf8)                                                             | 1.13.2                  | MIT                                 |
| [@webassemblyjs/wasm-edit](https://www.npmjs.com/package/@webassemblyjs/wasm-edit)                                                   | 1.14.1                  | MIT                                 |
| [@webassemblyjs/wasm-gen](https://www.npmjs.com/package/@webassemblyjs/wasm-gen)                                                     | 1.14.1                  | MIT                                 |
| [@webassemblyjs/wasm-opt](https://www.npmjs.com/package/@webassemblyjs/wasm-opt)                                                     | 1.14.1                  | MIT                                 |
| [@webassemblyjs/wasm-parser](https://www.npmjs.com/package/@webassemblyjs/wasm-parser)                                               | 1.14.1                  | MIT                                 |
| [@webassemblyjs/wast-printer](https://www.npmjs.com/package/@webassemblyjs/wast-printer)                                             | 1.14.1                  | MIT                                 |
| [@xtuc/ieee754](https://www.npmjs.com/package/@xtuc/ieee754)                                                                         | 1.2.0                   | BSD-3-Clause                        |
| [@xtuc/long](https://www.npmjs.com/package/@xtuc/long)                                                                               | 4.2.2                   | Apache-2.0                          |
| [@zxing/browser](https://www.npmjs.com/package/@zxing/browser)                                                                       | 0.2.1                   | MIT                                 |
| [@zxing/library](https://www.npmjs.com/package/@zxing/library)                                                                       | 0.23.0                  | Apache-2.0                          |
| [@zxing/text-encoding](https://www.npmjs.com/package/@zxing/text-encoding)                                                           | 0.9.0                   | (Unlicense OR Apache-2.0)           |
| [abort-controller](https://www.npmjs.com/package/abort-controller)                                                                   | 3.0.0                   | MIT                                 |
| [accepts](https://www.npmjs.com/package/accepts)                                                                                     | 1.3.8, 2.0.0            | MIT                                 |
| [acorn](https://www.npmjs.com/package/acorn)                                                                                         | 8.19.0                  | MIT                                 |
| [acorn-jsx](https://www.npmjs.com/package/acorn-jsx)                                                                                 | 5.3.2                   | MIT                                 |
| [ajv](https://www.npmjs.com/package/ajv)                                                                                             | 6.15.0, 8.18.0, 8.20.0  | MIT                                 |
| [ajv-formats](https://www.npmjs.com/package/ajv-formats)                                                                             | 3.0.1                   | MIT                                 |
| [ajv-keywords](https://www.npmjs.com/package/ajv-keywords)                                                                           | 3.5.2, 5.1.0            | MIT                                 |
| [ansi-colors](https://www.npmjs.com/package/ansi-colors)                                                                             | 4.1.3                   | MIT                                 |
| [ansi-escapes](https://www.npmjs.com/package/ansi-escapes)                                                                           | 4.3.2                   | MIT                                 |
| [ansi-regex](https://www.npmjs.com/package/ansi-regex)                                                                               | 5.0.1, 6.5.0            | MIT                                 |
| [ansi-styles](https://www.npmjs.com/package/ansi-styles)                                                                             | 4.3.0, 5.2.0, 6.2.3     | MIT                                 |
| [ansis](https://www.npmjs.com/package/ansis)                                                                                         | 4.2.0, 4.4.0            | ISC                                 |
| [anymatch](https://www.npmjs.com/package/anymatch)                                                                                   | 3.1.3                   | ISC                                 |
| [app-root-path](https://www.npmjs.com/package/app-root-path)                                                                         | 3.1.0                   | MIT                                 |
| [append-field](https://www.npmjs.com/package/append-field)                                                                           | 1.0.0                   | MIT                                 |
| [archiver](https://www.npmjs.com/package/archiver)                                                                                   | 7.0.1                   | MIT                                 |
| [archiver-utils](https://www.npmjs.com/package/archiver-utils)                                                                       | 5.0.2                   | MIT                                 |
| [argon2](https://www.npmjs.com/package/argon2)                                                                                       | 0.45.1                  | MIT                                 |
| [argparse](https://www.npmjs.com/package/argparse)                                                                                   | 1.0.10                  | MIT                                 |
| [argparse](https://www.npmjs.com/package/argparse)                                                                                   | 2.0.1                   | Python-2.0                          |
| [aria-hidden](https://www.npmjs.com/package/aria-hidden)                                                                             | 1.2.6                   | MIT                                 |
| [aria-query](https://www.npmjs.com/package/aria-query)                                                                               | 5.3.0, 5.3.2            | Apache-2.0                          |
| [array-timsort](https://www.npmjs.com/package/array-timsort)                                                                         | 1.0.3                   | MIT                                 |
| [asap](https://www.npmjs.com/package/asap)                                                                                           | 2.0.6                   | MIT                                 |
| [asn1](https://www.npmjs.com/package/asn1)                                                                                           | 0.2.6                   | MIT                                 |
| [assertion-error](https://www.npmjs.com/package/assertion-error)                                                                     | 2.0.1                   | MIT                                 |
| [async](https://www.npmjs.com/package/async)                                                                                         | 3.2.6                   | MIT                                 |
| [async-lock](https://www.npmjs.com/package/async-lock)                                                                               | 1.4.1                   | MIT                                 |
| [asynckit](https://www.npmjs.com/package/asynckit)                                                                                   | 0.4.0                   | MIT                                 |
| [available-typed-arrays](https://www.npmjs.com/package/available-typed-arrays)                                                       | 1.0.7                   | MIT                                 |
| [aws-ssl-profiles](https://www.npmjs.com/package/aws-ssl-profiles)                                                                   | 1.1.2                   | MIT                                 |
| [axe-core](https://www.npmjs.com/package/axe-core)                                                                                   | 4.14.0                  | MPL-2.0                             |
| [b4a](https://www.npmjs.com/package/b4a)                                                                                             | 1.9.0                   | Apache-2.0                          |
| [babel-jest](https://www.npmjs.com/package/babel-jest)                                                                               | 30.5.2                  | MIT                                 |
| [babel-plugin-istanbul](https://www.npmjs.com/package/babel-plugin-istanbul)                                                         | 8.0.0                   | BSD-3-Clause                        |
| [babel-plugin-jest-hoist](https://www.npmjs.com/package/babel-plugin-jest-hoist)                                                     | 30.5.0                  | MIT                                 |
| [babel-preset-current-node-syntax](https://www.npmjs.com/package/babel-preset-current-node-syntax)                                   | 1.2.0                   | MIT                                 |
| [babel-preset-jest](https://www.npmjs.com/package/babel-preset-jest)                                                                 | 30.5.0                  | MIT                                 |
| [balanced-match](https://www.npmjs.com/package/balanced-match)                                                                       | 1.0.2, 4.0.4            | MIT                                 |
| [bare-events](https://www.npmjs.com/package/bare-events)                                                                             | 2.9.2                   | Apache-2.0                          |
| [bare-fs](https://www.npmjs.com/package/bare-fs)                                                                                     | 4.8.4                   | Apache-2.0                          |
| [bare-path](https://www.npmjs.com/package/bare-path)                                                                                 | 3.1.2                   | Apache-2.0                          |
| [bare-stream](https://www.npmjs.com/package/bare-stream)                                                                             | 2.13.4                  | Apache-2.0                          |
| [bare-url](https://www.npmjs.com/package/bare-url)                                                                                   | 2.5.5                   | Apache-2.0                          |
| [base64-js](https://www.npmjs.com/package/base64-js)                                                                                 | 1.5.1                   | MIT                                 |
| [base64id](https://www.npmjs.com/package/base64id)                                                                                   | 2.0.0                   | MIT                                 |
| [baseline-browser-mapping](https://www.npmjs.com/package/baseline-browser-mapping)                                                   | 2.11.34                 | Apache-2.0                          |
| [bcrypt-pbkdf](https://www.npmjs.com/package/bcrypt-pbkdf)                                                                           | 1.0.2                   | BSD-3-Clause                        |
| [better-sqlite3](https://www.npmjs.com/package/better-sqlite3)                                                                       | 12.11.1, 13.0.3         | MIT                                 |
| [bidi-js](https://www.npmjs.com/package/bidi-js)                                                                                     | 1.1.0                   | MIT                                 |
| [bindings](https://www.npmjs.com/package/bindings)                                                                                   | 1.5.0                   | MIT                                 |
| [bl](https://www.npmjs.com/package/bl)                                                                                               | 4.1.0                   | MIT                                 |
| [body-parser](https://www.npmjs.com/package/body-parser)                                                                             | 2.4.0                   | MIT                                 |
| [bowser](https://www.npmjs.com/package/bowser)                                                                                       | 2.15.0                  | MIT                                 |
| [brace-expansion](https://www.npmjs.com/package/brace-expansion)                                                                     | 1.1.21, 2.1.7, 5.0.12   | MIT                                 |
| [browserslist](https://www.npmjs.com/package/browserslist)                                                                           | 4.29.5                  | MIT                                 |
| [bs-logger](https://www.npmjs.com/package/bs-logger)                                                                                 | 0.2.6                   | MIT                                 |
| [bser](https://www.npmjs.com/package/bser)                                                                                           | 2.1.2                   | MIT                                 |
| [buffer](https://www.npmjs.com/package/buffer)                                                                                       | 5.7.1, 6.0.3            | MIT                                 |
| [buffer-crc32](https://www.npmjs.com/package/buffer-crc32)                                                                           | 1.0.0                   | MIT                                 |
| [buffer-equal-constant-time](https://www.npmjs.com/package/buffer-equal-constant-time)                                               | 1.0.1                   | BSD-3-Clause                        |
| [buffer-from](https://www.npmjs.com/package/buffer-from)                                                                             | 1.1.2                   | MIT                                 |
| [buildcheck](https://www.npmjs.com/package/buildcheck)                                                                               | 0.0.7                   | MIT                                 |
| [busboy](https://www.npmjs.com/package/busboy)                                                                                       | 1.6.0                   | MIT                                 |
| [byline](https://www.npmjs.com/package/byline)                                                                                       | 5.0.0                   | MIT                                 |
| [bytes](https://www.npmjs.com/package/bytes)                                                                                         | 3.1.2                   | MIT                                 |
| [cacheable](https://www.npmjs.com/package/cacheable)                                                                                 | 2.5.0                   | MIT                                 |
| [call-bind](https://www.npmjs.com/package/call-bind)                                                                                 | 1.0.9                   | MIT                                 |
| [call-bind-apply-helpers](https://www.npmjs.com/package/call-bind-apply-helpers)                                                     | 1.0.2                   | MIT                                 |
| [call-bound](https://www.npmjs.com/package/call-bound)                                                                               | 1.0.4                   | MIT                                 |
| [callsites](https://www.npmjs.com/package/callsites)                                                                                 | 3.1.0                   | MIT                                 |
| [camelcase](https://www.npmjs.com/package/camelcase)                                                                                 | 5.3.1, 6.3.0            | MIT                                 |
| [caniuse-lite](https://www.npmjs.com/package/caniuse-lite)                                                                           | 1.0.30001820            | CC-BY-4.0                           |
| [canvas-confetti](https://www.npmjs.com/package/canvas-confetti)                                                                     | 1.9.4                   | ISC                                 |
| [chai](https://www.npmjs.com/package/chai)                                                                                           | 6.3.0                   | MIT                                 |
| [chalk](https://www.npmjs.com/package/chalk)                                                                                         | 4.1.2                   | MIT                                 |
| [char-regex](https://www.npmjs.com/package/char-regex)                                                                               | 1.0.2                   | MIT                                 |
| [chardet](https://www.npmjs.com/package/chardet)                                                                                     | 2.2.0                   | MIT                                 |
| [chokidar](https://www.npmjs.com/package/chokidar)                                                                                   | 4.0.3                   | MIT                                 |
| [chownr](https://www.npmjs.com/package/chownr)                                                                                       | 1.1.4                   | ISC                                 |
| [chrome-trace-event](https://www.npmjs.com/package/chrome-trace-event)                                                               | 1.0.4                   | MIT                                 |
| [ci-info](https://www.npmjs.com/package/ci-info)                                                                                     | 4.4.0                   | MIT                                 |
| [cjs-module-lexer](https://www.npmjs.com/package/cjs-module-lexer)                                                                   | 2.3.0                   | MIT                                 |
| [class-variance-authority](https://www.npmjs.com/package/class-variance-authority)                                                   | 0.7.1                   | Apache-2.0                          |
| [cli-cursor](https://www.npmjs.com/package/cli-cursor)                                                                               | 3.1.0                   | MIT                                 |
| [cli-spinners](https://www.npmjs.com/package/cli-spinners)                                                                           | 2.9.2                   | MIT                                 |
| [cli-table3](https://www.npmjs.com/package/cli-table3)                                                                               | 0.6.5                   | MIT                                 |
| [cli-width](https://www.npmjs.com/package/cli-width)                                                                                 | 4.1.0                   | ISC                                 |
| [client-only](https://www.npmjs.com/package/client-only)                                                                             | 0.0.1                   | MIT                                 |
| [cliui](https://www.npmjs.com/package/cliui)                                                                                         | 6.0.0, 8.0.1            | ISC                                 |
| [clone](https://www.npmjs.com/package/clone)                                                                                         | 1.0.4                   | MIT                                 |
| [clsx](https://www.npmjs.com/package/clsx)                                                                                           | 2.1.1                   | MIT                                 |
| [cluster-key-slot](https://www.npmjs.com/package/cluster-key-slot)                                                                   | 1.1.1                   | Apache-2.0                          |
| [co](https://www.npmjs.com/package/co)                                                                                               | 4.6.0                   | MIT                                 |
| [collect-v8-coverage](https://www.npmjs.com/package/collect-v8-coverage)                                                             | 1.0.3                   | MIT                                 |
| [color-convert](https://www.npmjs.com/package/color-convert)                                                                         | 2.0.1                   | MIT                                 |
| [color-name](https://www.npmjs.com/package/color-name)                                                                               | 1.1.4                   | MIT                                 |
| [combined-stream](https://www.npmjs.com/package/combined-stream)                                                                     | 1.0.8                   | MIT                                 |
| [commander](https://www.npmjs.com/package/commander)                                                                                 | 2.20.3, 4.1.1           | MIT                                 |
| [comment-json](https://www.npmjs.com/package/comment-json)                                                                           | 5.0.0                   | MIT                                 |
| [component-emitter](https://www.npmjs.com/package/component-emitter)                                                                 | 1.3.1                   | MIT                                 |
| [compress-commons](https://www.npmjs.com/package/compress-commons)                                                                   | 6.0.2                   | MIT                                 |
| [concat-map](https://www.npmjs.com/package/concat-map)                                                                               | 0.0.1                   | MIT                                 |
| [content-disposition](https://www.npmjs.com/package/content-disposition)                                                             | 1.1.0, 2.0.1            | MIT                                 |
| [content-type](https://www.npmjs.com/package/content-type)                                                                           | 1.0.5, 2.1.0            | MIT                                 |
| [convert-source-map](https://www.npmjs.com/package/convert-source-map)                                                               | 2.0.0                   | MIT                                 |
| [cookie](https://www.npmjs.com/package/cookie)                                                                                       | 0.7.2                   | MIT                                 |
| [cookie-parser](https://www.npmjs.com/package/cookie-parser)                                                                         | 1.4.7                   | MIT                                 |
| [cookie-signature](https://www.npmjs.com/package/cookie-signature)                                                                   | 1.0.6, 1.2.2            | MIT                                 |
| [cookiejar](https://www.npmjs.com/package/cookiejar)                                                                                 | 2.1.4                   | MIT                                 |
| [core-util-is](https://www.npmjs.com/package/core-util-is)                                                                           | 1.0.3                   | MIT                                 |
| [cors](https://www.npmjs.com/package/cors)                                                                                           | 2.8.6                   | MIT                                 |
| [cosmiconfig](https://www.npmjs.com/package/cosmiconfig)                                                                             | 8.3.6                   | MIT                                 |
| [cpu-features](https://www.npmjs.com/package/cpu-features)                                                                           | 0.0.10                  | MIT                                 |
| [crc-32](https://www.npmjs.com/package/crc-32)                                                                                       | 1.2.2                   | Apache-2.0                          |
| [crc32-stream](https://www.npmjs.com/package/crc32-stream)                                                                           | 6.0.0                   | MIT                                 |
| [cross-env](https://www.npmjs.com/package/cross-env)                                                                                 | 10.1.0                  | MIT                                 |
| [cross-spawn](https://www.npmjs.com/package/cross-spawn)                                                                             | 7.0.6                   | MIT                                 |
| [css-tree](https://www.npmjs.com/package/css-tree)                                                                                   | 3.2.1                   | MIT                                 |
| [css.escape](https://www.npmjs.com/package/css.escape)                                                                               | 1.5.1                   | MIT                                 |
| [csstype](https://www.npmjs.com/package/csstype)                                                                                     | 3.2.3                   | MIT                                 |
| [data-urls](https://www.npmjs.com/package/data-urls)                                                                                 | 8.0.0                   | MIT                                 |
| [dayjs](https://www.npmjs.com/package/dayjs)                                                                                         | 1.11.23                 | MIT                                 |
| [debug](https://www.npmjs.com/package/debug)                                                                                         | 4.3.7, 4.4.3            | MIT                                 |
| [decamelize](https://www.npmjs.com/package/decamelize)                                                                               | 1.2.0                   | MIT                                 |
| [decimal.js](https://www.npmjs.com/package/decimal.js)                                                                               | 10.6.0                  | MIT                                 |
| [decompress-response](https://www.npmjs.com/package/decompress-response)                                                             | 6.0.0                   | MIT                                 |
| [dedent](https://www.npmjs.com/package/dedent)                                                                                       | 1.7.2                   | MIT                                 |
| [deep-extend](https://www.npmjs.com/package/deep-extend)                                                                             | 0.6.0                   | MIT                                 |
| [deep-is](https://www.npmjs.com/package/deep-is)                                                                                     | 0.1.4                   | MIT                                 |
| [deepmerge](https://www.npmjs.com/package/deepmerge)                                                                                 | 4.3.1                   | MIT                                 |
| [defaults](https://www.npmjs.com/package/defaults)                                                                                   | 1.0.4                   | MIT                                 |
| [define-data-property](https://www.npmjs.com/package/define-data-property)                                                           | 1.1.4                   | MIT                                 |
| [delayed-stream](https://www.npmjs.com/package/delayed-stream)                                                                       | 1.0.0                   | MIT                                 |
| [denque](https://www.npmjs.com/package/denque)                                                                                       | 2.1.0                   | Apache-2.0                          |
| [depd](https://www.npmjs.com/package/depd)                                                                                           | 2.0.0                   | MIT                                 |
| [dequal](https://www.npmjs.com/package/dequal)                                                                                       | 2.0.3                   | MIT                                 |
| [detect-libc](https://www.npmjs.com/package/detect-libc)                                                                             | 2.1.2                   | Apache-2.0                          |
| [detect-newline](https://www.npmjs.com/package/detect-newline)                                                                       | 3.1.0                   | MIT                                 |
| [detect-node-es](https://www.npmjs.com/package/detect-node-es)                                                                       | 1.1.0                   | MIT                                 |
| [dezalgo](https://www.npmjs.com/package/dezalgo)                                                                                     | 1.0.4                   | ISC                                 |
| [dijkstrajs](https://www.npmjs.com/package/dijkstrajs)                                                                               | 1.0.3                   | MIT                                 |
| [docker-compose](https://www.npmjs.com/package/docker-compose)                                                                       | 1.5.0                   | MIT                                 |
| [docker-modem](https://www.npmjs.com/package/docker-modem)                                                                           | 5.0.7                   | Apache-2.0                          |
| [dockerode](https://www.npmjs.com/package/dockerode)                                                                                 | 5.0.1                   | Apache-2.0                          |
| [dom-accessibility-api](https://www.npmjs.com/package/dom-accessibility-api)                                                         | 0.5.16, 0.6.3           | MIT                                 |
| [dotenv](https://www.npmjs.com/package/dotenv)                                                                                       | 16.6.1                  | BSD-2-Clause                        |
| [dunder-proto](https://www.npmjs.com/package/dunder-proto)                                                                           | 1.0.1                   | MIT                                 |
| [eastasianwidth](https://www.npmjs.com/package/eastasianwidth)                                                                       | 0.2.0                   | MIT                                 |
| [ecdsa-sig-formatter](https://www.npmjs.com/package/ecdsa-sig-formatter)                                                             | 1.0.11                  | Apache-2.0                          |
| [ee-first](https://www.npmjs.com/package/ee-first)                                                                                   | 1.1.1                   | MIT                                 |
| [electron-to-chromium](https://www.npmjs.com/package/electron-to-chromium)                                                           | 1.5.468                 | ISC                                 |
| [emittery](https://www.npmjs.com/package/emittery)                                                                                   | 0.13.1                  | MIT                                 |
| [emoji-regex](https://www.npmjs.com/package/emoji-regex)                                                                             | 8.0.0, 9.2.2            | MIT                                 |
| [encodeurl](https://www.npmjs.com/package/encodeurl)                                                                                 | 2.0.1                   | MIT                                 |
| [end-of-stream](https://www.npmjs.com/package/end-of-stream)                                                                         | 1.4.5                   | MIT                                 |
| [engine.io](https://www.npmjs.com/package/engine.io)                                                                                 | 6.6.11                  | MIT                                 |
| [engine.io-client](https://www.npmjs.com/package/engine.io-client)                                                                   | 6.6.7                   | MIT                                 |
| [engine.io-parser](https://www.npmjs.com/package/engine.io-parser)                                                                   | 5.2.3                   | MIT                                 |
| [enhanced-resolve](https://www.npmjs.com/package/enhanced-resolve)                                                                   | 5.26.0                  | MIT                                 |
| [entities](https://www.npmjs.com/package/entities)                                                                                   | 8.1.0                   | BSD-2-Clause                        |
| [error-ex](https://www.npmjs.com/package/error-ex)                                                                                   | 1.3.4                   | MIT                                 |
| [es-define-property](https://www.npmjs.com/package/es-define-property)                                                               | 1.0.1                   | MIT                                 |
| [es-errors](https://www.npmjs.com/package/es-errors)                                                                                 | 1.3.0                   | MIT                                 |
| [es-module-lexer](https://www.npmjs.com/package/es-module-lexer)                                                                     | 2.3.2                   | MIT                                 |
| [es-object-atoms](https://www.npmjs.com/package/es-object-atoms)                                                                     | 1.1.2                   | MIT                                 |
| [es-set-tostringtag](https://www.npmjs.com/package/es-set-tostringtag)                                                               | 2.1.0                   | MIT                                 |
| [esbuild](https://www.npmjs.com/package/esbuild)                                                                                     | 0.28.2                  | MIT                                 |
| [escalade](https://www.npmjs.com/package/escalade)                                                                                   | 3.2.0                   | MIT                                 |
| [escape-html](https://www.npmjs.com/package/escape-html)                                                                             | 1.0.3                   | MIT                                 |
| [escape-string-regexp](https://www.npmjs.com/package/escape-string-regexp)                                                           | 2.0.0, 4.0.0            | MIT                                 |
| [eslint](https://www.npmjs.com/package/eslint)                                                                                       | 10.13.0                 | MIT                                 |
| [eslint-config-prettier](https://www.npmjs.com/package/eslint-config-prettier)                                                       | 10.1.8                  | MIT                                 |
| [eslint-scope](https://www.npmjs.com/package/eslint-scope)                                                                           | 9.1.2                   | BSD-2-Clause                        |
| [eslint-visitor-keys](https://www.npmjs.com/package/eslint-visitor-keys)                                                             | 3.4.3, 5.0.1            | Apache-2.0                          |
| [espree](https://www.npmjs.com/package/espree)                                                                                       | 11.2.0                  | BSD-2-Clause                        |
| [esprima](https://www.npmjs.com/package/esprima)                                                                                     | 4.0.1                   | BSD-2-Clause                        |
| [esquery](https://www.npmjs.com/package/esquery)                                                                                     | 1.7.0                   | BSD-3-Clause                        |
| [esrecurse](https://www.npmjs.com/package/esrecurse)                                                                                 | 4.3.0                   | BSD-2-Clause                        |
| [estraverse](https://www.npmjs.com/package/estraverse)                                                                               | 5.3.0                   | BSD-2-Clause                        |
| [estree-walker](https://www.npmjs.com/package/estree-walker)                                                                         | 3.0.3                   | MIT                                 |
| [esutils](https://www.npmjs.com/package/esutils)                                                                                     | 2.0.3                   | BSD-2-Clause                        |
| [etag](https://www.npmjs.com/package/etag)                                                                                           | 1.8.1                   | MIT                                 |
| [event-target-shim](https://www.npmjs.com/package/event-target-shim)                                                                 | 5.0.1                   | MIT                                 |
| [events](https://www.npmjs.com/package/events)                                                                                       | 3.3.0                   | MIT                                 |
| [events-universal](https://www.npmjs.com/package/events-universal)                                                                   | 1.0.1                   | Apache-2.0                          |
| [execa](https://www.npmjs.com/package/execa)                                                                                         | 5.1.1                   | MIT                                 |
| [exit-x](https://www.npmjs.com/package/exit-x)                                                                                       | 0.2.2                   | MIT                                 |
| [expand-template](https://www.npmjs.com/package/expand-template)                                                                     | 2.0.3                   | (MIT OR WTFPL)                      |
| [expect](https://www.npmjs.com/package/expect)                                                                                       | 30.5.2                  | MIT                                 |
| [expect-type](https://www.npmjs.com/package/expect-type)                                                                             | 1.4.0                   | Apache-2.0                          |
| [express](https://www.npmjs.com/package/express)                                                                                     | 5.2.1, 5.3.0            | MIT                                 |
| [fast-deep-equal](https://www.npmjs.com/package/fast-deep-equal)                                                                     | 3.1.3                   | MIT                                 |
| [fast-fifo](https://www.npmjs.com/package/fast-fifo)                                                                                 | 1.3.2                   | MIT                                 |
| [fast-json-stable-stringify](https://www.npmjs.com/package/fast-json-stable-stringify)                                               | 2.1.0                   | MIT                                 |
| [fast-levenshtein](https://www.npmjs.com/package/fast-levenshtein)                                                                   | 2.0.6                   | MIT                                 |
| [fast-safe-stringify](https://www.npmjs.com/package/fast-safe-stringify)                                                             | 2.1.1                   | MIT                                 |
| [fast-uri](https://www.npmjs.com/package/fast-uri)                                                                                   | 3.1.9                   | BSD-3-Clause                        |
| [fb-watchman](https://www.npmjs.com/package/fb-watchman)                                                                             | 2.0.4                   | MIT                                 |
| [fdir](https://www.npmjs.com/package/fdir)                                                                                           | 6.5.0                   | MIT                                 |
| [fflate](https://www.npmjs.com/package/fflate)                                                                                       | 0.8.3                   | MIT                                 |
| [file-entry-cache](https://www.npmjs.com/package/file-entry-cache)                                                                   | 11.1.5                  | MIT                                 |
| [file-type](https://www.npmjs.com/package/file-type)                                                                                 | 21.3.4, 22.3.0          | MIT                                 |
| [file-uri-to-path](https://www.npmjs.com/package/file-uri-to-path)                                                                   | 1.0.0                   | MIT                                 |
| [finalhandler](https://www.npmjs.com/package/finalhandler)                                                                           | 2.1.1                   | MIT                                 |
| [find-up](https://www.npmjs.com/package/find-up)                                                                                     | 4.1.0, 5.0.0            | MIT                                 |
| [flat-cache](https://www.npmjs.com/package/flat-cache)                                                                               | 6.1.23                  | MIT                                 |
| [flatted](https://www.npmjs.com/package/flatted)                                                                                     | 3.4.4                   | ISC                                 |
| [for-each](https://www.npmjs.com/package/for-each)                                                                                   | 0.3.5                   | MIT                                 |
| [foreground-child](https://www.npmjs.com/package/foreground-child)                                                                   | 3.3.1                   | ISC                                 |
| [fork-ts-checker-webpack-plugin](https://www.npmjs.com/package/fork-ts-checker-webpack-plugin)                                       | 9.1.0                   | MIT                                 |
| [form-data](https://www.npmjs.com/package/form-data)                                                                                 | 4.0.6                   | MIT                                 |
| [formidable](https://www.npmjs.com/package/formidable)                                                                               | 3.5.4                   | MIT                                 |
| [forwarded](https://www.npmjs.com/package/forwarded)                                                                                 | 0.2.0                   | MIT                                 |
| [framer-motion](https://www.npmjs.com/package/framer-motion)                                                                         | 14.9.0                  | MIT                                 |
| [fresh](https://www.npmjs.com/package/fresh)                                                                                         | 2.0.0                   | MIT                                 |
| [fs-constants](https://www.npmjs.com/package/fs-constants)                                                                           | 1.0.0                   | MIT                                 |
| [fs-extra](https://www.npmjs.com/package/fs-extra)                                                                                   | 10.1.0                  | MIT                                 |
| [fs-monkey](https://www.npmjs.com/package/fs-monkey)                                                                                 | 1.1.0                   | Unlicense                           |
| [fsevents](https://www.npmjs.com/package/fsevents)                                                                                   | 2.3.3                   | MIT                                 |
| [function-bind](https://www.npmjs.com/package/function-bind)                                                                         | 1.1.2                   | MIT                                 |
| [generate-function](https://www.npmjs.com/package/generate-function)                                                                 | 2.3.1                   | MIT                                 |
| [gensync](https://www.npmjs.com/package/gensync)                                                                                     | 1.0.0-beta.2            | MIT                                 |
| [get-caller-file](https://www.npmjs.com/package/get-caller-file)                                                                     | 2.0.5                   | ISC                                 |
| [get-intrinsic](https://www.npmjs.com/package/get-intrinsic)                                                                         | 1.3.0                   | MIT                                 |
| [get-nonce](https://www.npmjs.com/package/get-nonce)                                                                                 | 1.0.1                   | MIT                                 |
| [get-package-type](https://www.npmjs.com/package/get-package-type)                                                                   | 0.1.0                   | MIT                                 |
| [get-port](https://www.npmjs.com/package/get-port)                                                                                   | 5.1.1                   | MIT                                 |
| [get-proto](https://www.npmjs.com/package/get-proto)                                                                                 | 1.0.1                   | MIT                                 |
| [get-stream](https://www.npmjs.com/package/get-stream)                                                                               | 6.0.1                   | MIT                                 |
| [github-from-package](https://www.npmjs.com/package/github-from-package)                                                             | 0.0.0                   | MIT                                 |
| [glob](https://www.npmjs.com/package/glob)                                                                                           | 10.5.0                  | ISC                                 |
| [glob](https://www.npmjs.com/package/glob)                                                                                           | 13.0.6                  | BlueOak-1.0.0                       |
| [glob-parent](https://www.npmjs.com/package/glob-parent)                                                                             | 6.0.2                   | ISC                                 |
| [gopd](https://www.npmjs.com/package/gopd)                                                                                           | 1.2.0                   | MIT                                 |
| [graceful-fs](https://www.npmjs.com/package/graceful-fs)                                                                             | 4.2.11                  | ISC                                 |
| [handlebars](https://www.npmjs.com/package/handlebars)                                                                               | 4.7.10                  | MIT                                 |
| [has-flag](https://www.npmjs.com/package/has-flag)                                                                                   | 4.0.0                   | MIT                                 |
| [has-property-descriptors](https://www.npmjs.com/package/has-property-descriptors)                                                   | 1.0.2                   | MIT                                 |
| [has-symbols](https://www.npmjs.com/package/has-symbols)                                                                             | 1.1.0                   | MIT                                 |
| [has-tostringtag](https://www.npmjs.com/package/has-tostringtag)                                                                     | 1.0.2                   | MIT                                 |
| [hashery](https://www.npmjs.com/package/hashery)                                                                                     | 1.5.1                   | MIT                                 |
| [hasown](https://www.npmjs.com/package/hasown)                                                                                       | 2.0.4                   | MIT                                 |
| [helmet](https://www.npmjs.com/package/helmet)                                                                                       | 8.3.0                   | MIT                                 |
| [hookified](https://www.npmjs.com/package/hookified)                                                                                 | 1.15.1, 2.2.0           | MIT                                 |
| [howler](https://www.npmjs.com/package/howler)                                                                                       | 2.2.4                   | MIT                                 |
| [html-encoding-sniffer](https://www.npmjs.com/package/html-encoding-sniffer)                                                         | 7.0.0                   | MIT                                 |
| [html-escaper](https://www.npmjs.com/package/html-escaper)                                                                           | 2.0.2                   | MIT                                 |
| [http-errors](https://www.npmjs.com/package/http-errors)                                                                             | 2.0.1                   | MIT                                 |
| [human-signals](https://www.npmjs.com/package/human-signals)                                                                         | 2.1.0                   | Apache-2.0                          |
| [iconv-lite](https://www.npmjs.com/package/iconv-lite)                                                                               | 0.7.3                   | MIT                                 |
| [ieee754](https://www.npmjs.com/package/ieee754)                                                                                     | 1.2.1                   | BSD-3-Clause                        |
| [ignore](https://www.npmjs.com/package/ignore)                                                                                       | 5.3.2, 7.0.14           | MIT                                 |
| [import-fresh](https://www.npmjs.com/package/import-fresh)                                                                           | 3.3.1                   | MIT                                 |
| [import-local](https://www.npmjs.com/package/import-local)                                                                           | 3.2.0                   | MIT                                 |
| [imurmurhash](https://www.npmjs.com/package/imurmurhash)                                                                             | 0.1.4                   | MIT                                 |
| [indent-string](https://www.npmjs.com/package/indent-string)                                                                         | 4.0.0                   | MIT                                 |
| [inherits](https://www.npmjs.com/package/inherits)                                                                                   | 2.0.4                   | ISC                                 |
| [ini](https://www.npmjs.com/package/ini)                                                                                             | 1.3.8                   | ISC                                 |
| [intl-messageformat](https://www.npmjs.com/package/intl-messageformat)                                                               | 12.1.4                  | BSD-3-Clause                        |
| [ioredis](https://www.npmjs.com/package/ioredis)                                                                                     | 5.11.1                  | MIT                                 |
| [ipaddr.js](https://www.npmjs.com/package/ipaddr.js)                                                                                 | 1.9.1                   | MIT                                 |
| [is-arrayish](https://www.npmjs.com/package/is-arrayish)                                                                             | 0.2.1                   | MIT                                 |
| [is-callable](https://www.npmjs.com/package/is-callable)                                                                             | 1.2.7                   | MIT                                 |
| [is-extglob](https://www.npmjs.com/package/is-extglob)                                                                               | 2.1.1                   | MIT                                 |
| [is-fullwidth-code-point](https://www.npmjs.com/package/is-fullwidth-code-point)                                                     | 3.0.0                   | MIT                                 |
| [is-generator-fn](https://www.npmjs.com/package/is-generator-fn)                                                                     | 2.1.0                   | MIT                                 |
| [is-glob](https://www.npmjs.com/package/is-glob)                                                                                     | 4.0.3                   | MIT                                 |
| [is-interactive](https://www.npmjs.com/package/is-interactive)                                                                       | 1.0.0                   | MIT                                 |
| [is-potential-custom-element-name](https://www.npmjs.com/package/is-potential-custom-element-name)                                   | 1.0.1                   | MIT                                 |
| [is-promise](https://www.npmjs.com/package/is-promise)                                                                               | 4.0.0                   | MIT                                 |
| [is-property](https://www.npmjs.com/package/is-property)                                                                             | 1.0.2                   | MIT                                 |
| [is-stream](https://www.npmjs.com/package/is-stream)                                                                                 | 2.0.1                   | MIT                                 |
| [is-typed-array](https://www.npmjs.com/package/is-typed-array)                                                                       | 1.1.15                  | MIT                                 |
| [is-unicode-supported](https://www.npmjs.com/package/is-unicode-supported)                                                           | 0.1.0                   | MIT                                 |
| [isarray](https://www.npmjs.com/package/isarray)                                                                                     | 1.0.0, 2.0.5            | MIT                                 |
| [isexe](https://www.npmjs.com/package/isexe)                                                                                         | 2.0.0                   | ISC                                 |
| [istanbul-lib-coverage](https://www.npmjs.com/package/istanbul-lib-coverage)                                                         | 3.2.2                   | BSD-3-Clause                        |
| [istanbul-lib-instrument](https://www.npmjs.com/package/istanbul-lib-instrument)                                                     | 6.0.3                   | BSD-3-Clause                        |
| [istanbul-lib-report](https://www.npmjs.com/package/istanbul-lib-report)                                                             | 3.0.1                   | BSD-3-Clause                        |
| [istanbul-lib-source-maps](https://www.npmjs.com/package/istanbul-lib-source-maps)                                                   | 5.0.6                   | BSD-3-Clause                        |
| [istanbul-reports](https://www.npmjs.com/package/istanbul-reports)                                                                   | 3.2.0                   | BSD-3-Clause                        |
| [iterare](https://www.npmjs.com/package/iterare)                                                                                     | 1.2.1                   | ISC                                 |
| [jackspeak](https://www.npmjs.com/package/jackspeak)                                                                                 | 3.4.3                   | BlueOak-1.0.0                       |
| [jest](https://www.npmjs.com/package/jest)                                                                                           | 30.5.2                  | MIT                                 |
| [jest-changed-files](https://www.npmjs.com/package/jest-changed-files)                                                               | 30.5.1                  | MIT                                 |
| [jest-circus](https://www.npmjs.com/package/jest-circus)                                                                             | 30.5.2                  | MIT                                 |
| [jest-cli](https://www.npmjs.com/package/jest-cli)                                                                                   | 30.5.2                  | MIT                                 |
| [jest-config](https://www.npmjs.com/package/jest-config)                                                                             | 30.5.2                  | MIT                                 |
| [jest-diff](https://www.npmjs.com/package/jest-diff)                                                                                 | 30.5.2                  | MIT                                 |
| [jest-docblock](https://www.npmjs.com/package/jest-docblock)                                                                         | 30.5.0                  | MIT                                 |
| [jest-each](https://www.npmjs.com/package/jest-each)                                                                                 | 30.5.2                  | MIT                                 |
| [jest-environment-node](https://www.npmjs.com/package/jest-environment-node)                                                         | 30.5.2                  | MIT                                 |
| [jest-haste-map](https://www.npmjs.com/package/jest-haste-map)                                                                       | 30.5.1                  | MIT                                 |
| [jest-leak-detector](https://www.npmjs.com/package/jest-leak-detector)                                                               | 30.5.1                  | MIT                                 |
| [jest-matcher-utils](https://www.npmjs.com/package/jest-matcher-utils)                                                               | 30.5.2                  | MIT                                 |
| [jest-message-util](https://www.npmjs.com/package/jest-message-util)                                                                 | 30.5.1                  | MIT                                 |
| [jest-mock](https://www.npmjs.com/package/jest-mock)                                                                                 | 30.5.2                  | MIT                                 |
| [jest-regex-util](https://www.npmjs.com/package/jest-regex-util)                                                                     | 30.5.0                  | MIT                                 |
| [jest-resolve](https://www.npmjs.com/package/jest-resolve)                                                                           | 30.5.1                  | MIT                                 |
| [jest-resolve-dependencies](https://www.npmjs.com/package/jest-resolve-dependencies)                                                 | 30.5.2                  | MIT                                 |
| [jest-runner](https://www.npmjs.com/package/jest-runner)                                                                             | 30.5.2                  | MIT                                 |
| [jest-runtime](https://www.npmjs.com/package/jest-runtime)                                                                           | 30.5.2                  | MIT                                 |
| [jest-snapshot](https://www.npmjs.com/package/jest-snapshot)                                                                         | 30.5.2                  | MIT                                 |
| [jest-util](https://www.npmjs.com/package/jest-util)                                                                                 | 30.5.1                  | MIT                                 |
| [jest-validate](https://www.npmjs.com/package/jest-validate)                                                                         | 30.5.1                  | MIT                                 |
| [jest-watcher](https://www.npmjs.com/package/jest-watcher)                                                                           | 30.5.2                  | MIT                                 |
| [jest-worker](https://www.npmjs.com/package/jest-worker)                                                                             | 27.5.1, 30.5.1          | MIT                                 |
| [jiti](https://www.npmjs.com/package/jiti)                                                                                           | 2.7.0                   | MIT                                 |
| [js-tokens](https://www.npmjs.com/package/js-tokens)                                                                                 | 4.0.0                   | MIT                                 |
| [js-yaml](https://www.npmjs.com/package/js-yaml)                                                                                     | 3.15.2, 4.3.2           | MIT                                 |
| [jsdom](https://www.npmjs.com/package/jsdom)                                                                                         | 30.1.3                  | MIT                                 |
| [jsesc](https://www.npmjs.com/package/jsesc)                                                                                         | 3.1.0                   | MIT                                 |
| [json-parse-even-better-errors](https://www.npmjs.com/package/json-parse-even-better-errors)                                         | 2.3.1                   | MIT                                 |
| [json-schema-traverse](https://www.npmjs.com/package/json-schema-traverse)                                                           | 0.4.1, 1.0.0            | MIT                                 |
| [json-stable-stringify-without-jsonify](https://www.npmjs.com/package/json-stable-stringify-without-jsonify)                         | 1.0.1                   | MIT                                 |
| [json5](https://www.npmjs.com/package/json5)                                                                                         | 2.2.3                   | MIT                                 |
| [jsonc-parser](https://www.npmjs.com/package/jsonc-parser)                                                                           | 3.3.1                   | MIT                                 |
| [jsonfile](https://www.npmjs.com/package/jsonfile)                                                                                   | 6.2.1                   | MIT                                 |
| [jsonwebtoken](https://www.npmjs.com/package/jsonwebtoken)                                                                           | 9.0.3                   | MIT                                 |
| [jwa](https://www.npmjs.com/package/jwa)                                                                                             | 2.0.1                   | MIT                                 |
| [jws](https://www.npmjs.com/package/jws)                                                                                             | 4.0.1                   | MIT                                 |
| [keyv](https://www.npmjs.com/package/keyv)                                                                                           | 5.6.0                   | MIT                                 |
| [lazystream](https://www.npmjs.com/package/lazystream)                                                                               | 1.0.1                   | MIT                                 |
| [leven](https://www.npmjs.com/package/leven)                                                                                         | 3.1.0                   | MIT                                 |
| [levn](https://www.npmjs.com/package/levn)                                                                                           | 0.4.1                   | MIT                                 |
| [lightningcss](https://www.npmjs.com/package/lightningcss)                                                                           | 1.32.0, 1.33.0          | MPL-2.0                             |
| [lightningcss-darwin-arm64](https://www.npmjs.com/package/lightningcss-darwin-arm64)                                                 | 1.32.0, 1.33.0          | MPL-2.0                             |
| [lines-and-columns](https://www.npmjs.com/package/lines-and-columns)                                                                 | 1.2.4                   | MIT                                 |
| [load-esm](https://www.npmjs.com/package/load-esm)                                                                                   | 1.0.3                   | MIT                                 |
| [locate-path](https://www.npmjs.com/package/locate-path)                                                                             | 5.0.0, 6.0.0            | MIT                                 |
| [lodash](https://www.npmjs.com/package/lodash)                                                                                       | 4.18.1                  | MIT                                 |
| [lodash.camelcase](https://www.npmjs.com/package/lodash.camelcase)                                                                   | 4.3.0                   | MIT                                 |
| [lodash.includes](https://www.npmjs.com/package/lodash.includes)                                                                     | 4.3.0                   | MIT                                 |
| [lodash.isboolean](https://www.npmjs.com/package/lodash.isboolean)                                                                   | 3.0.3                   | MIT                                 |
| [lodash.isinteger](https://www.npmjs.com/package/lodash.isinteger)                                                                   | 4.0.4                   | MIT                                 |
| [lodash.isnumber](https://www.npmjs.com/package/lodash.isnumber)                                                                     | 3.0.3                   | MIT                                 |
| [lodash.isplainobject](https://www.npmjs.com/package/lodash.isplainobject)                                                           | 4.0.6                   | MIT                                 |
| [lodash.isstring](https://www.npmjs.com/package/lodash.isstring)                                                                     | 4.0.1                   | MIT                                 |
| [lodash.memoize](https://www.npmjs.com/package/lodash.memoize)                                                                       | 4.1.2                   | MIT                                 |
| [lodash.once](https://www.npmjs.com/package/lodash.once)                                                                             | 4.1.1                   | MIT                                 |
| [log-symbols](https://www.npmjs.com/package/log-symbols)                                                                             | 4.1.0                   | MIT                                 |
| [long](https://www.npmjs.com/package/long)                                                                                           | 5.3.2                   | Apache-2.0                          |
| [lru-cache](https://www.npmjs.com/package/lru-cache)                                                                                 | 5.1.1, 10.4.3           | ISC                                 |
| [lru-cache](https://www.npmjs.com/package/lru-cache)                                                                                 | 11.5.3                  | BlueOak-1.0.0                       |
| [lru.min](https://www.npmjs.com/package/lru.min)                                                                                     | 1.1.5                   | MIT                                 |
| [lucide-react](https://www.npmjs.com/package/lucide-react)                                                                           | 1.65.0                  | ISC                                 |
| [lz-string](https://www.npmjs.com/package/lz-string)                                                                                 | 1.5.0                   | MIT                                 |
| [magic-string](https://www.npmjs.com/package/magic-string)                                                                           | 0.30.17, 0.30.21, 1.4.5 | MIT                                 |
| [make-dir](https://www.npmjs.com/package/make-dir)                                                                                   | 4.0.0                   | MIT                                 |
| [make-error](https://www.npmjs.com/package/make-error)                                                                               | 1.3.6                   | ISC                                 |
| [math-intrinsics](https://www.npmjs.com/package/math-intrinsics)                                                                     | 1.1.0                   | MIT                                 |
| [mdn-data](https://www.npmjs.com/package/mdn-data)                                                                                   | 2.27.1                  | CC0-1.0                             |
| [media-typer](https://www.npmjs.com/package/media-typer)                                                                             | 0.3.0, 1.1.1            | MIT                                 |
| [memfs](https://www.npmjs.com/package/memfs)                                                                                         | 3.5.3                   | Unlicense                           |
| [merge-descriptors](https://www.npmjs.com/package/merge-descriptors)                                                                 | 2.0.0                   | MIT                                 |
| [merge-stream](https://www.npmjs.com/package/merge-stream)                                                                           | 2.0.0                   | MIT                                 |
| [methods](https://www.npmjs.com/package/methods)                                                                                     | 1.1.2                   | MIT                                 |
| [mime](https://www.npmjs.com/package/mime)                                                                                           | 2.6.0                   | MIT                                 |
| [mime-db](https://www.npmjs.com/package/mime-db)                                                                                     | 1.52.0, 1.54.0          | MIT                                 |
| [mime-types](https://www.npmjs.com/package/mime-types)                                                                               | 2.1.35, 3.0.2           | MIT                                 |
| [mimic-fn](https://www.npmjs.com/package/mimic-fn)                                                                                   | 2.1.0                   | MIT                                 |
| [mimic-response](https://www.npmjs.com/package/mimic-response)                                                                       | 3.1.0                   | MIT                                 |
| [min-indent](https://www.npmjs.com/package/min-indent)                                                                               | 1.0.1                   | MIT                                 |
| [minimatch](https://www.npmjs.com/package/minimatch)                                                                                 | 3.1.5, 5.1.9, 9.0.9     | ISC                                 |
| [minimatch](https://www.npmjs.com/package/minimatch)                                                                                 | 10.2.6                  | BlueOak-1.0.0                       |
| [minimist](https://www.npmjs.com/package/minimist)                                                                                   | 1.2.8                   | MIT                                 |
| [minimizer-webpack-plugin](https://www.npmjs.com/package/minimizer-webpack-plugin)                                                   | 5.13.1                  | MIT                                 |
| [minipass](https://www.npmjs.com/package/minipass)                                                                                   | 7.1.3                   | BlueOak-1.0.0                       |
| [mkdirp](https://www.npmjs.com/package/mkdirp)                                                                                       | 3.0.1                   | MIT                                 |
| [mkdirp-classic](https://www.npmjs.com/package/mkdirp-classic)                                                                       | 0.5.3                   | MIT                                 |
| [motion-dom](https://www.npmjs.com/package/motion-dom)                                                                               | 14.9.0                  | MIT                                 |
| [motion-utils](https://www.npmjs.com/package/motion-utils)                                                                           | 14.7.0                  | MIT                                 |
| [ms](https://www.npmjs.com/package/ms)                                                                                               | 2.1.3                   | MIT                                 |
| [multer](https://www.npmjs.com/package/multer)                                                                                       | 2.5.0                   | MIT                                 |
| [mute-stream](https://www.npmjs.com/package/mute-stream)                                                                             | 2.0.0                   | ISC                                 |
| [mysql2](https://www.npmjs.com/package/mysql2)                                                                                       | 3.24.6                  | MIT                                 |
| [named-placeholders](https://www.npmjs.com/package/named-placeholders)                                                               | 1.1.6                   | MIT                                 |
| [nan](https://www.npmjs.com/package/nan)                                                                                             | 2.30.0                  | MIT                                 |
| [nanoid](https://www.npmjs.com/package/nanoid)                                                                                       | 3.3.20                  | MIT                                 |
| [napi-build-utils](https://www.npmjs.com/package/napi-build-utils)                                                                   | 2.0.0                   | MIT                                 |
| [napi-postinstall](https://www.npmjs.com/package/napi-postinstall)                                                                   | 0.3.7                   | MIT                                 |
| [natural-compare](https://www.npmjs.com/package/natural-compare)                                                                     | 1.4.0                   | MIT                                 |
| [negotiator](https://www.npmjs.com/package/negotiator)                                                                               | 0.6.3, 1.1.0            | MIT                                 |
| [neo-async](https://www.npmjs.com/package/neo-async)                                                                                 | 2.6.2                   | MIT                                 |
| [next](https://www.npmjs.com/package/next)                                                                                           | 16.4.3                  | MIT                                 |
| [node-abi](https://www.npmjs.com/package/node-abi)                                                                                   | 3.101.0                 | MIT                                 |
| [node-abort-controller](https://www.npmjs.com/package/node-abort-controller)                                                         | 3.1.1                   | MIT                                 |
| [node-addon-api](https://www.npmjs.com/package/node-addon-api)                                                                       | 7.1.1, 8.9.2            | MIT                                 |
| [node-emoji](https://www.npmjs.com/package/node-emoji)                                                                               | 1.11.0                  | MIT                                 |
| [node-gyp-build](https://www.npmjs.com/package/node-gyp-build)                                                                       | 4.8.4                   | MIT                                 |
| [node-int64](https://www.npmjs.com/package/node-int64)                                                                               | 0.4.0                   | MIT                                 |
| [node-releases](https://www.npmjs.com/package/node-releases)                                                                         | 2.0.62                  | MIT                                 |
| [normalize-path](https://www.npmjs.com/package/normalize-path)                                                                       | 3.0.0                   | MIT                                 |
| [notepack.io](https://www.npmjs.com/package/notepack.io)                                                                             | 3.0.1                   | MIT                                 |
| [npm-run-path](https://www.npmjs.com/package/npm-run-path)                                                                           | 4.0.1                   | MIT                                 |
| [object-assign](https://www.npmjs.com/package/object-assign)                                                                         | 4.1.1                   | MIT                                 |
| [object-hash](https://www.npmjs.com/package/object-hash)                                                                             | 3.0.0                   | MIT                                 |
| [object-inspect](https://www.npmjs.com/package/object-inspect)                                                                       | 1.13.4                  | MIT                                 |
| [obug](https://www.npmjs.com/package/obug)                                                                                           | 3.0.0                   | MIT                                 |
| [on-finished](https://www.npmjs.com/package/on-finished)                                                                             | 2.4.2                   | MIT                                 |
| [once](https://www.npmjs.com/package/once)                                                                                           | 1.4.0                   | ISC                                 |
| [onetime](https://www.npmjs.com/package/onetime)                                                                                     | 5.1.2                   | MIT                                 |
| [optionator](https://www.npmjs.com/package/optionator)                                                                               | 0.9.4                   | MIT                                 |
| [ora](https://www.npmjs.com/package/ora)                                                                                             | 5.4.1                   | MIT                                 |
| [p-limit](https://www.npmjs.com/package/p-limit)                                                                                     | 2.3.0, 3.1.0            | MIT                                 |
| [p-locate](https://www.npmjs.com/package/p-locate)                                                                                   | 4.1.0, 5.0.0            | MIT                                 |
| [p-try](https://www.npmjs.com/package/p-try)                                                                                         | 2.2.0                   | MIT                                 |
| [package-json-from-dist](https://www.npmjs.com/package/package-json-from-dist)                                                       | 1.0.1                   | BlueOak-1.0.0                       |
| [parent-module](https://www.npmjs.com/package/parent-module)                                                                         | 1.0.1                   | MIT                                 |
| [parse-json](https://www.npmjs.com/package/parse-json)                                                                               | 5.2.0                   | MIT                                 |
| [parse5](https://www.npmjs.com/package/parse5)                                                                                       | 8.0.1                   | MIT                                 |
| [parseurl](https://www.npmjs.com/package/parseurl)                                                                                   | 1.3.3                   | MIT                                 |
| [passport](https://www.npmjs.com/package/passport)                                                                                   | 0.7.0                   | MIT                                 |
| [passport-jwt](https://www.npmjs.com/package/passport-jwt)                                                                           | 4.0.1                   | MIT                                 |
| [passport-strategy](https://www.npmjs.com/package/passport-strategy)                                                                 | 1.0.0                   | MIT                                 |
| [path-exists](https://www.npmjs.com/package/path-exists)                                                                             | 4.0.0                   | MIT                                 |
| [path-key](https://www.npmjs.com/package/path-key)                                                                                   | 3.1.1                   | MIT                                 |
| [path-scurry](https://www.npmjs.com/package/path-scurry)                                                                             | 1.11.1, 2.0.2           | BlueOak-1.0.0                       |
| [path-to-regexp](https://www.npmjs.com/package/path-to-regexp)                                                                       | 8.4.2                   | MIT                                 |
| [path-type](https://www.npmjs.com/package/path-type)                                                                                 | 4.0.0                   | MIT                                 |
| [pause](https://www.npmjs.com/package/pause)                                                                                         | 0.0.1                   | MIT (Readme.md; metadata Unknown)   |
| [pg](https://www.npmjs.com/package/pg)                                                                                               | 8.23.1                  | MIT                                 |
| [pg-cloudflare](https://www.npmjs.com/package/pg-cloudflare)                                                                         | 1.4.1                   | MIT                                 |
| [pg-connection-string](https://www.npmjs.com/package/pg-connection-string)                                                           | 2.14.1                  | MIT                                 |
| [pg-int8](https://www.npmjs.com/package/pg-int8)                                                                                     | 1.0.1                   | ISC                                 |
| [pg-pool](https://www.npmjs.com/package/pg-pool)                                                                                     | 3.14.0                  | MIT                                 |
| [pg-protocol](https://www.npmjs.com/package/pg-protocol)                                                                             | 1.16.1                  | MIT                                 |
| [pg-types](https://www.npmjs.com/package/pg-types)                                                                                   | 2.2.0                   | MIT                                 |
| [pgpass](https://www.npmjs.com/package/pgpass)                                                                                       | 1.0.5                   | MIT                                 |
| [picocolors](https://www.npmjs.com/package/picocolors)                                                                               | 1.1.1                   | ISC                                 |
| [picomatch](https://www.npmjs.com/package/picomatch)                                                                                 | 2.3.2, 4.0.4, 4.0.7     | MIT                                 |
| [pirates](https://www.npmjs.com/package/pirates)                                                                                     | 4.0.7                   | MIT                                 |
| [pkg-dir](https://www.npmjs.com/package/pkg-dir)                                                                                     | 4.2.0                   | MIT                                 |
| [playwright](https://www.npmjs.com/package/playwright)                                                                               | 1.64.1                  | Apache-2.0                          |
| [playwright-core](https://www.npmjs.com/package/playwright-core)                                                                     | 1.64.1                  | Apache-2.0                          |
| [pluralize](https://www.npmjs.com/package/pluralize)                                                                                 | 8.0.0                   | MIT                                 |
| [pngjs](https://www.npmjs.com/package/pngjs)                                                                                         | 5.0.0                   | MIT                                 |
| [possible-typed-array-names](https://www.npmjs.com/package/possible-typed-array-names)                                               | 1.1.0                   | MIT                                 |
| [postcss](https://www.npmjs.com/package/postcss)                                                                                     | 8.5.23, 8.5.32          | MIT                                 |
| [postgres-array](https://www.npmjs.com/package/postgres-array)                                                                       | 2.0.0                   | MIT                                 |
| [postgres-bytea](https://www.npmjs.com/package/postgres-bytea)                                                                       | 1.0.1                   | MIT                                 |
| [postgres-date](https://www.npmjs.com/package/postgres-date)                                                                         | 1.0.7                   | MIT                                 |
| [postgres-interval](https://www.npmjs.com/package/postgres-interval)                                                                 | 1.2.0                   | MIT                                 |
| [prebuild-install](https://www.npmjs.com/package/prebuild-install)                                                                   | 7.1.3                   | MIT                                 |
| [prelude-ls](https://www.npmjs.com/package/prelude-ls)                                                                               | 1.2.1                   | MIT                                 |
| [prettier](https://www.npmjs.com/package/prettier)                                                                                   | 3.9.10                  | MIT                                 |
| [pretty-format](https://www.npmjs.com/package/pretty-format)                                                                         | 27.5.1, 30.5.1          | MIT                                 |
| [process](https://www.npmjs.com/package/process)                                                                                     | 0.11.10                 | MIT                                 |
| [process-nextick-args](https://www.npmjs.com/package/process-nextick-args)                                                           | 2.0.1                   | MIT                                 |
| [proper-lockfile](https://www.npmjs.com/package/proper-lockfile)                                                                     | 4.1.2                   | MIT                                 |
| [properties-reader](https://www.npmjs.com/package/properties-reader)                                                                 | 3.0.1                   | MIT                                 |
| [protobufjs](https://www.npmjs.com/package/protobufjs)                                                                               | 7.6.6                   | BSD-3-Clause                        |
| [proxy-addr](https://www.npmjs.com/package/proxy-addr)                                                                               | 2.0.8                   | MIT                                 |
| [pump](https://www.npmjs.com/package/pump)                                                                                           | 3.0.4                   | MIT                                 |
| [punycode](https://www.npmjs.com/package/punycode)                                                                                   | 2.3.1                   | MIT                                 |
| [pure-rand](https://www.npmjs.com/package/pure-rand)                                                                                 | 7.0.1                   | MIT                                 |
| [qified](https://www.npmjs.com/package/qified)                                                                                       | 0.10.1                  | MIT                                 |
| [qrcode](https://www.npmjs.com/package/qrcode)                                                                                       | 1.5.4                   | MIT                                 |
| [qs](https://www.npmjs.com/package/qs)                                                                                               | 6.17.1                  | BSD-3-Clause                        |
| [radix-ui](https://www.npmjs.com/package/radix-ui)                                                                                   | 1.8.1                   | MIT                                 |
| [range-parser](https://www.npmjs.com/package/range-parser)                                                                           | 1.3.0                   | MIT                                 |
| [raw-body](https://www.npmjs.com/package/raw-body)                                                                                   | 3.0.2                   | MIT                                 |
| [rc](https://www.npmjs.com/package/rc)                                                                                               | 1.2.8                   | (BSD-2-Clause OR MIT OR Apache-2.0) |
| [react](https://www.npmjs.com/package/react)                                                                                         | 19.3.1                  | MIT                                 |
| [react-dom](https://www.npmjs.com/package/react-dom)                                                                                 | 19.3.1                  | MIT                                 |
| [react-hook-form](https://www.npmjs.com/package/react-hook-form)                                                                     | 7.91.0                  | MIT                                 |
| [react-is](https://www.npmjs.com/package/react-is)                                                                                   | 17.0.2, 19.3.1          | MIT                                 |
| [react-remove-scroll](https://www.npmjs.com/package/react-remove-scroll)                                                             | 2.7.2                   | MIT                                 |
| [react-remove-scroll-bar](https://www.npmjs.com/package/react-remove-scroll-bar)                                                     | 2.3.8                   | MIT                                 |
| [react-style-singleton](https://www.npmjs.com/package/react-style-singleton)                                                         | 2.2.3                   | MIT                                 |
| [readable-stream](https://www.npmjs.com/package/readable-stream)                                                                     | 2.3.8, 3.6.2, 4.8.0     | MIT                                 |
| [readdir-glob](https://www.npmjs.com/package/readdir-glob)                                                                           | 1.1.3                   | Apache-2.0                          |
| [readdirp](https://www.npmjs.com/package/readdirp)                                                                                   | 4.1.2                   | MIT                                 |
| [redent](https://www.npmjs.com/package/redent)                                                                                       | 3.0.0                   | MIT                                 |
| [redis-errors](https://www.npmjs.com/package/redis-errors)                                                                           | 1.2.0                   | MIT                                 |
| [redis-parser](https://www.npmjs.com/package/redis-parser)                                                                           | 3.0.0                   | MIT                                 |
| [reflect-metadata](https://www.npmjs.com/package/reflect-metadata)                                                                   | 0.2.2                   | Apache-2.0                          |
| [require-directory](https://www.npmjs.com/package/require-directory)                                                                 | 2.1.1                   | MIT                                 |
| [require-from-string](https://www.npmjs.com/package/require-from-string)                                                             | 2.0.2                   | MIT                                 |
| [require-main-filename](https://www.npmjs.com/package/require-main-filename)                                                         | 2.0.0                   | ISC                                 |
| [resolve-cwd](https://www.npmjs.com/package/resolve-cwd)                                                                             | 3.0.0                   | MIT                                 |
| [resolve-from](https://www.npmjs.com/package/resolve-from)                                                                           | 4.0.0, 5.0.0            | MIT                                 |
| [restore-cursor](https://www.npmjs.com/package/restore-cursor)                                                                       | 3.1.0                   | MIT                                 |
| [retry](https://www.npmjs.com/package/retry)                                                                                         | 0.12.0                  | MIT                                 |
| [rolldown](https://www.npmjs.com/package/rolldown)                                                                                   | 1.2.16                  | MIT                                 |
| [router](https://www.npmjs.com/package/router)                                                                                       | 2.2.0                   | MIT                                 |
| [rxjs](https://www.npmjs.com/package/rxjs)                                                                                           | 7.8.1, 7.8.2            | Apache-2.0                          |
| [safe-buffer](https://www.npmjs.com/package/safe-buffer)                                                                             | 5.1.2, 5.2.1            | MIT                                 |
| [safer-buffer](https://www.npmjs.com/package/safer-buffer)                                                                           | 2.1.2                   | MIT                                 |
| [saxes](https://www.npmjs.com/package/saxes)                                                                                         | 6.0.0                   | ISC                                 |
| [scheduler](https://www.npmjs.com/package/scheduler)                                                                                 | 0.28.0                  | MIT                                 |
| [schema-utils](https://www.npmjs.com/package/schema-utils)                                                                           | 3.3.0, 4.8.1            | MIT                                 |
| [semver](https://www.npmjs.com/package/semver)                                                                                       | 6.3.1, 7.8.5            | ISC                                 |
| [send](https://www.npmjs.com/package/send)                                                                                           | 1.2.1                   | MIT                                 |
| [serve-static](https://www.npmjs.com/package/serve-static)                                                                           | 2.2.1                   | MIT                                 |
| [set-blocking](https://www.npmjs.com/package/set-blocking)                                                                           | 2.0.0                   | ISC                                 |
| [set-function-length](https://www.npmjs.com/package/set-function-length)                                                             | 1.2.2                   | MIT                                 |
| [setprototypeof](https://www.npmjs.com/package/setprototypeof)                                                                       | 1.2.0                   | ISC                                 |
| [sha.js](https://www.npmjs.com/package/sha.js)                                                                                       | 2.4.12                  | (MIT AND BSD-3-Clause)              |
| [sharp](https://www.npmjs.com/package/sharp)                                                                                         | 0.35.5                  | Apache-2.0                          |
| [shebang-command](https://www.npmjs.com/package/shebang-command)                                                                     | 2.0.0                   | MIT                                 |
| [shebang-regex](https://www.npmjs.com/package/shebang-regex)                                                                         | 3.0.0                   | MIT                                 |
| [side-channel](https://www.npmjs.com/package/side-channel)                                                                           | 1.1.1                   | MIT                                 |
| [side-channel-list](https://www.npmjs.com/package/side-channel-list)                                                                 | 1.0.1                   | MIT                                 |
| [side-channel-map](https://www.npmjs.com/package/side-channel-map)                                                                   | 1.0.1                   | MIT                                 |
| [side-channel-weakmap](https://www.npmjs.com/package/side-channel-weakmap)                                                           | 1.0.2                   | MIT                                 |
| [signal-exit](https://www.npmjs.com/package/signal-exit)                                                                             | 3.0.7, 4.1.0            | ISC                                 |
| [simple-concat](https://www.npmjs.com/package/simple-concat)                                                                         | 1.0.1                   | MIT                                 |
| [simple-get](https://www.npmjs.com/package/simple-get)                                                                               | 4.0.1                   | MIT                                 |
| [slash](https://www.npmjs.com/package/slash)                                                                                         | 3.0.0                   | MIT                                 |
| [socket.io](https://www.npmjs.com/package/socket.io)                                                                                 | 4.8.3, 4.8.4            | MIT                                 |
| [socket.io-adapter](https://www.npmjs.com/package/socket.io-adapter)                                                                 | 2.5.8                   | MIT                                 |
| [socket.io-client](https://www.npmjs.com/package/socket.io-client)                                                                   | 4.8.4                   | MIT                                 |
| [socket.io-parser](https://www.npmjs.com/package/socket.io-parser)                                                                   | 4.2.7                   | MIT                                 |
| [source-map](https://www.npmjs.com/package/source-map)                                                                               | 0.6.1, 0.7.4            | BSD-3-Clause                        |
| [source-map-js](https://www.npmjs.com/package/source-map-js)                                                                         | 1.2.2                   | BSD-3-Clause                        |
| [source-map-support](https://www.npmjs.com/package/source-map-support)                                                               | 0.5.21                  | MIT                                 |
| [split-ca](https://www.npmjs.com/package/split-ca)                                                                                   | 1.0.1                   | ISC                                 |
| [split2](https://www.npmjs.com/package/split2)                                                                                       | 4.2.0                   | ISC                                 |
| [sprintf-js](https://www.npmjs.com/package/sprintf-js)                                                                               | 1.0.3                   | BSD-3-Clause                        |
| [sql-escaper](https://www.npmjs.com/package/sql-escaper)                                                                             | 1.5.2                   | MIT                                 |
| [sql-highlight](https://www.npmjs.com/package/sql-highlight)                                                                         | 6.1.0                   | MIT                                 |
| [ssh-remote-port-forward](https://www.npmjs.com/package/ssh-remote-port-forward)                                                     | 1.0.4                   | MIT                                 |
| [ssh2](https://www.npmjs.com/package/ssh2)                                                                                           | 1.17.0                  | MIT                                 |
| [stack-utils](https://www.npmjs.com/package/stack-utils)                                                                             | 2.0.6                   | MIT                                 |
| [standard-as-callback](https://www.npmjs.com/package/standard-as-callback)                                                           | 2.1.0                   | MIT                                 |
| [statuses](https://www.npmjs.com/package/statuses)                                                                                   | 2.0.2                   | MIT                                 |
| [std-env](https://www.npmjs.com/package/std-env)                                                                                     | 4.3.0                   | MIT                                 |
| [streamsearch](https://www.npmjs.com/package/streamsearch)                                                                           | 1.1.0                   | MIT                                 |
| [streamx](https://www.npmjs.com/package/streamx)                                                                                     | 2.28.1                  | MIT                                 |
| [string_decoder](https://www.npmjs.com/package/string_decoder)                                                                       | 1.1.1, 1.3.0            | MIT                                 |
| [string-length](https://www.npmjs.com/package/string-length)                                                                         | 4.0.2                   | MIT                                 |
| [string-width](https://www.npmjs.com/package/string-width)                                                                           | 4.2.3, 5.1.2            | MIT                                 |
| [strip-ansi](https://www.npmjs.com/package/strip-ansi)                                                                               | 6.0.1, 7.2.0            | MIT                                 |
| [strip-bom](https://www.npmjs.com/package/strip-bom)                                                                                 | 3.0.0, 4.0.0            | MIT                                 |
| [strip-final-newline](https://www.npmjs.com/package/strip-final-newline)                                                             | 2.0.0                   | MIT                                 |
| [strip-indent](https://www.npmjs.com/package/strip-indent)                                                                           | 3.0.0                   | MIT                                 |
| [strip-json-comments](https://www.npmjs.com/package/strip-json-comments)                                                             | 2.0.1, 3.1.1            | MIT                                 |
| [strtok3](https://www.npmjs.com/package/strtok3)                                                                                     | 10.6.3                  | MIT                                 |
| [styled-jsx](https://www.npmjs.com/package/styled-jsx)                                                                               | 5.1.6                   | MIT                                 |
| [superagent](https://www.npmjs.com/package/superagent)                                                                               | 10.4.1                  | MIT                                 |
| [supertest](https://www.npmjs.com/package/supertest)                                                                                 | 7.3.1                   | MIT                                 |
| [supports-color](https://www.npmjs.com/package/supports-color)                                                                       | 7.2.0, 8.1.1            | MIT                                 |
| [symbol-observable](https://www.npmjs.com/package/symbol-observable)                                                                 | 4.0.0                   | MIT                                 |
| [synckit](https://www.npmjs.com/package/synckit)                                                                                     | 0.11.13                 | MIT                                 |
| [tailwind-merge](https://www.npmjs.com/package/tailwind-merge)                                                                       | 3.7.0                   | MIT                                 |
| [tailwindcss](https://www.npmjs.com/package/tailwindcss)                                                                             | 4.3.3                   | MIT                                 |
| [tapable](https://www.npmjs.com/package/tapable)                                                                                     | 2.3.3                   | MIT                                 |
| [tar-fs](https://www.npmjs.com/package/tar-fs)                                                                                       | 2.1.5, 3.1.3            | MIT                                 |
| [tar-stream](https://www.npmjs.com/package/tar-stream)                                                                               | 2.2.0, 3.2.2            | MIT                                 |
| [teex](https://www.npmjs.com/package/teex)                                                                                           | 1.0.1                   | MIT                                 |
| [terser](https://www.npmjs.com/package/terser)                                                                                       | 5.51.2                  | BSD-2-Clause                        |
| [test-exclude](https://www.npmjs.com/package/test-exclude)                                                                           | 7.0.2                   | ISC                                 |
| [testcontainers](https://www.npmjs.com/package/testcontainers)                                                                       | 12.2.1                  | MIT                                 |
| [text-decoder](https://www.npmjs.com/package/text-decoder)                                                                           | 1.2.7                   | Apache-2.0                          |
| [tinybench](https://www.npmjs.com/package/tinybench)                                                                                 | 6.2.2                   | MIT                                 |
| [tinyexec](https://www.npmjs.com/package/tinyexec)                                                                                   | 1.3.1                   | MIT                                 |
| [tinyglobby](https://www.npmjs.com/package/tinyglobby)                                                                               | 0.2.17                  | MIT                                 |
| [tldts](https://www.npmjs.com/package/tldts)                                                                                         | 7.4.19                  | MIT                                 |
| [tldts-core](https://www.npmjs.com/package/tldts-core)                                                                               | 7.4.20                  | MIT                                 |
| [tmp](https://www.npmjs.com/package/tmp)                                                                                             | 0.2.7                   | MIT                                 |
| [to-buffer](https://www.npmjs.com/package/to-buffer)                                                                                 | 1.2.2                   | MIT                                 |
| [toidentifier](https://www.npmjs.com/package/toidentifier)                                                                           | 1.0.1                   | MIT                                 |
| [token-types](https://www.npmjs.com/package/token-types)                                                                             | 6.1.2                   | MIT                                 |
| [tough-cookie](https://www.npmjs.com/package/tough-cookie)                                                                           | 6.0.2                   | BSD-3-Clause                        |
| [tr46](https://www.npmjs.com/package/tr46)                                                                                           | 7.0.0                   | MIT                                 |
| [ts-api-utils](https://www.npmjs.com/package/ts-api-utils)                                                                           | 2.5.0                   | MIT                                 |
| [ts-custom-error](https://www.npmjs.com/package/ts-custom-error)                                                                     | 3.3.1                   | MIT                                 |
| [ts-jest](https://www.npmjs.com/package/ts-jest)                                                                                     | 29.4.15                 | MIT                                 |
| [tsconfig-paths](https://www.npmjs.com/package/tsconfig-paths)                                                                       | 4.2.0                   | MIT                                 |
| [tsconfig-paths-webpack-plugin](https://www.npmjs.com/package/tsconfig-paths-webpack-plugin)                                         | 4.2.0                   | MIT                                 |
| [tslib](https://www.npmjs.com/package/tslib)                                                                                         | 2.8.1                   | 0BSD                                |
| [tsx](https://www.npmjs.com/package/tsx)                                                                                             | 4.23.15                 | MIT                                 |
| [tunnel-agent](https://www.npmjs.com/package/tunnel-agent)                                                                           | 0.6.0                   | Apache-2.0                          |
| [turbo](https://www.npmjs.com/package/turbo)                                                                                         | 2.11.10                 | MIT                                 |
| [tweetnacl](https://www.npmjs.com/package/tweetnacl)                                                                                 | 0.14.5                  | Unlicense                           |
| [type-check](https://www.npmjs.com/package/type-check)                                                                               | 0.4.0                   | MIT                                 |
| [type-detect](https://www.npmjs.com/package/type-detect)                                                                             | 4.0.8                   | MIT                                 |
| [type-fest](https://www.npmjs.com/package/type-fest)                                                                                 | 0.21.3, 4.41.0          | (MIT OR CC0-1.0)                    |
| [type-is](https://www.npmjs.com/package/type-is)                                                                                     | 1.6.18, 2.1.0           | MIT                                 |
| [typed-array-buffer](https://www.npmjs.com/package/typed-array-buffer)                                                               | 1.0.3                   | MIT                                 |
| [typeorm](https://www.npmjs.com/package/typeorm)                                                                                     | 0.3.31                  | MIT                                 |
| [typescript](https://www.npmjs.com/package/typescript)                                                                               | 5.9.3                   | Apache-2.0                          |
| [typescript-eslint](https://www.npmjs.com/package/typescript-eslint)                                                                 | 8.72.1                  | MIT                                 |
| [uglify-js](https://www.npmjs.com/package/uglify-js)                                                                                 | 3.19.3                  | BSD-2-Clause                        |
| [uid](https://www.npmjs.com/package/uid)                                                                                             | 2.0.2                   | MIT                                 |
| [uid2](https://www.npmjs.com/package/uid2)                                                                                           | 1.0.0                   | MIT                                 |
| [uint8array-extras](https://www.npmjs.com/package/uint8array-extras)                                                                 | 1.6.0                   | MIT                                 |
| [undici](https://www.npmjs.com/package/undici)                                                                                       | 8.12.3                  | MIT                                 |
| [undici-types](https://www.npmjs.com/package/undici-types)                                                                           | 5.26.5, 7.24.6          | MIT                                 |
| [universalify](https://www.npmjs.com/package/universalify)                                                                           | 2.0.1                   | MIT                                 |
| [unpipe](https://www.npmjs.com/package/unpipe)                                                                                       | 1.0.0                   | MIT                                 |
| [unrs-resolver](https://www.npmjs.com/package/unrs-resolver)                                                                         | 1.12.2                  | MIT                                 |
| [update-browserslist-db](https://www.npmjs.com/package/update-browserslist-db)                                                       | 1.3.4                   | MIT                                 |
| [uri-js](https://www.npmjs.com/package/uri-js)                                                                                       | 4.4.1                   | BSD-2-Clause                        |
| [use-callback-ref](https://www.npmjs.com/package/use-callback-ref)                                                                   | 1.3.3                   | MIT                                 |
| [use-sidecar](https://www.npmjs.com/package/use-sidecar)                                                                             | 1.1.3                   | MIT                                 |
| [util-deprecate](https://www.npmjs.com/package/util-deprecate)                                                                       | 1.0.2                   | MIT                                 |
| [utils-merge](https://www.npmjs.com/package/utils-merge)                                                                             | 1.0.1                   | MIT                                 |
| [uuid](https://www.npmjs.com/package/uuid)                                                                                           | 11.1.1                  | MIT                                 |
| [v8-to-istanbul](https://www.npmjs.com/package/v8-to-istanbul)                                                                       | 9.3.0                   | ISC                                 |
| [vary](https://www.npmjs.com/package/vary)                                                                                           | 1.1.2                   | MIT                                 |
| [vite](https://www.npmjs.com/package/vite)                                                                                           | 8.3.5                   | MIT                                 |
| [vitest](https://www.npmjs.com/package/vitest)                                                                                       | 5.0.5                   | MIT                                 |
| [w3c-xmlserializer](https://www.npmjs.com/package/w3c-xmlserializer)                                                                 | 6.0.0                   | MIT                                 |
| [watchpack](https://www.npmjs.com/package/watchpack)                                                                                 | 2.6.3                   | MIT                                 |
| [wcwidth](https://www.npmjs.com/package/wcwidth)                                                                                     | 1.0.1                   | MIT                                 |
| [webidl-conversions](https://www.npmjs.com/package/webidl-conversions)                                                               | 8.0.1                   | BSD-2-Clause                        |
| [webpack](https://www.npmjs.com/package/webpack)                                                                                     | 5.112.2                 | MIT                                 |
| [webpack-node-externals](https://www.npmjs.com/package/webpack-node-externals)                                                       | 3.0.0                   | MIT                                 |
| [webpack-sources](https://www.npmjs.com/package/webpack-sources)                                                                     | 3.7.0                   | MIT                                 |
| [whatwg-mimetype](https://www.npmjs.com/package/whatwg-mimetype)                                                                     | 5.0.0                   | MIT                                 |
| [whatwg-url](https://www.npmjs.com/package/whatwg-url)                                                                               | 17.3.0                  | MIT                                 |
| [which](https://www.npmjs.com/package/which)                                                                                         | 2.0.2                   | ISC                                 |
| [which-module](https://www.npmjs.com/package/which-module)                                                                           | 2.0.1                   | ISC                                 |
| [which-typed-array](https://www.npmjs.com/package/which-typed-array)                                                                 | 1.1.24                  | MIT                                 |
| [why-is-node-running](https://www.npmjs.com/package/why-is-node-running)                                                             | 3.2.1                   | MIT                                 |
| [word-wrap](https://www.npmjs.com/package/word-wrap)                                                                                 | 1.2.5                   | MIT                                 |
| [wordwrap](https://www.npmjs.com/package/wordwrap)                                                                                   | 1.0.0                   | MIT                                 |
| [wrap-ansi](https://www.npmjs.com/package/wrap-ansi)                                                                                 | 6.2.0, 7.0.0, 8.1.0     | MIT                                 |
| [wrappy](https://www.npmjs.com/package/wrappy)                                                                                       | 1.0.2                   | ISC                                 |
| [write-file-atomic](https://www.npmjs.com/package/write-file-atomic)                                                                 | 5.0.1                   | ISC                                 |
| [ws](https://www.npmjs.com/package/ws)                                                                                               | 8.21.3                  | MIT                                 |
| [xml-name-validator](https://www.npmjs.com/package/xml-name-validator)                                                               | 5.0.0                   | Apache-2.0                          |
| [xmlchars](https://www.npmjs.com/package/xmlchars)                                                                                   | 2.2.0                   | MIT                                 |
| [xmlhttprequest-ssl](https://www.npmjs.com/package/xmlhttprequest-ssl)                                                               | 2.1.2                   | MIT                                 |
| [xtend](https://www.npmjs.com/package/xtend)                                                                                         | 4.0.2                   | MIT                                 |
| [y18n](https://www.npmjs.com/package/y18n)                                                                                           | 4.0.3, 5.0.8            | ISC                                 |
| [yallist](https://www.npmjs.com/package/yallist)                                                                                     | 3.1.1                   | ISC                                 |
| [yaml](https://www.npmjs.com/package/yaml)                                                                                           | 2.9.1                   | ISC                                 |
| [yargs](https://www.npmjs.com/package/yargs)                                                                                         | 15.4.1, 17.7.3          | MIT                                 |
| [yargs-parser](https://www.npmjs.com/package/yargs-parser)                                                                           | 18.1.3, 21.1.1          | ISC                                 |
| [yocto-queue](https://www.npmjs.com/package/yocto-queue)                                                                             | 0.1.0                   | MIT                                 |
| [yoctocolors-cjs](https://www.npmjs.com/package/yoctocolors-cjs)                                                                     | 2.1.3                   | MIT                                 |
| [zip-stream](https://www.npmjs.com/package/zip-stream)                                                                               | 6.0.1                   | MIT                                 |
| [zod](https://www.npmjs.com/package/zod)                                                                                             | 4.6.7                   | MIT                                 |
| [zustand](https://www.npmjs.com/package/zustand)                                                                                     | 5.0.16                  | MIT                                 |
