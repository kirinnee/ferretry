import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '@ferretry/kernel/host';
import { fixedClock } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { parseSessionId, sendPage, sendRecordView } from '@ferretry/core-mailbox/contract';
import { CONVERSATION_STATE } from '../../contract/index.ts';
import { StateSendLedger } from '../../daemon/delivery/adapters/state-send-ledger.ts';
import { SendsPager } from '../../../../core/mailbox/daemon/lib/delivery/sends-pager.ts';

/**
 * The SPEED half of "a chat opens on a 70 MB ledger": `GET /sends` read the whole `sends.jsonl` before cutting a page (1-1.8 s
 * on a real home). The page is now cut from an index and the end of the log, so it takes milliseconds whatever the ledger weighs.
 * That the page is the SAME page is checked at a small size in unit (`packages/core/mailbox/tests/unit/delivery/sends-pager.test.ts`); here it is
 * checked once more on the big file, beside the budget.
 */
const FERRET = parseSessionId('ferret-big');
const TARGET_BYTES = 70_000_000;
const SENDS = 9_000;
const BUDGET_MS = 200;

const home = mkdtempSync(join(tmpdir(), 'fy-sends-perf-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** About 70 MB of fake data: 9,000 sends, each written as accepted and again as it settled, a few old ones left open. */
function writeLedger(): number {
  const folder = join(home, 'state', 'conversation', FERRET);
  mkdirSync(folder, { recursive: true });
  const lines: string[] = [];
  let bytes = 0;
  for (let n = 0; bytes < TARGET_BYTES; n++) {
    const id = `snd-${String(n % SENDS).padStart(6, '0')}`;
    const acceptedAt = new Date(Date.UTC(2026, 10, 1) + (n % SENDS) * 60_000).toISOString();
    const settled = n >= SENDS;
    const fate = !settled ? 'accepted' : (n % SENDS) % 500 === 7 ? 'timed_out' : 'delivered';
    const line = JSON.stringify({
      format: 1,
      sendId: id,
      acceptedAt,
      acceptedTurn: n % 50,
      path: 'native-inline',
      message: 'fake words '.repeat(200 + (n % 100)),
      fate,
      at: acceptedAt,
    });
    lines.push(line);
    bytes += line.length + 1;
  }
  writeFileSync(join(folder, 'sends.jsonl'), `${lines.join('\n')}\n`);
  return bytes;
}

/**
 * The fastest of a few runs: a budget on one sample measures the garbage collector that happens to fall in it. The perf
 * tier runs one process at a time on its runner (`scripts/ci/test.sh perf`), so the fastest run is the code's.
 */
async function fastest(
  run: () => Promise<unknown>,
  before: () => Promise<unknown> = async () => undefined,
): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 5; sample++) {
    await before();
    const started = performance.now();
    await run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('a page of sends from a 70 MB ledger', () => {
  test('the newest page, the one after it and a page after an append each take under 200 ms', async () => {
    const size = writeLedger();
    expect(size).toBeGreaterThan(TARGET_BYTES);
    const port = state.createStatePort({
      home,
      pluginId: 'conversation',
      files: CONVERSATION_STATE,
      fs: state.createNodeHostFs(),
    });
    const ledger = new StateSendLedger(port, fixedClock('2026-11-17T00:00:00.000Z' as Instant));
    const pager = new SendsPager(ledger);
    const whole = (query: Parameters<typeof sendPage>[1]) =>
      ledger.list(FERRET).then(rows => sendPage(rows.map(sendRecordView), query));

    // The first look of a session reads its ledger once to build the index; it is not the budget.
    const first = await pager.page(FERRET, { limit: 100 });
    expect(first).toEqual(await whole({ limit: 100 }));
    expect(first?.sends.some(send => send.fate === 'timed_out')).toBe(true);

    const newestMs = await fastest(async () => await pager.page(FERRET, { limit: 100 }));
    const newest = await pager.page(FERRET, { limit: 100 });
    const cursor = newest?.nextCursor ?? '';
    const olderMs = await fastest(async () => await pager.page(FERRET, { limit: 100, before: cursor }));
    const older = await pager.page(FERRET, { limit: 100, before: cursor });

    // Each sample follows one more line appended to the ledger: the index reads only that line's end of the log.
    let appends = 0;
    const appendedMs = await fastest(
      async () => await pager.page(FERRET, { limit: 100 }),
      async () =>
        await ledger.accept(FERRET, {
          sendId: `snd-new-${appends++}`,
          acceptedAt: new Date(Date.UTC(2026, 11, 1, 0, appends)).toISOString(),
          acceptedTurn: 1,
          path: 'direct',
          message: 'one more',
          fate: 'accepted',
        }),
    );
    const appended = await pager.page(FERRET, { limit: 100 });

    expect(newest).toEqual(first);
    expect(older).toEqual(await whole({ limit: 100, before: cursor }));
    expect(appended?.sends[0]?.sendId).toBe(`snd-new-${appends - 1}`);
    expect(appended).toEqual(await whole({ limit: 100 }));
    expect(newestMs).toBeLessThan(BUDGET_MS);
    expect(olderMs).toBeLessThan(BUDGET_MS);
    expect(appendedMs).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
