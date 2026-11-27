import { expect, it } from 'bun:test';
import { CaptureFrameWindow } from '../../../daemon/worker/capture/frame-window.ts';

const clean = async () => undefined;

async function primed() {
  const window = new CaptureFrameWindow(() => Date.now());
  await expect(window.check(Date.now() / 1000, clean)).rejects.toThrow(/before its render/u);
  await Bun.sleep(5);
  return window;
}

it('requires a clean scan completed before the render timestamp and another at receipt', async () => {
  const window = await primed();
  let scans = 0;
  await window.check(Date.now() / 1000, async () => {
    scans++;
  });
  expect(scans).toBe(1);
});

it('uses an earlier uninterrupted clean scan when rendering precedes the latest receipt scan', async () => {
  const window = await primed();
  const renderedAt = Date.now() / 1000;
  await window.check(renderedAt, clean);
  await Bun.sleep(5);
  await window.check(renderedAt, clean);
});

for (const timestamp of [undefined, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
  it(`withholds a frame with an absent, invalid, old or future timestamp: ${String(timestamp)}`, async () => {
    const window = await primed();
    await expect(window.check(timestamp, clean)).rejects.toThrow();
  });
}

it('invalidates the earlier scan when an input or lifecycle event intervenes', async () => {
  const window = await primed();
  window.invalidate();
  await expect(window.check(Date.now() / 1000, clean)).rejects.toThrow();
});

it('withholds changes during the receipt scan and never primes from a failed scan', async () => {
  const window = await primed();
  await expect(window.check(Date.now() / 1000, async () => window.invalidate())).rejects.toThrow(/changed/u);
  await expect(
    window.check(Date.now() / 1000, async () => {
      throw new Error('scan failed');
    }),
  ).rejects.toThrow(/scan failed/u);
  await expect(window.check(Date.now() / 1000, clean)).rejects.toThrow();
});
