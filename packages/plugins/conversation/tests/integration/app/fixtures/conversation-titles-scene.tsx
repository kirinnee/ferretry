/**
 * The browser entry for conversation titles: the REAL conversation card (`ConversationLines`) over the rows the REAL
 * conversation index made from fake transcripts (the test serves them at `/rows.json`).
 *
 *   ?theme=<family>-<mode>
 */
import { createRoot } from 'react-dom/client';
import type { LinkableConversation } from '../../../../contract/index.ts';
import { ConversationLines } from '../../../../app/links/conversation-card.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

/** Every row the card draws is one list item, as the pickers draw it. */
const NOW = Date.parse('2026-02-02T09:00:00.000Z');

const rows = (await (await fetch('/rows.json')).json()) as readonly LinkableConversation[];

createRoot(document.getElementById('root') as HTMLElement).render(
  <ul style={{ listStyle: 'none', margin: 0, padding: 12, display: 'grid', gap: 8 }}>
    {rows.map(row => (
      <li key={row.id} data-row={row.id} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8 }}>
        <ConversationLines
          row={row}
          now={NOW}
          {...(row.ferret === undefined
            ? {}
            : { ferret: { id: row.ferret, name: row.ferretName ?? row.ferret, status: 'working' } })}
        />
      </li>
    ))}
  </ul>,
);
