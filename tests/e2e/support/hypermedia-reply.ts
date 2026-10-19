/**
 * What the fake harness answers with when a journey wants to see HYPERMEDIA in the real product: one
 * assistant message holding every `fy-render` form, plus the media files it names, made the way an
 * agent would make them and dropped where the fake harness copies them into the session's media
 * folder (`scripts/test/fake-claude-tui.sh`).
 *
 * The `html` fragment also carries payloads that would set `window.__fyPwned` if anything in it ever
 * ran; the journey asserts it never does.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const F = '```';
const fence = (type: string, alt: string, body: string, src?: string): string =>
  `${F}fy-render\ntype: ${type}\nalt: ${alt}\n${src === undefined ? '' : `src: ${src}\n`}---\n${body}\n${F}`;

/** The forms, in the order they appear, with the selector that proves each one rendered. */
export const HYPERMEDIA_FORMS = [
  { form: 'mermaid', rendered: 'img[data-fy-render-diagram="true"]' },
  { form: 'svg', rendered: '[data-fy-render-type="svg"] img' },
  { form: 'html', rendered: '[data-fy-render-fragment="true"]' },
  { form: 'image', rendered: '[data-fy-render-type="image"] img[src^="blob:"]' },
  { form: 'video', rendered: '[data-fy-render-type="video"] video[src^="blob:"]' },
  { form: 'audio', rendered: '[data-fy-render-type="audio"] audio[src^="blob:"]' },
  { form: 'pdf', rendered: '[data-fy-render-type="pdf"] [data-fy-render-row="true"]' },
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
      '<img src="x" onerror="window.__fyPwned = \'onerror\'" alt="">',
      "<script>window.__fyPwned = 'script'</script>",
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
