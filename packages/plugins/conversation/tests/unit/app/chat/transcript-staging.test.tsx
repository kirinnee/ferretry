import { afterEach, describe, expect, test } from 'bun:test';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import type { TranscriptHistoryControl } from '../../../../app/chat/transcript-history-row.tsx';
import {
  isStaged,
  STAGED_MARKER_CLASS,
  STAGING_PATIENCE_MS,
  stagedReadingPending,
  watchStagedReadings,
} from '../../../../app/chat/transcript-staging.ts';
import { answer } from '../../../../app/hypermedia/durian-answer.ts';
import { createDurianReader, type WorkerLike } from '../../../../app/hypermedia/durian-reader.ts';
import { isReadRequest, type ReadRequest } from '../../../../app/hypermedia/durian-wire.ts';
import { PENDING_READING_ATTRIBUTE } from '../../../../app/hypermedia/plain-fallback.tsx';
import { withDurianReader } from '../../../support/durian-reader.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

/**
 * AN OLDER PAGE GOES ON SCREEN ONLY ONCE ITS ROWS ARE READ (`transcript-staging.ts`): a message is its plain text until the
 * Durian worker answers and the read document is shorter, so rows that went on screen at once shrank above the reader one by
 * one and moved what they were reading. Here the worker answers only when the test says so.
 */

/** A worker that is ready at once and answers each ask only when `answerAll` is called. */
const heldWorker = () => {
  const asks: ReadRequest[] = [];
  let listener: WorkerLike['onmessage'] = null;
  const deliver = (data: unknown): void => queueMicrotask(() => listener?.(new MessageEvent('message', { data })));
  const worker: WorkerLike = {
    get onmessage() {
      return listener;
    },
    set onmessage(next) {
      const first = listener === null && next !== null;
      listener = next;
      if (first) deliver({ kind: 'ready' });
    },
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      if (isReadRequest(message)) asks.push(message);
    },
    terminate: () => undefined,
  };
  /** Answers every ask so far, and every ask the answers bring, until none is left. */
  const answerAll = async (): Promise<void> => {
    for (let ask = asks.shift(); ask !== undefined; ask = asks.shift()) {
      deliver(answer(ask));
      await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
    }
  };
  return { worker, answerAll, asks };
};

const rows = (count: number, prefix: string): TranscriptEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    kind: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `${prefix} ${index}`,
  }));

const history: TranscriptHistoryControl = { status: 'more', loadOlder: () => undefined };

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const content = (view: Mounted): HTMLElement =>
  must(view.container.querySelector<HTMLElement>('.fy-transcript-content'), 'the transcript content');
const marker = (view: Mounted): Element | null => view.container.querySelector(`.${STAGED_MARKER_CLASS}`);
const historyRow = (view: Mounted): string | undefined =>
  view.container.querySelector<HTMLElement>('.fy-transcript-history')?.dataset.history;

describe('an older page is held back until its rows are read', () => {
  test('its rows are mounted behind the marker, the row says loading, and the page goes on screen once read', async () => {
    const held = heldWorker();
    const reader = createDurianReader({ spawn: () => Promise.resolve(held.worker) });
    const tail = rows(4, 'tail');
    const draw = (entries: readonly TranscriptEntry[]) =>
      withDurianReader(<Transcript daemonId="d" entries={entries} history={history} sessionId="s" />, reader);
    const view = await mount(draw(tail));
    mounted = view;
    await held.answerAll();
    expect(marker(view)).toBeNull();
    expect(historyRow(view)).toBe('more');

    await view.render(draw([...rows(4, 'older'), ...tail]));
    // The older rows are there (mounted, asking to be read) but before the marker, so not laid out.
    const shown = must(marker(view), 'the staging marker');
    expect(shown.nextElementSibling?.textContent).toContain('tail 0');
    expect(view.container.textContent).toContain('older 1');
    const olderRow = must(
      [...content(view).children].find(child => child.textContent?.includes('older 1')),
      'an older row',
    );
    expect(isStaged(olderRow, content(view))).toBe(true);
    expect(isStaged(must(shown.nextElementSibling, 'the first row shown'), content(view))).toBe(false);
    expect(stagedReadingPending(content(view))).toBe(true);
    expect(historyRow(view)).toBe('loading');

    await held.answerAll();
    expect(view.container.querySelector(`[${PENDING_READING_ATTRIBUTE}]`)).toBeNull();
    expect(marker(view)).toBeNull();
    expect(historyRow(view)).toBe('more');
  });

  test('a page whose rows are never read goes on screen when the patience runs out', async () => {
    const box = document.createElement('div');
    box.innerHTML = `<div>older</div><div class="${STAGED_MARKER_CLASS}"></div><div><div ${PENDING_READING_ATTRIBUTE}></div></div>`;
    // A row still reading AFTER the marker (the tail streaming) never holds the page.
    expect(stagedReadingPending(box)).toBe(false);
    box.firstElementChild?.setAttribute(PENDING_READING_ATTRIBUTE, '');
    expect(stagedReadingPending(box)).toBe(true);

    // A staging that began long ago has no patience left: it is shown on the next turn, though a row still reads.
    const settled: string[] = [];
    const stop = watchStagedReadings(box, Number.NEGATIVE_INFINITY, () => settled.push('shown'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toEqual(['shown']);
    stop();
  });

  test('a page whose worker never answers is shown once the patience runs out, still as its plain text', async () => {
    const held = heldWorker();
    const reader = createDurianReader({ spawn: () => Promise.resolve(held.worker), parseBudgetMs: 60_000 });
    const tail = rows(2, 'tail');
    const draw = (entries: readonly TranscriptEntry[]) =>
      withDurianReader(<Transcript daemonId="d" entries={entries} history={history} sessionId="s" />, reader);
    const view = await mount(draw(tail));
    mounted = view;
    await held.answerAll();

    await view.render(draw([...rows(2, 'older'), ...tail]));
    expect(marker(view)).not.toBeNull();
    // Never answered: the page waits for no more than the patience.
    await interact(() => new Promise(resolve => setTimeout(resolve, STAGING_PATIENCE_MS + 100)));
    expect(marker(view)).toBeNull();
    expect(historyRow(view)).toBe('more');
    expect(view.container.querySelector(`[${PENDING_READING_ATTRIBUTE}]`)?.textContent).toContain('older 1');
  });

  test('a message arriving at the tail while an older page is held back is on screen at once', async () => {
    const held = heldWorker();
    const reader = createDurianReader({ spawn: () => Promise.resolve(held.worker) });
    const tail = rows(2, 'tail');
    const draw = (entries: readonly TranscriptEntry[]) =>
      withDurianReader(<Transcript daemonId="d" entries={entries} history={history} sessionId="s" />, reader);
    const view = await mount(draw(tail));
    mounted = view;
    await held.answerAll();
    const older = rows(2, 'older');
    await view.render(draw([...older, ...tail]));
    expect(marker(view)).not.toBeNull();

    const mine: TranscriptEntry = { id: 'mine', kind: 'user', text: 'my new message' };
    await view.render(draw([...older, ...tail, mine]));
    const row = must(
      [...content(view).children].find(child => child.textContent?.includes('my new message')),
      'the new row',
    );
    expect(isStaged(row, content(view))).toBe(false);
    // And a tail with no page above it is never held back at all.
    await held.answerAll();
    expect(marker(view)).toBeNull();
    await view.render(draw([...older, ...tail, mine, { id: 'reply', kind: 'assistant', text: 'a reply' }]));
    expect(marker(view)).toBeNull();
  });
});
