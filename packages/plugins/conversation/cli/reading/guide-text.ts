/**
 * The guide `fy render guide` prints: the `## Guide for agents` section of docs/hypermedia.md, from its heading line to
 * the `---` that closes it, GENERATED — never edited here. The doc owns the text; this constant only ships it in the
 * compiled binary, because a release has no repository beside it. Edit the doc, then run
 * `bun packages/plugins/conversation/tests/support/guide-text/generate.ts`; `tests/unit/cli/guide-drift.test.ts` fails
 * the commit that lets the two disagree.
 *
 * The section carries no example fence of the `fy-render` kind on purpose: this file is source, where
 * scripts/validate/no-fy-render-in-docs.sh refuses a fence opener.
 */
export const RENDER_GUIDE_SECTION = `
## Guide for agents

\`fy render guide [topic]\` prints this section and nothing else: the \`### overview\` body when no topic is named, or that topic's \`###\` body when one is. \`image\`, \`video\`, \`audio\` and \`pdf\` share the \`### media\` section, \`task\` and \`board\` share \`### task\`, and \`human\` also answers \`llm\`. \`fy render check <file|->\` is the doccheck: run it on a message before you send it. The CLI ships a byte-exact copy of this whole section in the binary (\`RENDER_GUIDE_SECTION\` in \`packages/plugins/conversation/cli/reading/guide-text.ts\`), written from this section by \`tests/support/guide-text/generate.ts\`, and \`tests/unit/cli/guide-drift.test.ts\` fails the commit that lets the copy disagree with it — so this section is the one owner of the text: edit it here, then run the generator.

Two shapes are deliberately absent from this section. An example fence of the \`fy-render\` kind, because the copy ships in the CLI's TypeScript source, where \`no-fy-render-in-docs.sh\` refuses a fence opener. And the per-type detail of \`fy-render\`: [fy-render.md](fy-render.md) holds the contract, and where the two disagree the contract wins and this section is wrong.

### overview

A message is Markdown (GitHub flavour: headings, lists, tables, task lists, code, links) with one rich part: a \`terminal\` fence, a shell session. A line \`:::human\` closed by a line \`:::\` is text for people, and \`:::llm\` after a part is the text another agent reads. Any other fence (\`ts\`, \`diff\`, \`sh\`) is plain code. A part with a mistake in it is shown as its source with the problem named, so check that it drew.

Diagrams, charts, pictures, media, maps, live tasks and static or interactive pages are a different fence: its info string is exactly \`fy-render\`, line 1 \`type: <type>\`, line 2 \`alt: <one-line description>\`, then a line \`---\`, then the payload. Types: \`mermaid\`, \`chart\`, \`svg\`, \`html\`, \`map\`, \`image\`, \`video\`, \`audio\`, \`pdf\`, \`lottie\`, \`task\`, \`board\`. A broken block renders as an ordinary code fence with no warning, so run \`fy render check\` on the message first.

Raw HTML in Markdown is shown as text. A Markdown image is not drawn (use an \`image\` block); a link may go to \`https://\`, \`mailto:\` or a heading of the same message, and nothing else. A message has no front matter: a first line \`---\` is just a line. A message over 300,000 bytes is shown as text. Never write any of this into files, docs, commits or PRs: it is for chat messages and agenda items only.

Reference things as plain text, never as links: see \`### references\`. For an explainer, show the idea: a \`mermaid\` flow, a \`chart\`, an interactive \`html\` page, a \`terminal\` session — and keep the words short.

### terminal

A shell session. A line starting \`$ \` (or \`% \`, or \`# \` for root) is a command; every other line is its output, shown as it is. Each command is one step. Info string: \` \`\`\`terminal title="two words" \`. \`console\` and \`shellsession\` mean the same part. A \` \`\`\`sh \` block is plain code and stays still.

Write \`@step <title>\` lines to set the steps yourself (then every line sits under a step; at least two steps, or none).

### chart

An \`fy-render\` block of \`type: chart\`. The payload is JSON/YAML {kind: bar, x: [Mon, Tue], y: {format: money}, series: [{name: Cost, data: [2, 3]}]}; kind line|bar|area|pie|doughnut|scatter|radar; format number|percent|money|duration|bytes; stacked; frames: [{label, series}] steps. No colours: tone accent|good|warn|bad|muted|1-8.

Say what the chart says; the reader's theme paints it. \`title:\` is optional; \`y\` (and a scatter's \`x\`) take \`{label, format, currency, min, max}\` — \`money\` takes an ISO 4217 \`currency\`, default USD, \`duration\` takes seconds, \`percent\` takes the number itself. \`stacked:\` on line, area and bar; \`horizontal:\` on bar; a series \`kind: line\` draws a line over bars; \`null\` in \`data\` is a gap; scatter data is \`[[x, y], …]\` on a numeric x axis. The reader gets tooltips, a legend they can toggle, zoom on line and area, and \`frames\` steps with Previous/Next and a slider; the numbers reach a screen reader as a table. Any key the language does not name — \`color:\` included — makes the block fall back to its source. Caps: 64 KiB, 12 series, 500 points a series, 500 labels, 30 frames.

### mermaid

An \`fy-render\` block of \`type: mermaid\`. The payload is Mermaid source (flowchart TB, sequenceDiagram, …): top-down, short labels. It is auto-themed: \`%%{init}%%\`, front matter and \`theme\`/\`themeVariables\`/\`themeCSS\` are ignored, and \`style\`/\`classDef\` colours still apply and fight the reader's theme — leave colours out. ≤ 20,000 characters. A wide left-to-right flowchart is redrawn top-down on a phone by itself, and the reader can scroll it sideways. A diagram that does not parse becomes a plain code fence.

### human

\`:::human\` text is shown to people, and \`:::llm\` after a part or \`:::human\` is the text another agent reads instead of it. The reader sees an \`:::llm\` text too, collapsed under "LLM-only text", so write nothing there you would not say to them. A part whose own text is over about 400 tokens should have one.

### references

A reference is a plain token in your text: \`:agent\` a fleet agent's session, \`@path\` a file (\`@src/api.ts\`, \`@src/api.ts:120\`, \`@src/api.ts:120-140\`), \`&F12\` a task, \`^A3\` an agenda item, \`/skill\` or \`$skill\` a skill, \`%terminal:dev\` and \`%browser:app\` a live terminal or page by its name. Write them as bare words in prose; the reader's app proves each one and turns it into a link, and one that does not exist stays plain text. A Markdown link that imitates a reference is plain text. Inside a code span a reference is shown as written.

### svg

One self-contained \`<svg>…</svg>\` (CSS animation welcome). No \`<script>\` or \`on*\` handler, no \`<foreignObject>\`, \`<use>\`, \`<!DOCTYPE>\` or \`<!ENTITY>\`, and no external reference — no web font, remote \`<image>\`, stylesheet, filter or mask: none of it loads in the \`<img>\` sink an SVG renders through. Give the root a \`viewBox\`, with \`width\`/\`height\` in plain numbers, \`px\`, or \`%\` of the viewBox. Caps: 100 KiB, 500 elements, 32 filter primitives, 8192 per axis, 16,777,216 pixels. Colours are yours — pick marks that read on light and dark, or set a background rectangle — and give text a real \`font-family\`.

### html

A fragment with inline CSS — tables, lists, \`<details>\`/\`<summary>\`, code, inline SVG, \`<style>\` — drawn straight into the message; nothing in it runs. Add a \`<script>\` or \`on…=\` handler only when the reader must do something: the block then runs as a live page in an isolated frame, marked "interactive" — one self-contained page with inline \`<style>\` and \`<script>\`, loading nothing from the network (no fetch, XHR, WebSocket, no CDN), no storage, no forms, no popups, never navigating, and no long loops (it stops after five seconds unresponsive or ten minutes). ≤ 200 KiB. The fragment's styles cannot reach the app and the app's cannot reach it.

**Interactive means a visualization the reader changes.** Draw something — bars, a curve, a grid, a diagram — and give it parameters (sliders, toggles, a select, segmented buttons); every change redraws it at once. Never a stepper, a slideshow, a quiz or Next/Back pages: a sequence is prose.

**It looks native when it uses the app's theme.** The page sits on the chat or agenda surface, so leave its background transparent and set no colour of your own unless the colour is the content (a swatch). Every colour comes from a theme token; light, dark and a theme switch while it runs follow by themselves.

- Tokens, as \`var(--name)\`, the same in a static fragment: ink \`--fg\` \`--fg-soft\` \`--muted\` \`--faint\`; surfaces \`--bg\` \`--surface\` \`--surface-2\` \`--surface-3\`; lines \`--border\` \`--border-soft\` \`--border-strong\`; accent \`--accent\` \`--accent-soft\` \`--accent-fg\`; status \`--ok\` \`--warn\` \`--err\` and \`--ok-bg\` \`--warn-bg\` \`--err-bg\`; series \`--viz-1\` … \`--viz-8\`; type \`--font-body\` \`--font-mono\` \`--text-xs\` \`--text-sm\` \`--text-base\` \`--text-lg\`; shape \`--radius-sm\` \`--radius-md\` \`--radius-pill\`; space \`--gap-xs\` \`--gap-sm\` \`--gap-md\`.
- Plain \`<button>\`, \`<input>\`, \`<select>\`, \`<table>\`, headings and text are already styled in a live page. Classes add the rest, live or static: \`fy-btn\` (\`fy-btn--primary\`, \`fy-btn--quiet\`; \`aria-pressed="true"\` marks one on), \`fy-segmented\` (a row of \`fy-btn\`), \`fy-range\` (a slider), \`fy-toggle\` (\`<label class="fy-toggle"><input type="checkbox"> Label</label>\`), \`fy-input\`, \`fy-select\`, \`fy-field\` (\`<label class="fy-field">Rate <input class="fy-range" type="range"> <output>3</output></label>\`), \`fy-card\`, \`fy-row\`, \`fy-stack\`, \`fy-grid\`, \`fy-muted\`, \`fy-num\`, \`fy-chip\`, \`fy-stat\` (\`<div class="fy-stat">Cost <b>$42</b></div>\`), \`fy-table\`, \`fy-legend\` with \`fy-swatch\`.
- Bars without a library: \`fy-bars\` holds \`fy-bar\` elements, each \`style="--v:40"\` (0–100, its height in percent) with optional \`data-value\` and \`data-label\`; \`fy-meter\` with \`style="--v:70"\` is one horizontal bar. \`data-tone\` is \`1\`–\`8\` (the series) or \`accent\`, \`good\`, \`warn\`, \`bad\`, \`muted\`, on a bar, swatch, meter, chip, or an inline-SVG shape (it sets \`fill\`, or \`stroke\` on \`fill="none"\`).
- Size: the frame grows to the page's height, up to 1200px, and never scrolls inside. Nothing may be wider than the column — a phone is about 360px — so let rows wrap (\`fy-row\` does) and give an SVG a \`viewBox\` with \`width="100%"\`. Fonts the app downloads are not available inside, so \`--font-body\` falls back to the reader's installed ones.

A slider that redraws bars:

\`\`\`html
<div class="fy-stack">
  <label class="fy-field"
    >Growth <input class="fy-range" id="g" type="range" min="0" max="50" value="20" /> <output id="o"></output
  ></label>
  <div class="fy-bars" id="bars"></div>
  <div class="fy-legend">
    <span><i class="fy-swatch"></i>Revenue, year 1 = 1.00</span>
  </div>
</div>
<script>
  const g = document.getElementById('g'),
    o = document.getElementById('o'),
    bars = document.getElementById('bars');
  function draw() {
    const values = [1, 2, 3, 4, 5].map(year => Math.pow(1 + g.value / 100, year - 1));
    const top = Math.max(...values);
    o.textContent = g.value + '%';
    bars.innerHTML = values
      .map(
        (v, i) =>
          \`<div class="fy-bar" style="--v:\${(v / top) * 100}" data-value="\${v.toFixed(2)}" data-label="Y\${i + 1}"></div>\`,
      )
      .join('');
  }
  g.addEventListener('input', draw);
  draw();
</script>
\`\`\`

### map

JSON/YAML {center: [lat, lng], zoom, markers: [{at, label, popup}], lines: [{points}], polygons, geojson}; real places.

\`center\` is \`[lat, lng]\`; omit it to fit the view to everything drawn. \`zoom\` is 0–18 (with a fit, the closest the fit may zoom). Markers carry \`at\`, \`label\` and \`popup\`; \`lines\` are routes (\`points: [[lat, lng], …]\`, \`label\`); \`polygons\` need three points a ring; \`geojson\` takes Point, LineString, Polygon and their \`Multi*\`/Feature/Collection forms. Colours: \`red\`, \`blue\`, \`green\`, \`amber\`, \`purple\` or \`#hex\`. An interactive map with OpenStreetMap tiles as its one remote load: pan, zoom, tap a marker for its popup. Caps: 32 KiB, 100 markers, 50 lines+polygons, 2,000 vertices; a refusal falls back to a coordinates list.

### media

save files you make into $FY_MEDIA_DIR and put \`src: media:<file name>\` before \`---\`, with no payload; \`src: @workspace/path\` and \`src: https://…\` also work.

That is \`image\`, \`video\`, \`audio\` and \`pdf\` — they name bytes instead of carrying them, and nothing follows the \`---\`. \`media:<file>\` is the one for anything you MADE: \`$FY_MEDIA_DIR\` is your session's media folder, outside every repository, so no ignore rules decide whether it can be shown; name the file by its path inside that folder. \`src: @workspace/path\` is written as an \`@file\` reference without a line, read with the reader's access — gitignored and protected files are never served, at most 1 MiB. For \`src: https://…\`, video and audio play directly; an image must come from a host that allows cross-origin reads (at most 2 MiB) or becomes a link; a pdf is always a link. \`http:\`, \`data:\` and \`blob:\` are refused. Extensions: image png/jpg/jpeg/gif/webp, video mp4/m4v/webm/ogv/mov, audio mp3/m4a/aac/wav/ogg/oga/opus/weba/flac, pdf. An \`image\` may instead be inline — \`mime: image/png|jpeg|gif|webp\` with a base64 payload, still, matching the declared type, ≤ 2 MiB decoded — \`src:\` or \`mime:\`, never both.

### task

\`task\` and \`board\` point at tasks on the board and show them live; they draw no picture and carry no bytes. \`task\`: the payload is one reference, \`&F12\`. \`board\`: references one per line or separated by spaces (at most 12, none twice), or a single line \`parent: &F12\` to show that task's children. Either form draws a framed mini board grouped by lane. The reader sees the real board task — title, lane, progress, its PRs — and it redraws by itself when the task moves; you write no title or status, so there is nothing to keep true. Prefer one block to pasting a status that goes stale. A task that does not exist or cannot be read shows as a quiet note, never a link. Chat messages and agenda bodies only. Caps: 2 KiB, 12 listed tasks, 24 children shown. A repeated or non-task reference, a \`parent:\` mixed with a list, or \`parent:\` on a \`task\` makes the block a plain code fence.

### lottie

A Lottie animation as JSON — the one animated type, with Pause/Play. No expressions: a string-valued \`"x"\` key anywhere is refused; export without expressions. No remote assets: embed images as \`data:\` URIs or leave them out. Caps: 1 MiB, 500 layers, 64 levels deep. It plays while on screen, starts paused under reduced motion, and stops after two minutes with Replay.

---
`;
