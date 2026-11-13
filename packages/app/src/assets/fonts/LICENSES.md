# Bundled fonts

Every font the app ships is under the SIL Open Font License 1.1 (OFL), and its licence text is in
[`licenses/`](licenses/). Files are the latin-subset woff2 cuts published by Fontsource
(`@fontsource/*`, `@fontsource-variable/*` 5.3.0) from each font's upstream release; the OFL permits
bundling and redistribution, and none of these is sold on its own.

`styles/theme-fonts.css` declares them, `lib/theme-fonts.ts` says which family draws with which, and
`tests/unit/theme-fonts.test.ts` fails when a file here is undeclared, unlicensed or over budget.

| Font             | Used by                                                         | Files (bytes)                                               | Licence                              | Upstream                                     |
| ---------------- | --------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------ | -------------------------------------------- |
| Inter            | studio, phosphor, blueprint, broadsheet, wayfinding, ledger, ma | `inter-latin-wght-normal` (48 256)                          | [OFL](licenses/inter.txt)            | https://github.com/rsms/inter                |
| Public Sans      | mission (stands in for Aptos)                                   | `public-sans-latin-wght-normal` (26 832)                    | [OFL](licenses/public-sans.txt)      | https://github.com/uswds/public-sans         |
| Cascadia Mono    | mission                                                         | `cascadia-mono-latin-wght-normal` (28 812)                  | [OFL](licenses/cascadia-mono.txt)    | https://github.com/microsoft/cascadia-code   |
| Archivo Black    | neo, wayfinding (stands in for Arial Black)                     | `archivo-black-latin-400-normal` (18 604)                   | [OFL](licenses/archivo-black.txt)    | https://github.com/Omnibus-Type/ArchivoBlack |
| IBM Plex Mono    | neo (code), ledger                                              | `ibm-plex-mono-latin-{400,700}-normal` (14 708 + 14 908)    | [OFL](licenses/ibm-plex-mono.txt)    | https://github.com/IBM/plex                  |
| Geist            | geist                                                           | `geist-latin-wght-normal` (29 400)                          | [OFL](licenses/geist.txt)            | https://github.com/vercel/geist-font         |
| Geist Mono       | geist (code)                                                    | `geist-mono-latin-wght-normal` (23 128)                     | [OFL](licenses/geist-mono.txt)       | https://github.com/vercel/geist-font         |
| Barlow Condensed | blueprint (stands in for DIN Condensed)                         | `barlow-condensed-latin-{400,600}-normal` (21 164 + 22 308) | [OFL](licenses/barlow-condensed.txt) | https://github.com/jpt/barlow                |
| Gelasio          | broadsheet, ma (stands in for Georgia)                          | `gelasio-latin-wght-normal` (34 832)                        | [OFL](licenses/gelasio.txt)          | https://github.com/SorkinType/Gelasio        |
| JetBrains Mono   | code in every Inter family; phosphor; the terminal              | `jetbrains-mono-latin-{400,700}-normal` (21 168 + 21 908)   | [OFL](licenses/jetbrains-mono.txt)   | https://github.com/JetBrains/JetBrainsMono   |

## Deliberately not bundled

- **Aptos** (Microsoft, not freely licensed) — named first in Mission's stack so an installed copy
  wins; Public Sans answers everywhere else.
- **DIN Condensed**, **Georgia**, **Arial Black**, **Helvetica Neue** — platform fonts, named first in
  their stacks for the same reason. Barlow Condensed, Gelasio and Archivo Black are the open look-alikes
  for the first three; Neo's body stays on the platform's Helvetica/Arial.
- **Contrast** draws with the device's own faces on purpose.
