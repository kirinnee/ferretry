import { describe, expect, it } from 'bun:test';
import { hasTokenShape, plainPaste, storedEnvironmentIssue, urlCarries } from '../../../contract/secret-shape.ts';

// R6: the stored rule is linear. What it finds is tests/unit/contract/secret-shape.test.ts; this file holds only the
// time, at 256 KiB.

/**
 * The BEST main-thread CPU time of a few runs of a synchronous `work`, in ms. A bound on the clock measures the box as
 * much as the code: a quadratic path is slow in every run and fails, a collection or a lost moment on a shared runner
 * lands in one run and does not. A further run is taken only while the best so far is at or over half the bound, which
 * gives the verdict of three runs and costs nothing when the first one is fast (the same shape as the kernel's
 * `issue-cap.test.ts`). The runs that matter are tens of ms, far above the clock's tick.
 */
function bestCpuMs(work: () => void, boundMs: number): number {
  if (typeof process.threadCpuUsage !== 'function') throw new Error('process.threadCpuUsage is not available');
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3 && best >= boundMs / 2; attempt += 1) {
    const before = process.threadCpuUsage();
    work();
    const spent = process.threadCpuUsage(before);
    best = Math.min(best, (spent.user + spent.system) / 1_000);
  }
  return best;
}

describe('R6: the stored rule is linear', () => {
  it('should judge a 256 KiB value of one repeated character in well under 100 ms, stored and prefilled', () => {
    let worst = 0;
    for (const character of [':', '@', '=', '%', ' ', ',', '\n', '?', '#', '/', '[', '$']) {
      const value = character.repeat(256 * 1024);
      for (const name of ['GATEWAY_TOKEN', 'GATEWAY_NOTE', 'ANTHROPIC_CUSTOM_HEADERS']) {
        const ms = bestCpuMs(() => {
          storedEnvironmentIssue(name, value);
          plainPaste(name, value, false);
          urlCarries(value);
        }, 100);
        worst = Math.max(worst, ms);
        expect(ms).toBeLessThan(100);
      }
    }
    // The CPU clock must read something: the slowest pair takes tens of ms, so a clock stuck at 0 would pass anything.
    expect(worst).toBeGreaterThan(0);
  });

  it('R7: should judge 256 KiB of key runs, PEM openings, schemes, queries and header names in under 250 ms', () => {
    const pieces = [
      'q7Zk0',
      'a1',
      'a1/',
      'a1.',
      'a-1',
      '-----BEGIN ',
      '-----BEGIN A1 ',
      'https://',
      'https://a/',
      'a,https://',
      '?a=',
      '?a=b&',
      '&a=1',
      'x-api-key:',
      'x-honeycomb-team=',
      'a-b-c-d-e-',
      '\t',
      '\r\n',
      'a:\n',
      '${secret:',
      '%2',
    ];
    let worst = 0;
    for (const piece of pieces) {
      const value = piece.repeat(Math.ceil((256 * 1024) / piece.length));
      for (const name of ['GATEWAY_TOKEN', 'AZURE_OPENAI_KEY', 'GATEWAY_NOTE', 'OTEL_EXPORTER_OTLP_HEADERS']) {
        const ms = bestCpuMs(() => {
          storedEnvironmentIssue(name, value);
          plainPaste(name, value, false);
        }, 250);
        worst = Math.max(worst, ms);
        expect(ms).toBeLessThan(250);
      }
    }
    // The CPU clock must read something: the slowest pieces take tens of ms, so a clock stuck at 0 would pass anything.
    expect(worst).toBeGreaterThan(0);
  });

  it('should judge repeated JWT openings in linear time', () => {
    const started = performance.now();
    expect(hasTokenShape(`x ${'eyJ'.repeat(90_000)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
