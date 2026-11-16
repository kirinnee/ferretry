import { describe, expect, test } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { SecretName } from '@ferretry/core-vault/contract';
import { maskedScreen } from '../../../../../daemon/lib/session/snapshot/screen-mask.ts';

const vault = (values: Record<string, string>) =>
  new FakeRedaction(new Map(Object.entries(values).map(([name, value]) => [name as SecretName, value])));

/** The SPEED half of F-0326 #U4: the full 200×1300 pane inside 2 s. The reading counts are held here at the full size and in the unit tier at a small one. */
describe('F-0326 #U4 the masker stays inside the stop bound on a big, busy screen', () => {
  /** A 4-character value printed densely across a 200×1300 pane (just under the masker's cap): 52,000 matches. Fake. */
  const PIN = '1234';
  const busy = (row: (index: number) => string) => Array.from({ length: 200 }, (_, index) => row(index)).join('\n');

  /** `maskedScreen` over `screen`, with every character it hands the scope counted. */
  async function timed(
    screen: string,
  ): Promise<{ readonly out: string; readonly asked: number; readonly took: number }> {
    let asked = 0;
    const started = performance.now();
    const out = await vault({ PIN }).read(scope =>
      maskedScreen(
        {
          ...scope,
          text: text => {
            asked += text.length;
            return scope.text(text);
          },
          lines: lines => {
            for (const line of lines) asked += line.length;
            return scope.lines(lines);
          },
        },
        screen,
      ),
    );
    return { out, asked, took: performance.now() - started };
  }

  test('F-0326 #U4 a 200×1300 screen dense with a short value behind a gutter is masked in under 2 s', async () => {
    const screen = busy(index => (index % 2 === 0 ? `  ⎿  ${`${PIN} `.repeat(259)}` : `${PIN} `.repeat(260)));
    const { out, asked, took } = await timed(screen);
    expect(out).not.toContain(PIN);
    expect(asked).toBeLessThanOrEqual(8 * screen.length);
    expect(took).toBeLessThan(2000);
  });

  test('F-0326 #U4 a screen that draws no gutter is masked in under 2 s', async () => {
    const screen = busy(() => `${PIN} `.repeat(260).trimEnd());
    const { out, asked, took } = await timed(screen);
    expect(out).not.toContain(PIN);
    expect(asked).toBeLessThanOrEqual(5 * screen.length);
    expect(took).toBeLessThan(2000);
  });
});
