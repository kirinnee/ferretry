import { describe, expect, it } from 'bun:test';
import type { ForeignHistoryListing, ImportedConversationDetail } from '@ferretry/protocol';
import { ImportedHistoryPage } from '../../src/components/imported-history-page.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../support/dom.ts';

const connection = daemonConnection({
  daemonId: 'archive-daemon',
  baseUrl: 'https://archive.example.test',
  deviceToken: 'archive-token',
});

const conversation = {
  id: 'import-one',
  harness: 'claude' as const,
  title: 'Keep this transcript read-only',
  eventCount: 2,
  startedAt: '2026-08-01T12:00:00.000Z',
  readOnly: true as const,
};

const listing: ForeignHistoryListing = {
  conversations: [conversation],
  skipped: [{ harness: 'codex', reason: 'invalid-json', count: 2 }],
};

const detail: ImportedConversationDetail = {
  conversation,
  messages: [
    { id: 'user-record', role: 'user', text: 'Please preserve this.' },
    { id: 'assistant-record', role: 'assistant', text: 'It remains archival evidence.' },
  ],
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('ImportedHistoryPage', () => {
  it('reads the supplied daemon, renders the archival boundary, and opens a transcript without session controls', async () => {
    const historyReads: string[] = [];
    const conversationReads: string[] = [];
    const view = await mount(
      <ImportedHistoryPage
        connection={connection}
        readHistory={async daemon => {
          historyReads.push(daemon.daemonId);
          return listing;
        }}
        readConversation={async (daemon, id) => {
          conversationReads.push(`${daemon.daemonId}:${id}`);
          return detail;
        }}
      />,
    );
    try {
      await settle();
      expect(historyReads).toEqual(['archive-daemon']);
      expect(view.container.textContent).toContain('cannot be resumed or sent messages');
      expect(view.container.textContent).toContain('Keep this transcript read-only');
      expect(view.container.textContent).toContain('2 Codex: invalid-json');
      expect(view.container.querySelectorAll('button')).toHaveLength(1);

      await interact(() => must(view.container.querySelector<HTMLButtonElement>('button'), 'read button').click());
      await settle();

      expect(conversationReads).toEqual(['archive-daemon:import-one']);
      expect(view.container.textContent).toContain('Read-only transcript');
      expect(view.container.textContent).toContain('Please preserve this.');
      expect(view.container.textContent).toContain('It remains archival evidence.');
    } finally {
      await view.unmount();
    }
  });

  it('calls an empty listing empty rather than broken', async () => {
    const view = await mount(
      <ImportedHistoryPage
        connection={connection}
        readHistory={async () => ({ conversations: [], skipped: [] })}
        readConversation={async () => detail}
      />,
    );
    try {
      await settle();
      expect(view.container.textContent).toContain('No readable imported conversations were found for this daemon.');
    } finally {
      await view.unmount();
    }
  });

  it('reports an unreadable history and an unreadable selected transcript plainly', async () => {
    const failedHistory = await mount(
      <ImportedHistoryPage
        connection={connection}
        readHistory={async () => await Promise.reject(new Error('history permission denied'))}
        readConversation={async () => detail}
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

    const failedConversation = await mount(
      <ImportedHistoryPage
        connection={connection}
        readHistory={async () => listing}
        readConversation={async () => await Promise.reject('offline')}
      />,
    );
    try {
      await settle();
      await interact(() =>
        must(failedConversation.container.querySelector<HTMLButtonElement>('button'), 'read button').click(),
      );
      await settle();
      expect(failedConversation.container.querySelector('[role="alert"]')?.textContent).toContain(
        'This imported conversation could not be read.',
      );
    } finally {
      await failedConversation.unmount();
    }
  });
});
