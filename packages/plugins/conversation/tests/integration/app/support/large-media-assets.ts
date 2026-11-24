/**
 * The two three-megabyte clips the large-media test plays, made here so no binary is committed.
 *
 *  - A WAV tone (16 kHz, mono, 16-bit): plain PCM that every Chromium plays and seeks, 3 MiB of it.
 *  - A VP8 WebM of noise, encoded by the ffmpeg Playwright ships for its own recordings (it can read piped JPEGs and
 *    write VP8 WebM, and nothing else). It is looked for in Playwright's browser cache; a machine without it runs the
 *    audio case only and says so.
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';

export const THREE_MIB = 3 * 1024 * 1024;

/** `seconds` of a rising tone as a canonical 44-byte-header WAV. */
export const toneWav = (seconds: number): Uint8Array => {
  const rate = 16_000;
  const samples = Math.round(seconds * rate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[at + index] = value.charCodeAt(index);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const t = index / rate;
    const hertz = 220 + 20 * (t % 10);
    view.setInt16(44 + index * 2, Math.round(Math.sin(2 * Math.PI * hertz * t) * 9_000), true);
  }
  return bytes;
};

/** The Playwright-shipped ffmpeg, or `undefined` when this machine has none. */
export const findFfmpeg = async (): Promise<string | undefined> => {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');
  const found = await readdir(base).catch(() => [] as string[]);
  const folder = found
    .filter(name => name.startsWith('ffmpeg-'))
    .sort()
    .at(-1);
  if (folder === undefined) return undefined;
  const binary = join(base, folder, 'ffmpeg-linux');
  return (await Bun.file(binary).exists()) ? binary : undefined;
};

/**
 * A VP8 WebM at least three mebibytes long: noise frames drawn and JPEG-encoded in the browser, piped to ffmpeg at a
 * bitrate high enough that the encoder has to spend it. Frames are added until the file is big enough.
 */
export const noiseWebm = async (browser: Browser, ffmpeg: string): Promise<Uint8Array> => {
  const page = await browser.newPage();
  try {
    for (const count of [30, 60, 120]) {
      const frames = await page.evaluate(async (total: number) => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        const made: string[] = [];
        for (let frame = 0; frame < total; frame += 1) {
          const image = context.createImageData(320, 240);
          for (let at = 0; at < image.data.length; at += 4) {
            const value = Math.floor(Math.random() * 256);
            image.data[at] = value;
            image.data[at + 1] = (value * 3 + frame * 8) & 255;
            image.data[at + 2] = 255 - value;
            image.data[at + 3] = 255;
          }
          context.putImageData(image, 0, 0);
          made.push(canvas.toDataURL('image/jpeg', 0.9).split(',')[1] as string);
        }
        return made;
      }, count);
      const output = join(process.env.TMPDIR ?? '/tmp', `fy-large-media-${process.pid}-${count}.webm`);
      const child = Bun.spawn(
        [
          ffmpeg,
          '-y',
          '-f',
          'image2pipe',
          '-framerate',
          '6',
          '-c:v',
          'mjpeg',
          '-i',
          '-',
          '-c:v',
          'libvpx',
          '-b:v',
          '12M',
          '-crf',
          '4',
          '-g',
          '1',
          '-pix_fmt',
          'yuv420p',
          output,
        ],
        { stderr: 'pipe', stdin: 'pipe', stdout: 'pipe' },
      );
      for (const frame of frames) child.stdin.write(Buffer.from(frame, 'base64'));
      await child.stdin.end();
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${errors.slice(-400)}`);
      const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
      await Bun.file(output).delete();
      if (bytes.byteLength >= THREE_MIB) return bytes;
    }
    throw new Error('could not make a three-mebibyte WebM');
  } finally {
    await page.close();
  }
};
