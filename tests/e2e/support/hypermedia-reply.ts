/**
 * What the fake harness answers with when a journey wants to see HYPERMEDIA in the real product: one
 * assistant message holding every `fy-render` form, plus the media files it names, made the way an
 * agent would make them and dropped where the fake harness copies them into the session's media
 * folder (`scripts/test/fake-claude-tui.sh`).
 *
 * The static `html` fragment carries no script, so it stays a fragment in the page. The INTERACTIVE one
 * — a slider and a toggle — runs in its own opaque frame, and also tries to reach the app
 * (`parent.__fyPwned`); the journey asserts the app's window never hears of it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const F = '```';
const fence = (type: string, alt: string, body: string, src?: string): string =>
  `${F}fy-render\ntype: ${type}\nalt: ${alt}\n${src === undefined ? '' : `src: ${src}\n`}---\n${body}\n${F}`;

/**
 * The forms, in the order they appear: the block that holds each one, and the selector that proves it
 * rendered. Two are `html` — a static fragment and an interactive page — told apart by presentation.
 */
export const HYPERMEDIA_FORMS = [
  { block: '[data-fy-render-type="mermaid"]', form: 'mermaid', rendered: 'img[data-fy-render-diagram="true"]' },
  { block: '[data-fy-render-type="svg"]', form: 'svg', rendered: '[data-fy-render-type="svg"] img' },
  {
    block: '[data-fy-render-presentation="fragment"]',
    form: 'html',
    rendered: '[data-fy-render-fragment="true"]',
  },
  {
    block: '[data-fy-render-presentation="interactive"]',
    form: 'interactive',
    rendered: '[data-fy-render-presentation="interactive"] iframe[data-fy-render-ready="true"]',
  },
  {
    block: '[data-fy-render-type="image"]',
    form: 'image',
    rendered: '[data-fy-render-type="image"] img[src^="blob:"]',
  },
  {
    block: '[data-fy-render-type="video"]',
    form: 'video',
    rendered: '[data-fy-render-type="video"] video[src^="blob:"]',
  },
  {
    block: '[data-fy-render-type="audio"]',
    form: 'audio',
    rendered: '[data-fy-render-type="audio"] audio[src^="blob:"]',
  },
  {
    block: '[data-fy-render-type="pdf"]',
    form: 'pdf',
    rendered: '[data-fy-render-type="pdf"] [data-fy-render-row="true"]',
  },
] as const;

const REPLY = [
  'Here is how a block reaches you now:',
  '',
  fence(
    'mermaid',
    'How a hypermedia block renders inline',
    [
      'flowchart LR',
      '  A[Message arrives] --> B{Near the screen?}',
      '  B -->|yes| C[Render inline]',
      '  B -->|no| D[Wait]',
    ].join('\n'),
  ),
  '',
  'The three stages, drawn:',
  '',
  fence(
    'svg',
    'Three stages: parse, near, draw',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 120" width="480" height="120"><rect width="480" height="120" rx="10" fill="#2a6f97"/><rect x="24" y="24" width="120" height="72" rx="8" fill="#61a5c2"/><rect x="180" y="24" width="120" height="72" rx="8" fill="#89c2d9"/><rect x="336" y="24" width="120" height="72" rx="8" fill="#a9d6e5"/></svg>',
  ),
  '',
  'A comparison, as a static fragment:',
  '',
  fence(
    'html',
    'A comparison of the two rendering paths',
    [
      '<table><thead><tr><th>Form</th><th>Where it draws</th></tr></thead>',
      '<tbody><tr><td>Mermaid, Lottie</td><td>sandbox frame, shown inline</td></tr>',
      '<tr><td>HTML</td><td>static fragment, no script</td></tr></tbody></table>',
      '<details><summary>Why no script?</summary><p>A fragment is an explanation, not an app.</p></details>',
    ].join(''),
  ),
  '',
  'Drag it to see how wall time changes:',
  '',
  fence(
    'html',
    'An interactive estimate of wall time against parallel agents',
    [
      '<style>body{margin:0}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}input[type=range]{flex:1 1 180px}.bar{height:12px;border-radius:6px;background:#2a9d8f}.track{flex:1 1 100%;background:rgba(127,127,127,.2);border-radius:6px}</style>',
      '<div class="row"><label for="n">Parallel agents</label><input id="n" type="range" min="1" max="16" value="6"><output id="o">6</output>',
      '<label><input id="c" type="checkbox"> include review</label>',
      '<div class="track"><div id="bar" class="bar" style="width:37%"></div></div><p id="t" style="margin:0">Estimated wall time: 18 min</p></div>',
      '<script>',
      'const n = document.getElementById("n"), c = document.getElementById("c"), o = document.getElementById("o"), bar = document.getElementById("bar"), t = document.getElementById("t");',
      'const draw = () => { const v = +n.value; o.textContent = v; bar.style.width = (v / 16 * 100) + "%"; t.textContent = "Estimated wall time: " + Math.round(90 / Math.sqrt(v) * 0.8 + (c.checked ? 6 : 0)) + " min"; };',
      'n.oninput = draw; c.onchange = draw; draw();',
      "try { parent.__fyPwned = 'parent'; } catch (e) {}",
      '</script>',
    ].join(''),
  ),
  '',
  'The chart I made from last week:',
  '',
  fence('image', 'A bar chart of p95 latency falling after Thursday', '', 'media:latency-chart.png'),
  '',
  'The recording of the progress bar:',
  '',
  fence('video', 'A two-second recording of a progress bar filling', '', 'media:progress.webm'),
  '',
  'The readiness chime:',
  '',
  fence('audio', 'A one-second readiness chime', '', 'media:chime.wav'),
  '',
  'And the report:',
  '',
  fence('pdf', 'The Q3 summary report', '', 'media:q3-summary.pdf'),
  '',
  'Section 3 has the numbers.',
].join('\n');

