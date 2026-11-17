/**
 * The browser entry for the harness history's skipped-transcripts note: the REAL `HistoryPage` over fixed fake data (two
 * conversations, three transcripts the index could not read: two in Claude Code, one in Codex).
 *
 *   ?theme=<family>-<mode>
 */
import { createRoot } from 'react-dom/client';
import { HistoryPage } from '../../../../app/links/history-page.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const entries = [
  {
    id: 'fake-one',
    harness: 'claude-code',
    title: 'Tidy the release notes',
    at: '2026-08-01T12:00:00.000Z',
    turns: 12,
  },
  { id: 'fake-two', harness: 'codex', title: 'Draft a migration plan', at: '2026-07-30T09:30:00.000Z', turns: 4 },
];

createRoot(document.getElementById('root') as HTMLElement).render(
  <HistoryPage
    daemon="daemon-a"
    readEntry={async () => ({ entry: entries[0] as never, messages: [] })}
    readHistory={async () => ({ entries: entries as never, skipped: 3, skippedBy: { 'claude-code': 2, codex: 1 } })}
  />,
);
