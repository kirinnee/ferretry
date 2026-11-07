import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import {
  type HistoryEntry,
  type HistoryList,
  HistoryPage,
  harnessName,
  readHistory,
  readHistoryEntry,
} from '../../../../app/links/history-page.tsx';
import { fakeClient } from '../../../support/app/client.tsx';

const DAEMON = 'archive-daemon';

const entry = {
  id: 'import-one',
  harness: 'claude-code',
  title: 'Keep this transcript read-only',
  at: '2026-08-01T12:00:00.000Z',
} as HistoryList['entries'][number];

const history: HistoryList = { entries: [entry] };

const detail: HistoryEntry = {
  entry,
  messages: [
    { role: 'user', text: 'Please preserve this.' },
    { role: 'assistant', text: 'It remains archival evidence.' },
  ],
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const readButton = (container: HTMLElement): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>('button:not([data-theme-trigger])'), 'read button');

describe('HistoryPage', () => {
  it('reads the history once, renders the archival boundary, and opens a transcript without ferret controls', async () => {
    let historyReads = 0;
    const entryReads: string[] = [];
    const view = await mount(
      <HistoryPage
        daemon={DAEMON}
        readHistory={async () => {
          historyReads += 1;
          return history;
        }}
        readEntry={async id => {
          entryReads.push(id);
          return detail;
        }}
      />,
    );
    try {
      await settle();
      expect(historyReads).toBe(1);
      expect(view.container.textContent).toContain(`Archive · ${DAEMON}`);
      expect(view.container.textContent).toContain('cannot be resumed or sent messages');
      expect(view.container.textContent).toContain('Keep this transcript read-only');
      expect(view.container.textContent).toContain('Claude Code');
      expect(view.container.querySelectorAll('button:not([data-theme-trigger])')).toHaveLength(1);

      await interact(() => readButton(view.container).click());
      await settle();

      expect(entryReads).toEqual(['import-one']);
      expect(view.container.textContent).toContain('Read-only transcript');
      expect(view.container.textContent).toContain('Please preserve this.');
      expect(view.container.textContent).toContain('It remains archival evidence.');
    } finally {
      await view.unmount();
    }
  });

  it('calls an empty listing empty rather than broken', async () => {
    const view = await mount(
      <HistoryPage daemon={DAEMON} readHistory={async () => ({ entries: [] })} readEntry={async () => detail} />,
    );
    try {
      await settle();
      expect(view.container.textContent).toContain('No readable harness conversations were found on this daemon.');
    } finally {
      await view.unmount();
    }
  });

  it('reports an unreadable history and an unreadable selected transcript plainly', async () => {
    const failedHistory = await mount(
      <HistoryPage
        daemon={DAEMON}
        readHistory={async () => await Promise.reject(new Error('history permission denied'))}
        readEntry={async () => detail}
      />,
    );
    try {
      await settle();
      expect(failedHistory.container.querySelector('[role="alert"]')?.textContent).toContain(
        'history permission denied',
      );
    } finally {
      await failedHistory.unmount();
    }

    const failedEntry = await mount(
      <HistoryPage
        daemon={DAEMON}
        readHistory={async () => history}
        readEntry={async () => await Promise.reject('offline')}
      />,
    );
    try {
      await settle();
      await interact(() => readButton(failedEntry.container).click());
      await settle();
      expect(failedEntry.container.querySelector('[role="alert"]')?.textContent).toContain(
        'This conversation could not be read.',
      );
    } finally {
      await failedEntry.unmount();
    }
  });
});

describe('the history reads', () => {
  it('lists the history and reads one entry by its id through the client, parsed', async () => {
    const client = fakeClient({
      'GET /v1/links/history': () => history,
      'GET /v1/links/history/:entryId': () => detail,
    });
    expect(await readHistory(client)).toEqual(history);
    expect(await readHistoryEntry(client, 'import-one')).toEqual(detail);
    expect(client.callsTo('GET /v1/links/history/:entryId')[0]?.params).toEqual({ entryId: 'import-one' });
    client.on('GET /v1/links/history', () => ({ entries: [{ id: 'x' }] }));
    await expect(readHistory(client)).rejects.toThrow();
  });

  it('names a harness as a reader calls it', () => {
    expect(harnessName('claude-code')).toBe('Claude Code');
    expect(harnessName('codex')).toBe('Codex');
    expect(harnessName('gemini')).toBe('gemini');
  });
});
