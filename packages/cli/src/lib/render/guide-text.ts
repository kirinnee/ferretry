/**
 * The guide `fy render guide` prints: a byte-exact copy of the `## Guide for agents` section of
 * docs/fy-render.md (blank lines around the section aside), from its heading line to the `---`
 * that closes it. The doc owns the text — this constant only ships it in the compiled binary,
 * because a release has no repository beside it — and the `render-guide-doc` contract in
 * scripts/validate/cli-contracts.sh fails the commit that lets the two disagree: edit the doc,
 * then copy the section whole into this literal (backticks escaped), never the other way round.
 *
 * The section carries no example fence on purpose: this file is source, where
 * scripts/validate/no-fy-render-in-docs.sh refuses an `fy-render` fence opener.
 */
export const RENDER_GUIDE_SECTION = `
## Guide for agents

\`fy render guide [type]\` prints this section and nothing else: the \`### overview\` body when no type is named, or that type's \`###\` body when one is. \`image\`, \`video\`, \`audio\` and \`pdf\` share the \`### media\` section, because they name bytes the same way. The CLI ships a byte-exact copy of this whole section in the binary (\`RENDER_GUIDE_SECTION\` in \`packages/cli/src/lib/render/guide-text.ts\`), and the \`render-guide-doc\` contract in \`scripts/validate/cli-contracts.sh\` fails the commit that lets the copy disagree with this section — so this section is the one owner of the text: edit it here, then copy the section whole into that constant.

Two shapes are deliberately absent from this section. An example fence, because the copy ships in the CLI's TypeScript source, where \`no-fy-render-in-docs.sh\` refuses a fence opener. And the per-type detail: the sections below distil the contract the rest of this document holds, and where the two disagree the contract wins and this section is wrong.

### overview

Write a fenced block whose info string is exactly \`fy-render\`: line 1 \`type: <type>\`, line 2 \`alt: <one-line description>\`, then a line \`---\`, then the payload. \`type:\` is always the first line, \`alt:\` is required (≤ 200 characters) and is the picture's description for a reader who cannot see it. \`mime:\` appears only on an inline \`image\`; a \`src:\` block has an empty payload. Any broken rule — an unknown type, an unknown or repeated key, a cap exceeded — renders as an ordinary code fence with no warning, so check that it drew. Chat only: never write fy-render into files, docs, commits or PRs.

### mermaid

Mermaid source (flowchart TB, sequenceDiagram, …): top-down, short labels. It is auto-themed: \`%%{init}%%\`, front matter and \`theme\`/\`themeVariables\`/\`themeCSS\` are ignored, and \`style\`/\`classDef\` colours still apply and fight the reader's theme — leave colours out. ≤ 20,000 characters. A wide left-to-right flowchart is redrawn top-down on a phone by itself, and the reader can scroll it sideways. A diagram that does not parse becomes a plain code fence.

### svg

One self-contained \`<svg>…</svg>\` (CSS animation welcome). No \`<script>\` or \`on*\` handler, no \`<foreignObject>\`, \`<use>\`, \`<!DOCTYPE>\` or \`<!ENTITY>\`, and no external reference — no web font, remote \`<image>\`, stylesheet, filter or mask: none of it loads in the \`<img>\` sink an SVG renders through. Give the root a \`viewBox\`, with \`width\`/\`height\` in plain numbers, \`px\`, or \`%\` of the viewBox. Caps: 100 KiB, 500 elements, 32 filter primitives, 8192 per axis, 16,777,216 pixels. Colours are yours — pick marks that read on light and dark, or set a background rectangle — and give text a real \`font-family\`.

### html

A fragment with inline CSS — tables, lists, \`<details>\`/\`<summary>\`, code, inline SVG, \`<style>\` — drawn straight into the message; nothing in it runs. Add a \`<script>\` or \`on…=\` handler only when the reader must do something: the block then runs as a live page in an isolated frame, marked "interactive" — one self-contained page with inline \`<style>\` and \`<script>\`, loading nothing from the network (no fetch, XHR, WebSocket, no CDN), no storage, no forms, no popups, never navigating, and no long loops (it stops after five seconds unresponsive or ten minutes). Theme tokens such as \`var(--fg)\` work; the fragment's styles cannot reach the app and the app's cannot reach it. ≤ 200 KiB, bounded in height, scrollable past that.

### chart

JSON/YAML {kind: bar, x: [Mon, Tue], y: {format: money}, series: [{name: Cost, data: [2, 3]}]}; kind line|bar|area|pie|doughnut|scatter|radar; format number|percent|money|duration|bytes; stacked; frames: [{label, series}] steps. No colours: tone accent|good|warn|bad|muted|1-8.

Say what the chart says; the reader's theme paints it. \`title:\` is optional; \`y\` (and a scatter's \`x\`) take \`{label, format, currency, min, max}\` — \`money\` takes an ISO 4217 \`currency\`, default USD, \`duration\` takes seconds, \`percent\` takes the number itself. \`stacked:\` on line, area and bar; \`horizontal:\` on bar; a series \`kind: line\` draws a line over bars; \`null\` in \`data\` is a gap; scatter data is \`[[x, y], …]\` on a numeric x axis. The reader gets tooltips, a legend they can toggle, zoom on line and area, and \`frames\` steps with Previous/Next and a slider; the numbers reach a screen reader as a table. Any key the language does not name — \`color:\` included — makes the block fall back to its source. Caps: 64 KiB, 12 series, 500 points a series, 500 labels, 30 frames.

### map

JSON/YAML {center: [lat, lng], zoom, markers: [{at, label, popup}], lines: [{points}], polygons, geojson}; real places.

\`center\` is \`[lat, lng]\`; omit it to fit the view to everything drawn. \`zoom\` is 0–18 (with a fit, the closest the fit may zoom). Markers carry \`at\`, \`label\` and \`popup\`; \`lines\` are routes (\`points: [[lat, lng], …]\`, \`label\`); \`polygons\` need three points a ring; \`geojson\` takes Point, LineString, Polygon and their \`Multi*\`/Feature/Collection forms. Colours: \`red\`, \`blue\`, \`green\`, \`amber\`, \`purple\` or \`#hex\`. An interactive map with OpenStreetMap tiles as its one remote load: pan, zoom, tap a marker for its popup. Caps: 32 KiB, 100 markers, 50 lines+polygons, 2,000 vertices; a refusal falls back to a coordinates list.

### media

save files you make into $FY_MEDIA_DIR and put \`src: media:<file name>\` before \`---\`, with no payload; \`src: @workspace/path\` and \`src: https://…\` also work.

That is \`image\`, \`video\`, \`audio\` and \`pdf\` — they name bytes instead of carrying them, and nothing follows the \`---\`. \`media:<file>\` is the one for anything you MADE: \`$FY_MEDIA_DIR\` is your session's media folder, outside every repository, so no ignore rules decide whether it can be shown; name the file by its path inside that folder. \`src: @workspace/path\` is written as an \`@file\` reference without a line, read with the reader's access — gitignored and protected files are never served, at most 1 MiB. For \`src: https://…\`, video and audio play directly; an image must come from a host that allows cross-origin reads (at most 2 MiB) or becomes a link; a pdf is always a link. \`http:\`, \`data:\` and \`blob:\` are refused. Extensions: image png/jpg/jpeg/gif/webp, video mp4/m4v/webm/ogv/mov, audio mp3/m4a/aac/wav/ogg/oga/opus/weba/flac, pdf. An \`image\` may instead be inline — \`mime: image/png|jpeg|gif|webp\` with a base64 payload, still, matching the declared type, ≤ 2 MiB decoded — \`src:\` or \`mime:\`, never both.

### lottie

A Lottie animation as JSON — the one animated type, with Pause/Play. No expressions: a string-valued \`"x"\` key anywhere is refused; export without expressions. No remote assets: embed images as \`data:\` URIs or leave them out. Caps: 1 MiB, 500 layers, 64 levels deep. It plays while on screen, starts paused under reduced motion, and stops after two minutes with Replay.

---
`;