/** A one-second 440 Hz tone, 8 kHz mono 16-bit PCM. */
const chime = (): Uint8Array => {
  const rate = 8_000;
  const samples = rate;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(at + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1)
    view.setInt16(44 + index * 2, Math.sin((2 * Math.PI * 440 * index) / rate) * 8_000 * (1 - index / samples), true);
  return new Uint8Array(view.buffer);
};

const REPORT = new TextEncoder().encode(
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
);

/**
 * The chart and the recording, MADE IN THE BROWSER — the host has no image or video encoder, and a
 * fixture file would be a binary in the repository. Returned as base64 so they cross `evaluate`.
 */
export const BROWSER_MEDIA_SCRIPT = `(async () => {
  const canvas = new OffscreenCanvas(720, 360);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 720, 360);
  g.fillStyle = '#334155'; g.font = '20px sans-serif'; g.fillText('p95 latency (ms)', 24, 36);
  [420, 410, 432, 405, 180, 172, 168].forEach((v, i) => {
    const h = (v / 450) * 260;
    g.fillStyle = i < 4 ? '#94a3b8' : '#0ea5e9';
    g.fillRect(40 + i * 96, 320 - h, 64, h);
  });
  const base64 = async blob => { const bytes = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const png = await base64(await canvas.convertToBlob({ type: 'image/png' }));
  const video = document.createElement('canvas'); video.width = 320; video.height = 180;
  const v = video.getContext('2d');
  const recorder = new MediaRecorder(video.captureStream(30), { mimeType: 'video/webm' });
  const chunks = []; recorder.ondataavailable = e => chunks.push(e.data);
  const stopped = new Promise(r => { recorder.onstop = r; });
  recorder.start();
  const started = performance.now();
  await new Promise(done => { const frame = () => { const t = Math.min((performance.now() - started) / 1500, 1); v.fillStyle = '#0f172a'; v.fillRect(0, 0, 320, 180); v.fillStyle = '#22c55e'; v.fillRect(40, 80, 240 * t, 20); if (t < 1) requestAnimationFrame(frame); else done(); }; frame(); });
  recorder.stop(); await stopped;
  return { png, webm: await base64(new Blob(chunks)) };
})()`;

/** Writes the reply and its media into the session's workspace, where the fake harness reads them. */
export async function stageHypermediaReply(workspace: string, media: { png: string; webm: string }): Promise<void> {
  const folder = join(workspace, '.fy-e2e-fake-media');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'latency-chart.png'), Buffer.from(media.png, 'base64'));
  await writeFile(join(folder, 'progress.webm'), Buffer.from(media.webm, 'base64'));
  await writeFile(join(folder, 'chime.wav'), chime());
  await writeFile(join(folder, 'q3-summary.pdf'), REPORT);
  await writeFile(join(workspace, '.fy-e2e-fake-reply.md'), `${REPLY}\n`);
}
