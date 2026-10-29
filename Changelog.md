## [4.99.0](https://github.com/kirinnee/ferretry/compare/v4.98.0...v4.99.0) (2026-10-29)

### Features

* **daemon:** back the Attention rule with a turn-end check ([#853](https://github.com/kirinnee/ferretry/issues/853)) ([5a9d0ed](https://github.com/kirinnee/ferretry/commit/5a9d0edcd2f67f9ad7f3230cc2ed2be03e1f655c))
* **pwa:** draw mermaid top-down and readable on phones ([#845](https://github.com/kirinnee/ferretry/issues/845)) ([8d613a5](https://github.com/kirinnee/ferretry/commit/8d613a51c7f2febeb2ef22fd0018ecd039e791fc))
* **warden:** Jev becomes the Warden's first responder ([#855](https://github.com/kirinnee/ferretry/issues/855)) ([9ef031a](https://github.com/kirinnee/ferretry/commit/9ef031a933e967886db9939ace4674004094ce37))

## [4.98.0](https://github.com/kirinnee/ferretry/compare/v4.97.2...v4.98.0) (2026-10-29)

### Features

* **pwa:** let dictation insert straight into the composer, with Undo ([#852](https://github.com/kirinnee/ferretry/issues/852)) ([61aab0f](https://github.com/kirinnee/ferretry/commit/61aab0faab38b28b9ed5d8a036b005f63343299c))

## [4.97.2](https://github.com/kirinnee/ferretry/compare/v4.97.1...v4.97.2) (2026-10-29)

### Fixes

* **daemon:** read memory usage again when Bun reports it interrupted ([#841](https://github.com/kirinnee/ferretry/issues/841)) ([6ad30ce](https://github.com/kirinnee/ferretry/commit/6ad30cef12a2782f61eda67a47d61353ac7484c6))
* **test:** stop requiring the newest releases to show changes in the in-app list ([#851](https://github.com/kirinnee/ferretry/issues/851)) ([006a643](https://github.com/kirinnee/ferretry/commit/006a64301e117a7ac8f88a33b2a3eb04d8eba642))

## [4.97.1](https://github.com/kirinnee/ferretry/compare/v4.97.0...v4.97.1) (2026-10-29)

### Fixes

* **ci:** hold the compiled binaries' download to a manifest ([#842](https://github.com/kirinnee/ferretry/issues/842)) ([06ca66e](https://github.com/kirinnee/ferretry/commit/06ca66e1d52e8c89b6fe2f32ff206ff46a01d913)), closes [actions/download-artifact#454](https://github.com/actions/download-artifact/issues/454)

## [4.97.0](https://github.com/kirinnee/ferretry/compare/v4.96.1...v4.97.0) (2026-10-29)

### Features

* **pwa:** add an in-app What's new page ([#832](https://github.com/kirinnee/ferretry/issues/832)) ([e06da76](https://github.com/kirinnee/ferretry/commit/e06da7665219ab5eec95eb10a5dba0bc3aa58d7a))
* **pwa:** capitalise What's new lines and hide test, ci and build entries ([#839](https://github.com/kirinnee/ferretry/issues/839)) ([1367606](https://github.com/kirinnee/ferretry/commit/1367606a0cd660ae75ebff771650d7eb44e1e0dc))

## [4.96.1](https://github.com/kirinnee/ferretry/compare/v4.96.0...v4.96.1) (2026-10-29)

### Fixes

* **daemon:** stop an idle feedback-draft panel reading as a running turn ([#838](https://github.com/kirinnee/ferretry/issues/838)) ([bd6fd57](https://github.com/kirinnee/ferretry/commit/bd6fd57ad86289cd6d0d819203da089b62e4dfec))
* **daemon:** wait for the turn end when a busy pane's queue is unreadable ([#837](https://github.com/kirinnee/ferretry/issues/837)) ([0ad9ae8](https://github.com/kirinnee/ferretry/commit/0ad9ae84164b3f4f64a1d3323bf586e83fdd189c))
* **release:** list each release's changes in the changelog and GitHub notes ([#828](https://github.com/kirinnee/ferretry/issues/828)) ([24d4926](https://github.com/kirinnee/ferretry/commit/24d4926520ab14213e29144d53cbc78a0459ff98))

## [4.96.0](https://github.com/kirinnee/ferretry/compare/v4.95.1...v4.96.0) (2026-10-28)

### Features

* **pwa:** attention cards render Markdown, steps as a checklist, to-do actions ([#835](https://github.com/kirinnee/ferretry/issues/835)) ([a802980](https://github.com/kirinnee/ferretry/commit/a80298060ab7e39288efeb052d87537021a84983))

## [4.95.1](https://github.com/kirinnee/ferretry/compare/v4.95.0...v4.95.1) (2026-10-28)

### Fixes

* **cli:** refuse unknown attention verbs and add a read-only show ([#829](https://github.com/kirinnee/ferretry/issues/829)) ([e637cad](https://github.com/kirinnee/ferretry/commit/e637cad0e35e6fb9bf2809d314bbec9da83b5b7d))
* **pwa:** draw Mermaid node and cluster borders with contrast in light themes ([#836](https://github.com/kirinnee/ferretry/issues/836)) ([3a1b977](https://github.com/kirinnee/ferretry/commit/3a1b9778e2a82d7cedb61725e055683a7ed7c21f))
* **test:** drive the idle budget suite with a manual clock, not Bun's fake timers ([#824](https://github.com/kirinnee/ferretry/issues/824)) ([b5b90cb](https://github.com/kirinnee/ferretry/commit/b5b90cb0db78cb7bd54b44a3853d32678d6ced63)), closes [#695](https://github.com/kirinnee/ferretry/issues/695)

## [4.95.0](https://github.com/kirinnee/ferretry/compare/v4.94.1...v4.95.0) (2026-10-28)

### Features

* **pwa:** per-machine notifications, single-source Needs you ([#816](https://github.com/kirinnee/ferretry/issues/816)) ([0cd2aff](https://github.com/kirinnee/ferretry/commit/0cd2aff5e93ec71c28cee4d29d0f82e718a7485b))
* **pwa:** themed chart hypermedia type, and Mermaid that follows the theme ([#827](https://github.com/kirinnee/ferretry/issues/827)) ([e1bafed](https://github.com/kirinnee/ferretry/commit/e1bafed242dfe2a82e4b4df9e34cc7eba943ad06))

### Fixes

* **pwa:** join hard-wrapped terminal links and say when 'Open links in' cannot be honoured ([#834](https://github.com/kirinnee/ferretry/issues/834)) ([159c736](https://github.com/kirinnee/ferretry/commit/159c736cb7b6131256e54b761ffe2fb6c349f39f))
* **warden:** stop investigating idle ferrets and back off repeat looks ([#825](https://github.com/kirinnee/ferretry/issues/825)) ([af69428](https://github.com/kirinnee/ferretry/commit/af6942898152fa154a180e15ee93d89182a62dd2))

## [4.94.1](https://github.com/kirinnee/ferretry/compare/v4.94.0...v4.94.1) (2026-10-28)

### Fixes

* **daemon:** open terminals in the owner's login shell instead of /bin/sh ([#830](https://github.com/kirinnee/ferretry/issues/830)) ([a9d16ca](https://github.com/kirinnee/ferretry/commit/a9d16ca18ea62402865428b71b8cc6f85a07d218))

## [4.94.0](https://github.com/kirinnee/ferretry/compare/v4.93.0...v4.94.0) (2026-10-28)

### Features

* **attention:** to-do items with Done / Need more info, and every human action its own item ([#833](https://github.com/kirinnee/ferretry/issues/833)) ([a80eaeb](https://github.com/kirinnee/ferretry/commit/a80eaeb6c8714ffca26ceef907228099c14008c3))

### Fixes

* **daemon:** wait out the tmux control client before the daemon exits ([#826](https://github.com/kirinnee/ferretry/issues/826)) ([613b797](https://github.com/kirinnee/ferretry/commit/613b7974ed3000e622db161524801a91bfe56a55))
* **pwa:** Text size on every engine, per-device label, iPad bottom gap ([#821](https://github.com/kirinnee/ferretry/issues/821)) ([79b0160](https://github.com/kirinnee/ferretry/commit/79b016078091fcc6f5b522a037fb17300ff444bc))

## [4.93.0](https://github.com/kirinnee/ferretry/compare/v4.92.1...v4.93.0) (2026-10-28)

### Features

* **attention:** step-by-step instructions and progress on items ([#818](https://github.com/kirinnee/ferretry/issues/818)) ([9363a14](https://github.com/kirinnee/ferretry/commit/9363a14d05f3011154c48fd0e03c8d93b43871f5))

### Fixes

* **pwa:** capture the push-to-talk shortcut without relying on button focus ([#823](https://github.com/kirinnee/ferretry/issues/823)) ([a153124](https://github.com/kirinnee/ferretry/commit/a15312402e8809d386d09c2c1f4c3f5d1a4068e2))

## [4.92.1](https://github.com/kirinnee/ferretry/compare/v4.92.0...v4.92.1) (2026-10-28)

### Fixes

* **chat:** show a reply's blocks as the agent writes them ([#815](https://github.com/kirinnee/ferretry/issues/815)) ([b07177b](https://github.com/kirinnee/ferretry/commit/b07177bae0ca50f053b4d45c70c50ca42b50ce80))

## [4.92.0](https://github.com/kirinnee/ferretry/compare/v4.91.0...v4.92.0) (2026-10-28)

### Features

* **attention:** batch the owner's answers to a ferret into one message ([#817](https://github.com/kirinnee/ferretry/issues/817)) ([3fb347a](https://github.com/kirinnee/ferretry/commit/3fb347a2ee46c7d61a512c096ced1e1719ae95d8))

## [4.91.0](https://github.com/kirinnee/ferretry/compare/v4.90.0...v4.91.0) (2026-10-28)

### Features

* **daemon:** raise a harness parked on its own prompt as an Attention item ([#814](https://github.com/kirinnee/ferretry/issues/814)) ([0f81f2c](https://github.com/kirinnee/ferretry/commit/0f81f2c7871ace51a68b872139907e46d1eb3831))

### Fixes

* **attention:** a ferret's raise is its own, so the owner's answer reaches it ([#813](https://github.com/kirinnee/ferretry/issues/813)) ([93b36ab](https://github.com/kirinnee/ferretry/commit/93b36abff707792a175ec459496a2c6f3e9ac5e5))

## [4.90.0](https://github.com/kirinnee/ferretry/compare/v4.89.4...v4.90.0) (2026-10-28)

### Features

* **daemon:** gate Codex conversion by rollout format, add 0.165 ([#812](https://github.com/kirinnee/ferretry/issues/812)) ([6333c71](https://github.com/kirinnee/ferretry/commit/6333c7151b29f29fe06814292500a28893a404c0))

## [4.89.4](https://github.com/kirinnee/ferretry/compare/v4.89.3...v4.89.4) (2026-10-28)

### Fixes

* **mcp-oauth:** read a successful registration leniently and name the bad field ([#803](https://github.com/kirinnee/ferretry/issues/803)) ([de7d3a2](https://github.com/kirinnee/ferretry/commit/de7d3a22e77d4830e86fc1805e2a56680ea9b636))

## [4.89.3](https://github.com/kirinnee/ferretry/compare/v4.89.2...v4.89.3) (2026-10-28)

### Fixes

* **fleet:** decode the contract PTY transcript as one stream ([#801](https://github.com/kirinnee/ferretry/issues/801)) ([8b9e1e1](https://github.com/kirinnee/ferretry/commit/8b9e1e10002cba50a163c384b16cb6f4dbed0d91))

## [4.89.2](https://github.com/kirinnee/ferretry/compare/v4.89.1...v4.89.2) (2026-10-27)

### Fixes

* **convert:** support Codex 0.164.0 in the conversation converter ([#802](https://github.com/kirinnee/ferretry/issues/802)) ([761bedd](https://github.com/kirinnee/ferretry/commit/761beddee8035f162302a19d16d4e096c717a6af))
* **daemon:** diagnose and retry refused MCP OAuth client registration ([#800](https://github.com/kirinnee/ferretry/issues/800)) ([4c55893](https://github.com/kirinnee/ferretry/commit/4c55893e3368a9c34456e40f859665cdbb04fbf2))

## [4.89.1](https://github.com/kirinnee/ferretry/compare/v4.89.0...v4.89.1) (2026-10-27)

### Fixes

* **daemon:** sign in to a project MCP server in an unregistered folder ([#798](https://github.com/kirinnee/ferretry/issues/798)) ([05b6aa4](https://github.com/kirinnee/ferretry/commit/05b6aa423a3f46a348faf04daad925c4fff7f8e8))

## [4.89.0](https://github.com/kirinnee/ferretry/compare/v4.88.0...v4.89.0) (2026-10-27)

### Features

* **attention:** point-form items, concise pushes, writing lint and edit ([#797](https://github.com/kirinnee/ferretry/issues/797)) ([ff9c3ec](https://github.com/kirinnee/ferretry/commit/ff9c3ecdce9e420881552090972ae65d447fd6b6))
* **pwa:** ask multi-question forms one question at a time ([#796](https://github.com/kirinnee/ferretry/issues/796)) ([d162b03](https://github.com/kirinnee/ferretry/commit/d162b03a49d9c60f889d91309df0df4025d53650))

## [4.88.0](https://github.com/kirinnee/ferretry/compare/v4.87.0...v4.88.0) (2026-10-26)

### Features

* **attention:** structured items, a quiet in-ferret panel, conversation-titled pushes ([#794](https://github.com/kirinnee/ferretry/issues/794)) ([2048cc3](https://github.com/kirinnee/ferretry/commit/2048cc37f54528a162b72eaa09fc9483daeec52f))

### Fixes

* **question:** finish tabbed question forms from any tab, pause instead of cancelling ([#795](https://github.com/kirinnee/ferretry/issues/795)) ([93f7cec](https://github.com/kirinnee/ferretry/commit/93f7cecf1d25c056c6308abd39021467185c13ab))

## [4.87.0](https://github.com/kirinnee/ferretry/compare/v4.86.2...v4.87.0) (2026-10-26)

### Features

* **pwa:** make links in terminals clickable ([#793](https://github.com/kirinnee/ferretry/issues/793)) ([3520136](https://github.com/kirinnee/ferretry/commit/3520136132ec15cccc5e20ede0a61a0a72eebbe3))

## [4.86.2](https://github.com/kirinnee/ferretry/compare/v4.86.1...v4.86.2) (2026-10-26)

### Fixes

* **pwa:** say "needs an update" for old machines, name unreadable MCP files, hold a send whose file failed ([#792](https://github.com/kirinnee/ferretry/issues/792)) ([609c912](https://github.com/kirinnee/ferretry/commit/609c912542d2cc2199a987fc13e7d3fb5bb507f0))

## [4.86.1](https://github.com/kirinnee/ferretry/compare/v4.86.0...v4.86.1) (2026-10-26)

### Fixes

* **warden:** name logins by runtime name, not manifest id ([#791](https://github.com/kirinnee/ferretry/issues/791)) ([4febb68](https://github.com/kirinnee/ferretry/commit/4febb68b5877ef5dc4ee252d727db485b3fa6bd5))

## [4.86.0](https://github.com/kirinnee/ferretry/compare/v4.85.0...v4.86.0) (2026-10-25)

### Features

* **pwa:** gate raised limits on the daemon's reported features ([#790](https://github.com/kirinnee/ferretry/issues/790)) ([7e5568a](https://github.com/kirinnee/ferretry/commit/7e5568a2adf78d1a330c5995a842365216268d22)), closes [#789](https://github.com/kirinnee/ferretry/issues/789)

## [4.85.0](https://github.com/kirinnee/ferretry/compare/v4.84.0...v4.85.0) (2026-10-25)

### Features

* **pack:** make "Your idea" a growing text area that takes 4,000 characters ([#789](https://github.com/kirinnee/ferretry/issues/789)) ([d259e7e](https://github.com/kirinnee/ferretry/commit/d259e7ebde03903f01786bd8a9c0aab473556599))

## [4.84.0](https://github.com/kirinnee/ferretry/compare/v4.83.0...v4.84.0) (2026-10-25)

### Features

* **pwa:** Context › MCP and Skills show every scope, with Check and Sign in ([#788](https://github.com/kirinnee/ferretry/issues/788)) ([153eae9](https://github.com/kirinnee/ferretry/commit/153eae92f6edbafe6fa23391175d9dba6a686753)), closes [#786](https://github.com/kirinnee/ferretry/issues/786) [#785](https://github.com/kirinnee/ferretry/issues/785)

## [4.83.0](https://github.com/kirinnee/ferretry/compare/v4.82.0...v4.83.0) (2026-10-25)

### Features

* **pack:** write the routing prompt for the owner ([#787](https://github.com/kirinnee/ferretry/issues/787)) ([a82e55f](https://github.com/kirinnee/ferretry/commit/a82e55fd48f2625c076c6ce9b3442d96d9fe7796))

## [4.82.0](https://github.com/kirinnee/ferretry/compare/v4.81.7...v4.82.0) (2026-10-24)

### Features

* **daemon:** skills inventory by scope; read a ferret's own home ([#785](https://github.com/kirinnee/ferretry/issues/785)) ([769d2a3](https://github.com/kirinnee/ferretry/commit/769d2a3b87d90b3c58318b45655e52614007a500))

### Fixes

* **daemon:** list, check and sign in to MCP servers in every scope ([#786](https://github.com/kirinnee/ferretry/issues/786)) ([4c37e87](https://github.com/kirinnee/ferretry/commit/4c37e87497976b4195f5170adf0d2153550078c2))

## [4.81.7](https://github.com/kirinnee/ferretry/compare/v4.81.6...v4.81.7) (2026-10-24)

### Fixes

* **pwa:** a notification tap opens its conversation on the machine that sent it ([#784](https://github.com/kirinnee/ferretry/issues/784)) ([2b3d6be](https://github.com/kirinnee/ferretry/commit/2b3d6be8fe45d17308d5c1e402860c8e0526004a)), closes [#768](https://github.com/kirinnee/ferretry/issues/768) [#768](https://github.com/kirinnee/ferretry/issues/768)

## [4.81.6](https://github.com/kirinnee/ferretry/compare/v4.81.5...v4.81.6) (2026-10-24)

### Fixes

* **daemon:** send a worker nothing it was told before it was ended while loading ([#783](https://github.com/kirinnee/ferretry/issues/783)) ([a4c3bde](https://github.com/kirinnee/ferretry/commit/a4c3bdedc006754a4093fe8e450fc9c09b919c6a)), closes [#777](https://github.com/kirinnee/ferretry/issues/777)

## [4.81.5](https://github.com/kirinnee/ferretry/compare/v4.81.4...v4.81.5) (2026-10-24)

### Fixes

* **daemon:** a stopping daemon's session worker can no longer leave a tmux server behind ([#782](https://github.com/kirinnee/ferretry/issues/782)) ([7c42819](https://github.com/kirinnee/ferretry/commit/7c42819e768c4668e36eb4c1a0f19d4c33b8d2fa)), closes [#777](https://github.com/kirinnee/ferretry/issues/777)

## [4.81.4](https://github.com/kirinnee/ferretry/compare/v4.81.3...v4.81.4) (2026-10-24)

### Fixes

* **question:** bind the question forms Claude and Codex really draw ([#776](https://github.com/kirinnee/ferretry/issues/776)) ([59519af](https://github.com/kirinnee/ferretry/commit/59519af86c11c0b9434456e83b36738f61e9f5e5))

## [4.81.3](https://github.com/kirinnee/ferretry/compare/v4.81.2...v4.81.3) (2026-10-24)

### Fixes

* **daemon:** settle an answer receipt once when a worker's look is one append behind ([#779](https://github.com/kirinnee/ferretry/issues/779)) ([0133ee5](https://github.com/kirinnee/ferretry/commit/0133ee572dfe3be6ab9916dbccb2a903a9120969))

## [4.81.2](https://github.com/kirinnee/ferretry/compare/v4.81.1...v4.81.2) (2026-10-24)

### Fixes

* **daemon:** never end a worker thread while it is still loading ([#777](https://github.com/kirinnee/ferretry/issues/777)) ([6a3e0c4](https://github.com/kirinnee/ferretry/commit/6a3e0c4544d6ef780ea2e3aff3dd91d054e9fe40))
* **daemon:** say why Chrome did not start; retry the smoke browser open ([#778](https://github.com/kirinnee/ferretry/issues/778)) ([4789c75](https://github.com/kirinnee/ferretry/commit/4789c75919120aafa64189ba2aae56e10493a414))

## [4.81.1](https://github.com/kirinnee/ferretry/compare/v4.81.0...v4.81.1) (2026-10-24)

### Fixes

* **pwa:** stop shipping a file over Cloudflare Pages' 25 MiB limit ([#772](https://github.com/kirinnee/ferretry/issues/772)) ([4e1e1c3](https://github.com/kirinnee/ferretry/commit/4e1e1c35f54a440a4db7095ae2d7cf968b57ef5d))

## [4.81.0](https://github.com/kirinnee/ferretry/compare/v4.80.1...v4.81.0) (2026-10-23)

### Features

* **pwa:** Attention — unread feel, in-ferret panel, swipe inbox, !A3 references ([#770](https://github.com/kirinnee/ferretry/issues/770)) ([23466b9](https://github.com/kirinnee/ferretry/commit/23466b99935b116a461fa6f64d2926d69229a1c2))

## [4.80.1](https://github.com/kirinnee/ferretry/compare/v4.80.0...v4.80.1) (2026-10-23)

### Fixes

* **question:** one request id per answer, friendly already-answered state ([#771](https://github.com/kirinnee/ferretry/issues/771)) ([a687109](https://github.com/kirinnee/ferretry/commit/a6871094cef80404bf29777cadfe010e6671feba))

## [4.80.0](https://github.com/kirinnee/ferretry/compare/v4.79.0...v4.80.0) (2026-10-23)

### Features

* **pack:** one routing prompt replaces the use-case guide, migrated once with a backup ([#769](https://github.com/kirinnee/ferretry/issues/769)) ([aa00456](https://github.com/kirinnee/ferretry/commit/aa004569c59ba4e141a72c92a8598256fd749f21))

## [4.79.0](https://github.com/kirinnee/ferretry/compare/v4.78.0...v4.79.0) (2026-10-23)

### Features

* **attention:** notifications are Attention — one push per ask, answers reach the ferret ([#768](https://github.com/kirinnee/ferretry/issues/768)) ([9759287](https://github.com/kirinnee/ferretry/commit/9759287d61098151eda0a1e385479281613b3eb9))
* open links in this computer's default browser ([#767](https://github.com/kirinnee/ferretry/issues/767)) ([7991411](https://github.com/kirinnee/ferretry/commit/7991411ace0d6f61a7fac77d34daa9b8e4ac1b2e))

## [4.78.0](https://github.com/kirinnee/ferretry/compare/v4.77.0...v4.78.0) (2026-10-23)

### Features

* **fleet:** teach every ferret to raise Attention for asks ([#766](https://github.com/kirinnee/ferretry/issues/766)) ([01a5be0](https://github.com/kirinnee/ferretry/commit/01a5be0e259e5df607fbb8c9384ac50f295c35ab))

## [4.77.0](https://github.com/kirinnee/ferretry/compare/v4.76.0...v4.77.0) (2026-10-23)

### Features

* **fleet:** remove a login from the app, with an impact preview ([#765](https://github.com/kirinnee/ferretry/issues/765)) ([67ce862](https://github.com/kirinnee/ferretry/commit/67ce862f00b144b119972e81c2341e232b627201)), closes [#752](https://github.com/kirinnee/ferretry/issues/752)

## [4.76.0](https://github.com/kirinnee/ferretry/compare/v4.75.4...v4.76.0) (2026-10-22)

### Features

* **pwa:** measured engine numbers, Parakeet 110M phone default, drop Zipformer 20M ([#750](https://github.com/kirinnee/ferretry/issues/750)) ([60b73df](https://github.com/kirinnee/ferretry/commit/60b73dfa0b30211a943f04cc6f4611282c0bf842))
* **pwa:** Vosk small English on-device dictation with live words ([#743](https://github.com/kirinnee/ferretry/issues/743)) ([ea40b26](https://github.com/kirinnee/ferretry/commit/ea40b260b584464c6136b3d773f74767837f42d0))
* **pwa:** Whisper tiny.en and base.en on-device dictation via transformers.js ([#745](https://github.com/kirinnee/ferretry/issues/745)) ([5e5bf42](https://github.com/kirinnee/ferretry/commit/5e5bf42beb14429f115ba4e32305568c6bf2f95d))

### Fixes

* **pwa:** keep one offline machine from blocking the rest of the app ([#764](https://github.com/kirinnee/ferretry/issues/764)) ([1ad52de](https://github.com/kirinnee/ferretry/commit/1ad52ded3c9b9e72ba1c81e91b504a81ca703bc2))

## [4.75.4](https://github.com/kirinnee/ferretry/compare/v4.75.3...v4.75.4) (2026-10-22)

### Performance

* **daemon:** walk Codex homes on the housekeeping worker, and only when they move ([#762](https://github.com/kirinnee/ferretry/issues/762)) ([8d85d61](https://github.com/kirinnee/ferretry/commit/8d85d616ccdf1a33eade6b77c6cd41a810f28861)), closes [#697](https://github.com/kirinnee/ferretry/issues/697)

## [4.75.3](https://github.com/kirinnee/ferretry/compare/v4.75.2...v4.75.3) (2026-10-22)

### Performance

* **daemon:** answer a watched, unchanged session document with no stat ([#763](https://github.com/kirinnee/ferretry/issues/763)) ([077dcdd](https://github.com/kirinnee/ferretry/commit/077dcdd19482e149affd8841d94c191941c0afab)), closes [#693](https://github.com/kirinnee/ferretry/issues/693)

## [4.75.2](https://github.com/kirinnee/ferretry/compare/v4.75.1...v4.75.2) (2026-10-22)

### Fixes

* **daemon:** tell a composer placeholder from typed text by its dim ink, and answer Claude's folder-trust screen ([#761](https://github.com/kirinnee/ferretry/issues/761)) ([9e456c0](https://github.com/kirinnee/ferretry/commit/9e456c0f03866931391ee0f850fdad8c6fc5c3fa)), closes [#756](https://github.com/kirinnee/ferretry/issues/756)

## [4.75.1](https://github.com/kirinnee/ferretry/compare/v4.75.0...v4.75.1) (2026-10-22)

### Performance

* **daemon:** run the remaining housekeeping timers on events, each with a slow backstop ([#759](https://github.com/kirinnee/ferretry/issues/759)) ([b7ee7de](https://github.com/kirinnee/ferretry/commit/b7ee7de865ff923666c7f4aed71e950b3e56fb5f)), closes [#740](https://github.com/kirinnee/ferretry/issues/740)

## [4.75.0](https://github.com/kirinnee/ferretry/compare/v4.74.0...v4.75.0) (2026-10-22)

### Features

* **pack:** draft a models guide with a short-lived builder ferret, reviewed as a diff ([#757](https://github.com/kirinnee/ferretry/issues/757)) ([bd3fb72](https://github.com/kirinnee/ferretry/commit/bd3fb72f9b08083d2fd798bf6cea0d209dd94ade))
* **pwa:** Moonshine Tiny/Base and Parakeet 110M on the sherpa runtime ([#744](https://github.com/kirinnee/ferretry/issues/744)) ([f55aea1](https://github.com/kirinnee/ferretry/commit/f55aea108dcd2aa36d7b3305a565b002129715d7))
* **pwa:** sherpa-onnx streaming Zipformer dictation with live words ([#741](https://github.com/kirinnee/ferretry/issues/741)) ([a8e23c7](https://github.com/kirinnee/ferretry/commit/a8e23c7bb99f2b23afc46b94e302fbed7176a036))

### Fixes

* **daemon:** a stop signalled during boot releases what the boot acquired ([#760](https://github.com/kirinnee/ferretry/issues/760)) ([11378ad](https://github.com/kirinnee/ferretry/commit/11378ad04f86acb237774d9898ce57fb75913664))
* **daemon:** wait out a stalled pane, type a send once, and offer Send it / Clear it / Retry ([#756](https://github.com/kirinnee/ferretry/issues/756)) ([81ecfb4](https://github.com/kirinnee/ferretry/commit/81ecfb4352cd97a5a83073615d6024128a656bb7))

### Performance

* **daemon:** a session worker reads only what its agent appended to the transcript ([#758](https://github.com/kirinnee/ferretry/issues/758)) ([ebf6a18](https://github.com/kirinnee/ferretry/commit/ebf6a183b250c356294633e98099d34d93c55fcd))

## [4.74.0](https://github.com/kirinnee/ferretry/compare/v4.73.1...v4.74.0) (2026-10-22)

### Features

* rename and remove runtimes (CLI + app) ([#752](https://github.com/kirinnee/ferretry/issues/752)) ([5576211](https://github.com/kirinnee/ferretry/commit/5576211f82e2e5bd5b010e10ece96a5a1608b07f))

## [4.73.1](https://github.com/kirinnee/ferretry/compare/v4.73.0...v4.73.1) (2026-10-22)

### Fixes

* **daemon:** hear dot-files through FSEvents on macOS instead of polling their directory ([#755](https://github.com/kirinnee/ferretry/issues/755)) ([742dad4](https://github.com/kirinnee/ferretry/commit/742dad467eb0fba2e3746426ac3fe50d03dd7827))

### Performance

* **cli:** say in every profile how the daemon is run, launchd's ProcessType included ([#754](https://github.com/kirinnee/ferretry/issues/754)) ([1dd45b9](https://github.com/kirinnee/ferretry/commit/1dd45b98008e67ae1e90b4cbd0e751e1ddf4af2c)), closes [#713](https://github.com/kirinnee/ferretry/issues/713)

## [4.73.0](https://github.com/kirinnee/ferretry/compare/v4.72.1...v4.73.0) (2026-10-22)

### Features

* **pack:** route sub-ferrets with the guide's routing prompt and live quota ([#753](https://github.com/kirinnee/ferretry/issues/753)) ([6464a0e](https://github.com/kirinnee/ferretry/commit/6464a0e1ba37dd1504bb941658e40a78995a0554))

## [4.72.1](https://github.com/kirinnee/ferretry/compare/v4.72.0...v4.72.1) (2026-10-22)

### Fixes

* **daemon:** let the lifecycle read and stop a session in any protocol status ([#749](https://github.com/kirinnee/ferretry/issues/749)) ([6898087](https://github.com/kirinnee/ferretry/commit/6898087215e803578907bff5462fd0515a83721b))
* **pwa:** keep Android Chrome in-browser dictation words ([#734](https://github.com/kirinnee/ferretry/issues/734)) ([e13dbcf](https://github.com/kirinnee/ferretry/commit/e13dbcfcf48062fda320b4618d0f4e382bc05b0a))

## [4.72.0](https://github.com/kirinnee/ferretry/compare/v4.71.1...v4.72.0) (2026-10-22)

### Features

* **pwa:** offer to turn on a machine's tunnel, and keep the device's tunnel in step with its switch ([#732](https://github.com/kirinnee/ferretry/issues/732)) ([fb0cf44](https://github.com/kirinnee/ferretry/commit/fb0cf44f22f4584c363a9ee593c16d7fac9198f6))
* **pwa:** on-device speech model catalog with install, use and try per engine ([#738](https://github.com/kirinnee/ferretry/issues/738)) ([8e480c8](https://github.com/kirinnee/ferretry/commit/8e480c853ae99f261c6872632fad8b957a381075))

### Fixes

* **daemon:** prove a revive-carried send by the pointer the relaunch typed ([#747](https://github.com/kirinnee/ferretry/issues/747)) ([ccc67df](https://github.com/kirinnee/ferretry/commit/ccc67df6d20a7de1307c4f04e337742885ac8b93))
* **relay:** measure tunnel session drops and recover them before they show ([#746](https://github.com/kirinnee/ferretry/issues/746)) ([f97aaf6](https://github.com/kirinnee/ferretry/commit/f97aaf61e50b42c02c55b5457e7f578cbd1b29ad))

### Performance

* **daemon:** start the WebRTC engine on the first offer and stop it when no peer needs it ([#748](https://github.com/kirinnee/ferretry/issues/748)) ([b5d8f64](https://github.com/kirinnee/ferretry/commit/b5d8f640bc364343c92cc8430d2fa97247ffd40d))

## [4.71.1](https://github.com/kirinnee/ferretry/compare/v4.71.0...v4.71.1) (2026-10-22)

### Fixes

* **cli:** read launchd plists that plutil or Xcode reformatted ([#739](https://github.com/kirinnee/ferretry/issues/739)) ([0579497](https://github.com/kirinnee/ferretry/commit/05794974100ee62d59695f46b0fc3f20c2ff1d1f))

## [4.71.0](https://github.com/kirinnee/ferretry/compare/v4.70.0...v4.71.0) (2026-10-22)

### Features

* **cli:** show progress for slow commands ([#736](https://github.com/kirinnee/ferretry/issues/736)) ([6d5aa7f](https://github.com/kirinnee/ferretry/commit/6d5aa7f21de9d4e45050603ad89c73ce334950c2))
* **pwa:** redesign the composer "+" menu and add a full-screen image viewer ([#730](https://github.com/kirinnee/ferretry/issues/730)) ([c865eed](https://github.com/kirinnee/ferretry/commit/c865eedde1cbc9068333fde2ba7e25dd672f35b8))
* **pwa:** time each dictation stage so a slow one is visible ([#735](https://github.com/kirinnee/ferretry/issues/735)) ([a2aafeb](https://github.com/kirinnee/ferretry/commit/a2aafeb83eb38a062efbdc2eb5b7541f860813ca))

### Performance

* **daemon:** a session-worker pool of two by default, shown in status and every profile ([#737](https://github.com/kirinnee/ferretry/issues/737)) ([6da239e](https://github.com/kirinnee/ferretry/commit/6da239eac3c9e4e41e9c43b47cce415ad3c7d3e5))
* **daemon:** session workers own every running session; main thread keeps no observation loop ([#740](https://github.com/kirinnee/ferretry/issues/740)) ([fec9407](https://github.com/kirinnee/ferretry/commit/fec9407079e3832a09396712e5c0925c5d7e7541))

## [4.70.0](https://github.com/kirinnee/ferretry/compare/v4.69.4...v4.70.0) (2026-10-22)

### Features

* **daemon:** make the Cloudflare tunnel carrier opt-in ([#731](https://github.com/kirinnee/ferretry/issues/731)) ([56dc952](https://github.com/kirinnee/ferretry/commit/56dc9521950244aed279312a85b6c33932798fe1))
* **pwa:** one small ⋯ menu for a message's actions ([#728](https://github.com/kirinnee/ferretry/issues/728)) ([0615295](https://github.com/kirinnee/ferretry/commit/061529540e7a2fc077d65f09e3ece6a37883e457))

### Fixes

* **pwa:** keep a machine's tunnel across reloads, and ask the daemon when it is gone ([#726](https://github.com/kirinnee/ferretry/issues/726)) ([1c7e2e9](https://github.com/kirinnee/ferretry/commit/1c7e2e98becc94c07b1c5b1e4efc44020ea486c6))

### Performance

* **daemon:** count a worker's looks and its answers apart in the profile ([#733](https://github.com/kirinnee/ferretry/issues/733)) ([d8f01ac](https://github.com/kirinnee/ferretry/commit/d8f01ac7e021c93c38f895e6cbd57b3adcb6d1ae))
* **daemon:** keep the fleet reading current by events, not a timer ([#724](https://github.com/kirinnee/ferretry/issues/724)) ([c4b0372](https://github.com/kirinnee/ferretry/commit/c4b0372f945cbeb9912dcd78920e9edd0d17c676))

## [4.69.4](https://github.com/kirinnee/ferretry/compare/v4.69.3...v4.69.4) (2026-10-22)

### Fixes

* **pwa:** keep the reconnect notice off the layout and stop Sessions cards overflowing ([#725](https://github.com/kirinnee/ferretry/issues/725)) ([d71b2f8](https://github.com/kirinnee/ferretry/commit/d71b2f84cd8061ba6c176a64009dd32b2030a100))

### Performance

* **daemon:** event-driven session workers own each running session's observation (stage 3c) ([#727](https://github.com/kirinnee/ferretry/issues/727)) ([aa02508](https://github.com/kirinnee/ferretry/commit/aa025084f83c989ff4e4aba0b3fa1d7088659e18))
* **daemon:** read the fleet's credentials and usage on a housekeeping worker ([#720](https://github.com/kirinnee/ferretry/issues/720)) ([445fae1](https://github.com/kirinnee/ferretry/commit/445fae19b7e3f21985f730dee5f97b17a88f33d2))

## [4.69.3](https://github.com/kirinnee/ferretry/compare/v4.69.2...v4.69.3) (2026-10-22)

### Fixes

* **daemon:** never type into a composer not proven empty, and never retype ([#721](https://github.com/kirinnee/ferretry/issues/721)) ([2e1d241](https://github.com/kirinnee/ferretry/commit/2e1d241125208de6d57c95e392a67d42e30768bc))

## [4.69.2](https://github.com/kirinnee/ferretry/compare/v4.69.1...v4.69.2) (2026-10-22)

### Performance

* **daemon:** observe each running session's turn on its own worker thread (stage 3b) ([#723](https://github.com/kirinnee/ferretry/issues/723)) ([4c59897](https://github.com/kirinnee/ferretry/commit/4c5989707ba5d4b5f52422329e11b28d1fb914cc))
* **daemon:** stop the self-check's late-tick feedback loop ([#722](https://github.com/kirinnee/ferretry/issues/722)) ([db8bf55](https://github.com/kirinnee/ferretry/commit/db8bf550fca8ec0742d9b191fc1b46e352d4f375))

## [4.69.1](https://github.com/kirinnee/ferretry/compare/v4.69.0...v4.69.1) (2026-10-22)

### Performance

* **daemon:** hand out one frozen instance per cached session document ([#718](https://github.com/kirinnee/ferretry/issues/718)) ([3105261](https://github.com/kirinnee/ferretry/commit/31052618d78f3835a58b720189577ed7a2a5f3ab)), closes [#693](https://github.com/kirinnee/ferretry/issues/693)
* **daemon:** two garbage-collector markers for the daemon, and none of its engine options for its agents ([#719](https://github.com/kirinnee/ferretry/issues/719)) ([0ce99d4](https://github.com/kirinnee/ferretry/commit/0ce99d4c93cdce59629f3873e840d61f69be6dcb))

## [4.69.0](https://github.com/kirinnee/ferretry/compare/v4.68.1...v4.69.0) (2026-10-22)

### Features

* **pwa:** choose where links open — your browser or Ferretry's side panel ([#717](https://github.com/kirinnee/ferretry/issues/717)) ([480a2b8](https://github.com/kirinnee/ferretry/commit/480a2b872581113325b1a4c77b21dab1f4b890f7))

### Performance

* **daemon:** redact a whole read with one vault open ([#715](https://github.com/kirinnee/ferretry/issues/715)) ([29daf07](https://github.com/kirinnee/ferretry/commit/29daf07125f524177ca34bd1d1f54c9442d2eec3))
* **pwa:** read the session lists when the fleet feed says something moved ([#716](https://github.com/kirinnee/ferretry/issues/716)) ([28f26bd](https://github.com/kirinnee/ferretry/commit/28f26bdce04271628ec40d65ca21a2160a2b10cd)), closes [#707](https://github.com/kirinnee/ferretry/issues/707) [#707](https://github.com/kirinnee/ferretry/issues/707) [#707](https://github.com/kirinnee/ferretry/issues/707)

## [4.68.1](https://github.com/kirinnee/ferretry/compare/v4.68.0...v4.68.1) (2026-10-22)

### Fixes

* **cli:** run the launchd daemon as an Interactive process ([#713](https://github.com/kirinnee/ferretry/issues/713)) ([d32f2fa](https://github.com/kirinnee/ferretry/commit/d32f2fa7c8c316f543231fff9d1acad4e70390e5))
* **daemon:** never retype a message Claude Code is holding in its queue ([#714](https://github.com/kirinnee/ferretry/issues/714)) ([7ebd08a](https://github.com/kirinnee/ferretry/commit/7ebd08a5e7ede6582e14012f164bac702377a221))
* **daemon:** stop macOS throttling the daemon, and cut its idle overhead ([#706](https://github.com/kirinnee/ferretry/issues/706)) ([39d1521](https://github.com/kirinnee/ferretry/commit/39d1521199d341588a93d2eb465fe812b2e03534))

### Performance

* **daemon:** anchor codex discovery's eager window to the session start ([#703](https://github.com/kirinnee/ferretry/issues/703)) ([a70d6d0](https://github.com/kirinnee/ferretry/commit/a70d6d02815a6cf71f1335c1353d9bf551384e6e)), closes [#697](https://github.com/kirinnee/ferretry/issues/697) [#702](https://github.com/kirinnee/ferretry/issues/702)

## [4.68.0](https://github.com/kirinnee/ferretry/compare/v4.67.1...v4.68.0) (2026-10-22)

### Features

* **pwa:** record a performance report from Settings › Machine › Performance ([#708](https://github.com/kirinnee/ferretry/issues/708)) ([955df6a](https://github.com/kirinnee/ferretry/commit/955df6ad5726aafd10666fee5e0a6de02e4116b1))

### Fixes

* **daemon:** stop the usage pass caching its own credential reads as unknown ([#710](https://github.com/kirinnee/ferretry/issues/710)) ([a346045](https://github.com/kirinnee/ferretry/commit/a346045fd534460609428723b3d3f96c00e2f4cb))
* **send:** finish a stranded turn pointer instead of refusing every later send ([#705](https://github.com/kirinnee/ferretry/issues/705)) ([b77da74](https://github.com/kirinnee/ferretry/commit/b77da74f25ca3f1bdf6ee390413a20ad01388d02))

### Performance

* **daemon:** extract the session observer as a pure fold behind an inline host (stage 3a) ([#712](https://github.com/kirinnee/ferretry/issues/712)) ([1874b94](https://github.com/kirinnee/ferretry/commit/1874b943649bfe7c1f006beb4a35569e678c7fbe)), closes [#689](https://github.com/kirinnee/ferretry/issues/689) [#701](https://github.com/kirinnee/ferretry/issues/701)
* **daemon:** let the app ask cheaply — a 304 fleet list, a fleet feed with no replay, a feed live at once ([#707](https://github.com/kirinnee/ferretry/issues/707)) ([5cfa0e3](https://github.com/kirinnee/ferretry/commit/5cfa0e3a180fbcedf9a295cc2c9f501e684683c2)), closes [#695](https://github.com/kirinnee/ferretry/issues/695)
* **daemon:** name every background timer in a profile, and plan stage 4 ([#709](https://github.com/kirinnee/ferretry/issues/709)) ([e271906](https://github.com/kirinnee/ferretry/commit/e271906f18c9ea2fc379b892e921823d333ac3cc))
* **daemon:** read each fleet credential once a pass and keep only its facts ([#711](https://github.com/kirinnee/ferretry/issues/711)) ([e36e32f](https://github.com/kirinnee/ferretry/commit/e36e32f394a542ec39bdc3e04197005912013ef1))

## [4.67.1](https://github.com/kirinnee/ferretry/compare/v4.67.0...v4.67.1) (2026-10-22)

### Performance

* **daemon:** profiles name polled directories and use the real sample interval ([#704](https://github.com/kirinnee/ferretry/issues/704)) ([fb21e3a](https://github.com/kirinnee/ferretry/commit/fb21e3a87b74d660508b38be5eaaf6df32fc64ab))
* **daemon:** say which timer started each child process, and lower the idle ceilings ([#702](https://github.com/kirinnee/ferretry/issues/702)) ([7525cdb](https://github.com/kirinnee/ferretry/commit/7525cdb2610bcd752917f65570d22d447ce2ef31)), closes [#693](https://github.com/kirinnee/ferretry/issues/693) [#696](https://github.com/kirinnee/ferretry/issues/696) [#697](https://github.com/kirinnee/ferretry/issues/697) [#698](https://github.com/kirinnee/ferretry/issues/698)
* **pwa:** stop the idle app re-asking, and record what each request costs ([#695](https://github.com/kirinnee/ferretry/issues/695)) ([159130f](https://github.com/kirinnee/ferretry/commit/159130fa09579b9ae4e81ddf512379b5fe1f3f07))

## [4.67.0](https://github.com/kirinnee/ferretry/compare/v4.66.7...v4.67.0) (2026-10-22)

### Features

* **daemon:** type tmux %extended-output as pane output ([#699](https://github.com/kirinnee/ferretry/issues/699)) ([b91dfdd](https://github.com/kirinnee/ferretry/commit/b91dfdd6bac4c03bb035c50197741a60f55d33dd))

## [4.66.7](https://github.com/kirinnee/ferretry/compare/v4.66.6...v4.66.7) (2026-10-22)

### Fixes

* **daemon:** write lifecycle transitions as locked read-modify-writes ([#700](https://github.com/kirinnee/ferretry/issues/700)) ([7199d03](https://github.com/kirinnee/ferretry/commit/7199d035c867784f7aee645406f1e4330571d02c))

### Performance

* **daemon:** pace codex rollout discovery and harden the walk cache ([#697](https://github.com/kirinnee/ferretry/issues/697)) ([9b52e7d](https://github.com/kirinnee/ferretry/commit/9b52e7d88bcd2c451efc1aef11046f3134feedf5)), closes [#693](https://github.com/kirinnee/ferretry/issues/693)

## [4.66.6](https://github.com/kirinnee/ferretry/compare/v4.66.5...v4.66.6) (2026-10-22)

### Performance

* **daemon:** answer tmux reads over one control-mode client ([#696](https://github.com/kirinnee/ferretry/issues/696)) ([12190fb](https://github.com/kirinnee/ferretry/commit/12190fbeb7c88d35e9e5137fed605f14dc3d1961))
* **daemon:** one file-event hub; transcript tails and config re-validated on events ([#698](https://github.com/kirinnee/ferretry/issues/698)) ([59956e0](https://github.com/kirinnee/ferretry/commit/59956e07d159f1832d3ae51e4010776e0f3b5166))
* **daemon:** profile the daemon from inside, and hold an idle fleet to CI ceilings ([#694](https://github.com/kirinnee/ferretry/issues/694)) ([2de8cb2](https://github.com/kirinnee/ferretry/commit/2de8cb29e473f67864e0ec186415229b71e29311))

## [4.66.5](https://github.com/kirinnee/ferretry/compare/v4.66.4...v4.66.5) (2026-10-22)

### Fixes

* **cli:** read the attach proof's start identity from the daemon's own module ([#692](https://github.com/kirinnee/ferretry/issues/692)) ([6a33233](https://github.com/kirinnee/ferretry/commit/6a332332c8e040fab8a8fb6e8c46dd5aa06f1acd))

### Performance

* **daemon:** read unchanged session documents from their identity, not the disk ([#693](https://github.com/kirinnee/ferretry/issues/693)) ([8780493](https://github.com/kirinnee/ferretry/commit/87804934cb5ae85083174d684b85b7023049df96))

## [4.66.4](https://github.com/kirinnee/ferretry/compare/v4.66.3...v4.66.4) (2026-10-21)

### Performance

* **daemon:** prove a file index through one shared walk instead of per-file opens ([#691](https://github.com/kirinnee/ferretry/issues/691)) ([92d3b93](https://github.com/kirinnee/ferretry/commit/92d3b939978488b7c3f2b67feebf072a66b9f356))

## [4.66.3](https://github.com/kirinnee/ferretry/compare/v4.66.2...v4.66.3) (2026-10-21)

### Performance

* **daemon:** fold analytics on a worker and hold boot to a 200 ms loop budget ([#690](https://github.com/kirinnee/ferretry/issues/690)) ([42ef847](https://github.com/kirinnee/ferretry/commit/42ef847a5a5d4fc02a5f1ef2eb847f4832de403a))

## [4.66.2](https://github.com/kirinnee/ferretry/compare/v4.66.1...v4.66.2) (2026-10-21)

### Fixes

* **daemon:** start worker threads inside the compiled binary ([#688](https://github.com/kirinnee/ferretry/issues/688)) ([a77b7f7](https://github.com/kirinnee/ferretry/commit/a77b7f77aeaf35cd0a51ba44309629856a15efc6))

## [4.66.1](https://github.com/kirinnee/ferretry/compare/v4.66.0...v4.66.1) (2026-10-21)

### Fixes

* **daemon:** finish the first declared-wait tick before the turn watcher starts ([#689](https://github.com/kirinnee/ferretry/issues/689)) ([0f0042c](https://github.com/kirinnee/ferretry/commit/0f0042c5339f35e2bbbf72b9d344cf47bb09eada)), closes [#687](https://github.com/kirinnee/ferretry/issues/687)

## [4.66.0](https://github.com/kirinnee/ferretry/compare/v4.65.0...v4.66.0) (2026-10-21)

### Features

* **daemon:** auto-resume ferrets after a host restart; relay is the default carrier ([#686](https://github.com/kirinnee/ferretry/issues/686)) ([6e1d5ed](https://github.com/kirinnee/ferretry/commit/6e1d5ed18bf92f33c75d581f0e48376c1d89c162))

### Fixes

* **daemon:** stop large fleets from stalling the event loop at boot ([#687](https://github.com/kirinnee/ferretry/issues/687)) ([02ed502](https://github.com/kirinnee/ferretry/commit/02ed50262e902937980e0ca035dbfa94579b3233))

## [4.65.0](https://github.com/kirinnee/ferretry/compare/v4.64.0...v4.65.0) (2026-10-21)

### Features

* **pwa:** dial the daemon peer-to-peer over WebRTC, and fall back saying why ([#684](https://github.com/kirinnee/ferretry/issues/684)) ([08c37cf](https://github.com/kirinnee/ferretry/commit/08c37cf0c4805e41fc92470f30d9191d1f2eacc6)), closes [#680](https://github.com/kirinnee/ferretry/issues/680)

### Performance

* open long sessions without a replay storm, and stop flashing Reconnecting ([#683](https://github.com/kirinnee/ferretry/issues/683)) ([44bbe5c](https://github.com/kirinnee/ferretry/commit/44bbe5c68c4cefa7803f50ebc3b5b850c5890906))

## [4.64.0](https://github.com/kirinnee/ferretry/compare/v4.63.0...v4.64.0) (2026-10-21)

### Features

* **daemon:** answer WebRTC offers and carry sessions over data channels ([#682](https://github.com/kirinnee/ferretry/issues/682)) ([f61fde6](https://github.com/kirinnee/ferretry/commit/f61fde68abbcb9b20ce81495d2dfc5e6bafe076f))
* **daemon:** run the hosted tunnel carrier ([#681](https://github.com/kirinnee/ferretry/issues/681)) ([82b6f2a](https://github.com/kirinnee/ferretry/commit/82b6f2aa133116e86806327e8cd7d2b9da7e5c7b))

## [4.63.0](https://github.com/kirinnee/ferretry/compare/v4.62.0...v4.63.0) (2026-10-21)

### Features

* **relay:** provision hosted Cloudflare tunnels from an account pool ([#679](https://github.com/kirinnee/ferretry/issues/679)) ([2a7c62a](https://github.com/kirinnee/ferretry/commit/2a7c62abd04f489f2d2736a347a266e33c835d2e))

## [4.62.0](https://github.com/kirinnee/ferretry/compare/v4.61.0...v4.62.0) (2026-10-21)

### Features

* **daemon:** embed a WebRTC engine and prove it on every target ([#678](https://github.com/kirinnee/ferretry/issues/678)) ([efc1097](https://github.com/kirinnee/ferretry/commit/efc1097731d6e26253062dc078893e0d47b7ed01))
* **pwa:** choose a connection per machine and dial the Cloudflare tunnel ([#680](https://github.com/kirinnee/ferretry/issues/680)) ([3eb4c8d](https://github.com/kirinnee/ferretry/commit/3eb4c8dae81d6278d49f458de0ad97b69b368d49))

## [4.61.0](https://github.com/kirinnee/ferretry/compare/v4.60.2...v4.61.0) (2026-10-21)

### Features

* **relay:** define the hosted tunnel carrier and the carrier choice ([#676](https://github.com/kirinnee/ferretry/issues/676)) ([7a7c887](https://github.com/kirinnee/ferretry/commit/7a7c88738711f6914f9e4675c8a27a738e586b5b))

### Fixes

* **daemon:** answer liveness from the first second and end a wedged loop ([#671](https://github.com/kirinnee/ferretry/issues/671)) ([e21da93](https://github.com/kirinnee/ferretry/commit/e21da93b5233a21e766bbe41142bbd9a571f43e5))
* **pwa:** fold cancelled sends into the timeline and let the reader dismiss them ([#677](https://github.com/kirinnee/ferretry/issues/677)) ([f4dd721](https://github.com/kirinnee/ferretry/commit/f4dd72142189a01523b9ad32e63f2805b8f4012e))

## [4.60.2](https://github.com/kirinnee/ferretry/compare/v4.60.1...v4.60.2) (2026-10-21)

### Fixes

* **relay:** read only the visible screen for the live activity line ([#673](https://github.com/kirinnee/ferretry/issues/673)) ([07227bd](https://github.com/kirinnee/ferretry/commit/07227bdade456eefc5ef556856db0e7785b84b6f))

## [4.60.1](https://github.com/kirinnee/ferretry/compare/v4.60.0...v4.60.1) (2026-10-21)

### Fixes

* **daemon:** answer unchanged transcript reads with 304 ([#675](https://github.com/kirinnee/ferretry/issues/675)) ([d81bb8c](https://github.com/kirinnee/ferretry/commit/d81bb8c6e7878492b94a21775517880b69e35373))
* **relay:** raise hosted byte ceilings to 20 GiB a day per daemon ([#670](https://github.com/kirinnee/ferretry/issues/670)) ([b0b81dc](https://github.com/kirinnee/ferretry/commit/b0b81dc8c8cba2be34a1eb62796ed8e9211981bc))
* **relay:** say when a spent relay allowance resets, and wait for it ([#672](https://github.com/kirinnee/ferretry/issues/672)) ([220a499](https://github.com/kirinnee/ferretry/commit/220a499a9c114dc8a977687934bafa2c0f2858b7))
* **relay:** stop streaming unseen terminals and pages, and repeated resizes ([#674](https://github.com/kirinnee/ferretry/issues/674)) ([9da2737](https://github.com/kirinnee/ferretry/commit/9da2737ff09d154bd71e0bc765f5f2f0acf451bb)), closes [#4](https://github.com/kirinnee/ferretry/issues/4) [#4b](https://github.com/kirinnee/ferretry/issues/4b) [#3](https://github.com/kirinnee/ferretry/issues/3)

## [4.60.0](https://github.com/kirinnee/ferretry/compare/v4.59.0...v4.60.0) (2026-10-21)

### Features

* **agent-tools:** open agent terminals and pages as workspace tabs ([#669](https://github.com/kirinnee/ferretry/issues/669)) ([465426e](https://github.com/kirinnee/ferretry/commit/465426e4f4dccf1586b00f981a2ad0103373752b))
* **pwa:** device permissions page, iPhone camera prompt and share my location ([#664](https://github.com/kirinnee/ferretry/issues/664)) ([8a33865](https://github.com/kirinnee/ferretry/commit/8a338656809b141da77f9297bad90cf2c483de89))

### Fixes

* **pwa:** reach the iPhone's bottom edge and pin Jump to latest to the composer ([#668](https://github.com/kirinnee/ferretry/issues/668)) ([2020b0e](https://github.com/kirinnee/ferretry/commit/2020b0e6c930eff2c7738b9456762255f363370f)), closes [#651](https://github.com/kirinnee/ferretry/issues/651)

## [4.59.0](https://github.com/kirinnee/ferretry/compare/v4.58.0...v4.59.0) (2026-10-21)

### Features

* **pwa:** dictation clean-up debug view and transcription log ([#667](https://github.com/kirinnee/ferretry/issues/667)) ([caf5f9c](https://github.com/kirinnee/ferretry/commit/caf5f9c8bea13904e9215bdb026ea8e74309fd5c))

## [4.58.0](https://github.com/kirinnee/ferretry/compare/v4.57.0...v4.58.0) (2026-10-21)

### Features

* **browser:** add a Real window browser mode for owners ([#662](https://github.com/kirinnee/ferretry/issues/662)) ([22207c3](https://github.com/kirinnee/ferretry/commit/22207c30d0afc5d9ccc0b2a3c683611ffa653264))
* **import:** list and continue the computer's default CLI conversations ([#666](https://github.com/kirinnee/ferretry/issues/666)) ([667d9be](https://github.com/kirinnee/ferretry/commit/667d9be9debf87f4363196e98120846e87c0f5c7))
* **pwa:** compact Sessions sidebar with a quick density toggle ([#660](https://github.com/kirinnee/ferretry/issues/660)) ([b246d9f](https://github.com/kirinnee/ferretry/commit/b246d9f020b8fe50979b783a5a8f614f98f3149f))
* **pwa:** render type: map fy-render blocks inline ([#663](https://github.com/kirinnee/ferretry/issues/663)) ([41b50d8](https://github.com/kirinnee/ferretry/commit/41b50d86ab3e86c5e17d2e959ec3d64ba166aaa4))

### Fixes

* **pwa:** draw each sent message once, handing its bubble over in place ([#665](https://github.com/kirinnee/ferretry/issues/665)) ([fc4c838](https://github.com/kirinnee/ferretry/commit/fc4c838c32261b7458b31dc35e5f5151c152a8c5))
* **pwa:** let every key reach the remote browser view ([#661](https://github.com/kirinnee/ferretry/issues/661)) ([ff8b1ba](https://github.com/kirinnee/ferretry/commit/ff8b1ba23501a7ed184148f46cea64ab77b86369))

## [4.57.0](https://github.com/kirinnee/ferretry/compare/v4.56.3...v4.57.0) (2026-10-21)

### Features

* **daemon:** let the daemon update and restart while ferrets are mid-turn ([#658](https://github.com/kirinnee/ferretry/issues/658)) ([4777895](https://github.com/kirinnee/ferretry/commit/4777895bf245bfcd2a29592bdebef4d7a3c17c64))
* default sessions filter to Interactive; readable titles for unnamed sub-ferrets ([#655](https://github.com/kirinnee/ferretry/issues/655)) ([7f44321](https://github.com/kirinnee/ferretry/commit/7f443213a4cbf6221d4a1a472c2eadc1d7b36b2a))

## [4.56.3](https://github.com/kirinnee/ferretry/compare/v4.56.2...v4.56.3) (2026-10-21)

### Fixes

* **fleet:** start Claude sessions with Remote Control off ([#656](https://github.com/kirinnee/ferretry/issues/656)) ([b69036f](https://github.com/kirinnee/ferretry/commit/b69036fdce15f97407ccdbcfc6c4884fb9fa6db3))
* **settings:** keep typing through re-renders; unlock up to a week, raised with a passkey, kept across restarts ([#657](https://github.com/kirinnee/ferretry/issues/657)) ([c57461b](https://github.com/kirinnee/ferretry/commit/c57461b4845221a91d96d15bd9debc06d96a8e44))

## [4.56.2](https://github.com/kirinnee/ferretry/compare/v4.56.1...v4.56.2) (2026-10-21)

### Fixes

* **daemon:** confirm sends to huge (adopted) transcripts and bound every transcript read ([#652](https://github.com/kirinnee/ferretry/issues/652)) ([f678abe](https://github.com/kirinnee/ferretry/commit/f678abe9c97ab27e4157f85c99b75c440a69dde8))
* **pwa:** calm phone session bar, task-titled sidebar rows, shorter bottom gap ([#651](https://github.com/kirinnee/ferretry/issues/651)) ([00afe95](https://github.com/kirinnee/ferretry/commit/00afe955d1b184f161b0bd00b4d5108d60fc7c94))
* **pwa:** roomier composer, sessions page that fits a phone, sub-ferret pill only for active children ([#654](https://github.com/kirinnee/ferretry/issues/654)) ([3cdb06c](https://github.com/kirinnee/ferretry/commit/3cdb06cb4dec17290a2437d37db06971a9ad6592))
* **relay:** never leave a phone's message on "Sending" forever ([#650](https://github.com/kirinnee/ferretry/issues/650)) ([191a563](https://github.com/kirinnee/ferretry/commit/191a5634ba57bbfb30c020c5d35afc43468f8680))

### Performance

* **terminal:** echo a relayed keystroke in one round trip, and paint used terminals at all ([#653](https://github.com/kirinnee/ferretry/issues/653)) ([d3fb1cb](https://github.com/kirinnee/ferretry/commit/d3fb1cbc24cd5dec235696774ba13156ac28dc9c))

## [4.56.1](https://github.com/kirinnee/ferretry/compare/v4.56.0...v4.56.1) (2026-10-20)

### Fixes

* **pwa:** pay the bottom safe-area inset once (iPhone dead band) ([#649](https://github.com/kirinnee/ferretry/issues/649)) ([b0879f0](https://github.com/kirinnee/ferretry/commit/b0879f097f732d4a94103f08fd642f39d6f77164))

## [4.56.0](https://github.com/kirinnee/ferretry/compare/v4.55.0...v4.56.0) (2026-10-20)

### Features

* **pwa:** keep the app alive on Back, cache sessions, restore scroll ([#648](https://github.com/kirinnee/ferretry/issues/648)) ([65c926c](https://github.com/kirinnee/ferretry/commit/65c926c740f2cc514caae8049b49f7a609d52d20))

## [4.55.0](https://github.com/kirinnee/ferretry/compare/v4.54.0...v4.55.0) (2026-10-20)

### Features

* **insights:** Overview + Query pages, catalog list prices, active time ([#646](https://github.com/kirinnee/ferretry/issues/646)) ([4477e76](https://github.com/kirinnee/ferretry/commit/4477e760aa64f4fbae615ae2e23064b025531bb8))

## [4.54.0](https://github.com/kirinnee/ferretry/compare/v4.53.2...v4.54.0) (2026-10-20)

### Features

* **migrate:** move a ferret to the other harness by converting its conversation ([#647](https://github.com/kirinnee/ferretry/issues/647)) ([60f8ff8](https://github.com/kirinnee/ferretry/commit/60f8ff8b323af817580cf287816862949a047e1d))

### Fixes

* **daemon:** say why a sub-ferret's harness exited at start ([#642](https://github.com/kirinnee/ferretry/issues/642)) ([443e057](https://github.com/kirinnee/ferretry/commit/443e057cd31afecf62d392d48945fc4c161d28d8))

## [4.53.2](https://github.com/kirinnee/ferretry/compare/v4.53.1...v4.53.2) (2026-10-20)

### Fixes

* **hypermedia:** resumed ferrets hear their sections; Pack and Hypermedia marks ([#645](https://github.com/kirinnee/ferretry/issues/645)) ([2a65fb5](https://github.com/kirinnee/ferretry/commit/2a65fb5e5742d8b07ce6eb9540437897e219aa70))

## [4.53.1](https://github.com/kirinnee/ferretry/compare/v4.53.0...v4.53.1) (2026-10-20)

### Fixes

* **chat:** send restart notice only when it matters; one meta row on bubbles ([#643](https://github.com/kirinnee/ferretry/issues/643)) ([0861f97](https://github.com/kirinnee/ferretry/commit/0861f975a96944a5d9337149954508df4c262f33))

## [4.53.0](https://github.com/kirinnee/ferretry/compare/v4.52.0...v4.53.0) (2026-10-20)

### Features

* **clone:** copy API-key logins with their keys, never a sign-in ([#644](https://github.com/kirinnee/ferretry/issues/644)) ([93bde7b](https://github.com/kirinnee/ferretry/commit/93bde7b2967a6daf43b9b47bd7cdfe56ca0fed31))

### Fixes

* **pwa:** draw every new chat card from the active theme ([#640](https://github.com/kirinnee/ferretry/issues/640)) ([ade6c00](https://github.com/kirinnee/ferretry/commit/ade6c0022afa256e78c240b77acbad57389eff6b)), closes [575-#631](https://github.com/kirinnee/575-/issues/631)

## [4.52.0](https://github.com/kirinnee/ferretry/compare/v4.51.0...v4.52.0) (2026-10-20)

### Features

* **harness:** know how claude and codex were installed and update them ([#641](https://github.com/kirinnee/ferretry/issues/641)) ([0f65c23](https://github.com/kirinnee/ferretry/commit/0f65c2394761cd58f32c5c1fbbda8fe6617ce3a3))
* **pwa:** clean up dictation straight from the browser with a device-held Groq/Cerebras key ([#639](https://github.com/kirinnee/ferretry/issues/639)) ([acaf231](https://github.com/kirinnee/ferretry/commit/acaf2313af5ea2780f6c31ef265ed8f52e888042))

## [4.51.0](https://github.com/kirinnee/ferretry/compare/v4.50.0...v4.51.0) (2026-10-20)

### Features

* **pwa:** name the agent once per run of messages ([#635](https://github.com/kirinnee/ferretry/issues/635)) ([44b6915](https://github.com/kirinnee/ferretry/commit/44b6915237d39191f38e42dfec76bb1ab684dd23))

## [4.50.0](https://github.com/kirinnee/ferretry/compare/v4.49.1...v4.50.0) (2026-10-20)

### Features

* **pwa:** drag to reorder machines in the Sessions bar ([#637](https://github.com/kirinnee/ferretry/issues/637)) ([4e889e2](https://github.com/kirinnee/ferretry/commit/4e889e20b0c6cb990fa9953e396d54c7e5d400a8))
* **secrets:** copy secrets to another machine, sealed end to end ([#636](https://github.com/kirinnee/ferretry/issues/636)) ([c0e6e0b](https://github.com/kirinnee/ferretry/commit/c0e6e0b54ba8331e5290139e12cf5b33d6f76ec7))

## [4.49.1](https://github.com/kirinnee/ferretry/compare/v4.49.0...v4.49.1) (2026-10-20)

### Fixes

* **daemon:** Restart and same-harness migrate resume the bound conversation ([#632](https://github.com/kirinnee/ferretry/issues/632)) ([05fb99e](https://github.com/kirinnee/ferretry/commit/05fb99eef9ae67532e974b2cce4e7534c4bf1952))
* **pack:** probe the runtime through the start's own launcher ([#634](https://github.com/kirinnee/ferretry/issues/634)) ([40d9a85](https://github.com/kirinnee/ferretry/commit/40d9a85fa175aa29e00a3024a389b810c79c1958))
* **pwa:** open each machine's row as that machine, and mark every machine's rows ([#633](https://github.com/kirinnee/ferretry/issues/633)) ([81af753](https://github.com/kirinnee/ferretry/commit/81af753a1e2c17f8e06acb26245dfcfc9051d147))

## [4.49.0](https://github.com/kirinnee/ferretry/compare/v4.48.5...v4.49.0) (2026-10-20)

### Features

* **cli:** add `fy setup` and an agent prompt that hands commands to the person ([#631](https://github.com/kirinnee/ferretry/issues/631)) ([9b4d4b8](https://github.com/kirinnee/ferretry/commit/9b4d4b8de24fca9ca4a628921641451f546fcb85))

## [4.48.5](https://github.com/kirinnee/ferretry/compare/v4.48.4...v4.48.5) (2026-10-20)

### Fixes

* Restart keeps the session's context window and speaks plainly ([#630](https://github.com/kirinnee/ferretry/issues/630)) ([3e21253](https://github.com/kirinnee/ferretry/commit/3e21253f8e1768bcd889ca8d687700be8fd70547))

## [4.48.4](https://github.com/kirinnee/ferretry/compare/v4.48.3...v4.48.4) (2026-10-20)

### Fixes

* **pwa:** route each request to the daemon it was built for ([#629](https://github.com/kirinnee/ferretry/issues/629)) ([4faaa8f](https://github.com/kirinnee/ferretry/commit/4faaa8f91f47d1aabdb006986334324574514314))
* Restart CLI no longer refused by the agent's own processes ([#628](https://github.com/kirinnee/ferretry/issues/628)) ([cd4251d](https://github.com/kirinnee/ferretry/commit/cd4251df1f249c0ff136167e7f3bd41c8eb50704))

## [4.48.3](https://github.com/kirinnee/ferretry/compare/v4.48.2...v4.48.3) (2026-10-20)

### Fixes

* **stt:** bound dictation cleanup context and say why a cleanup was kept raw ([#627](https://github.com/kirinnee/ferretry/issues/627)) ([17b395c](https://github.com/kirinnee/ferretry/commit/17b395ca6c6c34b6eecb5fc77e6c4e1db3ccc5b1))

## [4.48.2](https://github.com/kirinnee/ferretry/compare/v4.48.1...v4.48.2) (2026-10-20)

### Fixes

* **daemon:** prove codex delivery from the composer and let a person cancel stuck messages ([#626](https://github.com/kirinnee/ferretry/issues/626)) ([e8c539c](https://github.com/kirinnee/ferretry/commit/e8c539cc28235736f7ff7093abbc6e9f512a6b28))

## [4.48.1](https://github.com/kirinnee/ferretry/compare/v4.48.0...v4.48.1) (2026-10-20)

### Fixes

* **cli:** accept a newer install when updating the daemon ([#625](https://github.com/kirinnee/ferretry/issues/625)) ([56dc7fd](https://github.com/kirinnee/ferretry/commit/56dc7fd4eaf53e7ddead50200a674f43ec3c0f03))

## [4.48.0](https://github.com/kirinnee/ferretry/compare/v4.47.1...v4.48.0) (2026-10-20)

### Features

* **pwa:** right-click / long-press actions menu on a session row ([#624](https://github.com/kirinnee/ferretry/issues/624)) ([e5cd04c](https://github.com/kirinnee/ferretry/commit/e5cd04c246c756764ab6461aad99c84575367e4a))

## [4.47.1](https://github.com/kirinnee/ferretry/compare/v4.47.0...v4.47.1) (2026-10-20)

### Fixes

* **relay:** heal leaked hosted reservations so a daemon can never be locked out by 4432 ([#623](https://github.com/kirinnee/ferretry/issues/623)) ([00c18c6](https://github.com/kirinnee/ferretry/commit/00c18c6a881d0dea76099c4fc25cba919e9281de))

## [4.47.0](https://github.com/kirinnee/ferretry/compare/v4.46.0...v4.47.0) (2026-10-20)

### Features

* **pwa:** one colourful conversation list with source filters and clean titles ([#622](https://github.com/kirinnee/ferretry/issues/622)) ([67d972e](https://github.com/kirinnee/ferretry/commit/67d972e8dce82fe83c2c1bbb0ed930641ce40c4d))

### Fixes

* **daemon:** keep codex trust and the correlation root correct on codex 0.163 ([#621](https://github.com/kirinnee/ferretry/issues/621)) ([a47a7c0](https://github.com/kirinnee/ferretry/commit/a47a7c00a7472a947363d5b5d6cf7dc134d5c287))

## [4.46.0](https://github.com/kirinnee/ferretry/compare/v4.45.0...v4.46.0) (2026-10-20)

### Features

* **pwa:** read-only Connection status that says reconnecting and links the self-hosting runbook ([#620](https://github.com/kirinnee/ferretry/issues/620)) ([58c7579](https://github.com/kirinnee/ferretry/commit/58c7579fecf6932685d984c98c4f0e6dc594539c))

### Fixes

* **pwa:** keep shell redirections out of the Sent-to card ([#619](https://github.com/kirinnee/ferretry/issues/619)) ([8205e65](https://github.com/kirinnee/ferretry/commit/8205e650900fbfaf49dfa2e13309db6975853613))

## [4.45.0](https://github.com/kirinnee/ferretry/compare/v4.44.1...v4.45.0) (2026-10-20)

### Features

* **pwa:** run html with script as an inline interactive illustration ([#616](https://github.com/kirinnee/ferretry/issues/616)) ([1626d83](https://github.com/kirinnee/ferretry/commit/1626d8354db53525e9cc7e70e4395d7dd7532e5e))

## [4.44.1](https://github.com/kirinnee/ferretry/compare/v4.44.0...v4.44.1) (2026-10-20)

### Fixes

* **pack:** sub-ferrets in the parent's project, lineage, first-class cards, harness events ([#618](https://github.com/kirinnee/ferretry/issues/618)) ([76cb1d9](https://github.com/kirinnee/ferretry/commit/76cb1d943807ac0510d5a8982312ce25bcc132ab)), closes [#608](https://github.com/kirinnee/ferretry/issues/608)

## [4.44.0](https://github.com/kirinnee/ferretry/compare/v4.43.0...v4.44.0) (2026-10-20)

### Features

* **import:** show conversation names first ([#617](https://github.com/kirinnee/ferretry/issues/617)) ([67cba3f](https://github.com/kirinnee/ferretry/commit/67cba3f8260057b8e18034d7d654bb495af525eb))

## [4.43.0](https://github.com/kirinnee/ferretry/compare/v4.42.0...v4.43.0) (2026-10-19)

### Features

* fast mode for Claude Code and Codex ([#610](https://github.com/kirinnee/ferretry/issues/610)) ([e13f0ce](https://github.com/kirinnee/ferretry/commit/e13f0cea7c74e9799f845425b9ae1cbbd910b976))

### Fixes

* **fleet:** read a macOS Claude login by Claude's own acct rule, and say where a sign-in looked ([#615](https://github.com/kirinnee/ferretry/issues/615)) ([428d1c0](https://github.com/kirinnee/ferretry/commit/428d1c0c2f5c7761a450d3995b42911fa150807d)), closes [#477](https://github.com/kirinnee/ferretry/issues/477)

## [4.42.0](https://github.com/kirinnee/ferretry/compare/v4.41.0...v4.42.0) (2026-10-19)

### Features

* **models:** detect locally installed Ollama models ([#605](https://github.com/kirinnee/ferretry/issues/605)) ([1f6f6e3](https://github.com/kirinnee/ferretry/commit/1f6f6e309ff97bd69901524d3266f06adc18fe7b))

## [4.41.0](https://github.com/kirinnee/ferretry/compare/v4.40.0...v4.41.0) (2026-10-19)

### Features

* Pack mode — sub-ferrets on the right model, instructions as system prompt ([#612](https://github.com/kirinnee/ferretry/issues/612)) ([06a89c0](https://github.com/kirinnee/ferretry/commit/06a89c07242e40ca68a5814193dd6a566b4208c6))

### Fixes

* **pwa:** fy-render under Pages, static html fragments, and servable agent media ([#606](https://github.com/kirinnee/ferretry/issues/606)) ([54067bd](https://github.com/kirinnee/ferretry/commit/54067bd1d623ee57ece2140d83795200331bfa4c))
* **update:** refresh the Homebrew tap before upgrading the cask ([#614](https://github.com/kirinnee/ferretry/issues/614)) ([0265ab3](https://github.com/kirinnee/ferretry/commit/0265ab31208fe76f569526507184244d82306e48))

## [4.40.0](https://github.com/kirinnee/ferretry/compare/v4.39.0...v4.40.0) (2026-10-19)

### Features

* **pwa:** nest sub-ferrets under their parent in the Sessions bar ([#611](https://github.com/kirinnee/ferretry/issues/611)) ([1f43d17](https://github.com/kirinnee/ferretry/commit/1f43d1797eeb91f5e7ccdab82f2602d84103ee65))

### Fixes

* **daemon:** bind Codex transcripts from the launch, not the first long send ([#609](https://github.com/kirinnee/ferretry/issues/609)) ([b5d1635](https://github.com/kirinnee/ferretry/commit/b5d1635a49d324383fab69230cc60b8e6b7db260))

## [4.39.0](https://github.com/kirinnee/ferretry/compare/v4.38.0...v4.39.0) (2026-10-19)

### Features

* **fleet:** Codex in-chat model picker offers the runtime's catalog ([#602](https://github.com/kirinnee/ferretry/issues/602)) ([b5282b0](https://github.com/kirinnee/ferretry/commit/b5282b02e75aec49ab7fd8834aefb301b9405c2e))
* **pwa:** make messages between ferrets first class ([#608](https://github.com/kirinnee/ferretry/issues/608)) ([4ba259d](https://github.com/kirinnee/ferretry/commit/4ba259dd25ec3b18663c6961d32212f33fe4eec9))
* **pwa:** pick the new-session runtime with buttons, split Claude and Codex ([#603](https://github.com/kirinnee/ferretry/issues/603)) ([396ac52](https://github.com/kirinnee/ferretry/commit/396ac52c1d2cb74d3f49ef8771f468e8b5ba255d))

### Fixes

* **ci:** walk the gallery's viewports one after the other again ([#613](https://github.com/kirinnee/ferretry/issues/613)) ([e5d500a](https://github.com/kirinnee/ferretry/commit/e5d500a4d82e29aef7b60a5247519968352098d0)), closes [#598](https://github.com/kirinnee/ferretry/issues/598) [#598](https://github.com/kirinnee/ferretry/issues/598)
* small batch — hypermedia default, colour tokens, question preview, harness path ([#604](https://github.com/kirinnee/ferretry/issues/604)) ([9c28669](https://github.com/kirinnee/ferretry/commit/9c28669b1a009e8f91e5e55a24993392b4f6e83e)), closes [#589](https://github.com/kirinnee/ferretry/issues/589)
* surface harness startup dialogs instead of leaving sessions stuck ([#607](https://github.com/kirinnee/ferretry/issues/607)) ([067a8d2](https://github.com/kirinnee/ferretry/commit/067a8d23d0ebb3a8bc5c97b28f75e8346fab1a12))

## [4.38.0](https://github.com/kirinnee/ferretry/compare/v4.37.0...v4.38.0) (2026-10-19)

### Features

* **pwa:** flatten Add a login into one screen ([#599](https://github.com/kirinnee/ferretry/issues/599)) ([5921a9a](https://github.com/kirinnee/ferretry/commit/5921a9ae2d2710bb7e2fc99b31905d9757409c37))
* **pwa:** render hypermedia inline, as if native ([#601](https://github.com/kirinnee/ferretry/issues/601)) ([eb0de6f](https://github.com/kirinnee/ferretry/commit/eb0de6f554afd150b16e5a0ab44fa7945b056dc2))
* **pwa:** review dictation in a mini box before inserting ([#600](https://github.com/kirinnee/ferretry/issues/600)) ([7e60347](https://github.com/kirinnee/ferretry/commit/7e6034772a3ba1f0a2b3a922637d7909ba21d028))

## [4.37.0](https://github.com/kirinnee/ferretry/compare/v4.36.0...v4.37.0) (2026-10-19)

### Features

* **stt:** editable dictation cleanup prompts, gpt-oss default, always-on guard ([#585](https://github.com/kirinnee/ferretry/issues/585)) ([5469356](https://github.com/kirinnee/ferretry/commit/546935611f3813269945d407d4bd59a06d208133))

## [4.36.0](https://github.com/kirinnee/ferretry/compare/v4.35.0...v4.36.0) (2026-10-19)

### Features

* **pwa:** show compaction progress with an estimated percent ([#596](https://github.com/kirinnee/ferretry/issues/596)) ([f67a7b8](https://github.com/kirinnee/ferretry/commit/f67a7b89b2ee413ecbc23c329ef86e2a8014e975))

### Fixes

* first runtime becomes the default; push setup to create one ([#582](https://github.com/kirinnee/ferretry/issues/582)) ([a40341c](https://github.com/kirinnee/ferretry/commit/a40341c8094d6caa62dd899d55d269901bd0fb12))

## [4.35.0](https://github.com/kirinnee/ferretry/compare/v4.34.0...v4.35.0) (2026-10-19)

### Features

* **pwa:** run interactive html and show workspace media in fy-render ([#588](https://github.com/kirinnee/ferretry/issues/588)) ([8e973eb](https://github.com/kirinnee/ferretry/commit/8e973eb079e5a1c9272c4eed058b3e48f4336963))

## [4.34.0](https://github.com/kirinnee/ferretry/compare/v4.33.1...v4.34.0) (2026-10-19)

### Features

* **fleet:** let interactive ferrets ask the owner questions ([#581](https://github.com/kirinnee/ferretry/issues/581)) ([2ecd37c](https://github.com/kirinnee/ferretry/commit/2ecd37c9458f1082257da60ba00b9164075c4960))
* **hypermedia:** per-ferret Hypermedia switch, on by default ([#589](https://github.com/kirinnee/ferretry/issues/589)) ([22d0d8a](https://github.com/kirinnee/ferretry/commit/22d0d8aa9e93d8f9404df066476987d4ddacaa58))
* **pwa:** continue from stopped ferrets or Ferretry's own history ([#575](https://github.com/kirinnee/ferretry/issues/575)) ([45effa8](https://github.com/kirinnee/ferretry/commit/45effa8b3f6e8265ebcb4b393eee4402de237e97))
* **pwa:** filter the sessions list by kind and hide stopped sessions ([#578](https://github.com/kirinnee/ferretry/issues/578)) ([0f963f8](https://github.com/kirinnee/ferretry/commit/0f963f81ce643895dfd21d276a21b3c03057d5f4))
* **pwa:** show a live input meter while dictating; live words off by default ([#580](https://github.com/kirinnee/ferretry/issues/580)) ([cfa2914](https://github.com/kirinnee/ferretry/commit/cfa2914a1012731bfc9b0799d65ee13e43d52a7a)), closes [#545](https://github.com/kirinnee/ferretry/issues/545)
* **pwa:** simpler setup import, one conversation choice and one-line results ([#579](https://github.com/kirinnee/ferretry/issues/579)) ([0aace8b](https://github.com/kirinnee/ferretry/commit/0aace8bc8df6036d16d70b7bb517e34cc9cfa9a6))
* **warden:** layered triage and a growing cooldown ([#583](https://github.com/kirinnee/ferretry/issues/583)) ([212908b](https://github.com/kirinnee/ferretry/commit/212908b1dfcf17188a05f57812044527a772cde9))
* **warden:** restart and a liveness check (replays [#586](https://github.com/kirinnee/ferretry/issues/586) and [#587](https://github.com/kirinnee/ferretry/issues/587) onto main) ([#592](https://github.com/kirinnee/ferretry/issues/592)) ([2a620df](https://github.com/kirinnee/ferretry/commit/2a620df6f07b55423746259c9ae00429047f9c84))

### Fixes

* **ci:** pin node in the devshells and guard it comes from /nix/store ([#590](https://github.com/kirinnee/ferretry/issues/590)) ([753d50c](https://github.com/kirinnee/ferretry/commit/753d50c6fd8d60517e16ea103c6779a42e46e79c)), closes [#584](https://github.com/kirinnee/ferretry/issues/584)
* **daemon:** read process age with portable ps etime (macOS Restart CLI) ([#577](https://github.com/kirinnee/ferretry/issues/577)) ([4ba3c40](https://github.com/kirinnee/ferretry/commit/4ba3c4040561fe3a99cb73c25ce06a13c0c3e21c)), closes [#session-workspace](https://github.com/kirinnee/ferretry/issues/session-workspace)
* **runtime:** confirm a Claude /model switch and bound "switching…" ([#576](https://github.com/kirinnee/ferretry/issues/576)) ([72f3aa3](https://github.com/kirinnee/ferretry/commit/72f3aa3a9c7c6738b27910cbee2fd21abf364676))

## [4.33.1](https://github.com/kirinnee/ferretry/compare/v4.33.0...v4.33.1) (2026-10-19)

### Fixes

* **relay:** restore a daemon claim the rendezvous lost, and let the daemon prove it holds one ([#572](https://github.com/kirinnee/ferretry/issues/572)) ([42c12cd](https://github.com/kirinnee/ferretry/commit/42c12cd4e5e7c2f6c77f50d9864a7c30ce8c97b1))
* **update:** tell home-manager inside nix-darwin/NixOS from a system install ([#573](https://github.com/kirinnee/ferretry/issues/573)) ([1d95f9f](https://github.com/kirinnee/ferretry/commit/1d95f9fc5e3c49d566e8ebd9e49b6fa584a0d991))

## [4.33.0](https://github.com/kirinnee/ferretry/compare/v4.32.1...v4.33.0) (2026-10-19)

### Features

* **pwa:** let an agent set Ferretry up, and stop the floating CTA covering buttons ([#571](https://github.com/kirinnee/ferretry/issues/571)) ([6d14437](https://github.com/kirinnee/ferretry/commit/6d14437ccd21b729e0cfdfdb3ad5bdeef2d5f42f))

## [4.32.1](https://github.com/kirinnee/ferretry/compare/v4.32.0...v4.32.1) (2026-10-19)

### Fixes

* **pwa:** show conversations as compact two-line rows ([#569](https://github.com/kirinnee/ferretry/issues/569)) ([008cf85](https://github.com/kirinnee/ferretry/commit/008cf8584088ee81d53af99db829795d1c8f9c65))
* **tests:** stop test daemons launching real harnesses and leaking tmux ([#568](https://github.com/kirinnee/ferretry/issues/568)) ([689748b](https://github.com/kirinnee/ferretry/commit/689748b4639e673b89afd45790c23c7e335fb51b))

## [4.32.0](https://github.com/kirinnee/ferretry/compare/v4.31.0...v4.32.0) (2026-10-19)

### Features

* **models:** follow a published model catalog without a release ([#566](https://github.com/kirinnee/ferretry/issues/566)) ([02373cd](https://github.com/kirinnee/ferretry/commit/02373cdf3967783ff6d977655eefb17d4685486d))
* **pwa:** add a /get-started guide and refresh the landing copy ([#563](https://github.com/kirinnee/ferretry/issues/563)) ([e4413a4](https://github.com/kirinnee/ferretry/commit/e4413a410befaee27de41f7114112e91385abd9b))

## [4.31.0](https://github.com/kirinnee/ferretry/compare/v4.30.1...v4.31.0) (2026-10-19)

### Features

* **daemon:** detect the install method and update the daemon in place ([#564](https://github.com/kirinnee/ferretry/issues/564)) ([2744b2e](https://github.com/kirinnee/ferretry/commit/2744b2e81e7e47a837cbd5cbba930a9aab1f30bf))

## [4.30.1](https://github.com/kirinnee/ferretry/compare/v4.30.0...v4.30.1) (2026-10-19)

### Fixes

* **daemon:** relaunch sessions on current settings ([#567](https://github.com/kirinnee/ferretry/issues/567)) ([023f512](https://github.com/kirinnee/ferretry/commit/023f51274f82047c39b1c5623030af8a04904ce4))

## [4.30.0](https://github.com/kirinnee/ferretry/compare/v4.29.0...v4.30.0) (2026-10-19)

### Features

* **fleet:** per-provider model catalogs for every login and picker ([#565](https://github.com/kirinnee/ferretry/issues/565)) ([770f600](https://github.com/kirinnee/ferretry/commit/770f6000e99b59755d5d3e0985bba040a08c1002))

## [4.29.0](https://github.com/kirinnee/ferretry/compare/v4.28.1...v4.29.0) (2026-10-19)

### Features

* keep existing Claude Code and Codex conversations as ferrets ([#562](https://github.com/kirinnee/ferretry/issues/562)) ([11432c9](https://github.com/kirinnee/ferretry/commit/11432c9330633fd00f35a489382fa6d5b07be749))

## [4.28.1](https://github.com/kirinnee/ferretry/compare/v4.28.0...v4.28.1) (2026-10-18)

### Fixes

* **cli:** leave a claimed home after reset so install works again ([#561](https://github.com/kirinnee/ferretry/issues/561)) ([5a5e148](https://github.com/kirinnee/ferretry/commit/5a5e1484f1b11036a4281210e7038c0d6770e7a5))

## [4.28.0](https://github.com/kirinnee/ferretry/compare/v4.27.1...v4.28.0) (2026-10-18)

### Features

* **pwa:** live activity row — theme spinners, ticking clock, live token counts ([#560](https://github.com/kirinnee/ferretry/issues/560)) ([db739d9](https://github.com/kirinnee/ferretry/commit/db739d9de05183be7dbc4727a9c4155a2dab2471))

## [4.27.1](https://github.com/kirinnee/ferretry/compare/v4.27.0...v4.27.1) (2026-10-18)

### Fixes

* **pwa:** settle the full-browser frame's transition before measuring it ([#559](https://github.com/kirinnee/ferretry/issues/559)) ([8608349](https://github.com/kirinnee/ferretry/commit/8608349f16a2279c8f7eb6f88ae446de0874f276))

## [4.27.0](https://github.com/kirinnee/ferretry/compare/v4.26.1...v4.27.0) (2026-10-18)

### Features

* surface harness permission prompts as approval cards ([#558](https://github.com/kirinnee/ferretry/issues/558)) ([80830f9](https://github.com/kirinnee/ferretry/commit/80830f971ba2efecbb239e36b38f786ba0603153))

## [4.26.1](https://github.com/kirinnee/ferretry/compare/v4.26.0...v4.26.1) (2026-10-18)

### Fixes

* **warden:** stop defaulting the investigation login to a compiled-in wrapper ([#556](https://github.com/kirinnee/ferretry/issues/556)) ([c3e6a30](https://github.com/kirinnee/ferretry/commit/c3e6a30e243d9b211f6ff8067ec0a45b922eb0a0))

## [4.26.0](https://github.com/kirinnee/ferretry/compare/v4.25.0...v4.26.0) (2026-10-18)

### Features

* **pwa:** one session list across every paired machine ([#557](https://github.com/kirinnee/ferretry/issues/557)) ([683016f](https://github.com/kirinnee/ferretry/commit/683016f48d1d2a860a6dd6a88db193af732f0ef5))

## [4.25.0](https://github.com/kirinnee/ferretry/compare/v4.24.1...v4.25.0) (2026-10-18)

### Features

* **pwa:** a calmer Sessions list, and closable workspace tabs on a phone ([#555](https://github.com/kirinnee/ferretry/issues/555)) ([970902a](https://github.com/kirinnee/ferretry/commit/970902ad0d7cdf027fb2ebe5b79de2d4e3ce8101)), closes [#551](https://github.com/kirinnee/ferretry/issues/551)

## [4.24.1](https://github.com/kirinnee/ferretry/compare/v4.24.0...v4.24.1) (2026-10-18)

### Fixes

* make the phone-daemon connection survive relay drops, and stay calm when it can't ([#553](https://github.com/kirinnee/ferretry/issues/553)) ([b15df17](https://github.com/kirinnee/ferretry/commit/b15df1716b27770633305c533490b4c4e15e3125)), closes [#507](https://github.com/kirinnee/ferretry/issues/507) [DaemonCarrierRouter#hold](https://github.com/kirinnee/DaemonCarrierRouter/issues/hold)
* **pwa:** show what the person sent, not the turn-file pointer ([#554](https://github.com/kirinnee/ferretry/issues/554)) ([43ab097](https://github.com/kirinnee/ferretry/commit/43ab097cd84c67e9d1f7d4dc831d3b2d391a798b))

## [4.24.0](https://github.com/kirinnee/ferretry/compare/v4.23.3...v4.24.0) (2026-10-18)

### Features

* **pwa:** a comfortable phone without spending more space ([#551](https://github.com/kirinnee/ferretry/issues/551)) ([f09599d](https://github.com/kirinnee/ferretry/commit/f09599ded861fadb510481d8ef3b12c345599d25))
* **pwa:** flatten New machine setup into one rail; Add runtime is one form ([#552](https://github.com/kirinnee/ferretry/issues/552)) ([1b62b90](https://github.com/kirinnee/ferretry/commit/1b62b905bc46b349597380321a4996b3fed3a89d))

### Fixes

* **pwa:** show configuration changes live, without a reload ([#550](https://github.com/kirinnee/ferretry/issues/550)) ([1ffb679](https://github.com/kirinnee/ferretry/commit/1ffb679cf19054cc7dfd0b0b5e9d44d6e39158f7))

## [4.23.3](https://github.com/kirinnee/ferretry/compare/v4.23.2...v4.23.3) (2026-10-18)

### Fixes

* **pwa:** local message times and redrawn receipt ticks ([#549](https://github.com/kirinnee/ferretry/issues/549)) ([8539630](https://github.com/kirinnee/ferretry/commit/85396308b95502746b80cefcf50dd160d1c1e028))

## [4.23.2](https://github.com/kirinnee/ferretry/compare/v4.23.1...v4.23.2) (2026-10-18)

### Fixes

* **cli:** hand an unsupervised fyd over to systemd instead of starting a second one ([#548](https://github.com/kirinnee/ferretry/issues/548)) ([9523dcf](https://github.com/kirinnee/ferretry/commit/9523dcfe009c496c0f58acf6d5059abfc0ad6e58))
* **pwa:** give the harness file fixtures a size, and gate the full gallery ([#546](https://github.com/kirinnee/ferretry/issues/546)) ([4bf0415](https://github.com/kirinnee/ferretry/commit/4bf0415f575548784e9bced3363307430bf2e2ee)), closes [#432](https://github.com/kirinnee/ferretry/issues/432)

## [4.23.1](https://github.com/kirinnee/ferretry/compare/v4.23.0...v4.23.1) (2026-10-18)

### Fixes

* **fleet:** say why a Claude sign-in failed instead of "didn't answer" ([#547](https://github.com/kirinnee/ferretry/issues/547)) ([0c067cf](https://github.com/kirinnee/ferretry/commit/0c067cf0a72ff62a253a294bc41857cfc24aab19))

## [4.23.0](https://github.com/kirinnee/ferretry/compare/v4.22.1...v4.23.0) (2026-10-17)

### Features

* **pwa:** near-live Parakeet dictation words ([#545](https://github.com/kirinnee/ferretry/issues/545)) ([0b67f76](https://github.com/kirinnee/ferretry/commit/0b67f769f942cd4d6cb2a45f67cda01fb5fe9ef5))

## [4.22.1](https://github.com/kirinnee/ferretry/compare/v4.22.0...v4.22.1) (2026-10-16)

### Fixes

* **test:** remove six recurring CI failures at their cause ([#544](https://github.com/kirinnee/ferretry/issues/544)) ([8dd4d31](https://github.com/kirinnee/ferretry/commit/8dd4d31275015c9c7a1a8dc0941d715570c4a700))

## [4.22.0](https://github.com/kirinnee/ferretry/compare/v4.21.1...v4.22.0) (2026-10-16)

### Features

* onboarding v2, This machine / This device, Clone v2 + Export ([#542](https://github.com/kirinnee/ferretry/issues/542)) ([2a26a79](https://github.com/kirinnee/ferretry/commit/2a26a79df651ec944ad995480e487cab30477a42)), closes [#535](https://github.com/kirinnee/ferretry/issues/535)
* **pwa:** show passive learning on Info › Runtime ([#543](https://github.com/kirinnee/ferretry/issues/543)) ([e409a71](https://github.com/kirinnee/ferretry/commit/e409a71c16ab6bfbd46c2359e79ff16743d81149))

## [4.21.1](https://github.com/kirinnee/ferretry/compare/v4.21.0...v4.21.1) (2026-10-16)

### Performance

* **daemon:** serve relayed requests concurrently, per session ([#541](https://github.com/kirinnee/ferretry/issues/541)) ([e44a52f](https://github.com/kirinnee/ferretry/commit/e44a52fb1f36ec60ab5ff4ab61ce446e1bbaa7bc))

## [4.21.0](https://github.com/kirinnee/ferretry/compare/v4.20.1...v4.21.0) (2026-10-16)

### Features

* **pwa:** phone composer, type, slim switch, receipts and install prompt ([#539](https://github.com/kirinnee/ferretry/issues/539)) ([ecb2c5d](https://github.com/kirinnee/ferretry/commit/ecb2c5d19045236dc010cbfd1d30cc42bf9ab698)), closes [#507](https://github.com/kirinnee/ferretry/issues/507)

### Fixes

* **pwa:** stream the remote browser live view over the relay ([#540](https://github.com/kirinnee/ferretry/issues/540)) ([b10272a](https://github.com/kirinnee/ferretry/commit/b10272ad279ff4d8d15fff0e007af2bdb33f55d9))

## [4.20.1](https://github.com/kirinnee/ferretry/compare/v4.20.0...v4.20.1) (2026-10-16)

### Performance

* **relay:** take hosted metering off the frame path; quieter, snappier terminals ([#538](https://github.com/kirinnee/ferretry/issues/538)) ([62ddc92](https://github.com/kirinnee/ferretry/commit/62ddc9235665ae131fcde04e51af5ec59c8ad406))

## [4.20.0](https://github.com/kirinnee/ferretry/compare/v4.19.1...v4.20.0) (2026-10-16)

### Features

* **pwa:** group provider tiles and add a search to Add a login ([#536](https://github.com/kirinnee/ferretry/issues/536)) ([5004a5f](https://github.com/kirinnee/ferretry/commit/5004a5f6e5ba0387cac4951b70b6f5998380ca05))
* **pwa:** Parakeet on-device dictation beside phone/browser voice ([#535](https://github.com/kirinnee/ferretry/issues/535)) ([bdb2213](https://github.com/kirinnee/ferretry/commit/bdb22133788bfecd26544cdbfdc8fa392e8c1fcd))

### Fixes

* address agents by name everywhere and render peer messages as theirs ([#537](https://github.com/kirinnee/ferretry/issues/537)) ([020a369](https://github.com/kirinnee/ferretry/commit/020a36922601ef2549f9398d321a1bd9322e07f1))

## [4.19.1](https://github.com/kirinnee/ferretry/compare/v4.19.0...v4.19.1) (2026-10-16)

### Fixes

* **fleet:** stop Claude's one-shot auto-mode dialog from parking agents ([#534](https://github.com/kirinnee/ferretry/issues/534)) ([698e670](https://github.com/kirinnee/ferretry/commit/698e67021e1ccb6f8164d821753ff2063eca93d3))

## [4.19.0](https://github.com/kirinnee/ferretry/compare/v4.18.0...v4.19.0) (2026-10-16)

### Features

* **fleet:** one-click providers, auto-detect, and one login for both CLIs ([#533](https://github.com/kirinnee/ferretry/issues/533)) ([a79b434](https://github.com/kirinnee/ferretry/commit/a79b43416a9e3900ad74930fa0b3b0af2c29af2f))
* **pwa:** profiles as a bag of components (drag & drop + Resolved) ([#532](https://github.com/kirinnee/ferretry/issues/532)) ([9bd50ab](https://github.com/kirinnee/ferretry/commit/9bd50abf36c16722bab204aa427433f1d894e9c9))

## [4.18.0](https://github.com/kirinnee/ferretry/compare/v4.17.0...v4.18.0) (2026-10-16)

### Features

* **learning:** passive lessons, Global/Repo, Apply with diff, scan with estimate ([#529](https://github.com/kirinnee/ferretry/issues/529)) ([1ab2676](https://github.com/kirinnee/ferretry/commit/1ab267648da749f61e88593ca0cac845dd5746a2))

## [4.17.0](https://github.com/kirinnee/ferretry/compare/v4.16.0...v4.17.0) (2026-10-16)

### Features

* **usage:** provider quota adapters for environment logins ([#531](https://github.com/kirinnee/ferretry/issues/531)) ([dcd8ff7](https://github.com/kirinnee/ferretry/commit/dcd8ff711ce28a3f1cf7a580bc25b89cdd31624b))

## [4.16.0](https://github.com/kirinnee/ferretry/compare/v4.15.0...v4.16.0) (2026-10-16)

### Features

* **pwa:** Ask the Warden from Actions, and runtime pickers in Info › Runtime ([#530](https://github.com/kirinnee/ferretry/issues/530)) ([b9073c3](https://github.com/kirinnee/ferretry/commit/b9073c3449bbfd615ce142b12f39d94a85aef847))

## [4.15.0](https://github.com/kirinnee/ferretry/compare/v4.14.0...v4.15.0) (2026-10-16)

### Features

* **fleet:** environment logins and a built-in provider preset catalog ([#527](https://github.com/kirinnee/ferretry/issues/527)) ([dadddd5](https://github.com/kirinnee/ferretry/commit/dadddd5abe102a9e205a788eb302a791992e7592))

## [4.14.0](https://github.com/kirinnee/ferretry/compare/v4.13.0...v4.14.0) (2026-10-16)

### Features

* **pwa:** session header LOOK/DO — Info panel, Actions menu and Add MCP server ([#528](https://github.com/kirinnee/ferretry/issues/528)) ([bba1329](https://github.com/kirinnee/ferretry/commit/bba1329a8d678a7355ba64e7d58621db728efa60))

## [4.13.0](https://github.com/kirinnee/ferretry/compare/v4.12.1...v4.13.0) (2026-10-16)

### Features

* **warden:** Jev guard tier, spend caps, triggers, Needs-you feed, Warden page redesign ([#526](https://github.com/kirinnee/ferretry/issues/526)) ([5e2106e](https://github.com/kirinnee/ferretry/commit/5e2106e1bcbee93121b52118abf77290fa2d63fc))

## [4.12.1](https://github.com/kirinnee/ferretry/compare/v4.12.0...v4.12.1) (2026-10-16)

### Fixes

* **pwa:** compact runtime pickers — popover on desktop, sheet on phone ([#525](https://github.com/kirinnee/ferretry/issues/525)) ([6157960](https://github.com/kirinnee/ferretry/commit/61579603b47a70017f2d88d680c6dd01ac58ec2f))

## [4.12.0](https://github.com/kirinnee/ferretry/compare/v4.11.0...v4.12.0) (2026-10-16)

### Features

* **pwa:** This machine › Files — the configuration files and Edit as YAML ([#522](https://github.com/kirinnee/ferretry/issues/522)) ([993eeda](https://github.com/kirinnee/ferretry/commit/993eeda4446519fa7ed5d904896cb68bf7318506))

## [4.11.0](https://github.com/kirinnee/ferretry/compare/v4.10.1...v4.11.0) (2026-10-16)

### Features

* **config:** building blocks as human-editable YAML files ([#521](https://github.com/kirinnee/ferretry/issues/521)) ([94ceca6](https://github.com/kirinnee/ferretry/commit/94ceca6ccb9bedc8f8f2d5069bd90c31a0704149))

## [4.10.1](https://github.com/kirinnee/ferretry/compare/v4.10.0...v4.10.1) (2026-10-16)

### Fixes

* **pwa:** one phone title in the app bar, "Insights" for its views ([#524](https://github.com/kirinnee/ferretry/issues/524)) ([2fd5ccb](https://github.com/kirinnee/ferretry/commit/2fd5ccb79c19608ebcd25ef406a2843e56f32f2b)), closes [#519](https://github.com/kirinnee/ferretry/issues/519) [#520](https://github.com/kirinnee/ferretry/issues/520)

## [4.10.0](https://github.com/kirinnee/ferretry/compare/v4.9.1...v4.10.0) (2026-10-16)

### Features

* **pwa:** Insights shell, Analytics overview and session cost pane ([#520](https://github.com/kirinnee/ferretry/issues/520)) ([c28712b](https://github.com/kirinnee/ferretry/commit/c28712b608ced033818d4324052a7db22c916012))

## [4.9.1](https://github.com/kirinnee/ferretry/compare/v4.9.0...v4.9.1) (2026-10-16)

### Fixes

* **pwa:** fit the phone — keyboard-safe forms, one-line device notice, terminal keys, browser address ([#519](https://github.com/kirinnee/ferretry/issues/519)) ([43aaf4f](https://github.com/kirinnee/ferretry/commit/43aaf4f6360ba4feeef97f991e28cf6156c8df83)), closes [#509](https://github.com/kirinnee/ferretry/issues/509)

## [4.9.0](https://github.com/kirinnee/ferretry/compare/v4.8.0...v4.9.0) (2026-10-16)

### Features

* **pwa:** pair a phone from the machine menu and the finder ([#523](https://github.com/kirinnee/ferretry/issues/523)) ([aadabb5](https://github.com/kirinnee/ferretry/commit/aadabb5c6c2a10edecfdcc0d40556fbf5258af1f))

## [4.8.0](https://github.com/kirinnee/ferretry/compare/v4.7.0...v4.8.0) (2026-10-16)

### Features

* **daemon:** speed-up keys — Jev, Groq, Cerebras behind ports ([#514](https://github.com/kirinnee/ferretry/issues/514)) ([b431f1f](https://github.com/kirinnee/ferretry/commit/b431f1fba0bca8b99fbee0839793bba35b78c760))

### Fixes

* **pwa:** Add to chat leaves the caret after what it added in every editor ([#517](https://github.com/kirinnee/ferretry/issues/517)) ([fbb4785](https://github.com/kirinnee/ferretry/commit/fbb478545c6738e6e4ccb442b5011657caae6d17)), closes [#511](https://github.com/kirinnee/ferretry/issues/511)
* **pwa:** show a new session as Ready, with its launch runtime and real quota ([#510](https://github.com/kirinnee/ferretry/issues/510)) ([66617cb](https://github.com/kirinnee/ferretry/commit/66617cbb7fd654140ac447e78741d33148215103)), closes [#516](https://github.com/kirinnee/ferretry/issues/516)

## [4.7.0](https://github.com/kirinnee/ferretry/compare/v4.6.0...v4.7.0) (2026-10-16)

### Features

* **pwa:** quiet the chat transcript and follow the tail like kteam ([#512](https://github.com/kirinnee/ferretry/issues/512)) ([da53673](https://github.com/kirinnee/ferretry/commit/da536739a9ccef6dd369c97622bf1ae4ecb2bfec))

### Fixes

* **pwa:** say what failed on each leg when pairing cannot reach a machine ([#518](https://github.com/kirinnee/ferretry/issues/518)) ([44634e9](https://github.com/kirinnee/ferretry/commit/44634e9b2799dcda31aa366986cbe97554aeafce))
* **relay:** stop the hosted Worker crashing on every rendezvous upgrade ([#515](https://github.com/kirinnee/ferretry/issues/515)) ([cf4e64d](https://github.com/kirinnee/ferretry/commit/cf4e64dade259013cb05ecd774db19b219844414))

## [4.6.0](https://github.com/kirinnee/ferretry/compare/v4.5.1...v4.6.0) (2026-10-16)

### Features

* **pwa:** drive agent terminals and browser pages from the workspace ([#513](https://github.com/kirinnee/ferretry/issues/513)) ([336e06c](https://github.com/kirinnee/ferretry/commit/336e06c4ce5304c72c6aae15aab1c968867b2f53))

### Fixes

* **pwa:** composer formats as you type, real Vim keys, and two send buttons ([#511](https://github.com/kirinnee/ferretry/issues/511)) ([f5feeb8](https://github.com/kirinnee/ferretry/commit/f5feeb821083135ffb0b91188268910b484835cc))

## [4.5.1](https://github.com/kirinnee/ferretry/compare/v4.5.0...v4.5.1) (2026-10-16)

### Fixes

* **pwa:** align the session page's conversation, tabs, panes and sidebar ([#509](https://github.com/kirinnee/ferretry/issues/509)) ([3a5544e](https://github.com/kirinnee/ferretry/commit/3a5544e3a23100344fa41047435db24bf748d2ab))

## [4.5.0](https://github.com/kirinnee/ferretry/compare/v4.4.0...v4.5.0) (2026-10-16)

### Features

* **send:** prove where every send went, and retry only what is proven absent ([#507](https://github.com/kirinnee/ferretry/issues/507)) ([7242991](https://github.com/kirinnee/ferretry/commit/7242991fda424bb886b8f69b00f17897b101d973))

## [4.4.0](https://github.com/kirinnee/ferretry/compare/v4.3.0...v4.4.0) (2026-10-16)

### Features

* **cli:** Ferretry tools MCP server in every agent runtime ([#501](https://github.com/kirinnee/ferretry/issues/501)) ([0701b3c](https://github.com/kirinnee/ferretry/commit/0701b3c6712ce70d64664c5e09a2607057443f63))

## [4.3.0](https://github.com/kirinnee/ferretry/compare/v4.2.0...v4.3.0) (2026-10-16)

### Features

* **daemon:** drive terminals and browser pages by name, with takeover ([#500](https://github.com/kirinnee/ferretry/issues/500)) ([cbb13e5](https://github.com/kirinnee/ferretry/commit/cbb13e58a19e2624d8bb1a8597469d7155f0e93c))

## [4.2.0](https://github.com/kirinnee/ferretry/compare/v4.1.1...v4.2.0) (2026-10-16)

### Features

* **fleet:** machine-wide default runtime and agent control settings ([#504](https://github.com/kirinnee/ferretry/issues/504)) ([7161f59](https://github.com/kirinnee/ferretry/commit/7161f594c870276eb38b541d1c9d79620d6eda7b))
* **pwa:** rich text editor, recall a queued message, and sends that never interrupt ([#508](https://github.com/kirinnee/ferretry/issues/508)) ([f34323b](https://github.com/kirinnee/ferretry/commit/f34323be46dd79ac241bbf7ffd3cc5fe83f38d94))

## [4.1.1](https://github.com/kirinnee/ferretry/compare/v4.1.0...v4.1.1) (2026-10-16)

### Fixes

* **pwa:** monospace terminals, a typeable Console, a resizable sessions bar and a close-tab choice ([#506](https://github.com/kirinnee/ferretry/issues/506)) ([ae77e35](https://github.com/kirinnee/ferretry/commit/ae77e35589c01e696b8353af59a3808ea91bbc3c)), closes [#497](https://github.com/kirinnee/ferretry/issues/497)

## [4.1.0](https://github.com/kirinnee/ferretry/compare/v4.0.0...v4.1.0) (2026-10-16)

### Features

* **daemon:** auto-name every agent and serve session rename ([#497](https://github.com/kirinnee/ferretry/issues/497)) ([592cdc1](https://github.com/kirinnee/ferretry/commit/592cdc18db6db38b3022a05ad6493ba27c96dfc9))

## [4.0.0](https://github.com/kirinnee/ferretry/compare/v3.53.0...v4.0.0) (2026-10-16)

### ⚠ BREAKING CHANGES

* **notifications:** RegisterPushDeviceRequestSchema and PushDeviceViewSchema no
longer carry `prefs`; PushPreferencesSchema is removed from @ferretry/protocol.
A pre-existing push.json enrolment document holding the old `prefs` field
now fails to parse (StatePushRepository is a strict schema) and must be
re-enrolled.

* fix(notifications): tolerate version skew, apply the filter in the real push path

### Features

* **notifications:** every daemon sends every event, the client filters ([#503](https://github.com/kirinnee/ferretry/issues/503)) ([7a73b96](https://github.com/kirinnee/ferretry/commit/7a73b96778c651eb5c4de1ace7bab1ed44f251e4))
* **release:** ship the browser worker in every channel and find Chrome ([#495](https://github.com/kirinnee/ferretry/issues/495)) ([53dd087](https://github.com/kirinnee/ferretry/commit/53dd087115480cb6d6aa19d65618dafeafdb6682))

## [3.53.0](https://github.com/kirinnee/ferretry/compare/v3.52.0...v3.53.0) (2026-10-16)

### Features

* **pwa:** editor style, per-device send key, motion and conversation settings ([#505](https://github.com/kirinnee/ferretry/issues/505)) ([67f1bd7](https://github.com/kirinnee/ferretry/commit/67f1bd70e5581aed6acc249152ec46bf0eebaaa5))

## [3.52.0](https://github.com/kirinnee/ferretry/compare/v3.51.0...v3.52.0) (2026-10-16)

### Features

* **pwa:** split workspace on the session page — Console, terminals, browser, files, context rail ([#502](https://github.com/kirinnee/ferretry/issues/502)) ([0d56653](https://github.com/kirinnee/ferretry/commit/0d56653f83ff617f1bc1cda681176dd916558144))

## [3.51.0](https://github.com/kirinnee/ferretry/compare/v3.50.0...v3.51.0) (2026-10-16)

### Features

* **pwa:** clean conversation, live activity line and compact composer ([#499](https://github.com/kirinnee/ferretry/issues/499)) ([cca1e7a](https://github.com/kirinnee/ferretry/commit/cca1e7adb85068eef8689894e328750ec17be50b))

## [3.50.0](https://github.com/kirinnee/ferretry/compare/v3.49.0...v3.50.0) (2026-10-16)

### Features

* **pwa:** split-tree workspace with draggable tabs and resizable panes ([#496](https://github.com/kirinnee/ferretry/issues/496)) ([0853225](https://github.com/kirinnee/ferretry/commit/0853225df9a7af47a5616b4e566809390325ee44))

## [3.49.0](https://github.com/kirinnee/ferretry/compare/v3.48.0...v3.49.0) (2026-10-16)

### Features

* **pwa:** phone workspace — chip row, swipe, terminal key bar, context sheet ([#493](https://github.com/kirinnee/ferretry/issues/493)) ([f4325e3](https://github.com/kirinnee/ferretry/commit/f4325e36ad47e9317d55692713a9949e971e2fb3))
* **pwa:** sessions bar, compact session bar and Insights ([#498](https://github.com/kirinnee/ferretry/issues/498)) ([934ae1f](https://github.com/kirinnee/ferretry/commit/934ae1fb0ad85872784a17dadc9dd773fb9bd523))
* **pwa:** This folder context rail — signals, MCP, skills, docs ([#494](https://github.com/kirinnee/ferretry/issues/494)) ([045dd99](https://github.com/kirinnee/ferretry/commit/045dd9982b2ee239ef9aedb36ff66649bbd874ce)), closes [#491](https://github.com/kirinnee/ferretry/issues/491)

## [3.48.0](https://github.com/kirinnee/ferretry/compare/v3.47.0...v3.48.0) (2026-10-16)

### Features

* **fleet:** sign in to remote MCP servers from the PWA ([#491](https://github.com/kirinnee/ferretry/issues/491)) ([74c1a41](https://github.com/kirinnee/ferretry/commit/74c1a418a35f217e017f3014075af1cd82ff36c1))

## [3.47.0](https://github.com/kirinnee/ferretry/compare/v3.46.2...v3.47.0) (2026-10-16)

### Features

* **fleet:** derive a profile's harness scope and refuse mixing Claude and Codex ([#492](https://github.com/kirinnee/ferretry/issues/492)) ([a6969f7](https://github.com/kirinnee/ferretry/commit/a6969f767d8d96cc6aa9d6a3472919099ff6a11c))

## [3.46.2](https://github.com/kirinnee/ferretry/compare/v3.46.1...v3.46.2) (2026-10-16)

### Fixes

* **fleet:** pick up a running sign-in instead of dead-ending on it ([#490](https://github.com/kirinnee/ferretry/issues/490)) ([47d3646](https://github.com/kirinnee/ferretry/commit/47d36461f7d08f79cce241c12059b8c8991e989b))

## [3.46.1](https://github.com/kirinnee/ferretry/compare/v3.46.0...v3.46.1) (2026-10-15)

### Fixes

* **daemon:** name passkeys by device and machine ([#479](https://github.com/kirinnee/ferretry/issues/479)) ([26d5ca9](https://github.com/kirinnee/ferretry/commit/26d5ca9c56655ded6b43ee59a731bd90b02fe389))

## [3.46.0](https://github.com/kirinnee/ferretry/compare/v3.45.2...v3.46.0) (2026-10-15)

### Features

* **pwa:** one look per navigation level, and a full-screen machine setup ([#478](https://github.com/kirinnee/ferretry/issues/478)) ([42bc574](https://github.com/kirinnee/ferretry/commit/42bc574b40692e069d7bdb3c5054360f30649c0a)), closes [#daemons](https://github.com/kirinnee/ferretry/issues/daemons) [#security](https://github.com/kirinnee/ferretry/issues/security) [#daemons](https://github.com/kirinnee/ferretry/issues/daemons)

## [3.45.2](https://github.com/kirinnee/ferretry/compare/v3.45.1...v3.45.2) (2026-10-14)

### Fixes

* **fleet:** read a Claude login by the keychain pair Claude itself reads ([#477](https://github.com/kirinnee/ferretry/issues/477)) ([675c438](https://github.com/kirinnee/ferretry/commit/675c438e0e431ecefe401ba2867b665ae5a9a2f6)), closes [#401](https://github.com/kirinnee/ferretry/issues/401)

## [3.45.1](https://github.com/kirinnee/ferretry/compare/v3.45.0...v3.45.1) (2026-10-14)

### Fixes

* prompts from the machine on screen, version header, live theme, skew advice, release banner, test timings ([#475](https://github.com/kirinnee/ferretry/issues/475)) ([5b1d131](https://github.com/kirinnee/ferretry/commit/5b1d1317dd7a337ed908bf90e4e498f6d4e6df6e))

## [3.45.0](https://github.com/kirinnee/ferretry/compare/v3.44.0...v3.45.0) (2026-10-14)

### Features

* **daemon:** security audit log and new-device alerts ([#461](https://github.com/kirinnee/ferretry/issues/461)) ([c3318be](https://github.com/kirinnee/ferretry/commit/c3318bed3a96e9ddc874ed181925e5756371c6e8)), closes [#463](https://github.com/kirinnee/ferretry/issues/463)

## [3.44.0](https://github.com/kirinnee/ferretry/compare/v3.43.1...v3.44.0) (2026-10-14)

### Features

* **security:** harden against one compromised machine reaching the others ([#468](https://github.com/kirinnee/ferretry/issues/468)) ([324ec60](https://github.com/kirinnee/ferretry/commit/324ec607b46a990bb3769a1296d823231cdb95d6)), closes [#464](https://github.com/kirinnee/ferretry/issues/464)

## [3.43.1](https://github.com/kirinnee/ferretry/compare/v3.43.0...v3.43.1) (2026-10-14)

### Fixes

* e2e prep bugs — daemon discovery, dead lifecycle claims, worktree rm without tmux, machine names, start help ([#469](https://github.com/kirinnee/ferretry/issues/469)) ([0767a9b](https://github.com/kirinnee/ferretry/commit/0767a9bf7bba8c6e58ce5a784b334b156a6c247a))
* revoked devices told to pair again, re-pair, Codex login on shutdown, detached start, version skew, fresh passkey to add a device ([#470](https://github.com/kirinnee/ferretry/issues/470)) ([716ce4f](https://github.com/kirinnee/ferretry/commit/716ce4ff7f67b2f1696a211db76f49e6c2298d1a))

## [3.43.0](https://github.com/kirinnee/ferretry/compare/v3.42.0...v3.43.0) (2026-10-14)

### Features

* **zero-trust:** passkey unlock, least-privilege device grants, security settings, operator password deleted ([#464](https://github.com/kirinnee/ferretry/issues/464)) ([22ba0dc](https://github.com/kirinnee/ferretry/commit/22ba0dc7e5bd7795608549a081ea3400f9a6837d)), closes [#417](https://github.com/kirinnee/ferretry/issues/417) [#463](https://github.com/kirinnee/ferretry/issues/463) [#security](https://github.com/kirinnee/ferretry/issues/security)

## [3.42.0](https://github.com/kirinnee/ferretry/compare/v3.41.0...v3.42.0) (2026-10-13)

### Features

* **pwa:** sign PWA releases and verify them in the service worker ([#462](https://github.com/kirinnee/ferretry/issues/462)) ([c50783a](https://github.com/kirinnee/ferretry/commit/c50783a2675e4c770d86c22796e68df9b1846a4a))

## [3.41.0](https://github.com/kirinnee/ferretry/compare/v3.40.0...v3.41.0) (2026-10-13)

### Features

* **zero-trust:** device keys, mutual handshake, access lease and idle expiry ([#463](https://github.com/kirinnee/ferretry/issues/463)) ([a3bdf01](https://github.com/kirinnee/ferretry/commit/a3bdf01fec925544282682d9ba45fe6ef2886ec5)), closes [#417](https://github.com/kirinnee/ferretry/issues/417)

## [3.40.0](https://github.com/kirinnee/ferretry/compare/v3.39.0...v3.40.0) (2026-10-13)

### Features

* **fleet-login:** sign Codex in with a pasted link when device codes are off ([#459](https://github.com/kirinnee/ferretry/issues/459)) ([0ea4552](https://github.com/kirinnee/ferretry/commit/0ea45527feac3a664b5a4f99a20d68e5583b28f8))

## [3.39.0](https://github.com/kirinnee/ferretry/compare/v3.38.0...v3.39.0) (2026-10-13)

### Features

* **account:** first run asks, never auto-imports ([#460](https://github.com/kirinnee/ferretry/issues/460)) ([697ad60](https://github.com/kirinnee/ferretry/commit/697ad607e362045c2fe7d20f2e0cc1af846a1913))

## [3.38.0](https://github.com/kirinnee/ferretry/compare/v3.37.0...v3.38.0) (2026-10-13)

### Features

* **account:** retire the old account system and polish the Machines margins (U21) ([#458](https://github.com/kirinnee/ferretry/issues/458)) ([5e3e062](https://github.com/kirinnee/ferretry/commit/5e3e0622a75adaef19527b7c52aa7d0afe663bed))

## [3.37.0](https://github.com/kirinnee/ferretry/compare/v3.36.0...v3.37.0) (2026-10-13)

### Features

* **pwa:** Machines Settings tab, first run, Clone, install and migration entry (U19) ([#455](https://github.com/kirinnee/ferretry/issues/455)) ([aef4e62](https://github.com/kirinnee/ferretry/commit/aef4e62e33995ffdc80906d7a993f6e45f1938e9))

## [3.36.0](https://github.com/kirinnee/ferretry/compare/v3.35.0...v3.36.0) (2026-10-13)

### Features

* **pwa:** Runtimes and Credentials tabs, Add a runtime, Add a login (U17) ([#454](https://github.com/kirinnee/ferretry/issues/454)) ([7d1cef7](https://github.com/kirinnee/ferretry/commit/7d1cef751a90c5468687b2c1972f7f7b02fb3e4b))

## [3.35.0](https://github.com/kirinnee/ferretry/compare/v3.34.0...v3.35.0) (2026-10-13)

### Features

* **cli:** account-model commands — setup, machine, runtimes, credentials, profiles, components (U20) ([#456](https://github.com/kirinnee/ferretry/issues/456)) ([acc95d8](https://github.com/kirinnee/ferretry/commit/acc95d805149f670ae4e67023e6de83da149ae94))
* **pwa:** Profiles and Components tabs, Build a profile (U18) ([#453](https://github.com/kirinnee/ferretry/issues/453)) ([a9b6bfc](https://github.com/kirinnee/ferretry/commit/a9b6bfce4a1e8bac930dc400db18b87602476bc3))

## [3.34.0](https://github.com/kirinnee/ferretry/compare/v3.33.0...v3.34.0) (2026-10-13)

### Features

* **pwa:** one shared stage-then-apply for account-model changes ([#452](https://github.com/kirinnee/ferretry/issues/452)) ([56b6daa](https://github.com/kirinnee/ferretry/commit/56b6daa1b968b421968c4e80fa79d4c026df7bbe))

## [3.33.0](https://github.com/kirinnee/ferretry/compare/v3.32.0...v3.33.0) (2026-10-13)

### Features

* **fleet:** setup and clone routes, executors and their dial (U15) ([#451](https://github.com/kirinnee/ferretry/issues/451)) ([8c217d2](https://github.com/kirinnee/ferretry/commit/8c217d2fb43125080dd9abb26c8f042a26171708))

## [3.32.0](https://github.com/kirinnee/ferretry/compare/v3.31.0...v3.32.0) (2026-10-13)

### Features

* **pwa:** Machines shell beside the old Accounts panels (U16) ([#450](https://github.com/kirinnee/ferretry/issues/450)) ([48f8bb2](https://github.com/kirinnee/ferretry/commit/48f8bb26a705855978ca8c61b0993dd451126719))

## [3.31.0](https://github.com/kirinnee/ferretry/compare/v3.30.0...v3.31.0) (2026-10-13)

### Features

* **fleet:** account-model catalogue routes, reviewed changes and their dial (U14) ([#449](https://github.com/kirinnee/ferretry/issues/449)) ([9d2387e](https://github.com/kirinnee/ferretry/commit/9d2387efebd7ac9b7f94142430e6065fed2d64cb))

## [3.30.0](https://github.com/kirinnee/ferretry/compare/v3.29.0...v3.30.0) (2026-10-13)

### Features

* **daemon:** launch policy for account-model runtimes (U12) ([#448](https://github.com/kirinnee/ferretry/issues/448)) ([a507e67](https://github.com/kirinnee/ferretry/commit/a507e6786f38075d06fe525af05a1d26a695c14c))
* **fleet:** migrate version-1 installs to the account model (U9) ([#447](https://github.com/kirinnee/ferretry/issues/447)) ([bf31681](https://github.com/kirinnee/ferretry/commit/bf316819dfb3530a2007ecf9edb1f363b3b198f7))

## [3.29.0](https://github.com/kirinnee/ferretry/compare/v3.28.0...v3.29.0) (2026-10-13)

### Features

* **daemon:** credential routes, Check now and sign-in by credential (account model U13) ([#446](https://github.com/kirinnee/ferretry/issues/446)) ([080f397](https://github.com/kirinnee/ferretry/commit/080f397a148a3ce929d49e754069378e6766cd20))

## [3.28.0](https://github.com/kirinnee/ferretry/compare/v3.27.0...v3.28.0) (2026-10-13)

### Features

* **fleet:** materialise the account model and runtime wrappers (U6) ([#445](https://github.com/kirinnee/ferretry/issues/445)) ([2e9cc61](https://github.com/kirinnee/ferretry/commit/2e9cc619b7ab228055ce3dfcfadb0e5651f58cc2))

## [3.27.0](https://github.com/kirinnee/ferretry/compare/v3.26.0...v3.27.0) (2026-10-13)

### Features

* **fleet:** import scan for first run and Import again (account model U10) ([#444](https://github.com/kirinnee/ferretry/issues/444)) ([777f3f6](https://github.com/kirinnee/ferretry/commit/777f3f6f52de74ba8f2236c257a1c4cab9038893))

## [3.26.0](https://github.com/kirinnee/ferretry/compare/v3.25.0...v3.26.0) (2026-10-13)

### Features

* **fleet:** credential status and usage for the account model (U7) ([#441](https://github.com/kirinnee/ferretry/issues/441)) ([1306eb7](https://github.com/kirinnee/ferretry/commit/1306eb7221386933a52e1a70577c3c1ebf981b2b))

## [3.25.0](https://github.com/kirinnee/ferretry/compare/v3.24.0...v3.25.0) (2026-10-13)

### Features

* **fleet:** adapt generic components to each harness (account model U5) ([#443](https://github.com/kirinnee/ferretry/issues/443)) ([41a13df](https://github.com/kirinnee/ferretry/commit/41a13df66a8d34039c995a0ad7a317f2a0cd0275))

### Fixes

* **fleet:** keep Codex .system skills on apply; read v1 skills references ([#442](https://github.com/kirinnee/ferretry/issues/442)) ([6228c34](https://github.com/kirinnee/ferretry/commit/6228c347e668588fe1733f7df274c16138aa6323))

## [3.24.0](https://github.com/kirinnee/ferretry/compare/v3.23.0...v3.24.0) (2026-10-13)

### Features

* **fleet:** add profile layering and the agent fixed layer (account model U2) ([#439](https://github.com/kirinnee/ferretry/issues/439)) ([fb13a03](https://github.com/kirinnee/ferretry/commit/fb13a0374f0d9f7f00602f6cf77b46b75d82ccd7))
* **fleet:** resolve and share credential stores for the account model (U3) ([#438](https://github.com/kirinnee/ferretry/issues/438)) ([8208b8b](https://github.com/kirinnee/ferretry/commit/8208b8b61c0981418e563209a7b68b5f4dfe3c19))

## [3.23.0](https://github.com/kirinnee/ferretry/compare/v3.22.0...v3.23.0) (2026-10-13)

### Features

* **fleet:** add the version-2 account model schema and the version-1 converter ([#437](https://github.com/kirinnee/ferretry/issues/437)) ([c6bafc9](https://github.com/kirinnee/ferretry/commit/c6bafc9101a498f478a4429eb8162e482c88b7c4))

## [3.22.0](https://github.com/kirinnee/ferretry/compare/v3.21.0...v3.22.0) (2026-10-13)

### Features

* **daemon:** install a harness tool on explicit request (account model U11) ([#435](https://github.com/kirinnee/ferretry/issues/435)) ([7ca30bb](https://github.com/kirinnee/ferretry/commit/7ca30bb49a9d4e027bc6e25188017deb81ca815b))

## [3.21.0](https://github.com/kirinnee/ferretry/compare/v3.20.9...v3.21.0) (2026-10-13)

### Features

* **fleet:** seed every account-model module and its registration once ([#434](https://github.com/kirinnee/ferretry/issues/434)) ([0da0e22](https://github.com/kirinnee/ferretry/commit/0da0e22cd863b817e6062e648d7787509d3f1da0))

## [3.20.9](https://github.com/kirinnee/ferretry/compare/v3.20.8...v3.20.9) (2026-10-12)

### Fixes

* **cli:** derive the binary and daemon names in every hint ([#431](https://github.com/kirinnee/ferretry/issues/431)) ([fa43128](https://github.com/kirinnee/ferretry/commit/fa43128884a3acbbd415f418b884d5f8e1dd7957))
* **cli:** make daemon lifecycle verbs act only on this state home's daemon ([#429](https://github.com/kirinnee/ferretry/issues/429)) ([3ae40c6](https://github.com/kirinnee/ferretry/commit/3ae40c697c66f53a49c18ae2ad38ae77ea2a50b5))
* **daemon:** close two sign-in races and refuse clone transports that run commands ([#423](https://github.com/kirinnee/ferretry/issues/423)) ([f626376](https://github.com/kirinnee/ferretry/commit/f62637689d24f811197182899a2e37dac09e4a58)), closes [#launch](https://github.com/kirinnee/ferretry/issues/launch)
* **daemon:** expire unlocked attachments and give the attachment tree one owner ([#426](https://github.com/kirinnee/ferretry/issues/426)) ([623698c](https://github.com/kirinnee/ferretry/commit/623698c85fc9b6c4c75c69748d3165fa36f743ac))
* **daemon:** parse learning, browser-profile and login documents at the boundary ([#428](https://github.com/kirinnee/ferretry/issues/428)) ([ccde53e](https://github.com/kirinnee/ferretry/commit/ccde53e4cb890a84aef0b24f2648098c3c12d2ae))
* **daemon:** prove host arrival, charge password attempts first, mask cut secrets ([#427](https://github.com/kirinnee/ferretry/issues/427)) ([1aae585](https://github.com/kirinnee/ferretry/commit/1aae58598cd950d6b717d6c14983cc65efd6433e))
* **fleet:** never destroy, expose or write through a user's credential and config files ([#424](https://github.com/kirinnee/ferretry/issues/424)) ([8b179fc](https://github.com/kirinnee/ferretry/commit/8b179fc6944aee25fee4b79765c409889513ae1e))
* **pwa:** one status badge in plain words, a real browser command, no "teammate" role word ([#425](https://github.com/kirinnee/ferretry/issues/425)) ([2efcfc7](https://github.com/kirinnee/ferretry/commit/2efcfc77f9d64c6c9fd0051500cc9cf21c7adf19))
* **pwa:** route every daemon read through the carrier, and ban direct network calls ([#432](https://github.com/kirinnee/ferretry/issues/432)) ([37db54e](https://github.com/kirinnee/ferretry/commit/37db54ed04b032a14941795619807f78540f4cc9))
* **relay,daemon:** keep the relay link up across ended sessions and close a revoked device's sockets ([#430](https://github.com/kirinnee/ferretry/issues/430)) ([d22b04f](https://github.com/kirinnee/ferretry/commit/d22b04f3190aae0018dafe77b6714723ea610479))

## [3.20.8](https://github.com/kirinnee/ferretry/compare/v3.20.7...v3.20.8) (2026-09-26)

### Fixes

* **daemon:** settle a session whose agent exited instead of reading running forever ([#419](https://github.com/kirinnee/ferretry/issues/419)) ([ab18c63](https://github.com/kirinnee/ferretry/commit/ab18c63e7b13efb938784219b1afb985054eb289))

## [3.20.7](https://github.com/kirinnee/ferretry/compare/v3.20.6...v3.20.7) (2026-09-26)

### Fixes

* **pwa:** remove the carrier chooser from first-run onboarding ([#421](https://github.com/kirinnee/ferretry/issues/421)) ([8dbae38](https://github.com/kirinnee/ferretry/commit/8dbae38a7872946f2b1365d895d6711da50713f3))

## [3.20.6](https://github.com/kirinnee/ferretry/compare/v3.20.5...v3.20.6) (2026-09-26)

### Fixes

* **pwa:** name a session's account by its fleet name, not the wrapper id ([#420](https://github.com/kirinnee/ferretry/issues/420)) ([908cd38](https://github.com/kirinnee/ferretry/commit/908cd38ffcae1cd010887d1be9ba81b46124953c))

## [3.20.5](https://github.com/kirinnee/ferretry/compare/v3.20.4...v3.20.5) (2026-09-26)

### Fixes

* **pwa:** lead the account box with the fleet's name, not the wrapper id ([#418](https://github.com/kirinnee/ferretry/issues/418)) ([59dd66a](https://github.com/kirinnee/ferretry/commit/59dd66a08f7995c1520ef0d8ce92ff04cbbe3109))

## [3.20.4](https://github.com/kirinnee/ferretry/compare/v3.20.3...v3.20.4) (2026-09-26)

### Fixes

* **daemon:** look for harness logins under the HOME the CLI ran with ([#417](https://github.com/kirinnee/ferretry/issues/417)) ([a64914b](https://github.com/kirinnee/ferretry/commit/a64914b6a4f356b46857865e012c6be24fd6b43f))

## [3.20.3](https://github.com/kirinnee/ferretry/compare/v3.20.2...v3.20.3) (2026-09-26)

### Fixes

* **daemon:** start sessions on macOS, and smoke a real session on every target ([#416](https://github.com/kirinnee/ferretry/issues/416)) ([ee2d66a](https://github.com/kirinnee/ferretry/commit/ee2d66ab450afa24762b50f26a40253e7e943141))

## [3.20.2](https://github.com/kirinnee/ferretry/compare/v3.20.1...v3.20.2) (2026-09-26)

### Fixes

* **daemon:** start sessions under a daemon that has no UTF-8 locale ([#415](https://github.com/kirinnee/ferretry/issues/415)) ([ce5c92a](https://github.com/kirinnee/ferretry/commit/ce5c92a3dc73228369d8ef76888c6aa01abfcb37))
* **fleet:** show a first run's copied logins as ready, not four sign-ins ([#414](https://github.com/kirinnee/ferretry/issues/414)) ([f8eab50](https://github.com/kirinnee/ferretry/commit/f8eab50316abc290b934f3b81ab7ddf54fc955e0))
* **pwa:** make the New session form speak the product on a phone ([#413](https://github.com/kirinnee/ferretry/issues/413)) ([5093276](https://github.com/kirinnee/ferretry/commit/5093276279b481db1f6554c7051179c46080e6a4))

## [3.20.1](https://github.com/kirinnee/ferretry/compare/v3.20.0...v3.20.1) (2026-09-26)

### Fixes

* **cli:** tell a non-interactive first start how to set a password ([#407](https://github.com/kirinnee/ferretry/issues/407)) ([efa0d15](https://github.com/kirinnee/ferretry/commit/efa0d15e8ce3eb8f0be40bac7e23d405ba36d8cb))
* **daemon:** name the account that can run a session when the terminal one is asked for ([#409](https://github.com/kirinnee/ferretry/issues/409)) ([0cae62e](https://github.com/kirinnee/ferretry/commit/0cae62ed008cb36cb05a8e9a2caf2cfdb2d398c7))
* **fleet-login:** say when a sign-in code was rejected or expired ([#410](https://github.com/kirinnee/ferretry/issues/410)) ([8764f5b](https://github.com/kirinnee/ferretry/commit/8764f5bd55d1b1f33d40e3ff71904369fc769f5d))
* **pwa:** offer only accounts that can run a session in the New session picker ([#411](https://github.com/kirinnee/ferretry/issues/411)) ([b7b76ef](https://github.com/kirinnee/ferretry/commit/b7b76ef440c8b66452927c0a11c25e17eaef0417))

## [3.20.0](https://github.com/kirinnee/ferretry/compare/v3.19.1...v3.20.0) (2026-09-02)

### Features

* **pwa:** Accounts becomes a daemon panel, one level under Fleet ([#406](https://github.com/kirinnee/ferretry/issues/406)) ([b506d7b](https://github.com/kirinnee/ferretry/commit/b506d7b896382e20c5f6700ffc032f99212dd3de))

## [3.19.1](https://github.com/kirinnee/ferretry/compare/v3.19.0...v3.19.1) (2026-09-02)

### Fixes

* **pwa:** one word per concept, and say where the web login is ([#405](https://github.com/kirinnee/ferretry/issues/405)) ([c944c61](https://github.com/kirinnee/ferretry/commit/c944c616fae913526ff13ad1c47a8799dccf6ac9))

## [3.19.0](https://github.com/kirinnee/ferretry/compare/v3.18.0...v3.19.0) (2026-09-02)

### Features

* **fleet:** say when a credential is still this host's own copy ([#404](https://github.com/kirinnee/ferretry/issues/404)) ([96e9ff5](https://github.com/kirinnee/ferretry/commit/96e9ff59839a99d81050be372c986a7181240e19))

## [3.18.0](https://github.com/kirinnee/ferretry/compare/v3.17.6...v3.18.0) (2026-09-02)

### Features

* **fleet:** renew a credential that can renew itself, when somebody is there ([#403](https://github.com/kirinnee/ferretry/issues/403)) ([6bd0f1f](https://github.com/kirinnee/ferretry/commit/6bd0f1f419b677636e976ed398cfe0d9bda2a1ce))

## [3.17.6](https://github.com/kirinnee/ferretry/compare/v3.17.5...v3.17.6) (2026-09-02)

### Fixes

* **fleet:** print the renewal command beside an account that can renew itself ([#402](https://github.com/kirinnee/ferretry/issues/402)) ([49f7665](https://github.com/kirinnee/ferretry/commit/49f766598ff050ff748f64174731d4df21b7a179))

## [3.17.5](https://github.com/kirinnee/ferretry/compare/v3.17.4...v3.17.5) (2026-08-26)

### Fixes

* **fleet:** read the credential the harness actually wrote, and stop crediting a login that wrote nothing ([#401](https://github.com/kirinnee/ferretry/issues/401)) ([1e2b661](https://github.com/kirinnee/ferretry/commit/1e2b661f5b41fa283d0dfb8a54b7a6ebd712c351))

## [3.17.4](https://github.com/kirinnee/ferretry/compare/v3.17.3...v3.17.4) (2026-08-25)

### Fixes

* **fleet:** close OAuth evidence categories ([#400](https://github.com/kirinnee/ferretry/issues/400)) ([8b93b94](https://github.com/kirinnee/ferretry/commit/8b93b9471ef8b8c686da303a540823ef3b87535a))
* **fleet:** retain safe OAuth rejection evidence ([#399](https://github.com/kirinnee/ferretry/issues/399)) ([dc63fd1](https://github.com/kirinnee/ferretry/commit/dc63fd1f1766e3f71a2aad0ff1b3cf60e9945176))

## [3.17.3](https://github.com/kirinnee/ferretry/compare/v3.17.2...v3.17.3) (2026-08-25)

### Fixes

* **fleet:** let colour and layout do the triage in fy fleet health ([#398](https://github.com/kirinnee/ferretry/issues/398)) ([4153eb4](https://github.com/kirinnee/ferretry/commit/4153eb42606a77dfefc499c820111ffb2aa5814a))

## [3.17.2](https://github.com/kirinnee/ferretry/compare/v3.17.1...v3.17.2) (2026-08-25)

### Fixes

* **fleet:** keep refreshable credentials honest ([#397](https://github.com/kirinnee/ferretry/issues/397)) ([c4b43b3](https://github.com/kirinnee/ferretry/commit/c4b43b371d65784d7249f0a84024bf501e01590e))

## [3.17.1](https://github.com/kirinnee/ferretry/compare/v3.17.0...v3.17.1) (2026-08-25)

### Fixes

* **fleet:** an edit keeps the model you took out of service, and the reason ([#396](https://github.com/kirinnee/ferretry/issues/396)) ([15ceb00](https://github.com/kirinnee/ferretry/commit/15ceb001a024c08c2901602c020084d7ba396a72)), closes [#390](https://github.com/kirinnee/ferretry/issues/390)

## [3.17.0](https://github.com/kirinnee/ferretry/compare/v3.16.0...v3.17.0) (2026-08-25)

### Features

* **pwa:** settings compose — several stack into one, and you can see the order ([#395](https://github.com/kirinnee/ferretry/issues/395)) ([5877dd5](https://github.com/kirinnee/ferretry/commit/5877dd53a6e1217e787bb9e54a740eb5c83fed4c))

## [3.16.0](https://github.com/kirinnee/ferretry/compare/v3.15.1...v3.16.0) (2026-08-25)

### Features

* **pwa:** profiles on screen — pick one, stack several, or add a new one ([#394](https://github.com/kirinnee/ferretry/issues/394)) ([61594d8](https://github.com/kirinnee/ferretry/commit/61594d8155acff5c2a970b075975bdd6dae20bf3))

## [3.15.1](https://github.com/kirinnee/ferretry/compare/v3.15.0...v3.15.1) (2026-08-25)

### Fixes

* **pwa:** a gallery capture is the card it names, or it refuses ([#393](https://github.com/kirinnee/ferretry/issues/393)) ([91da38c](https://github.com/kirinnee/ferretry/commit/91da38c68caf01ea30e7bc4a8a5a14ef21c50046))

## [3.15.0](https://github.com/kirinnee/ferretry/compare/v3.14.0...v3.15.0) (2026-08-25)

### Features

* **pwa:** the Fleet screen says what each harness has, and which one answers by default ([#392](https://github.com/kirinnee/ferretry/issues/392)) ([52cb59d](https://github.com/kirinnee/ferretry/commit/52cb59d728fa2f964f5166b77358f2111974b86c))

## [3.14.0](https://github.com/kirinnee/ferretry/compare/v3.13.0...v3.14.0) (2026-08-25)

### Features

* **pwa:** every step asks the same question — pick what this fleet has, or add one ([#391](https://github.com/kirinnee/ferretry/issues/391)) ([c04520a](https://github.com/kirinnee/ferretry/commit/c04520a5876d1898581c642758db72339d0072b2))

## [3.13.0](https://github.com/kirinnee/ferretry/compare/v3.12.0...v3.13.0) (2026-08-25)

### Features

* **fleet:** an account serves the models it declares, and says why one is off ([#390](https://github.com/kirinnee/ferretry/issues/390)) ([f4967c8](https://github.com/kirinnee/ferretry/commit/f4967c8893e4a6e1d2aba0e83b5160fadb57c54a)), closes [#383](https://github.com/kirinnee/ferretry/issues/383)

## [3.12.0](https://github.com/kirinnee/ferretry/compare/v3.11.0...v3.12.0) (2026-08-25)

### Features

* **fleet:** a profile can authenticate an account instead of a login ([#389](https://github.com/kirinnee/ferretry/issues/389)) ([b1683f9](https://github.com/kirinnee/ferretry/commit/b1683f9c1e15e41bd9aec343ce663544ad82a425))

## [3.11.0](https://github.com/kirinnee/ferretry/compare/v3.10.0...v3.11.0) (2026-08-25)

### Features

* **pwa:** accounts as a place — every account, its verdict, and when it was last checked ([#388](https://github.com/kirinnee/ferretry/issues/388)) ([426aa5d](https://github.com/kirinnee/ferretry/commit/426aa5d04c78bf9cbce68f0bfe0f635dabc361f4))

## [3.10.0](https://github.com/kirinnee/ferretry/compare/v3.9.1...v3.10.0) (2026-08-25)

### Features

* **fleet:** shared assets are one file, not two equal copies ([#387](https://github.com/kirinnee/ferretry/issues/387)) ([063cd8b](https://github.com/kirinnee/ferretry/commit/063cd8bf972f45ce49b521b3c0f8e434ff7e05a5))

## [3.9.1](https://github.com/kirinnee/ferretry/compare/v3.9.0...v3.9.1) (2026-08-25)

### Fixes

* **fleet:** a usage row names the account, not its uuid ([#386](https://github.com/kirinnee/ferretry/issues/386)) ([dc02751](https://github.com/kirinnee/ferretry/commit/dc027513e91a366495025f9748a23cb624630fd0))

## [3.9.0](https://github.com/kirinnee/ferretry/compare/v3.8.1...v3.9.0) (2026-08-25)

### Features

* **fleet:** seed default accounts from this host's own harness login ([#385](https://github.com/kirinnee/ferretry/issues/385)) ([4ad582c](https://github.com/kirinnee/ferretry/commit/4ad582cdc664b9d51d0a8d556589bbef0cec26ff))

### Fixes

* **fleet:** the four complaints the audit left standing ([#384](https://github.com/kirinnee/ferretry/issues/384)) ([0053ca2](https://github.com/kirinnee/ferretry/commit/0053ca2ee61f45ee42096eae18757f167056777b))

## [3.8.1](https://github.com/kirinnee/ferretry/compare/v3.8.0...v3.8.1) (2026-08-24)

### Fixes

* **fleet:** the account you sign in is the account that gets signed in ([#383](https://github.com/kirinnee/ferretry/issues/383)) ([04e6b86](https://github.com/kirinnee/ferretry/commit/04e6b863359ba23aee1e311122842b6a170a5ecb))

## [3.8.0](https://github.com/kirinnee/ferretry/compare/v3.7.0...v3.8.0) (2026-08-24)

### Features

* **fleet:** the Fleet screen says whether each account is signed in ([#380](https://github.com/kirinnee/ferretry/issues/380)) ([bd5d9eb](https://github.com/kirinnee/ferretry/commit/bd5d9eb741168023927f511d1bde2509ccd01240))

## [3.7.0](https://github.com/kirinnee/ferretry/compare/v3.6.2...v3.7.0) (2026-08-24)

### Features

* **fleet:** every account says whether it is signed in, and when that was last checked ([#379](https://github.com/kirinnee/ferretry/issues/379)) ([457fb3e](https://github.com/kirinnee/ferretry/commit/457fb3e6f93490f98fadcdd49959230ebbdeaecf)), closes [#378](https://github.com/kirinnee/ferretry/issues/378)

## [3.6.2](https://github.com/kirinnee/ferretry/compare/v3.6.1...v3.6.2) (2026-08-24)

### Fixes

* **pwa:** a live event feed that died stayed dead, and the page kept looking live ([#381](https://github.com/kirinnee/ferretry/issues/381)) ([2d961d7](https://github.com/kirinnee/ferretry/commit/2d961d70ad77bcdfea434157d5f81a97bbc7e111))

## [3.6.1](https://github.com/kirinnee/ferretry/compare/v3.6.0...v3.6.1) (2026-08-24)

### Fixes

* the daemon was billing your own fleet accounts on a timer, and no longer can ([#378](https://github.com/kirinnee/ferretry/issues/378)) ([646596a](https://github.com/kirinnee/ferretry/commit/646596a761a01fa9adfe72e68d06abfd3472bce8))

## [3.6.0](https://github.com/kirinnee/ferretry/compare/v3.5.0...v3.6.0) (2026-08-24)

### Features

* **fleet:** make a detected harness usable the moment the daemon starts ([#377](https://github.com/kirinnee/ferretry/issues/377)) ([b5c27f4](https://github.com/kirinnee/ferretry/commit/b5c27f4b7227c5c580ef3937141e79e7cf478c11))

## [3.5.0](https://github.com/kirinnee/ferretry/compare/v3.4.0...v3.5.0) (2026-08-19)

### Features

* **daemon:** drive each harness's own sign-in from a browser, holding no token ([#376](https://github.com/kirinnee/ferretry/issues/376)) ([63a7002](https://github.com/kirinnee/ferretry/commit/63a7002ff0fc10142a37892cf16e82f56f6931e8)), closes [#375](https://github.com/kirinnee/ferretry/issues/375)

## [3.4.0](https://github.com/kirinnee/ferretry/compare/v3.3.0...v3.4.0) (2026-08-19)

### Features

* **fleet:** renew an expired token without asking anybody ([#375](https://github.com/kirinnee/ferretry/issues/375)) ([912d48c](https://github.com/kirinnee/ferretry/commit/912d48c7fee9cfe321371827193e304f688f67ff))

## [3.3.0](https://github.com/kirinnee/ferretry/compare/v3.2.0...v3.3.0) (2026-08-19)

### Features

* **pwa:** ask one question at a time to add a fleet account ([#374](https://github.com/kirinnee/ferretry/issues/374)) ([6b45025](https://github.com/kirinnee/ferretry/commit/6b450253042de156ada355e8cdbf9fbbab7b9497))

## [3.2.0](https://github.com/kirinnee/ferretry/compare/v3.1.2...v3.2.0) (2026-08-19)

### Features

* **fleet:** select shared skills per item ([#373](https://github.com/kirinnee/ferretry/issues/373)) ([b7bba5e](https://github.com/kirinnee/ferretry/commit/b7bba5e8b09f0faa7b21585e6a10eff7a5ed6b1e))

## [3.1.2](https://github.com/kirinnee/ferretry/compare/v3.1.1...v3.1.2) (2026-08-19)

### Fixes

* **pwa:** ask the browser whether it is blocking the local network, instead of asserting the daemon is gone ([#371](https://github.com/kirinnee/ferretry/issues/371)) ([6f57801](https://github.com/kirinnee/ferretry/commit/6f578014bdf27ab1bf08949215a13ce80ae1c312)), closes [#370](https://github.com/kirinnee/ferretry/issues/370) [#370](https://github.com/kirinnee/ferretry/issues/370)

## [3.1.1](https://github.com/kirinnee/ferretry/compare/v3.1.0...v3.1.1) (2026-08-19)

### Fixes

* **pwa:** stop the Fleet panel asking for a password it cannot check, and drop the first-run ceremony ([#370](https://github.com/kirinnee/ferretry/issues/370)) ([803e30d](https://github.com/kirinnee/ferretry/commit/803e30df3c080d8325778d0ae5b6146f9a274847)), closes [#369](https://github.com/kirinnee/ferretry/issues/369)

## [3.1.0](https://github.com/kirinnee/ferretry/compare/v3.0.1...v3.1.0) (2026-08-19)

### Features

* **contracts:** gate the transport CORS allowlist against its clients ([#369](https://github.com/kirinnee/ferretry/issues/369)) ([ce4a443](https://github.com/kirinnee/ferretry/commit/ce4a443031910aa721addc860fb9efb1daeeb57e))

## [3.0.1](https://github.com/kirinnee/ferretry/compare/v3.0.0...v3.0.1) (2026-08-19)

### Fixes

* **daemon:** admit the operator unlock header on a CORS preflight ([#368](https://github.com/kirinnee/ferretry/issues/368)) ([5d7420e](https://github.com/kirinnee/ferretry/commit/5d7420e7863af101bbf77556bfdec21366b3c66c))

## [3.0.0](https://github.com/kirinnee/ferretry/compare/v2.1.0...v3.0.0) (2026-08-19)

### ⚠ BREAKING CHANGES

* **grants:** `fy daemon password clear` no longer exists, and
`PUT /v1/grants/password` no longer reads an absent `password` as a request to
remove one; such a body is now refused as invalid. Setting an operator password
is one-way. Replace a forgotten password with `fy daemon password set`, which
never asks for the old one.

### Features

* **grants:** remove the verb that removed the operator password ([#363](https://github.com/kirinnee/ferretry/issues/363)) ([79ddf16](https://github.com/kirinnee/ferretry/commit/79ddf16e5eefb2a5487b0e737d04e26ff42ab598))

## [2.1.0](https://github.com/kirinnee/ferretry/compare/v2.0.0...v2.1.0) (2026-08-19)

### Features

* **cli:** remove both roots of an installation with one verb ([#364](https://github.com/kirinnee/ferretry/issues/364)) ([c0cda74](https://github.com/kirinnee/ferretry/commit/c0cda74b83cb1f1a8b007cdcb5e0b8c3ceefb6b9))

## [2.0.0](https://github.com/kirinnee/ferretry/compare/v1.0.0...v2.0.0) (2026-08-19)

### ⚠ BREAKING CHANGES

* **fleet:** `POST /v1/fleet/proposals/:proposalId/authorize` and the
`fy fleet authorize` verb are removed. `FleetPermissions` is now
`{ mayInspect, mayPropose, mayApply, applyRefusal, confirmation }`; the proposal
apply request carries `operatorPassword` instead of `approvalCode`; the proposal
view no longer has an `approval` field; and `@ferretry/protocol` no longer exports
anything from `fleet-authorization.ts`.

Refs: docs/design/fleet-authority-unification.md §9

### Features

* **fleet:** govern the fleet by the capability model ([#362](https://github.com/kirinnee/ferretry/issues/362)) ([1940522](https://github.com/kirinnee/ferretry/commit/19405223865c08574e378593157af17a232f3b8e)), closes [#358](https://github.com/kirinnee/ferretry/issues/358)

## [1.0.0](https://github.com/kirinnee/ferretry/compare/v0.180.0...v1.0.0) (2026-08-19)

### ⚠ BREAKING CHANGES

* **cli:** `fy daemon snapshot build|list|promote` are removed. What
runs is the installed daemon; upgrading is your package manager's job and
`fy daemon restart` picks it up. `fy daemon which` no longer reports a
`promoted` identity, and its --json payload no longer carries that key.

### Features

* **cli:** run the daemon this host installed, not a snapshot of it ([#361](https://github.com/kirinnee/ferretry/issues/361)) ([7db6564](https://github.com/kirinnee/ferretry/commit/7db656428997e6c44ee21f7dddf536e0b91be35e))

### Fixes

* **pwa:** make the settings screen look designed ([#360](https://github.com/kirinnee/ferretry/issues/360)) ([c76cf0f](https://github.com/kirinnee/ferretry/commit/c76cf0ffd1c88492d943f6745c06e8da0a6e8761))

## [0.180.0](https://github.com/kirinnee/ferretry/compare/v0.179.0...v0.180.0) (2026-08-18)

### Features

* **grants:** gate a local browser behind the operator password ([#358](https://github.com/kirinnee/ferretry/issues/358)) ([727cb7f](https://github.com/kirinnee/ferretry/commit/727cb7f13153a24a3fc573837d0f327720cf48e0))

## [0.179.0](https://github.com/kirinnee/ferretry/compare/v0.178.0...v0.179.0) (2026-08-18)

### Features

* **fleet:** declare and switch the documents a fleet shares ([#357](https://github.com/kirinnee/ferretry/issues/357)) ([5a08a0f](https://github.com/kirinnee/ferretry/commit/5a08a0f87bb4822f8440642fa4adef486fedd1da)), closes [#356](https://github.com/kirinnee/ferretry/issues/356)

## [0.178.0](https://github.com/kirinnee/ferretry/compare/v0.177.1...v0.178.0) (2026-08-18)

### Features

* **fleet:** fill the new-account form from what the host already knows ([#356](https://github.com/kirinnee/ferretry/issues/356)) ([03d07b2](https://github.com/kirinnee/ferretry/commit/03d07b2f7295b5f46a9e78c29111a98d17164ce0)), closes [#355](https://github.com/kirinnee/ferretry/issues/355)

## [0.177.1](https://github.com/kirinnee/ferretry/compare/v0.177.0...v0.177.1) (2026-08-18)

### Fixes

* **pwa:** prevent unit network pollution ([#354](https://github.com/kirinnee/ferretry/issues/354)) ([1cbc299](https://github.com/kirinnee/ferretry/commit/1cbc29975d287d0b839e530ccc672c4360229664))
* **pwa:** retry the fy-render sandbox handshake ([#352](https://github.com/kirinnee/ferretry/issues/352)) ([d82a44e](https://github.com/kirinnee/ferretry/commit/d82a44eb81b1310bef8aeacbac64f9b164bfd156))

## [0.177.0](https://github.com/kirinnee/ferretry/compare/v0.176.0...v0.177.0) (2026-08-18)

### Features

* **daemon:** let an operator say where the harnesses are ([#359](https://github.com/kirinnee/ferretry/issues/359)) ([0a9b184](https://github.com/kirinnee/ferretry/commit/0a9b184b94f252662cd375a1ccf7cd95611e1ad6))

## [0.176.0](https://github.com/kirinnee/ferretry/compare/v0.175.4...v0.176.0) (2026-08-14)

### Features

* **daemon:** fork a conversation from any durable message ([#350](https://github.com/kirinnee/ferretry/issues/350)) ([43a3370](https://github.com/kirinnee/ferretry/commit/43a3370477626d29e09a87540fdf36f9a20a1f32))

## [0.175.4](https://github.com/kirinnee/ferretry/compare/v0.175.3...v0.175.4) (2026-08-14)

### Fixes

* **cli:** refresh stale daemon snapshots on start ([#351](https://github.com/kirinnee/ferretry/issues/351)) ([06a0b88](https://github.com/kirinnee/ferretry/commit/06a0b8829a5c327ee31c65f18285e7ea1b731b4b))

## [0.175.3](https://github.com/kirinnee/ferretry/compare/v0.175.2...v0.175.3) (2026-08-10)

### Fixes

* **pwa:** render mermaid and lottie as trusted data in an opaque sandbox ([#349](https://github.com/kirinnee/ferretry/issues/349)) ([cd72e6f](https://github.com/kirinnee/ferretry/commit/cd72e6f1b2373876a771d5a880c4baccf4e0c916))

## [0.175.2](https://github.com/kirinnee/ferretry/compare/v0.175.1...v0.175.2) (2026-08-10)

### Performance

* **pwa:** complete bounded current-session search ([#331](https://github.com/kirinnee/ferretry/issues/331) recovered) ([#348](https://github.com/kirinnee/ferretry/issues/348)) ([abf83af](https://github.com/kirinnee/ferretry/commit/abf83afdf55f70b71270e09023b7d8b6c8fc4778))

## [0.175.1](https://github.com/kirinnee/ferretry/compare/v0.175.0...v0.175.1) (2026-08-10)

### Fixes

* **daemon:** enforce locality for public privileged routes ([#347](https://github.com/kirinnee/ferretry/issues/347)) ([33eef7f](https://github.com/kirinnee/ferretry/commit/33eef7f2802c6af5064dd2851f913a7b27b02b19))

## [0.175.0](https://github.com/kirinnee/ferretry/compare/v0.174.0...v0.175.0) (2026-08-10)

### Features

* **worktrees:** managed worktree lifecycle (recovered) ([#338](https://github.com/kirinnee/ferretry/issues/338)) ([641a5aa](https://github.com/kirinnee/ferretry/commit/641a5aae0849117cd2a5f981e22129887c67eb9f))

## [0.174.0](https://github.com/kirinnee/ferretry/compare/v0.173.1...v0.174.0) (2026-08-10)

### Features

* **analytics:** configurable model pricing (recovered) ([#337](https://github.com/kirinnee/ferretry/issues/337)) ([cc7980b](https://github.com/kirinnee/ferretry/commit/cc7980b34209abe5df9de62bc2eeac9e018eb1f3))

## [0.173.1](https://github.com/kirinnee/ferretry/compare/v0.173.0...v0.173.1) (2026-08-10)

### Fixes

* **daemon:** preserve structured answer recovery ([#329](https://github.com/kirinnee/ferretry/issues/329), recovered) ([#346](https://github.com/kirinnee/ferretry/issues/346)) ([3271861](https://github.com/kirinnee/ferretry/commit/32718617f556e61ae3c8658347d8a6b2f566e039)), closes [#326](https://github.com/kirinnee/ferretry/issues/326) [#20](https://github.com/kirinnee/ferretry/issues/20)

## [0.173.0](https://github.com/kirinnee/ferretry/compare/v0.172.1...v0.173.0) (2026-08-10)

### Features

* **daemon:** agent-callable notifications ([#332](https://github.com/kirinnee/ferretry/issues/332)) ([a7f2805](https://github.com/kirinnee/ferretry/commit/a7f28054d8f849a2955c2d8a4140ef19cf58311c))

## [0.172.1](https://github.com/kirinnee/ferretry/compare/v0.172.0...v0.172.1) (2026-08-10)

### Fixes

* **catalog:** refuse relative project paths at the protocol boundary ([#342](https://github.com/kirinnee/ferretry/issues/342)) ([25d5509](https://github.com/kirinnee/ferretry/commit/25d5509a31c2d0cd43f0348f0fa8498336abf2ba))

## [0.172.0](https://github.com/kirinnee/ferretry/compare/v0.171.0...v0.172.0) (2026-08-10)

### Features

* **pwa:** add project detail core (#F116, recovered) ([#345](https://github.com/kirinnee/ferretry/issues/345)) ([9cc88e8](https://github.com/kirinnee/ferretry/commit/9cc88e886bcdca6553f6453326b8fb988245bf16)), closes [#F116](https://github.com/kirinnee/ferretry/issues/F116) [#F116](https://github.com/kirinnee/ferretry/issues/F116)

## [0.171.0](https://github.com/kirinnee/ferretry/compare/v0.170.0...v0.171.0) (2026-08-10)

### Features

* complete composer backlog rows 33, 39, and 49 ([#326](https://github.com/kirinnee/ferretry/issues/326)) ([7b9ce37](https://github.com/kirinnee/ferretry/commit/7b9ce379b12cab7e4442e91ab608b841868ff85e)), closes [#39](https://github.com/kirinnee/ferretry/issues/39) [#63](https://github.com/kirinnee/ferretry/issues/63)
* enforce closed schema maps ([#343](https://github.com/kirinnee/ferretry/issues/343)) ([9af5108](https://github.com/kirinnee/ferretry/commit/9af5108b371a68e8581841172ee0e86d81c0d4ee))
* **pwa:** complete the filesystem surface ([#333](https://github.com/kirinnee/ferretry/issues/333)) ([659cc2f](https://github.com/kirinnee/ferretry/commit/659cc2f908cb04fac215b531a8d282758f1660ea)), closes [#37](https://github.com/kirinnee/ferretry/issues/37) [#62](https://github.com/kirinnee/ferretry/issues/62)

## [0.170.0](https://github.com/kirinnee/ferretry/compare/v0.169.0...v0.170.0) (2026-08-10)

### Features

* **daemon:** deliver the replacement-start half of cross-harness handover ([#48](https://github.com/kirinnee/ferretry/issues/48), recovered) ([#341](https://github.com/kirinnee/ferretry/issues/341)) ([1b1b8cb](https://github.com/kirinnee/ferretry/commit/1b1b8cb984043b4aa1f85f954c528e471ebd0e06))

### Fixes

* **attention:** stop the Attention sheet answering the wrong item (recovered row-40 follow-ups) ([#340](https://github.com/kirinnee/ferretry/issues/340)) ([fbc83f3](https://github.com/kirinnee/ferretry/commit/fbc83f39b08b0325e4d9871efba30d794055126d)), closes [#336](https://github.com/kirinnee/ferretry/issues/336) [#336](https://github.com/kirinnee/ferretry/issues/336) [#335](https://github.com/kirinnee/ferretry/issues/335) [#336](https://github.com/kirinnee/ferretry/issues/336)

## [0.169.0](https://github.com/kirinnee/ferretry/compare/v0.168.0...v0.169.0) (2026-08-10)

### Features

* **pwa:** register projects from the browser ([#69](https://github.com/kirinnee/ferretry/issues/69)) ([#339](https://github.com/kirinnee/ferretry/issues/339)) ([5e43048](https://github.com/kirinnee/ferretry/commit/5e43048a3de366aead51fb252e69a37b43b86789))

## [0.168.0](https://github.com/kirinnee/ferretry/compare/v0.167.0...v0.168.0) (2026-08-10)

### Features

* **search:** complete bounded current-session search ([#322](https://github.com/kirinnee/ferretry/issues/322)) ([9d7db2b](https://github.com/kirinnee/ferretry/commit/9d7db2b72444793b07b2ef9c26166137601c26ae))

## [0.167.0](https://github.com/kirinnee/ferretry/compare/v0.166.0...v0.167.0) (2026-08-09)

### Features

* **attention:** add lifecycle action surfaces ([#336](https://github.com/kirinnee/ferretry/issues/336)) ([3b1fdaf](https://github.com/kirinnee/ferretry/commit/3b1fdafad27200aa19b15800d9f6cbe92630ee5c))
* **daemon:** mount session browser runtime ([#316](https://github.com/kirinnee/ferretry/issues/316)) ([d359fea](https://github.com/kirinnee/ferretry/commit/d359fead9f61a6a8b1443eafc0a849edf7be3d78))

## [0.166.0](https://github.com/kirinnee/ferretry/compare/v0.165.0...v0.166.0) (2026-08-09)

### Features

* add fleet cgroup controls ([#324](https://github.com/kirinnee/ferretry/issues/324)) ([357c478](https://github.com/kirinnee/ferretry/commit/357c47893ff7ab9f0c6fad2fa05523d33978567c))
* **pwa:** add bounded fy-render illustrations ([#327](https://github.com/kirinnee/ferretry/issues/327)) ([86dcbc8](https://github.com/kirinnee/ferretry/commit/86dcbc89742c923df0a8e4a7c87ef209518a3b27)), closes [#65](https://github.com/kirinnee/ferretry/issues/65) [#65](https://github.com/kirinnee/ferretry/issues/65) [#65](https://github.com/kirinnee/ferretry/issues/65) [#65](https://github.com/kirinnee/ferretry/issues/65) [#65](https://github.com/kirinnee/ferretry/issues/65) [#id](https://github.com/kirinnee/ferretry/issues/id)

### Fixes

* **tasks:** preserve completion provenance ([#330](https://github.com/kirinnee/ferretry/issues/330)) ([266ca32](https://github.com/kirinnee/ferretry/commit/266ca32bf26594ab334f727e9c1b2ef27cc90406))

## [0.165.0](https://github.com/kirinnee/ferretry/compare/v0.164.0...v0.165.0) (2026-08-07)

### Features

* **cli:** run the daemon from stable snapshots with per-snapshot GC roots and serialized lifecycle ([#323](https://github.com/kirinnee/ferretry/issues/323)) ([20cf7f8](https://github.com/kirinnee/ferretry/commit/20cf7f822affd487c04a3d7c39dfadf460b81ad6))
* **relay:** pair and stream across the relay, so a phone works from anywhere ([#325](https://github.com/kirinnee/ferretry/issues/325)) ([a3ad0e4](https://github.com/kirinnee/ferretry/commit/a3ad0e4271dd10beb0565b0c1a9e99010edfb73e)), closes [#v1](https://github.com/kirinnee/ferretry/issues/v1) [#v2](https://github.com/kirinnee/ferretry/issues/v2) [#v1](https://github.com/kirinnee/ferretry/issues/v1) [#v1](https://github.com/kirinnee/ferretry/issues/v1)

### Fixes

* **pwa:** harden current-session search interaction ([#321](https://github.com/kirinnee/ferretry/issues/321)) ([fa346ae](https://github.com/kirinnee/ferretry/commit/fa346ae52a58a845505d27245ac32cfa6d06eb7f))

## [0.164.0](https://github.com/kirinnee/ferretry/compare/v0.163.0...v0.164.0) (2026-08-06)

### Features

* **daemon:** authorize warden remedies at the route spine ([#315](https://github.com/kirinnee/ferretry/issues/315)) ([26754ce](https://github.com/kirinnee/ferretry/commit/26754ceeb27564b3c098833e51006b779107275c))
* **protocol:** add board task aggregate contract ([#320](https://github.com/kirinnee/ferretry/issues/320)) ([11b889e](https://github.com/kirinnee/ferretry/commit/11b889e722b3b652f442226bd708338627eda1d7))
* **pwa:** add global destination finder ([#318](https://github.com/kirinnee/ferretry/issues/318)) ([4389fa6](https://github.com/kirinnee/ferretry/commit/4389fa6d1390f753d7c053ce76c6cff3c199672f))

### Fixes

* **pwa:** key the access legend from the weights on screen ([#317](https://github.com/kirinnee/ferretry/issues/317)) ([7fe4806](https://github.com/kirinnee/ferretry/commit/7fe48066a301f1e143cc9825ff6dfeaad95a9bd6))
* **tasks:** bound fleet task-board reads ([#319](https://github.com/kirinnee/ferretry/issues/319)) ([fffbcda](https://github.com/kirinnee/ferretry/commit/fffbcdab5947e0372e5b4b38290a6f1c969c8579)), closes [#5](https://github.com/kirinnee/ferretry/issues/5)

## [0.163.0](https://github.com/kirinnee/ferretry/compare/v0.162.2...v0.163.0) (2026-08-06)

### Features

* **pwa:** tree-board and Skills reference actions ([#43](https://github.com/kirinnee/ferretry/issues/43)) ([#311](https://github.com/kirinnee/ferretry/issues/311)) ([df9d953](https://github.com/kirinnee/ferretry/commit/df9d9534c105b4479ea8b5644181d3145114ea11)), closes [#35](https://github.com/kirinnee/ferretry/issues/35)

## [0.162.2](https://github.com/kirinnee/ferretry/compare/v0.162.1...v0.162.2) (2026-08-06)

### Fixes

* **daemon:** govern remote project registration ([#313](https://github.com/kirinnee/ferretry/issues/313)) ([e0a1e72](https://github.com/kirinnee/ferretry/commit/e0a1e72f6f44a6e9cb8daa14b58bcca7b5804788))
* **relay:** compile one hosted directory default ([#312](https://github.com/kirinnee/ferretry/issues/312)) ([d436aa9](https://github.com/kirinnee/ferretry/commit/d436aa9e26710312f249f66510161c15cac77666))

## [0.162.1](https://github.com/kirinnee/ferretry/compare/v0.162.0...v0.162.1) (2026-08-06)

### Fixes

* **nix:** install git hooks reliably across linked worktrees ([#314](https://github.com/kirinnee/ferretry/issues/314)) ([27021e8](https://github.com/kirinnee/ferretry/commit/27021e8c477d9cc9a34f27615a28d0b08feef024)), closes [#283](https://github.com/kirinnee/ferretry/issues/283)

## [0.162.0](https://github.com/kirinnee/ferretry/compare/v0.161.0...v0.162.0) (2026-08-06)

### Features

* **daemon:** serve web push enrolment and a per-daemon VAPID key ([#302](https://github.com/kirinnee/ferretry/issues/302)) ([ee36220](https://github.com/kirinnee/ferretry/commit/ee362203f5381a1dcaf9383eb529f045dcbf20ec))

## [0.161.0](https://github.com/kirinnee/ferretry/compare/v0.160.4...v0.161.0) (2026-08-06)

### Features

* **validate:** add Wave A drift gates ([#308](https://github.com/kirinnee/ferretry/issues/308)) ([5ae3fb9](https://github.com/kirinnee/ferretry/commit/5ae3fb950a7d9f96516509fbdd6d6512dbf72c97))

## [0.160.4](https://github.com/kirinnee/ferretry/compare/v0.160.3...v0.160.4) (2026-08-06)

### Fixes

* finish pairing advertisement follow-ups ([#307](https://github.com/kirinnee/ferretry/issues/307)) ([bc80c76](https://github.com/kirinnee/ferretry/commit/bc80c7696af78539a0e2071340529a53b5f2bcd2))

## [0.160.3](https://github.com/kirinnee/ferretry/compare/v0.160.2...v0.160.3) (2026-08-06)

### Fixes

* stop advertising loopback pairing QR codes ([#306](https://github.com/kirinnee/ferretry/issues/306)) ([b781975](https://github.com/kirinnee/ferretry/commit/b781975108f638348116891b95e5f31e4e09513a))

## [0.160.2](https://github.com/kirinnee/ferretry/compare/v0.160.1...v0.160.2) (2026-08-05)

### Fixes

* resolve the conflict that shipped in docs/grants.md, and gate the marker class ([#300](https://github.com/kirinnee/ferretry/issues/300)) ([5411c56](https://github.com/kirinnee/ferretry/commit/5411c56983fd88c44d7cdb5303a39d1a41d089df)), closes [#295](https://github.com/kirinnee/ferretry/issues/295)

## [0.160.1](https://github.com/kirinnee/ferretry/compare/v0.160.0...v0.160.1) (2026-08-05)

### Fixes

* **daemon:** dial the advertised relay when none is configured ([#301](https://github.com/kirinnee/ferretry/issues/301)) ([d69072a](https://github.com/kirinnee/ferretry/commit/d69072a003f155393e5c4c36f31e85373fd0d009))

## [0.160.0](https://github.com/kirinnee/ferretry/compare/v0.159.1...v0.160.0) (2026-08-05)

### Features

* **pwa:** add daemon account and project pickers ([#297](https://github.com/kirinnee/ferretry/issues/297)) ([1748959](https://github.com/kirinnee/ferretry/commit/174895917ab5bbd278d8de65b9a327c1b6f2ca8b))

## [0.159.1](https://github.com/kirinnee/ferretry/compare/v0.159.0...v0.159.1) (2026-08-05)

### Fixes

* **pwa:** pass the daemon's own posture, and label the one-way door ([#296](https://github.com/kirinnee/ferretry/issues/296)) ([e109895](https://github.com/kirinnee/ferretry/commit/e109895f2c70eee3ce5009d5a7fdf75f0044f911))

## [0.159.0](https://github.com/kirinnee/ferretry/compare/v0.158.0...v0.159.0) (2026-08-05)

### Features

* **pwa:** add a device to one daemon from the browser ([#295](https://github.com/kirinnee/ferretry/issues/295)) ([0d0b883](https://github.com/kirinnee/ferretry/commit/0d0b883e4fa22584f66a7334e3d7442c50f61ff5))

## [0.158.0](https://github.com/kirinnee/ferretry/compare/v0.157.0...v0.158.0) (2026-08-05)

### Features

* **pwa:** a structurally varied theme catalogue ([#290](https://github.com/kirinnee/ferretry/issues/290)) ([3c0ce05](https://github.com/kirinnee/ferretry/commit/3c0ce05b26ff88107162c80ec4e166f5a0dbcc0d))

### Fixes

* **pwa:** stop a theme change cutting the app in half ([#294](https://github.com/kirinnee/ferretry/issues/294)) ([bc795c2](https://github.com/kirinnee/ferretry/commit/bc795c2ef4a0ba2d29a3341bf2ccf8ab9da3db72))

## [0.157.0](https://github.com/kirinnee/ferretry/compare/v0.156.0...v0.157.0) (2026-08-05)

### Features

* **daemon:** widening is a local act, and every refusal names its fix ([#292](https://github.com/kirinnee/ferretry/issues/292)) ([f62e444](https://github.com/kirinnee/ferretry/commit/f62e44497bccca8d3a2bfcd4b454e6da9087ad23)), closes [#289](https://github.com/kirinnee/ferretry/issues/289) [#289](https://github.com/kirinnee/ferretry/issues/289)

### Fixes

* **cli:** claim the state-home layout wherever Ferretry creates it ([#293](https://github.com/kirinnee/ferretry/issues/293)) ([008f1b9](https://github.com/kirinnee/ferretry/commit/008f1b98bc3f7d13bf997e20e212e4c168310ba4))

## [0.156.0](https://github.com/kirinnee/ferretry/compare/v0.155.0...v0.156.0) (2026-08-05)

### Features

* **history:** import foreign Claude and Codex transcripts ([#287](https://github.com/kirinnee/ferretry/issues/287)) ([13c52bb](https://github.com/kirinnee/ferretry/commit/13c52bbda25543417dbb1ae81fc425b1923bcd3e))

## [0.155.0](https://github.com/kirinnee/ferretry/compare/v0.154.1...v0.155.0) (2026-08-05)

### Features

* **daemon:** capability grants for callers that are not on this host ([#289](https://github.com/kirinnee/ferretry/issues/289)) ([a30c0bd](https://github.com/kirinnee/ferretry/commit/a30c0bde60b7c80dc5db083a5088aad7e105919a))

### Fixes

* **daemon:** render doctor impacts only when missing ([#291](https://github.com/kirinnee/ferretry/issues/291)) ([5b24b42](https://github.com/kirinnee/ferretry/commit/5b24b42afe18650beccc8ef78553390b7b3d96c9))

## [0.154.1](https://github.com/kirinnee/ferretry/compare/v0.154.0...v0.154.1) (2026-08-05)

### Fixes

* **daemon:** read the fleet manifest the CLI writes, and refuse the one it cannot ([#288](https://github.com/kirinnee/ferretry/issues/288)) ([a96ae6f](https://github.com/kirinnee/ferretry/commit/a96ae6f070101e20c61d91236d332f75f8e5475a))

## [0.154.0](https://github.com/kirinnee/ferretry/compare/v0.153.1...v0.154.0) (2026-08-05)

### Features

* **settings:** move daemon panels to a vertical rail ([#286](https://github.com/kirinnee/ferretry/issues/286)) ([8889707](https://github.com/kirinnee/ferretry/commit/8889707fc2b0e94475f515ef9ba8550fa9d0b411))

## [0.153.1](https://github.com/kirinnee/ferretry/compare/v0.153.0...v0.153.1) (2026-08-05)

### Fixes

* **fleet:** add first account to empty config ([#285](https://github.com/kirinnee/ferretry/issues/285)) ([94c6293](https://github.com/kirinnee/ferretry/commit/94c6293be44ec1e86936febbfdbded5a730988fe))

## [0.153.0](https://github.com/kirinnee/ferretry/compare/v0.152.2...v0.153.0) (2026-08-05)

### Features

* **fleet:** guide first account setup ([#284](https://github.com/kirinnee/ferretry/issues/284)) ([390867f](https://github.com/kirinnee/ferretry/commit/390867f80bf3c0f31df2dd6fd6bc7719a4111197))

## [0.152.2](https://github.com/kirinnee/ferretry/compare/v0.152.1...v0.152.2) (2026-08-05)

### Fixes

* **tasks:** parallelize fleet board reads ([#282](https://github.com/kirinnee/ferretry/issues/282)) ([37af20d](https://github.com/kirinnee/ferretry/commit/37af20d49c9b556e98d8049e4ae2551212e66849))

## [0.152.1](https://github.com/kirinnee/ferretry/compare/v0.152.0...v0.152.1) (2026-08-05)

### Fixes

* preserve commit hooks across worktrees ([#283](https://github.com/kirinnee/ferretry/issues/283)) ([5ed0c50](https://github.com/kirinnee/ferretry/commit/5ed0c50941f417b429b18428b6cf26099450b24e))

## [0.152.0](https://github.com/kirinnee/ferretry/compare/v0.151.1...v0.152.0) (2026-08-05)

### Features

* **settings:** add a resource limits surface ([#279](https://github.com/kirinnee/ferretry/issues/279)) ([f0c2488](https://github.com/kirinnee/ferretry/commit/f0c248838f69aefafedfcfcbaf2e4692bac84fed))

## [0.151.1](https://github.com/kirinnee/ferretry/compare/v0.151.0...v0.151.1) (2026-08-05)

### Fixes

* **nix:** derive install workspace graph ([#278](https://github.com/kirinnee/ferretry/issues/278)) ([d278119](https://github.com/kirinnee/ferretry/commit/d278119c11a1d00c030f486b57af531df4de6090))

## [0.151.0](https://github.com/kirinnee/ferretry/compare/v0.150.1...v0.151.0) (2026-08-05)

### Features

* answer structured questions end to end ([#277](https://github.com/kirinnee/ferretry/issues/277)) ([25e08aa](https://github.com/kirinnee/ferretry/commit/25e08aa2f78a99021a0f445968cf5bb095a2909c))

## [0.150.1](https://github.com/kirinnee/ferretry/compare/v0.150.0...v0.150.1) (2026-08-05)

### Fixes

* **stt:** close browser-only review gaps ([#274](https://github.com/kirinnee/ferretry/issues/274)) ([bb56587](https://github.com/kirinnee/ferretry/commit/bb56587bf8c980a4f50fe120044513b43298b3c5)), closes [#273](https://github.com/kirinnee/ferretry/issues/273)

## [0.150.0](https://github.com/kirinnee/ferretry/compare/v0.149.1...v0.150.0) (2026-08-05)

### Features

* **fleet:** configure the fleet from the UI, under host authority ([#276](https://github.com/kirinnee/ferretry/issues/276)) ([9b33c29](https://github.com/kirinnee/ferretry/commit/9b33c2953e228bb7d9c7eef947d0fea2e6385497))

## [0.149.1](https://github.com/kirinnee/ferretry/compare/v0.149.0...v0.149.1) (2026-08-05)

### Fixes

* **stt:** tighten dictation bounds and disclosure ([#275](https://github.com/kirinnee/ferretry/issues/275)) ([af4aa65](https://github.com/kirinnee/ferretry/commit/af4aa65b87cf86b71743e371687f023edffdb1e8))

## [0.149.0](https://github.com/kirinnee/ferretry/compare/v0.148.1...v0.149.0) (2026-08-05)

### Features

* add safe rich file previews ([#272](https://github.com/kirinnee/ferretry/issues/272)) ([dd782c5](https://github.com/kirinnee/ferretry/commit/dd782c51e6f2704d31f741df8a1a4bf8251199b8))

## [0.148.1](https://github.com/kirinnee/ferretry/compare/v0.148.0...v0.148.1) (2026-08-05)

### Fixes

* **pwa:** preserve mobile text selection ([#271](https://github.com/kirinnee/ferretry/issues/271)) ([a82650c](https://github.com/kirinnee/ferretry/commit/a82650cf051ea64b67fcd832d50f13e4e4dfb28e))

## [0.148.0](https://github.com/kirinnee/ferretry/compare/v0.147.0...v0.148.0) (2026-08-05)

### Features

* **daemon:** add encrypted attachment routes ([#268](https://github.com/kirinnee/ferretry/issues/268)) ([54d16df](https://github.com/kirinnee/ferretry/commit/54d16df7dcf26dd487229d54395c3c97381daa8a))

## [0.147.0](https://github.com/kirinnee/ferretry/compare/v0.146.0...v0.147.0) (2026-08-05)

### Features

* **pwa:** render warden report evidence readably ([#269](https://github.com/kirinnee/ferretry/issues/269)) ([b799103](https://github.com/kirinnee/ferretry/commit/b799103fa868de9a8ebd2417c00c42427282bdd9))

## [0.146.0](https://github.com/kirinnee/ferretry/compare/v0.145.0...v0.146.0) (2026-08-05)

### Features

* **pwa:** make each linked daemon a settings sub-tab ([#264](https://github.com/kirinnee/ferretry/issues/264)) ([11b5b62](https://github.com/kirinnee/ferretry/commit/11b5b62574102ed4497a18c9605621c6ad0a6dbf))

## [0.145.0](https://github.com/kirinnee/ferretry/compare/v0.144.0...v0.145.0) (2026-08-05)

### Features

* **pwa:** polish transcript density ([#267](https://github.com/kirinnee/ferretry/issues/267)) ([a5cb02d](https://github.com/kirinnee/ferretry/commit/a5cb02dec682afb91db13fc61c629c7d30612f5f))

### Fixes

* **pwa:** retire clear session command ([#266](https://github.com/kirinnee/ferretry/issues/266)) ([b8e0ee1](https://github.com/kirinnee/ferretry/commit/b8e0ee18340c2b2948010fc111615873c7ea2c80))

## [0.144.0](https://github.com/kirinnee/ferretry/compare/v0.143.0...v0.144.0) (2026-08-05)

### Features

* **pwa:** expand landing feature story ([#263](https://github.com/kirinnee/ferretry/issues/263)) ([0badb40](https://github.com/kirinnee/ferretry/commit/0badb40440381f85a61edcc3ad9cc92904ee13ab))
* **pwa:** mount composer runtime controls ([#256](https://github.com/kirinnee/ferretry/issues/256)) ([c073532](https://github.com/kirinnee/ferretry/commit/c07353244779b33dc3e176edc2052e15790d76b6))
* **pwa:** simplify lineage navigation ([#262](https://github.com/kirinnee/ferretry/issues/262)) ([95d156d](https://github.com/kirinnee/ferretry/commit/95d156dd59817ee512e4ea1a44f3d611cb1c7a4d))

### Fixes

* **pwa:** the Illegal invocation regression, the silent relay socket, and the green pill that lied ([#265](https://github.com/kirinnee/ferretry/issues/265)) ([defa8ff](https://github.com/kirinnee/ferretry/commit/defa8ff88403f5d8f3aa1c8682819476127db0ac)), closes [#235](https://github.com/kirinnee/ferretry/issues/235)

## [0.143.0](https://github.com/kirinnee/ferretry/compare/v0.142.0...v0.143.0) (2026-08-05)

### Features

* **pwa:** remote provider login by URL handoff ([#260](https://github.com/kirinnee/ferretry/issues/260)) ([e6cc51b](https://github.com/kirinnee/ferretry/commit/e6cc51b93904814e16c074f5d3cfb03a7f890cc0))
* **tasks:** add a Mark done control, enforced in the daemon ([#259](https://github.com/kirinnee/ferretry/issues/259)) ([f609e65](https://github.com/kirinnee/ferretry/commit/f609e65bb001bda1da0be8fa34c33af35d8da914))

### Fixes

* **nix:** link the relay workspace package into the compiled binaries ([#261](https://github.com/kirinnee/ferretry/issues/261)) ([183a298](https://github.com/kirinnee/ferretry/commit/183a2985499d0d37eecb79c43ca6a945e2f92235))

## [0.142.0](https://github.com/kirinnee/ferretry/compare/v0.141.0...v0.142.0) (2026-08-05)

### Features

* **daemon:** add a cross-platform browser worker ([#257](https://github.com/kirinnee/ferretry/issues/257)) ([289d0d8](https://github.com/kirinnee/ferretry/commit/289d0d806e2f325951c529d2dfcb2701a6572921))
* **fleet:** ship default assets a fresh account can run with ([#253](https://github.com/kirinnee/ferretry/issues/253)) ([f04986e](https://github.com/kirinnee/ferretry/commit/f04986e07eba1f00b4ba0af90ef1f608129aff1e))
* **pwa:** expand browser to full viewport ([#258](https://github.com/kirinnee/ferretry/issues/258)) ([79ecbaf](https://github.com/kirinnee/ferretry/commit/79ecbaf805da9c64dee3f3e006df590b0323c60c))

## [0.141.0](https://github.com/kirinnee/ferretry/compare/v0.140.1...v0.141.0) (2026-08-05)

### Features

* **fleet:** pool Claude and Codex history independently, and migrate what exists ([#255](https://github.com/kirinnee/ferretry/issues/255)) ([411f9bb](https://github.com/kirinnee/ferretry/commit/411f9bb5efb4488349e0fb87f7c6e326811ebf37)), closes [#F85](https://github.com/kirinnee/ferretry/issues/F85) [#F85](https://github.com/kirinnee/ferretry/issues/F85)

## [0.140.1](https://github.com/kirinnee/ferretry/compare/v0.140.0...v0.140.1) (2026-08-05)

### Fixes

* **cli:** remove the duplicated fleet health entry ([#254](https://github.com/kirinnee/ferretry/issues/254)) ([c551c5b](https://github.com/kirinnee/ferretry/commit/c551c5bcd931955b9834f228fa57215409a17e46))

## [0.140.0](https://github.com/kirinnee/ferretry/compare/v0.139.0...v0.140.0) (2026-08-05)

### Features

* **fleet:** know which accounts can actually complete a turn ([#252](https://github.com/kirinnee/ferretry/issues/252)) ([3c2d6c1](https://github.com/kirinnee/ferretry/commit/3c2d6c107b638cbb5e9d7719be16f9878247770b))

## [0.139.0](https://github.com/kirinnee/ferretry/compare/v0.138.0...v0.139.0) (2026-08-05)

### Features

* **daemon:** refresh fleet evidence unattended ([#250](https://github.com/kirinnee/ferretry/issues/250)) ([7f57c40](https://github.com/kirinnee/ferretry/commit/7f57c408f84a02334188bd923131d370cea233fb))
* **doctor:** report host dependencies ([#244](https://github.com/kirinnee/ferretry/issues/244)) ([fc4f80b](https://github.com/kirinnee/ferretry/commit/fc4f80bf56b662ab9d1ce0a76e9dd5f5b03c2533))

## [0.138.0](https://github.com/kirinnee/ferretry/compare/v0.137.0...v0.138.0) (2026-08-05)

### Features

* **daemon:** read quota from this host's own fleet, not from kfleet ([#251](https://github.com/kirinnee/ferretry/issues/251)) ([bef8afa](https://github.com/kirinnee/ferretry/commit/bef8afaa3ea68cf4acc95d0bce700deb3f49cc69))

## [0.137.0](https://github.com/kirinnee/ferretry/compare/v0.136.0...v0.137.0) (2026-08-05)

### Features

* **pwa:** add current-session file and task search ([#239](https://github.com/kirinnee/ferretry/issues/239)) ([69b72b6](https://github.com/kirinnee/ferretry/commit/69b72b68d5e3cfb484b64ddf91a9a62dd81ccdf8))

## [0.136.0](https://github.com/kirinnee/ferretry/compare/v0.135.0...v0.136.0) (2026-08-05)

### Features

* **secrets:** a daemon secret store agents use without ever holding one ([#245](https://github.com/kirinnee/ferretry/issues/245)) ([6bffba9](https://github.com/kirinnee/ferretry/commit/6bffba959a42f723128789e4ac9af7546c8767ad))

## [0.135.0](https://github.com/kirinnee/ferretry/compare/v0.134.0...v0.135.0) (2026-08-05)

### Features

* **attention:** enforce asymmetric dismissal authority ([#242](https://github.com/kirinnee/ferretry/issues/242)) ([5d3a0dc](https://github.com/kirinnee/ferretry/commit/5d3a0dca3bdca6779d933d23a780730d7b0fb025))
* **fleet:** report real Anthropic quota, from one probe both consumers share ([#247](https://github.com/kirinnee/ferretry/issues/247)) ([c51c046](https://github.com/kirinnee/ferretry/commit/c51c04637dcdfe20d93e0fccb573786a52e77466))

## [0.134.0](https://github.com/kirinnee/ferretry/compare/v0.133.0...v0.134.0) (2026-08-05)

### Features

* configure portable fleet environment per daemon ([#238](https://github.com/kirinnee/ferretry/issues/238)) ([7dd12fe](https://github.com/kirinnee/ferretry/commit/7dd12fee5cb32513f9df6ee59d8cc8ab19f345cc))

## [0.133.0](https://github.com/kirinnee/ferretry/compare/v0.132.0...v0.133.0) (2026-08-05)

### Features

* **fleet:** one browser approval per provider account, not per wrapper ([#240](https://github.com/kirinnee/ferretry/issues/240)) ([2522dcd](https://github.com/kirinnee/ferretry/commit/2522dcd4575f42f3df3c566bb4499dec90d638f4))

### Fixes

* **fleet:** let a first run create the fleet root ([#241](https://github.com/kirinnee/ferretry/issues/241)) ([aab7d8d](https://github.com/kirinnee/ferretry/commit/aab7d8d7e32f202036a02b3f407783f3366a2ea9))
* **pwa:** refuse ambiguous file references ([#243](https://github.com/kirinnee/ferretry/issues/243)) ([1ff99eb](https://github.com/kirinnee/ferretry/commit/1ff99eb0b164c8d23b119796d61cc21f80f17de1))

## [0.132.0](https://github.com/kirinnee/ferretry/compare/v0.131.0...v0.132.0) (2026-08-05)

### Features

* **daemon:** tell an operator whether any agent harness is ready ([#230](https://github.com/kirinnee/ferretry/issues/230)) ([0b58290](https://github.com/kirinnee/ferretry/commit/0b5829025c56639e6f3c88b43ab7356ecbba5666))
* **fleet:** map what stands between us and deleting kfleet, then close three of it ([#236](https://github.com/kirinnee/ferretry/issues/236)) ([bafb7c2](https://github.com/kirinnee/ferretry/commit/bafb7c286214d132d32dd089fe255bfded9515bb)), closes [#231](https://github.com/kirinnee/ferretry/issues/231)
* **pwa:** the browser half of the relay, so a phone can reach a daemon behind NAT ([#235](https://github.com/kirinnee/ferretry/issues/235)) ([bfe86c9](https://github.com/kirinnee/ferretry/commit/bfe86c96b29402d33bf9772131d03237bb380669))

## [0.131.0](https://github.com/kirinnee/ferretry/compare/v0.130.0...v0.131.0) (2026-08-05)

### Features

* **daemon:** mount fleet routes ([#237](https://github.com/kirinnee/ferretry/issues/237)) ([44684ea](https://github.com/kirinnee/ferretry/commit/44684ea302fe3b4f4e339784c8bcd1c1dbed1868))
* **pwa:** daemon-scoped settings, a Warden tab, and configurable Enter ([#234](https://github.com/kirinnee/ferretry/issues/234)) ([29a97f5](https://github.com/kirinnee/ferretry/commit/29a97f54f78912eeb07c77e17196cb92a53c115a))

## [0.130.0](https://github.com/kirinnee/ferretry/compare/v0.129.0...v0.130.0) (2026-08-05)

### Features

* **pwa:** add daemon fleet inventory surface ([#231](https://github.com/kirinnee/ferretry/issues/231)) ([d704ee4](https://github.com/kirinnee/ferretry/commit/d704ee436f6cb504c6cff9978324fe166534d154))
* **pwa:** make daemon scoping an enforced invariant ([#233](https://github.com/kirinnee/ferretry/issues/233)) ([f73e340](https://github.com/kirinnee/ferretry/commit/f73e3405e5dfc4aff461c19ed4e2a9f29e6b69df))
* **pwa:** the daemon needs a computer, so stop asking phones what they are ([#222](https://github.com/kirinnee/ferretry/issues/222)) ([4fffe63](https://github.com/kirinnee/ferretry/commit/4fffe63b4feceaed11ba57f1aa019a2ff1fb2189)), closes [#215](https://github.com/kirinnee/ferretry/issues/215)

## [0.129.0](https://github.com/kirinnee/ferretry/compare/v0.128.0...v0.129.0) (2026-08-04)

### Features

* add a durable Projects registry and hub ([#221](https://github.com/kirinnee/ferretry/issues/221)) ([9a41a08](https://github.com/kirinnee/ferretry/commit/9a41a089d1d4cf28726197f4464d2c0436f472f2))
* **daemon:** dial the rendezvous, so a phone can reach a daemon behind NAT ([#225](https://github.com/kirinnee/ferretry/issues/225)) ([02596a3](https://github.com/kirinnee/ferretry/commit/02596a31b4279f9e64c2aaac0d6ba08f160bf710))
* **pwa:** simplify the landing page to a StoryBrand arc ([#226](https://github.com/kirinnee/ferretry/issues/226)) ([8c84fc9](https://github.com/kirinnee/ferretry/commit/8c84fc9a21316091899dc2c9871e88d0e4478c1e))

## [0.128.0](https://github.com/kirinnee/ferretry/compare/v0.127.1...v0.128.0) (2026-08-04)

### Features

* **pwa:** split settings into sections and manage daemons ([#227](https://github.com/kirinnee/ferretry/issues/227)) ([2a3c269](https://github.com/kirinnee/ferretry/commit/2a3c26902d1be55207cbf75c0fa51ade40c3ec8d))

## [0.127.1](https://github.com/kirinnee/ferretry/compare/v0.127.0...v0.127.1) (2026-08-04)

### Fixes

* **daemon:** make a fresh install work, and say what it is doing ([#224](https://github.com/kirinnee/ferretry/issues/224)) ([f93a1ae](https://github.com/kirinnee/ferretry/commit/f93a1ae7e149e3840dfee96c65b1f95f036eac2e))

## [0.127.0](https://github.com/kirinnee/ferretry/compare/v0.126.0...v0.127.0) (2026-08-04)

### Features

* **pwa:** distinguish attention action kinds ([#219](https://github.com/kirinnee/ferretry/issues/219)) ([f0db384](https://github.com/kirinnee/ferretry/commit/f0db384952f25337f045e55c64fa7c9cac36195d))

### Fixes

* bind PWA fetch and clarify pairing ([#223](https://github.com/kirinnee/ferretry/issues/223)) ([cc3b762](https://github.com/kirinnee/ferretry/commit/cc3b762277397dda2f71e47b0e01d2df5b17e4db))
* **pwa:** stabilize terminal deck theme test ([#220](https://github.com/kirinnee/ferretry/issues/220)) ([5145741](https://github.com/kirinnee/ferretry/commit/5145741278497918d0430cbe67fb62e14801c57e))

## [0.126.0](https://github.com/kirinnee/ferretry/compare/v0.125.0...v0.126.0) (2026-08-04)

### Features

* **cli:** hold a Nix-store daemon against garbage collection ([#218](https://github.com/kirinnee/ferretry/issues/218)) ([3a55a53](https://github.com/kirinnee/ferretry/commit/3a55a5329f95d69fc4f69b8c5c74ad5618481cca))

## [0.125.0](https://github.com/kirinnee/ferretry/compare/v0.124.0...v0.125.0) (2026-08-04)

### Features

* **daemon:** add portable transcript digest ([#214](https://github.com/kirinnee/ferretry/issues/214)) ([1492c14](https://github.com/kirinnee/ferretry/commit/1492c14e5d28aa796b50ce8128217ced8fd6a16b))
* **pwa:** ask who does the setup before asking what the device is ([#215](https://github.com/kirinnee/ferretry/issues/215)) ([28b01c0](https://github.com/kirinnee/ferretry/commit/28b01c0c44f6206c4da57d8a6e5e7cac00ca5f9e))

## [0.124.0](https://github.com/kirinnee/ferretry/compare/v0.123.0...v0.124.0) (2026-08-04)

### Features

* **task-boards:** verify replacement authority before handoff ([#212](https://github.com/kirinnee/ferretry/issues/212)) ([5cb7901](https://github.com/kirinnee/ferretry/commit/5cb7901bfc1ac1588251916553a4d078d14f15ff))

### Fixes

* **daemon:** declare the log directory so a fresh machine can start the daemon ([#213](https://github.com/kirinnee/ferretry/issues/213)) ([07cede8](https://github.com/kirinnee/ferretry/commit/07cede8486aad2c954d40f572cbeded4cb275824))

## [0.123.0](https://github.com/kirinnee/ferretry/compare/v0.122.0...v0.123.0) (2026-08-04)

### Features

* **daemon:** ingest finished sessions into a queryable analytics store ([#209](https://github.com/kirinnee/ferretry/issues/209)) ([520dc46](https://github.com/kirinnee/ferretry/commit/520dc46c316fff210734c708f6ca6ad5ede5170e))
* **pwa:** one tab per file, and Pins and Attention out of the side-pane model ([#210](https://github.com/kirinnee/ferretry/issues/210)) ([820e5af](https://github.com/kirinnee/ferretry/commit/820e5af6baf12cf4608dc1aaacb715ac4c339712)), closes [#35](https://github.com/kirinnee/ferretry/issues/35) [#63](https://github.com/kirinnee/ferretry/issues/63) [#17](https://github.com/kirinnee/ferretry/issues/17) [#17](https://github.com/kirinnee/ferretry/issues/17) [#35](https://github.com/kirinnee/ferretry/issues/35) [#35](https://github.com/kirinnee/ferretry/issues/35)

### Fixes

* **pages:** do not let devshell chatter corrupt the relay origin ([#211](https://github.com/kirinnee/ferretry/issues/211)) ([9b68e21](https://github.com/kirinnee/ferretry/commit/9b68e216fd319f660f046e1fa6e14465dabc8f53))

## [0.122.0](https://github.com/kirinnee/ferretry/compare/v0.121.0...v0.122.0) (2026-08-04)

### Features

* **pwa:** onboarding asks what the device is, and the same machine stops scanning its own screen ([#207](https://github.com/kirinnee/ferretry/issues/207)) ([d03d4d2](https://github.com/kirinnee/ferretry/commit/d03d4d232776fbe250bc4fc150b158d7278cfdee))

## [0.121.0](https://github.com/kirinnee/ferretry/compare/v0.120.1...v0.121.0) (2026-08-04)

### Features

* **pwa:** co-control a session terminal with the agent that opened it ([#206](https://github.com/kirinnee/ferretry/issues/206)) ([a456a65](https://github.com/kirinnee/ferretry/commit/a456a65c43d36e7d1c9e8587e32b047fe99ffffe)), closes [#34](https://github.com/kirinnee/ferretry/issues/34) [#21](https://github.com/kirinnee/ferretry/issues/21) [#41](https://github.com/kirinnee/ferretry/issues/41)

## [0.120.1](https://github.com/kirinnee/ferretry/compare/v0.120.0...v0.120.1) (2026-08-04)

### Fixes

* **relay:** close hosted failure gaps ([#205](https://github.com/kirinnee/ferretry/issues/205)) ([0f49332](https://github.com/kirinnee/ferretry/commit/0f493329aac55e0863f717c146f4266615631c0b))

## [0.120.0](https://github.com/kirinnee/ferretry/compare/v0.119.0...v0.120.0) (2026-08-04)

### Features

* **pwa:** one reference standard everywhere — skills, references inside code, and one wired surface ([#203](https://github.com/kirinnee/ferretry/issues/203)) ([17bbf74](https://github.com/kirinnee/ferretry/commit/17bbf743b809a7e84d3a01a8ba5ef9f5475bcee0)), closes [#64](https://github.com/kirinnee/ferretry/issues/64) [#64](https://github.com/kirinnee/ferretry/issues/64)
* **relay:** ship a survivable hosted default ([#204](https://github.com/kirinnee/ferretry/issues/204)) ([2dd6f4f](https://github.com/kirinnee/ferretry/commit/2dd6f4f0d56d632dc2a67410803f1114aca8ff2e)), closes [#198](https://github.com/kirinnee/ferretry/issues/198) [#198](https://github.com/kirinnee/ferretry/issues/198) [#198](https://github.com/kirinnee/ferretry/issues/198) [#198](https://github.com/kirinnee/ferretry/issues/198) [#198](https://github.com/kirinnee/ferretry/issues/198) [#198](https://github.com/kirinnee/ferretry/issues/198)

## [0.119.0](https://github.com/kirinnee/ferretry/compare/v0.118.0...v0.119.0) (2026-08-04)

### Features

* **pwa:** resolve the relay origin at build time and disclose the live carrier ([#202](https://github.com/kirinnee/ferretry/issues/202)) ([f499fcb](https://github.com/kirinnee/ferretry/commit/f499fcb8fbe7b6f78f3244e5b4ee2ddee08f5ef0))

## [0.118.0](https://github.com/kirinnee/ferretry/compare/v0.117.0...v0.118.0) (2026-08-04)

### Features

* make the file browser work on macOS, and fail honestly where it cannot ([#201](https://github.com/kirinnee/ferretry/issues/201)) ([ea2eeea](https://github.com/kirinnee/ferretry/commit/ea2eeea2e18828b37070e2bdb3541badfa0d65bb))

## [0.117.0](https://github.com/kirinnee/ferretry/compare/v0.116.0...v0.117.0) (2026-08-04)

### Features

* **daemon:** migrate a session when its account runs out of tokens ([#200](https://github.com/kirinnee/ferretry/issues/200)) ([10b8ab6](https://github.com/kirinnee/ferretry/commit/10b8ab624d88506a045a84794dbf76cdeaa40fbd))
* **pwa:** addressable, session-scoped references for terminals and browser pages ([#199](https://github.com/kirinnee/ferretry/issues/199)) ([ef4794d](https://github.com/kirinnee/ferretry/commit/ef4794dce2f74ed66a0b0643433dbebceac69938))
* **pwa:** separate pairing and connection routes ([#196](https://github.com/kirinnee/ferretry/issues/196)) ([446b13d](https://github.com/kirinnee/ferretry/commit/446b13d7294bb5339ba81837a66e62348cbca48f))

## [0.116.0](https://github.com/kirinnee/ferretry/compare/v0.115.0...v0.116.0) (2026-08-04)

### Features

* **pwa:** rebuild onboarding around three entry paths ([#195](https://github.com/kirinnee/ferretry/issues/195)) ([255e1ac](https://github.com/kirinnee/ferretry/commit/255e1ac242510be24ed5456684d1428f96d76530))

## [0.115.0](https://github.com/kirinnee/ferretry/compare/v0.114.0...v0.115.0) (2026-08-04)

### Features

* **pwa:** assemble the session workspace ([#194](https://github.com/kirinnee/ferretry/issues/194)) ([567425b](https://github.com/kirinnee/ferretry/commit/567425be5077a68fc9ca6e19ae26e2493ca2d90c)), closes [#session-workspace](https://github.com/kirinnee/ferretry/issues/session-workspace)

## [0.114.0](https://github.com/kirinnee/ferretry/compare/v0.113.0...v0.114.0) (2026-08-04)

### Features

* **daemon:** make cost tracking report actual cost ([#191](https://github.com/kirinnee/ferretry/issues/191)) ([7e556a5](https://github.com/kirinnee/ferretry/commit/7e556a51500b6c667bc76d305af1014f843bd600))

## [0.113.0](https://github.com/kirinnee/ferretry/compare/v0.112.0...v0.113.0) (2026-08-04)

### Features

* **pwa:** make the setup screen sleek, visual and ADHD-friendly ([#193](https://github.com/kirinnee/ferretry/issues/193)) ([ffb0f99](https://github.com/kirinnee/ferretry/commit/ffb0f999464d6e4af29a705a3c1c6db5bdcc9bbb))

## [0.112.0](https://github.com/kirinnee/ferretry/compare/v0.111.0...v0.112.0) (2026-08-04)

### Features

* **daemon:** mint terminal stream tickets so a phone can open a terminal ([#189](https://github.com/kirinnee/ferretry/issues/189)) ([fee8557](https://github.com/kirinnee/ferretry/commit/fee8557a8ed392158b7f9765529c256d4eb83caf)), closes [#184](https://github.com/kirinnee/ferretry/issues/184)

### Fixes

* **daemon:** let a pane name itself, and refuse a cross-family migration ([#190](https://github.com/kirinnee/ferretry/issues/190)) ([a8cf4cd](https://github.com/kirinnee/ferretry/commit/a8cf4cdd98da39c756b59e5fa8060c63b5bdbc26))

## [0.111.0](https://github.com/kirinnee/ferretry/compare/v0.110.0...v0.111.0) (2026-08-04)

### Features

* **pwa:** add four-step onboarding ([#188](https://github.com/kirinnee/ferretry/issues/188)) ([5f26d78](https://github.com/kirinnee/ferretry/commit/5f26d78ac7830a8aa76ecff8a691fdab0487a6e5)), closes [#ferretry-portrait-gate](https://github.com/kirinnee/ferretry/issues/ferretry-portrait-gate) [#fy-portrait-gate](https://github.com/kirinnee/ferretry/issues/fy-portrait-gate)
* **relay:** end-to-end rendezvous over Workers and Durable Objects ([#187](https://github.com/kirinnee/ferretry/issues/187)) ([5bfd802](https://github.com/kirinnee/ferretry/commit/5bfd80233754f1d42eed24981ec4da22c99418d9))

## [0.110.0](https://github.com/kirinnee/ferretry/compare/v0.109.0...v0.110.0) (2026-08-03)

### Features

* **pwa:** rewrite landing agent OS pitch ([#185](https://github.com/kirinnee/ferretry/issues/185)) ([dfad55a](https://github.com/kirinnee/ferretry/commit/dfad55a7df55e3a64ad41c839380f0e72f31f0fd))

## [0.109.0](https://github.com/kirinnee/ferretry/compare/v0.108.1...v0.109.0) (2026-08-03)

### Features

* **daemon:** let a paired device authenticate a live socket ([#184](https://github.com/kirinnee/ferretry/issues/184)) ([d395332](https://github.com/kirinnee/ferretry/commit/d3953324c4f028784cdd81778ac86d4fd0dda4be))

## [0.108.1](https://github.com/kirinnee/ferretry/compare/v0.108.0...v0.108.1) (2026-08-03)

### Fixes

* **release:** ship daemon binary ([#183](https://github.com/kirinnee/ferretry/issues/183)) ([2056e0d](https://github.com/kirinnee/ferretry/commit/2056e0dd1613c465b90a0844c5e146066e26ae7a))

## [0.108.0](https://github.com/kirinnee/ferretry/compare/v0.107.0...v0.108.0) (2026-08-03)

### Features

* **pwa:** add static landing page ([#182](https://github.com/kirinnee/ferretry/issues/182)) ([d4cbd42](https://github.com/kirinnee/ferretry/commit/d4cbd42d8d78cfe725ee440f2f2b4dd873147f16))

## [0.107.0](https://github.com/kirinnee/ferretry/compare/v0.106.1...v0.107.0) (2026-08-03)

### Features

* **pwa:** install the Fleet Grid mark as the app's favicon, PWA icon and header mark ([#181](https://github.com/kirinnee/ferretry/issues/181)) ([e292ed4](https://github.com/kirinnee/ferretry/commit/e292ed4cce4635924cdfe8685127ba18543c9e2e))

## [0.106.1](https://github.com/kirinnee/ferretry/compare/v0.106.0...v0.106.1) (2026-08-03)

### Fixes

* **release:** push Gemfury packages to the kirinnee97 account ([#180](https://github.com/kirinnee/ferretry/issues/180)) ([0410c62](https://github.com/kirinnee/ferretry/commit/0410c629e01f82a85b7362e594ae71256c5a1a0e))

## [0.106.0](https://github.com/kirinnee/ferretry/compare/v0.105.0...v0.106.0) (2026-08-03)

### Features

* **cli:** pair a device with a QR in the terminal ([#179](https://github.com/kirinnee/ferretry/issues/179)) ([b2e8e38](https://github.com/kirinnee/ferretry/commit/b2e8e389fdb00b83a42144685598ccd4d580a686))

## [0.105.0](https://github.com/kirinnee/ferretry/compare/v0.104.0...v0.105.0) (2026-08-03)

### Features

* **daemon:** add secure device pairing ([#178](https://github.com/kirinnee/ferretry/issues/178)) ([6194413](https://github.com/kirinnee/ferretry/commit/6194413d390da03e87c1565affe478efc82d997c))

## [0.104.0](https://github.com/kirinnee/ferretry/compare/v0.103.1...v0.104.0) (2026-08-03)

### Features

* **pwa:** make pairing one action, scanned not pasted ([#177](https://github.com/kirinnee/ferretry/issues/177)) ([3c2e313](https://github.com/kirinnee/ferretry/commit/3c2e313089d240dd4013a7f4cfd4c60d8aa3b953))

## [0.103.1](https://github.com/kirinnee/ferretry/compare/v0.103.0...v0.103.1) (2026-08-03)

### Fixes

* **pages:** run wrangler through the devshell and create the project on first deploy ([#174](https://github.com/kirinnee/ferretry/issues/174)) ([940f4dd](https://github.com/kirinnee/ferretry/commit/940f4dddeaf744169c158a109c77cfb0b4dd3852)), closes [.#ci](https://github.com/kirinnee/./issues/ci)

## [0.103.0](https://github.com/kirinnee/ferretry/compare/v0.102.0...v0.103.0) (2026-08-03)

### Features

* **pwa:** deploy static app to pages ([#172](https://github.com/kirinnee/ferretry/issues/172)) ([fb3e13b](https://github.com/kirinnee/ferretry/commit/fb3e13b41a9f183e02946ebc346cd91410ed8955))

## [0.102.0](https://github.com/kirinnee/ferretry/compare/v0.101.0...v0.102.0) (2026-08-03)

### Features

* **pwa:** assemble the application root ([#173](https://github.com/kirinnee/ferretry/issues/173)) ([0381154](https://github.com/kirinnee/ferretry/commit/0381154edeae654965ffd8f5cc5e8d79d3e37f9b))

## [0.101.0](https://github.com/kirinnee/ferretry/compare/v0.100.0...v0.101.0) (2026-08-01)

### Features

* **pwa:** connect sessions and unified browser surfaces ([#170](https://github.com/kirinnee/ferretry/issues/170)) ([6a08139](https://github.com/kirinnee/ferretry/commit/6a08139fb101aeaf9b8c971b99f20363f831af07))

## [0.100.0](https://github.com/kirinnee/ferretry/compare/v0.99.0...v0.100.0) (2026-08-01)

### Features

* **daemon:** mount learning mining ([#168](https://github.com/kirinnee/ferretry/issues/168)) ([e45769b](https://github.com/kirinnee/ferretry/commit/e45769bf7c1df692eeacbaf9199be9ceb7d999ac))

## [0.99.0](https://github.com/kirinnee/ferretry/compare/v0.98.0...v0.99.0) (2026-08-01)

### Features

* **daemon:** serve attach and fleet events ([#167](https://github.com/kirinnee/ferretry/issues/167)) ([504626e](https://github.com/kirinnee/ferretry/commit/504626eafdfe3d738c9b31c771d4dca6feb154e9))

## [0.98.0](https://github.com/kirinnee/ferretry/compare/v0.97.0...v0.98.0) (2026-08-01)

### Features

* **daemon:** persist final frames and turn logs ([#166](https://github.com/kirinnee/ferretry/issues/166)) ([2a38d64](https://github.com/kirinnee/ferretry/commit/2a38d6490aefc910c197b288a4e2e9f0629778e2))

## [0.97.0](https://github.com/kirinnee/ferretry/compare/v0.96.0...v0.97.0) (2026-08-01)

### Features

* **cli:** add daemon-scoped operator reads ([#164](https://github.com/kirinnee/ferretry/issues/164)) ([d303ae4](https://github.com/kirinnee/ferretry/commit/d303ae4b0b7a423419b017ad5e927d92118ed660))

## [0.96.0](https://github.com/kirinnee/ferretry/compare/v0.95.0...v0.96.0) (2026-08-01)

### Features

* **daemon:** serve the warden sweep runtime and mount fleet supervision ([#163](https://github.com/kirinnee/ferretry/issues/163)) ([76e62eb](https://github.com/kirinnee/ferretry/commit/76e62eb98e34481b8d9f5749f1e9ee127fb2b1c6))

## [0.95.0](https://github.com/kirinnee/ferretry/compare/v0.94.0...v0.95.0) (2026-08-01)

### Features

* **daemon:** add terminal reap safety policy ([#156](https://github.com/kirinnee/ferretry/issues/156)) ([bad02f1](https://github.com/kirinnee/ferretry/commit/bad02f10a52f0c7e17c8e43d1b5f8a9676c46086))

## [0.94.0](https://github.com/kirinnee/ferretry/compare/v0.93.0...v0.94.0) (2026-08-01)

### Features

* **cli:** expose daemon capabilities ([#162](https://github.com/kirinnee/ferretry/issues/162)) ([88274e8](https://github.com/kirinnee/ferretry/commit/88274e8e88f89a2b9a058b3ed36f734ef7d0d0ee))
* **daemon:** mount scratch garbage collection ([#154](https://github.com/kirinnee/ferretry/issues/154)) ([e4726ee](https://github.com/kirinnee/ferretry/commit/e4726ee6ec9ca7527b76e63064b3493568b80e42))

## [0.93.0](https://github.com/kirinnee/ferretry/compare/v0.92.2...v0.93.0) (2026-08-01)

### Features

* **daemon:** wake a declared wait on a per-daemon monitor tick ([#161](https://github.com/kirinnee/ferretry/issues/161)) ([fe842eb](https://github.com/kirinnee/ferretry/commit/fe842ebcd6b014092df605e9e4d50e4d7191586e))

## [0.92.2](https://github.com/kirinnee/ferretry/compare/v0.92.1...v0.92.2) (2026-08-01)

### Fixes

* **daemon:** draw free callsigns uniformly ([#160](https://github.com/kirinnee/ferretry/issues/160)) ([8af35a7](https://github.com/kirinnee/ferretry/commit/8af35a7cf53adc14166bf5d5bf8e50d76cf6145b))

## [0.92.1](https://github.com/kirinnee/ferretry/compare/v0.92.0...v0.92.1) (2026-08-01)

### Fixes

* **daemon:** fail closed on damaged durable state ([#159](https://github.com/kirinnee/ferretry/issues/159)) ([3cf756b](https://github.com/kirinnee/ferretry/commit/3cf756bdcea6f8d52ccc06bdc1f1f6e6ae57df1f))

## [0.92.0](https://github.com/kirinnee/ferretry/compare/v0.91.0...v0.92.0) (2026-08-01)

### Features

* **daemon:** confine the session working-tree read by descriptor ([#158](https://github.com/kirinnee/ferretry/issues/158)) ([19b3607](https://github.com/kirinnee/ferretry/commit/19b36075317cb28c90b3c61bc9296a711335c135)), closes [#150](https://github.com/kirinnee/ferretry/issues/150)

## [0.91.0](https://github.com/kirinnee/ferretry/compare/v0.90.2...v0.91.0) (2026-08-01)

### Features

* **daemon:** record session transcript provenance and mount the reader ([#152](https://github.com/kirinnee/ferretry/issues/152)) ([e871482](https://github.com/kirinnee/ferretry/commit/e871482c8c9b84f4bb689138b555139a81d4137a))
* **daemon:** serve send and interrupt, and end a peer's declared wait ([#153](https://github.com/kirinnee/ferretry/issues/153)) ([01beebe](https://github.com/kirinnee/ferretry/commit/01beebea83b33d65a89aac93cf35d2efd7cbd240))

## [0.90.2](https://github.com/kirinnee/ferretry/compare/v0.90.1...v0.90.2) (2026-08-01)

### Fixes

* **daemon:** bound initial attachment decoding ([#150](https://github.com/kirinnee/ferretry/issues/150)) ([148550d](https://github.com/kirinnee/ferretry/commit/148550d1afa1c301439f740bfc78658514084fab))
* **daemon:** preserve observed model in migration windows ([#151](https://github.com/kirinnee/ferretry/issues/151)) ([ce453d0](https://github.com/kirinnee/ferretry/commit/ce453d0839a856a215b9a8b329435dde1e059e93))

## [0.90.1](https://github.com/kirinnee/ferretry/compare/v0.90.0...v0.90.1) (2026-08-01)

### Fixes

* **daemon:** release the speech worker when it goes idle ([#149](https://github.com/kirinnee/ferretry/issues/149)) ([fcede99](https://github.com/kirinnee/ferretry/commit/fcede9927a5bbdb70598b59c549bfa39187a22f2))

## [0.90.0](https://github.com/kirinnee/ferretry/compare/v0.89.0...v0.90.0) (2026-08-01)

### Features

* **daemon:** prove a turn reached the pane, and map the tmux/browser/stt gaps ([#147](https://github.com/kirinnee/ferretry/issues/147)) ([f5a8a71](https://github.com/kirinnee/ferretry/commit/f5a8a71e53b550c8c8e3bda633c27537620446e3))
* **daemon:** serve the session signal surface ([#145](https://github.com/kirinnee/ferretry/issues/145)) ([33c41fd](https://github.com/kirinnee/ferretry/commit/33c41fd400034259dc5a54a3db5c7d5a9c31399f))
* **pwa:** hold live clock during selection ([#143](https://github.com/kirinnee/ferretry/issues/143)) ([adb5f34](https://github.com/kirinnee/ferretry/commit/adb5f3412880eab396678aed73ddf3edf8311a9a))
* **pwa:** port composer autocomplete providers ([#146](https://github.com/kirinnee/ferretry/issues/146)) ([833dd55](https://github.com/kirinnee/ferretry/commit/833dd5598b1526f35ac710c01f43ddb701a56af4))

## [0.89.0](https://github.com/kirinnee/ferretry/compare/v0.88.0...v0.89.0) (2026-08-01)

### Features

* **pwa:** port sessions dashboard and migration sheets ([#144](https://github.com/kirinnee/ferretry/issues/144)) ([c316918](https://github.com/kirinnee/ferretry/commit/c316918616c040504bdd18f0942969f631f8d2f5))

## [0.88.0](https://github.com/kirinnee/ferretry/compare/v0.87.0...v0.88.0) (2026-08-01)

### Features

* **pwa:** port thinking indicator ([#141](https://github.com/kirinnee/ferretry/issues/141)) ([afb88db](https://github.com/kirinnee/ferretry/commit/afb88db3ede25d1e68acf2bb3144dfe38e95929f))

## [0.87.0](https://github.com/kirinnee/ferretry/compare/v0.86.0...v0.87.0) (2026-08-01)

### Features

* **pwa:** port the skills, usage and project-scope surfaces ([#142](https://github.com/kirinnee/ferretry/issues/142)) ([653d20d](https://github.com/kirinnee/ferretry/commit/653d20ddd5c126d70a9ecf38e85d6d39781307f4)), closes [#135](https://github.com/kirinnee/ferretry/issues/135) [#135](https://github.com/kirinnee/ferretry/issues/135)

## [0.86.0](https://github.com/kirinnee/ferretry/compare/v0.85.0...v0.86.0) (2026-08-01)

### Features

* **pwa:** port the Files tab, attachments, the terminal pane and the in-app browser ([#137](https://github.com/kirinnee/ferretry/issues/137)) ([60fb362](https://github.com/kirinnee/ferretry/commit/60fb36229c84ad1e84ac264cfcedd4715fd59d12)), closes [#123](https://github.com/kirinnee/ferretry/issues/123) [#127](https://github.com/kirinnee/ferretry/issues/127)

## [0.85.0](https://github.com/kirinnee/ferretry/compare/v0.84.0...v0.85.0) (2026-08-01)

### Features

* **daemon:** add atomic warden report writes ([#138](https://github.com/kirinnee/ferretry/issues/138)) ([a1cf683](https://github.com/kirinnee/ferretry/commit/a1cf683fe8f7ba5e1e1525d7b91d09905b5a8a22))
* **pwa:** port the runtime controls, the agent sidebar and the chat page model ([#140](https://github.com/kirinnee/ferretry/issues/140)) ([b997c84](https://github.com/kirinnee/ferretry/commit/b997c849daeee5b257a72339f229056da6c4652d)), closes [#129](https://github.com/kirinnee/ferretry/issues/129)

### Fixes

* **pwa:** distinguish missing warden reports ([#139](https://github.com/kirinnee/ferretry/issues/139)) ([19bae20](https://github.com/kirinnee/ferretry/commit/19bae20c6f70c9f9718d9f33414dcb9356b0900d))

## [0.84.0](https://github.com/kirinnee/ferretry/compare/v0.83.0...v0.84.0) (2026-08-01)

### Features

* **daemon:** serve skills and project catalogs ([#136](https://github.com/kirinnee/ferretry/issues/136)) ([e342573](https://github.com/kirinnee/ferretry/commit/e3425733f520e25d8444a22d2dec96a2adb38647))

## [0.83.0](https://github.com/kirinnee/ferretry/compare/v0.82.0...v0.83.0) (2026-08-01)

### Features

* **pwa:** port lineage and harden session analytics ([#135](https://github.com/kirinnee/ferretry/issues/135)) ([0e036a5](https://github.com/kirinnee/ferretry/commit/0e036a58b76d10f390377abbae80805103dff7c3))

## [0.82.0](https://github.com/kirinnee/ferretry/compare/v0.81.0...v0.82.0) (2026-08-01)

### Features

* **pwa:** port the dictation UI, daemon-bound ([#134](https://github.com/kirinnee/ferretry/issues/134)) ([209ea05](https://github.com/kirinnee/ferretry/commit/209ea05af366e2e7fedf0f54dae396957d96933b)), closes [#126](https://github.com/kirinnee/ferretry/issues/126)
* **pwa:** port visual viewport and density hooks ([#133](https://github.com/kirinnee/ferretry/issues/133)) ([7fe9708](https://github.com/kirinnee/ferretry/commit/7fe970820e0d002eec8183bae2b07602f06b4678))

## [0.81.0](https://github.com/kirinnee/ferretry/compare/v0.80.0...v0.81.0) (2026-08-01)

### Features

* **pwa:** port browser, analytics, and learning surfaces ([#132](https://github.com/kirinnee/ferretry/issues/132)) ([f4f3884](https://github.com/kirinnee/ferretry/commit/f4f3884d855ff2cb03d3f4a5c603c21b63eb7fe3))

## [0.80.0](https://github.com/kirinnee/ferretry/compare/v0.79.0...v0.80.0) (2026-08-01)

### Features

* **pwa:** port browser interaction hooks ([#131](https://github.com/kirinnee/ferretry/issues/131)) ([b1a9bc4](https://github.com/kirinnee/ferretry/commit/b1a9bc4962b91a875c71553c8f8fc918c8857114))
* **pwa:** port the chat surface machinery — markdown, references, quoting, system blocks ([#129](https://github.com/kirinnee/ferretry/issues/129)) ([463b9e5](https://github.com/kirinnee/ferretry/commit/463b9e521c5471d095903994c67dc9ee25134bd8))

## [0.79.0](https://github.com/kirinnee/ferretry/compare/v0.78.0...v0.79.0) (2026-08-01)

### Features

* **pwa:** port lineage safety primitives ([#130](https://github.com/kirinnee/ferretry/issues/130)) ([18b717d](https://github.com/kirinnee/ferretry/commit/18b717d31e9e41206007580be127bc12bee0f0a2))

## [0.78.0](https://github.com/kirinnee/ferretry/compare/v0.77.0...v0.78.0) (2026-08-01)

### Features

* **pwa:** add attachment contracts ([#127](https://github.com/kirinnee/ferretry/issues/127)) ([a480135](https://github.com/kirinnee/ferretry/commit/a4801351084d22a5cbaa48f964f60b6cd47b39c4))
* **pwa:** add daemon-scoped settings page ([#128](https://github.com/kirinnee/ferretry/issues/128)) ([6aaaa39](https://github.com/kirinnee/ferretry/commit/6aaaa3955382cdfa469d566e39a957ad6587dc9d))
* **pwa:** port the dictation and speech-to-text subsystem, daemon-bound ([#126](https://github.com/kirinnee/ferretry/issues/126)) ([732e957](https://github.com/kirinnee/ferretry/commit/732e957cf8ab65fd007d830ba487e5ff44edff40)), closes [#32](https://github.com/kirinnee/ferretry/issues/32)

## [0.77.0](https://github.com/kirinnee/ferretry/compare/v0.76.0...v0.77.0) (2026-08-01)

### Features

* **pwa:** add daemon-scoped new session page ([#125](https://github.com/kirinnee/ferretry/issues/125)) ([ffdbe5a](https://github.com/kirinnee/ferretry/commit/ffdbe5a46ea83d35b58e4123fdf5a7be3ff696ff))

## [0.76.0](https://github.com/kirinnee/ferretry/compare/v0.75.0...v0.76.0) (2026-08-01)

### Features

* **pwa:** port daemon-scoped files tree foundation ([#123](https://github.com/kirinnee/ferretry/issues/123)) ([56be222](https://github.com/kirinnee/ferretry/commit/56be222755eb7d9511703431a5a9927cde59adef))
* **pwa:** port the fleet grouping, task projections and fleet-view hook ([#124](https://github.com/kirinnee/ferretry/issues/124)) ([d4c4393](https://github.com/kirinnee/ferretry/commit/d4c4393afd3ebfb0ba91281bd6ca4033458006fe))

## [0.75.0](https://github.com/kirinnee/ferretry/compare/v0.74.0...v0.75.0) (2026-08-01)

### Features

* **pwa:** add daemon-scoped pin and attention hooks ([#122](https://github.com/kirinnee/ferretry/issues/122)) ([461da82](https://github.com/kirinnee/ferretry/commit/461da823095ec2ab29898df9e4da2b3c5132a52d))

## [0.74.0](https://github.com/kirinnee/ferretry/compare/v0.73.0...v0.74.0) (2026-08-01)

### Features

* **pwa:** add warden attention surface ([#121](https://github.com/kirinnee/ferretry/issues/121)) ([f89e835](https://github.com/kirinnee/ferretry/commit/f89e8355b0759275367d052df05caa4fdc7fd505))

## [0.73.0](https://github.com/kirinnee/ferretry/compare/v0.72.0...v0.73.0) (2026-08-01)

### Features

* **daemon:** request the child grant a --board-access start asks for ([#120](https://github.com/kirinnee/ferretry/issues/120)) ([c6854c2](https://github.com/kirinnee/ferretry/commit/c6854c264569384d86161b38ba004c35c4835d49))
* **pwa:** paint markdown syntax behind the composer, and port its trigger engine ([#119](https://github.com/kirinnee/ferretry/issues/119)) ([1c3becc](https://github.com/kirinnee/ferretry/commit/1c3becc674a985a53e6180733c9a294c78a9a807))

## [0.72.0](https://github.com/kirinnee/ferretry/compare/v0.71.0...v0.72.0) (2026-08-01)

### Features

* **pwa:** scope attachment blob cache by daemon ([#118](https://github.com/kirinnee/ferretry/issues/118)) ([217ee18](https://github.com/kirinnee/ferretry/commit/217ee18eda178db93d57475d98a7daea92d258ed))

## [0.71.0](https://github.com/kirinnee/ferretry/compare/v0.70.0...v0.71.0) (2026-08-01)

### Features

* **pwa:** port the send ledger's transcript row ([#117](https://github.com/kirinnee/ferretry/issues/117)) ([3147e7f](https://github.com/kirinnee/ferretry/commit/3147e7f902787907899eb823528c7df9e7adac46))

## [0.70.0](https://github.com/kirinnee/ferretry/compare/v0.69.0...v0.70.0) (2026-08-01)

### Features

* **pwa:** add daemon pairing screen ([#116](https://github.com/kirinnee/ferretry/issues/116)) ([5d049d9](https://github.com/kirinnee/ferretry/commit/5d049d93891b950d693e321096861ea303118396))

## [0.69.0](https://github.com/kirinnee/ferretry/compare/v0.68.0...v0.69.0) (2026-08-01)

### Features

* **daemon:** mount the dictation surface, and stop the invocation gate matching a field name inside a string ([#114](https://github.com/kirinnee/ferretry/issues/114)) ([2cf3ec7](https://github.com/kirinnee/ferretry/commit/2cf3ec7f83aa983468afe92671dfdf985eea9e34))
* **pwa:** port the transcript's tool runs ([#115](https://github.com/kirinnee/ferretry/issues/115)) ([edd53e9](https://github.com/kirinnee/ferretry/commit/edd53e9c3e352c5bb019418dec6b28e3a2e8377f))

## [0.68.0](https://github.com/kirinnee/ferretry/compare/v0.67.0...v0.68.0) (2026-08-01)

### Features

* **pwa:** port the fleet navigation rail ([#113](https://github.com/kirinnee/ferretry/issues/113)) ([46bb127](https://github.com/kirinnee/ferretry/commit/46bb127b277c93b0120eed5317d498142acc3e8f))
* **pwa:** render task name context ([#112](https://github.com/kirinnee/ferretry/issues/112)) ([390fcc3](https://github.com/kirinnee/ferretry/commit/390fcc351bfbeffdacc849c17faf1e7b33705177))

## [0.67.0](https://github.com/kirinnee/ferretry/compare/v0.66.0...v0.67.0) (2026-08-01)

### Features

* **pwa:** add daemon-scoped notification data layer ([#111](https://github.com/kirinnee/ferretry/issues/111)) ([16b1a6d](https://github.com/kirinnee/ferretry/commit/16b1a6dc8eb0864883eb5ba615165b7e45b514f7))

## [0.66.0](https://github.com/kirinnee/ferretry/compare/v0.65.0...v0.66.0) (2026-08-01)

### Features

* **daemon:** resolve a task's assignee by the teammate name a human typed ([#110](https://github.com/kirinnee/ferretry/issues/110)) ([40e1537](https://github.com/kirinnee/ferretry/commit/40e1537e6c89e6147f4dee6d88fdfef94f9a79b6)), closes [#5](https://github.com/kirinnee/ferretry/issues/5) [#5](https://github.com/kirinnee/ferretry/issues/5)
* **pwa:** add dictation shortcut settings ([#109](https://github.com/kirinnee/ferretry/issues/109)) ([f0c5c91](https://github.com/kirinnee/ferretry/commit/f0c5c916408ce86a9b048ea208f83653695826e5))
* **pwa:** port the sidebar's destructive path — row menu, gesture, bulk stop confirmation ([#108](https://github.com/kirinnee/ferretry/issues/108)) ([2b67e53](https://github.com/kirinnee/ferretry/commit/2b67e5371972c3161afb473b690e087f8a7c5656))

## [0.65.0](https://github.com/kirinnee/ferretry/compare/v0.64.0...v0.65.0) (2026-08-01)

### Features

* **daemon:** mount the human browser-login window ([#106](https://github.com/kirinnee/ferretry/issues/106)) ([2ab7816](https://github.com/kirinnee/ferretry/commit/2ab781693b772e32b654883624b47d2d01761ea7)), closes [#15](https://github.com/kirinnee/ferretry/issues/15)

### Fixes

* **pwa:** preserve learning proposal controls ([#107](https://github.com/kirinnee/ferretry/issues/107)) ([c5dd85b](https://github.com/kirinnee/ferretry/commit/c5dd85b0bfc4e00a3d30aa953156196e15016708))

## [0.64.0](https://github.com/kirinnee/ferretry/compare/v0.63.1...v0.64.0) (2026-08-01)

### Features

* **pwa:** add daemon-scoped pins board ([#105](https://github.com/kirinnee/ferretry/issues/105)) ([685cf3d](https://github.com/kirinnee/ferretry/commit/685cf3d0759491b90254de49446bfbd0e2c2d65e))

## [0.63.1](https://github.com/kirinnee/ferretry/compare/v0.63.0...v0.63.1) (2026-08-01)

### Fixes

* **pwa:** reset transcript state per daemon ([#104](https://github.com/kirinnee/ferretry/issues/104)) ([26481fc](https://github.com/kirinnee/ferretry/commit/26481fc60d93348c8008b5652e019bf6ecd34b19))

## [0.63.0](https://github.com/kirinnee/ferretry/compare/v0.62.0...v0.63.0) (2026-08-01)

### Features

* **pwa:** add pins ledger trigger ([#103](https://github.com/kirinnee/ferretry/issues/103)) ([77350a1](https://github.com/kirinnee/ferretry/commit/77350a186b1337abe6fbccd770f56775ee62f704))

## [0.62.0](https://github.com/kirinnee/ferretry/compare/v0.61.0...v0.62.0) (2026-08-01)

### Features

* **daemon:** mount the task board membership lifecycle ([#102](https://github.com/kirinnee/ferretry/issues/102)) ([d3622b9](https://github.com/kirinnee/ferretry/commit/d3622b9c9bfab712588f4b52f8483f63e0b950cb))

## [0.61.0](https://github.com/kirinnee/ferretry/compare/v0.60.0...v0.61.0) (2026-07-31)

### Features

* **pwa:** port session task projections ([#101](https://github.com/kirinnee/ferretry/issues/101)) ([345df1f](https://github.com/kirinnee/ferretry/commit/345df1ff48480521e09acb7049773a3be08ce564))

## [0.60.0](https://github.com/kirinnee/ferretry/compare/v0.59.0...v0.60.0) (2026-07-31)

### Features

* **pwa:** port the agent sidebar's action, stop-scope and decision model ([#99](https://github.com/kirinnee/ferretry/issues/99)) ([59efa03](https://github.com/kirinnee/ferretry/commit/59efa037d4f3fe0b2c3e0ab05a82d8c354d887d7))

### Fixes

* **pwa:** keep remote browser source text-safe ([#100](https://github.com/kirinnee/ferretry/issues/100)) ([f330f2f](https://github.com/kirinnee/ferretry/commit/f330f2f47b9028e9fcae8c5fd801f1e24222f931))
* **pwa:** keep remote browser source text-safe ([#98](https://github.com/kirinnee/ferretry/issues/98)) ([9679da4](https://github.com/kirinnee/ferretry/commit/9679da49068a3b3b06dea649483c949507d22edf))

## [0.59.0](https://github.com/kirinnee/ferretry/compare/v0.58.0...v0.59.0) (2026-07-31)

### Features

* **pwa:** add notification settings surface ([#96](https://github.com/kirinnee/ferretry/issues/96)) ([73c61d1](https://github.com/kirinnee/ferretry/commit/73c61d147bf2e71440c3ed16dc7f30648c49425d))

## [0.58.0](https://github.com/kirinnee/ferretry/compare/v0.57.0...v0.58.0) (2026-07-31)

### Features

* **pwa:** add daemon-scoped data layer ([#97](https://github.com/kirinnee/ferretry/issues/97)) ([40f5f5f](https://github.com/kirinnee/ferretry/commit/40f5f5f8c40b85b377fba818a9f8c8ce2fba620a))
* **pwa:** make the remote browser drivable — chrome, daemon-scoped state, and input ([#95](https://github.com/kirinnee/ferretry/issues/95)) ([1df3282](https://github.com/kirinnee/ferretry/commit/1df3282ce6a33dfe59e948b0fdf36f41d18080ea))

## [0.57.0](https://github.com/kirinnee/ferretry/compare/v0.56.0...v0.57.0) (2026-07-31)

### Features

* **pwa:** add attention ledger ([#91](https://github.com/kirinnee/ferretry/issues/91)) ([876e4d4](https://github.com/kirinnee/ferretry/commit/876e4d42552653bd6774b7c095c9b2e5e6127623))
* **pwa:** port the command palette ([#92](https://github.com/kirinnee/ferretry/issues/92)) ([d74f741](https://github.com/kirinnee/ferretry/commit/d74f7410ebffe20b72e57f3bfd41273eb70fc28a))

### Fixes

* **daemon:** bound git runner timeouts ([#94](https://github.com/kirinnee/ferretry/issues/94)) ([1ec9d2e](https://github.com/kirinnee/ferretry/commit/1ec9d2e9867ac58d2c41ab0f4f0d966311abc91e))

## [0.56.0](https://github.com/kirinnee/ferretry/compare/v0.55.0...v0.56.0) (2026-07-31)

### Features

* **daemon:** hand a started agent the files its opening message attached ([#88](https://github.com/kirinnee/ferretry/issues/88)) ([97b93f1](https://github.com/kirinnee/ferretry/commit/97b93f12b9ef49484850eb6294df79393895d4a6)), closes [#12](https://github.com/kirinnee/ferretry/issues/12) [#13](https://github.com/kirinnee/ferretry/issues/13)
* **daemon:** mint a per-session credential and carry it through the tmux launch seam ([#89](https://github.com/kirinnee/ferretry/issues/89)) ([ebcdd2f](https://github.com/kirinnee/ferretry/commit/ebcdd2f496b2556a67640cac3515cf8a25612f73)), closes [#5](https://github.com/kirinnee/ferretry/issues/5)
* **pwa:** add daemon-bound global analytics ([#87](https://github.com/kirinnee/ferretry/issues/87)) ([5fda1b4](https://github.com/kirinnee/ferretry/commit/5fda1b45d279418516228e549d2b53cf1ac55315))
* **pwa:** add encrypted attachment unlock prompt ([#90](https://github.com/kirinnee/ferretry/issues/90)) ([0f552b1](https://github.com/kirinnee/ferretry/commit/0f552b1217ad4129bc3b2994650ad22ee83e0a55))
* **pwa:** port the theme picker and its preference model ([#86](https://github.com/kirinnee/ferretry/issues/86)) ([62aadcd](https://github.com/kirinnee/ferretry/commit/62aadcdfbeea141559ad29a8bfc1be53cb3c97f8))

### Fixes

* **pwa:** give the query-starter row a role its aria-label supports ([575c6f0](https://github.com/kirinnee/ferretry/commit/575c6f079f039272b92cfcee5c3f47441043c1ab))

## [0.55.0](https://github.com/kirinnee/ferretry/compare/v0.54.0...v0.55.0) (2026-07-31)

### Features

* **pwa:** add structured question form ([#84](https://github.com/kirinnee/ferretry/issues/84)) ([797167e](https://github.com/kirinnee/ferretry/commit/797167e198b89d2e339b1103b7255fd1ca099ea7))
* **pwa:** add task dependency graph ([#85](https://github.com/kirinnee/ferretry/issues/85)) ([0b346e4](https://github.com/kirinnee/ferretry/commit/0b346e45704b58fd0e29bbb0e351f62494b2258d))

## [0.54.0](https://github.com/kirinnee/ferretry/compare/v0.53.0...v0.54.0) (2026-07-31)

### Features

* **pwa:** add learning status header ([#76](https://github.com/kirinnee/ferretry/issues/76)) ([41247ca](https://github.com/kirinnee/ferretry/commit/41247ca2e695b7a34beb84e47df32e0dbebf87d9))

## [0.53.0](https://github.com/kirinnee/ferretry/compare/v0.52.0...v0.53.0) (2026-07-31)

### Features

* **pwa:** add daemon-scoped data foundations ([#82](https://github.com/kirinnee/ferretry/issues/82)) ([b3794b7](https://github.com/kirinnee/ferretry/commit/b3794b731ae4d27ea86d091b6be2cc0ed459594b)), closes [#48](https://github.com/kirinnee/ferretry/issues/48) [#login](https://github.com/kirinnee/ferretry/issues/login) [#login](https://github.com/kirinnee/ferretry/issues/login)

## [0.52.0](https://github.com/kirinnee/ferretry/compare/v0.51.0...v0.52.0) (2026-07-31)

### Features

* **pwa:** show composer quota ([#83](https://github.com/kirinnee/ferretry/issues/83)) ([f6d2daf](https://github.com/kirinnee/ferretry/commit/f6d2daf29c51da9808c292f4def5e99335314c49))

## [0.51.0](https://github.com/kirinnee/ferretry/compare/v0.50.0...v0.51.0) (2026-07-31)

### Features

* **pwa:** join optimistic sends to the durable ledger ([#81](https://github.com/kirinnee/ferretry/issues/81)) ([736a924](https://github.com/kirinnee/ferretry/commit/736a9249c2191ea86ba599d25d1bd0e75ae5644e))

## [0.50.0](https://github.com/kirinnee/ferretry/compare/v0.49.0...v0.50.0) (2026-07-31)

### Features

* **pwa:** add learning proposal review ([#80](https://github.com/kirinnee/ferretry/issues/80)) ([48aeba0](https://github.com/kirinnee/ferretry/commit/48aeba062fb92da1775e3603bf5a151c31c7798e))

## [0.49.0](https://github.com/kirinnee/ferretry/compare/v0.48.0...v0.49.0) (2026-07-31)

### Features

* **pwa:** port the session header ([#77](https://github.com/kirinnee/ferretry/issues/77)) ([6ff3d12](https://github.com/kirinnee/ferretry/commit/6ff3d1223676c1379c7f2c5c92a4cf11f2f801fa))
* **pwa:** port web terminals and the send ledger read model ([#78](https://github.com/kirinnee/ferretry/issues/78)) ([d843282](https://github.com/kirinnee/ferretry/commit/d84328227ab6c6e7151eddd522ca07b0a3219056))

## [0.48.0](https://github.com/kirinnee/ferretry/compare/v0.47.0...v0.48.0) (2026-07-31)

### Features

* **pwa:** add analytics query completion ([#75](https://github.com/kirinnee/ferretry/issues/75)) ([5d610b0](https://github.com/kirinnee/ferretry/commit/5d610b05fd4d1f3ccc18462e3c6c14f3ff234a2a))
* **pwa:** add markdown composer settings ([#74](https://github.com/kirinnee/ferretry/issues/74)) ([33c5237](https://github.com/kirinnee/ferretry/commit/33c5237e66e6e6f9127bd48194c25a3cdcf04528))

## [0.47.0](https://github.com/kirinnee/ferretry/compare/v0.46.0...v0.47.0) (2026-07-31)

### Features

* **pwa:** port PWA side pane shell ([#73](https://github.com/kirinnee/ferretry/issues/73)) ([6228154](https://github.com/kirinnee/ferretry/commit/622815499c6dfcce7e3a11df7a612f2adca7970d))
* **pwa:** port the conversation-width control ([#72](https://github.com/kirinnee/ferretry/issues/72)) ([115ff59](https://github.com/kirinnee/ferretry/commit/115ff595aeeaaee7d94cfa70555bbae011967ce5))

## [0.46.0](https://github.com/kirinnee/ferretry/compare/v0.45.0...v0.46.0) (2026-07-31)

### Features

* **pwa:** add analytics time-series charts ([#70](https://github.com/kirinnee/ferretry/issues/70)) ([84d368c](https://github.com/kirinnee/ferretry/commit/84d368c17b83065f85985dd32a171ad039d88d72))

## [0.45.0](https://github.com/kirinnee/ferretry/compare/v0.44.0...v0.45.0) (2026-07-31)

### Features

* **pwa:** port the shared session marks, context menu and chunk error boundary ([#69](https://github.com/kirinnee/ferretry/issues/69)) ([cffc1fb](https://github.com/kirinnee/ferretry/commit/cffc1fb0ace78a1d1de916642f44057280bccbb5)), closes [#menu](https://github.com/kirinnee/ferretry/issues/menu)

## [0.44.0](https://github.com/kirinnee/ferretry/compare/v0.43.0...v0.44.0) (2026-07-31)

### Features

* **pwa:** show daemon session quota ([#67](https://github.com/kirinnee/ferretry/issues/67)) ([3b6d066](https://github.com/kirinnee/ferretry/commit/3b6d066c741c3a36241cb5ed51ab5fe395d9647c))

## [0.43.0](https://github.com/kirinnee/ferretry/compare/v0.42.0...v0.43.0) (2026-07-31)

### Features

* **daemon:** mount the revive and the start recovery read ([#64](https://github.com/kirinnee/ferretry/issues/64)) ([9141857](https://github.com/kirinnee/ferretry/commit/91418570eeab5abac6b439f02ca058f4dcbd5239))
* **pwa:** port analytics result ledger ([#66](https://github.com/kirinnee/ferretry/issues/66)) ([b5132cf](https://github.com/kirinnee/ferretry/commit/b5132cf77ca5eb7425a7ed42af78e2715b433def))
* **pwa:** port warden feature surfaces ([#65](https://github.com/kirinnee/ferretry/issues/65)) ([cd70fe0](https://github.com/kirinnee/ferretry/commit/cd70fe0ed78c474226ed76d28a9c0f5acc6191b2))

## [0.42.0](https://github.com/kirinnee/ferretry/compare/v0.41.0...v0.42.0) (2026-07-31)

### Features

* **pwa:** improve session screen status cues ([#63](https://github.com/kirinnee/ferretry/issues/63)) ([4ce9b90](https://github.com/kirinnee/ferretry/commit/4ce9b902517a2a09b5034858a2194bf933905928))

## [0.41.0](https://github.com/kirinnee/ferretry/compare/v0.40.0...v0.41.0) (2026-07-31)

### Features

* **pwa:** add daemon-scoped remote browser viewer ([#62](https://github.com/kirinnee/ferretry/issues/62)) ([f0bd262](https://github.com/kirinnee/ferretry/commit/f0bd26256ad5fa96a8671fcb650adb4b37a95d18))

## [0.40.0](https://github.com/kirinnee/ferretry/compare/v0.39.0...v0.40.0) (2026-07-31)

### Features

* **daemon:** port STT audio capture, models, and enhancement ([#17](https://github.com/kirinnee/ferretry/issues/17)) ([fa33747](https://github.com/kirinnee/ferretry/commit/fa337470e32b2349eef9010fe5e2804e7dc67c5e))

## [0.39.0](https://github.com/kirinnee/ferretry/compare/v0.38.0...v0.39.0) (2026-07-31)

### Features

* **pwa:** port the app shell, side-pane chrome and layout primitives ([#61](https://github.com/kirinnee/ferretry/issues/61)) ([642805b](https://github.com/kirinnee/ferretry/commit/642805bb33583c1a21b37495d8f6db1db6716ff8)), closes [#46](https://github.com/kirinnee/ferretry/issues/46)

## [0.38.0](https://github.com/kirinnee/ferretry/compare/v0.37.0...v0.38.0) (2026-07-31)

### Features

* **daemon:** claim the callsign a start asks for ([#59](https://github.com/kirinnee/ferretry/issues/59)) ([e078f9d](https://github.com/kirinnee/ferretry/commit/e078f9de25592d554863fd6e9bcad31cfad21411)), closes [#9](https://github.com/kirinnee/ferretry/issues/9)
* **pwa:** add daemon-scoped browser transport ([#60](https://github.com/kirinnee/ferretry/issues/60)) ([f8d7123](https://github.com/kirinnee/ferretry/commit/f8d7123874b7ae0dd223f109e661f4fd7b5c1a2a))

## [0.37.0](https://github.com/kirinnee/ferretry/compare/v0.36.0...v0.37.0) (2026-07-31)

### Features

* **daemon:** mount session start and stop over the reconciled document ([#57](https://github.com/kirinnee/ferretry/issues/57)) ([1525b85](https://github.com/kirinnee/ferretry/commit/1525b8544ef41b0ce381c9d340c4de05edee7e40))
* **pwa:** port browser login banner ([#58](https://github.com/kirinnee/ferretry/issues/58)) ([b4d770a](https://github.com/kirinnee/ferretry/commit/b4d770aac507aaaeeeff46789d4b0535aa231349))

## [0.36.0](https://github.com/kirinnee/ferretry/compare/v0.35.0...v0.36.0) (2026-07-31)

### Features

* **pwa:** add daemon-scoped pin cache ([#56](https://github.com/kirinnee/ferretry/issues/56)) ([9404a4a](https://github.com/kirinnee/ferretry/commit/9404a4a6bd3ba80fa6a75fccd6abc8dd9e8522f4))
* **pwa:** port session context controls ([#55](https://github.com/kirinnee/ferretry/issues/55)) ([bdadaee](https://github.com/kirinnee/ferretry/commit/bdadaeec3234ba8c43018c5384e758211c72e244))

## [0.35.0](https://github.com/kirinnee/ferretry/compare/v0.34.0...v0.35.0) (2026-07-31)

### Features

* **pwa:** add daemon-scoped attention cache ([#54](https://github.com/kirinnee/ferretry/issues/54)) ([47dcbb6](https://github.com/kirinnee/ferretry/commit/47dcbb6a861cf3078f0ad0c22bd2e5e77d84c14c))
* **pwa:** port the task surfaces and the warden fleet-checks strip ([#53](https://github.com/kirinnee/ferretry/issues/53)) ([e211a7a](https://github.com/kirinnee/ferretry/commit/e211a7aa8c9bdbb3279bf291ae764ddf320b6ab4))

## [0.34.0](https://github.com/kirinnee/ferretry/compare/v0.33.0...v0.34.0) (2026-07-31)

### Features

* **daemon:** mount the self-check behind the health route the CLI parses ([#52](https://github.com/kirinnee/ferretry/issues/52)) ([7ff6108](https://github.com/kirinnee/ferretry/commit/7ff6108c27c429f058ccfdb35b8c91ec9de5dde9)), closes [#19](https://github.com/kirinnee/ferretry/issues/19)

## [0.33.0](https://github.com/kirinnee/ferretry/compare/v0.32.0...v0.33.0) (2026-07-31)

### Features

* **pwa:** add daemon-scoped model catalogs ([#50](https://github.com/kirinnee/ferretry/issues/50)) ([01225f1](https://github.com/kirinnee/ferretry/commit/01225f15ff07b4aa5199412fcd1266435efcf454))

## [0.32.0](https://github.com/kirinnee/ferretry/compare/v0.31.0...v0.32.0) (2026-07-31)

### Features

* **pwa:** port the app shell — primitives, side-pane tab chrome, and the modal shell ([#49](https://github.com/kirinnee/ferretry/issues/49)) ([06aa3a4](https://github.com/kirinnee/ferretry/commit/06aa3a4a40ddba88fe59b3c83df15d15cdc0cd0e)), closes [#46](https://github.com/kirinnee/ferretry/issues/46)

## [0.31.0](https://github.com/kirinnee/ferretry/compare/v0.30.0...v0.31.0) (2026-07-31)

### Features

* **daemon:** mount the team recommender and verify every remaining blocker ([#48](https://github.com/kirinnee/ferretry/issues/48)) ([28f2616](https://github.com/kirinnee/ferretry/commit/28f261647f919ecb49d73b7b8cccee3649488edd))
* **pwa:** add session screen components ([#46](https://github.com/kirinnee/ferretry/issues/46)) ([df8e844](https://github.com/kirinnee/ferretry/commit/df8e8444daa20a6577d9f014c05f0bfc67ff1180))

### Fixes

* **pwa:** clear the four lint errors that turned main red ([1e81b27](https://github.com/kirinnee/ferretry/commit/1e81b27d5153e890e09bbcb0e096d7afc9f00fbe)), closes [#45](https://github.com/kirinnee/ferretry/issues/45) [#46](https://github.com/kirinnee/ferretry/issues/46)

## [0.30.0](https://github.com/kirinnee/ferretry/compare/v0.29.0...v0.30.0) (2026-07-31)

### Features

* **pwa:** add daemon-scoped page shells ([#45](https://github.com/kirinnee/ferretry/issues/45)) ([af54547](https://github.com/kirinnee/ferretry/commit/af54547d94d96f58f2c3140fc0a9f766922df695))
* **pwa:** add ticketed event transport ([#44](https://github.com/kirinnee/ferretry/issues/44)) ([34a3b0b](https://github.com/kirinnee/ferretry/commit/34a3b0b955983efcd2bec315c6afd4c458067656))

## [0.29.0](https://github.com/kirinnee/ferretry/compare/v0.28.0...v0.29.0) (2026-07-31)

### Features

* **pwa:** port initial hooks and audio worklet ([#41](https://github.com/kirinnee/ferretry/issues/41)) ([c41f9d6](https://github.com/kirinnee/ferretry/commit/c41f9d6867a8ab9dc957150b125c4fcc47e80b1e))

## [0.28.0](https://github.com/kirinnee/ferretry/compare/v0.27.0...v0.28.0) (2026-07-31)

### Features

* **daemon:** mount session read surface ([#43](https://github.com/kirinnee/ferretry/issues/43)) ([b9e2044](https://github.com/kirinnee/ferretry/commit/b9e2044cfcdb7f6519826feec190eb32199c73ae))
* **pwa:** add daemon-bound API client ([#42](https://github.com/kirinnee/ferretry/issues/42)) ([440dd2a](https://github.com/kirinnee/ferretry/commit/440dd2a88815ba8b37bf6dd93df28b1bf7c040e5))

## [0.27.0](https://github.com/kirinnee/ferretry/compare/v0.26.0...v0.27.0) (2026-07-31)

### Features

* **pwa:** persist drafts by daemon scope ([#40](https://github.com/kirinnee/ferretry/issues/40)) ([83c1259](https://github.com/kirinnee/ferretry/commit/83c12597d0e0ccecdae98bca4cf40c25b119e529))

## [0.26.0](https://github.com/kirinnee/ferretry/compare/v0.25.0...v0.26.0) (2026-07-31)

### Features

* **pwa:** add multi-daemon connection seam ([#39](https://github.com/kirinnee/ferretry/issues/39)) ([3212ef9](https://github.com/kirinnee/ferretry/commit/3212ef9da870a557f97751646989706d4d59ac1b))

## [0.25.0](https://github.com/kirinnee/ferretry/compare/v0.24.0...v0.25.0) (2026-07-31)

### Features

* **daemon:** mount the learning review board and retire the dead task-title duplicate ([#38](https://github.com/kirinnee/ferretry/issues/38)) ([46ca99b](https://github.com/kirinnee/ferretry/commit/46ca99bdd3a35c6d04b16ee9c477d0f6501f7401))

## [0.24.0](https://github.com/kirinnee/ferretry/compare/v0.23.0...v0.24.0) (2026-07-31)

### Features

* **daemon:** add the WebSocket seam and mount terminal streaming ([#37](https://github.com/kirinnee/ferretry/issues/37)) ([b772ae8](https://github.com/kirinnee/ferretry/commit/b772ae81c07918d76bbc18a24ea687f649c14a42))

## [0.23.0](https://github.com/kirinnee/ferretry/compare/v0.22.0...v0.23.0) (2026-07-31)

### Features

* **cli:** port the learning, dictation, worktree and fleet command groups ([#36](https://github.com/kirinnee/ferretry/issues/36)) ([b6f48e3](https://github.com/kirinnee/ferretry/commit/b6f48e321ac9bfae859e0689b3fe1fa80cc4da0d))

## [0.22.0](https://github.com/kirinnee/ferretry/compare/v0.21.0...v0.22.0) (2026-07-31)

### Features

* **daemon:** mount the task boards, analytics, terminals and callsigns ([#35](https://github.com/kirinnee/ferretry/issues/35)) ([94e6558](https://github.com/kirinnee/ferretry/commit/94e65587e2a927c0c81d2b2012d58b9740e240fa)), closes [#10](https://github.com/kirinnee/ferretry/issues/10) [#10](https://github.com/kirinnee/ferretry/issues/10) [#6](https://github.com/kirinnee/ferretry/issues/6) [#6](https://github.com/kirinnee/ferretry/issues/6) [#21](https://github.com/kirinnee/ferretry/issues/21) [#21](https://github.com/kirinnee/ferretry/issues/21) [#9](https://github.com/kirinnee/ferretry/issues/9)

## [0.21.0](https://github.com/kirinnee/ferretry/compare/v0.20.0...v0.21.0) (2026-07-31)

### Features

* **daemon:** stamp warden lineage at spawn and port the Codex harness quirks ([#33](https://github.com/kirinnee/ferretry/issues/33)) ([05e94c6](https://github.com/kirinnee/ferretry/commit/05e94c60ce46cd80dc222d46a6f3caa9334f0ca0))

## [0.20.0](https://github.com/kirinnee/ferretry/compare/v0.19.0...v0.20.0) (2026-07-31)

### Features

* **daemon:** port session resume/revive and daemon wedge/health detection ([#34](https://github.com/kirinnee/ferretry/issues/34)) ([301c072](https://github.com/kirinnee/ferretry/commit/301c072759def9948d83e7887b1ca1490bbefd19))

## [0.19.0](https://github.com/kirinnee/ferretry/compare/v0.18.0...v0.19.0) (2026-07-31)

### Features

* **cli:** port the daemon control command group ([#31](https://github.com/kirinnee/ferretry/issues/31)) ([d080ab4](https://github.com/kirinnee/ferretry/commit/d080ab4bbdf4cfe6db537b06549b0765cb6861fb))
* **daemon:** complete the daemon composition root and mount the pin and attention boards ([#32](https://github.com/kirinnee/ferretry/issues/32)) ([576c9e8](https://github.com/kirinnee/ferretry/commit/576c9e88af2a525200b1c1c8f7224c90ad91130d)), closes [#14](https://github.com/kirinnee/ferretry/issues/14)

## [0.18.0](https://github.com/kirinnee/ferretry/compare/v0.17.0...v0.18.0) (2026-07-31)

### Features

* **cli:** port the browser and bulk stop command groups ([#29](https://github.com/kirinnee/ferretry/issues/29)) ([290622e](https://github.com/kirinnee/ferretry/commit/290622ea5f12d9eaefb113eee5628a0e6562dca0))

## [0.17.0](https://github.com/kirinnee/ferretry/compare/v0.16.0...v0.17.0) (2026-07-31)

### Features

* **cli:** port the task and task-board command groups ([#27](https://github.com/kirinnee/ferretry/issues/27)) ([5a3771f](https://github.com/kirinnee/ferretry/commit/5a3771fd903026836c0cffdeff7669d8cd3c7dbf))

## [0.16.0](https://github.com/kirinnee/ferretry/compare/v0.15.0...v0.16.0) (2026-07-31)

### Features

* **cli:** add the session command group — start, ps/status, send/reply/answer, name ([#30](https://github.com/kirinnee/ferretry/issues/30)) ([cb68ff6](https://github.com/kirinnee/ferretry/commit/cb68ff6beb80e8eb78f4fae068d1a8748b366697))

## [0.15.0](https://github.com/kirinnee/ferretry/compare/v0.14.0...v0.15.0) (2026-07-31)

### Features

* **cli:** port the attention, pin and analytics command groups ([#28](https://github.com/kirinnee/ferretry/issues/28)) ([2d0f9b0](https://github.com/kirinnee/ferretry/commit/2d0f9b07950eafc02ba31b6fa2d4ffe5d0edafe3))

## [0.14.0](https://github.com/kirinnee/ferretry/compare/v0.13.0...v0.14.0) (2026-07-31)

### Features

* **daemon:** add transcript ingestion ([#23](https://github.com/kirinnee/ferretry/issues/23)) ([30964c5](https://github.com/kirinnee/ferretry/commit/30964c5d24203aa0db18338978b1bc70ad191878))
* **daemon:** serve the HTTP API — routing, authorization and the usage/metrics feeds ([#26](https://github.com/kirinnee/ferretry/issues/26)) ([e10db2a](https://github.com/kirinnee/ferretry/commit/e10db2a1d070dd84d7fe78b6a00f3bd1e90199b8))

## [0.13.0](https://github.com/kirinnee/ferretry/compare/v0.12.0...v0.13.0) (2026-07-31)

### Features

* **daemon:** port the core recommendation engine and the usage feed ([#24](https://github.com/kirinnee/ferretry/issues/24)) ([d691d06](https://github.com/kirinnee/ferretry/commit/d691d06fcc184eef52a75a5e2f8c39705c903ee9))

## [0.12.0](https://github.com/kirinnee/ferretry/compare/v0.11.1...v0.12.0) (2026-07-31)

### Features

* **daemon:** add destructive migration preflight ([#20](https://github.com/kirinnee/ferretry/issues/20)) ([69253d4](https://github.com/kirinnee/ferretry/commit/69253d4ad7d5b941a3be3eee7d9fcaa04754f81a))

## [0.11.1](https://github.com/kirinnee/ferretry/compare/v0.11.0...v0.11.1) (2026-07-31)

### Fixes

* **gates:** unbreak main by allowlisting the unwired terminal modules ([f1d52da](https://github.com/kirinnee/ferretry/commit/f1d52daeedecf84ccd86fd1feadd99a679975a4a)), closes [#21](https://github.com/kirinnee/ferretry/issues/21) [#21](https://github.com/kirinnee/ferretry/issues/21)

## [0.11.0](https://github.com/kirinnee/ferretry/compare/v0.10.0...v0.11.0) (2026-07-31)

### Features

* **daemon:** add session lifecycle service ([#22](https://github.com/kirinnee/ferretry/issues/22)) ([8ef1bd0](https://github.com/kirinnee/ferretry/commit/8ef1bd0fd01f256883c5b8eadedf769d8c16e2fe))
* **daemon:** establish terminal IO policies ([#21](https://github.com/kirinnee/ferretry/issues/21)) ([16302e2](https://github.com/kirinnee/ferretry/commit/16302e2996a267839faa47873dd26f30784ed197))

## [0.10.0](https://github.com/kirinnee/ferretry/compare/v0.9.0...v0.10.0) (2026-07-31)

### Features

* **daemon:** port the browser transport, worker client, and frame governor ([#18](https://github.com/kirinnee/ferretry/issues/18)) ([47ae59f](https://github.com/kirinnee/ferretry/commit/47ae59f0338f876c9a43bcb2babb28ab2146851b))

## [0.9.0](https://github.com/kirinnee/ferretry/compare/v0.8.0...v0.9.0) (2026-07-31)

### Features

* **daemon:** add boot readiness runtime ([#16](https://github.com/kirinnee/ferretry/issues/16)) ([e549633](https://github.com/kirinnee/ferretry/commit/e5496330221b5a5c16a5c065a091daef7f5789e4))

## [0.8.0](https://github.com/kirinnee/ferretry/compare/v0.7.0...v0.8.0) (2026-07-31)

### Features

* **daemon:** port warden supervision — detection, verdicts, failover and provenance ([#19](https://github.com/kirinnee/ferretry/issues/19)) ([a29cbc4](https://github.com/kirinnee/ferretry/commit/a29cbc431afe6d12a47b958a7259daf1c57c6a9e))

## [0.7.0](https://github.com/kirinnee/ferretry/compare/v0.6.0...v0.7.0) (2026-07-31)

### Features

* **daemon:** add analytics ingestion and query ([#6](https://github.com/kirinnee/ferretry/issues/6)) ([f94f2a9](https://github.com/kirinnee/ferretry/commit/f94f2a9bb2fba970decc325a8f2402cf1dbe9a42))
* **daemon:** add bounded docx extraction ([#12](https://github.com/kirinnee/ferretry/issues/12)) ([d8c173b](https://github.com/kirinnee/ferretry/commit/d8c173bc220866303306b175c723a1936d5c268c))
* **daemon:** add browser session control ([#15](https://github.com/kirinnee/ferretry/issues/15)) ([658d890](https://github.com/kirinnee/ferretry/commit/658d890c092554c745cc2868455986aa6df450fb))
* **daemon:** add learning evidence pipeline ([#13](https://github.com/kirinnee/ferretry/issues/13)) ([9be10df](https://github.com/kirinnee/ferretry/commit/9be10df0383c7bbb1c7629ebc89b56203d5e824e))
* **daemon:** add pin domain service ([#14](https://github.com/kirinnee/ferretry/issues/14)) ([dcf48f2](https://github.com/kirinnee/ferretry/commit/dcf48f285ad56bb03ace140335b7364e33566916))
* **daemon:** complete attention lifecycle ([#11](https://github.com/kirinnee/ferretry/issues/11)) ([f513f27](https://github.com/kirinnee/ferretry/commit/f513f27942917814ab571b5dd1c6230755969128))
* **tasks:** port the task record system and its file store ([#10](https://github.com/kirinnee/ferretry/issues/10)) ([60eb311](https://github.com/kirinnee/ferretry/commit/60eb311731ab492ed5a95d9b3adad602fcdd529a))

## [0.6.0](https://github.com/kirinnee/ferretry/compare/v0.5.0...v0.6.0) (2026-07-31)

### Features

* **daemon:** complete task board membership lifecycle ([#5](https://github.com/kirinnee/ferretry/issues/5)) ([4489432](https://github.com/kirinnee/ferretry/commit/44894321d8b9107afc784b78117eea4342892aa5))

## [0.5.0](https://github.com/kirinnee/ferretry/compare/v0.4.0...v0.5.0) (2026-07-31)

### Features

* **daemon:** add the callsign name pool, managed worktrees, and the Git adapter ([#9](https://github.com/kirinnee/ferretry/issues/9)) ([d37fe8a](https://github.com/kirinnee/ferretry/commit/d37fe8a79e6c604ba3a669f53be8dbbfe4b24a2e))
* **daemon:** port the tmux controller ([#7](https://github.com/kirinnee/ferretry/issues/7)) ([1d2ebd8](https://github.com/kirinnee/ferretry/commit/1d2ebd8f1f9939d0034bc417716f0dacfbb420d9))
* **fleet:** port the fleet provisioner, manifest, and usage collector ([#8](https://github.com/kirinnee/ferretry/issues/8)) ([1231649](https://github.com/kirinnee/ferretry/commit/1231649d73e66d32f3c06c21a52dfb14537a26d1))
* **protocol:** add wire schemas and the typed client SDK ([#2](https://github.com/kirinnee/ferretry/issues/2)) ([1a9e7d1](https://github.com/kirinnee/ferretry/commit/1a9e7d14977e6640bd214ad03af5de35d5bc2017))

## [0.4.0](https://github.com/kirinnee/ferretry/compare/v0.3.0...v0.4.0) (2026-07-31)

### Features

* **test:** add isolated E2E harness ([#4](https://github.com/kirinnee/ferretry/issues/4)) ([ae66ac5](https://github.com/kirinnee/ferretry/commit/ae66ac56860fab840abd427cb4944cd7749fba6c))

## [0.3.0](https://github.com/kirinnee/ferretry/compare/v0.2.1...v0.3.0) (2026-07-31)

### Features

* **daemon:** add the state home and storage foundation ([#3](https://github.com/kirinnee/ferretry/issues/3)) ([43bc58d](https://github.com/kirinnee/ferretry/commit/43bc58d99eb2932f7c53e11c36d980a53f5233e8))

## [0.2.1](https://github.com/kirinnee/ferretry/compare/v0.2.0...v0.2.1) (2026-07-30)

### Fixes

* **release:** make CD reruns idempotent with release mode replace ([b96cb3f](https://github.com/kirinnee/ferretry/commit/b96cb3f0f49de52c13c5571bff4d36562ca2cfb2))

## [0.2.0](https://github.com/kirinnee/ferretry/compare/v0.1.0...v0.2.0) (2026-07-30)

### Features

* **release:** add Gemfury apt/yum channel for deb/rpm packages ([9ec53e4](https://github.com/kirinnee/ferretry/commit/9ec53e40090b992bd2c6bd881432d12f45bf7555))
