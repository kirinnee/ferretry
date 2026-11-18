/**
 * The browser entry for "a picture in a message opens in the app's one viewer": Conversation's REAL `SessionChatPage`, drawn
 * as the chat page (`?ctx=chat`) or `embedded` under a stand-in agenda item card (`?ctx=agenda`), with one assistant message
 * carrying an `image` fence — the real `fy-render` block, whose picture is the real `FyRenderZoomImage`. Everything is fake data.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { SessionChatPage } from '../../../../app/chat/session-chat-page.tsx';
import { ferretView } from '../../../support/app/ferret-view.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-dark';
const agenda = params.get('ctx') === 'agenda';
const phone = window.innerWidth < 768;

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

/** A 1800 x 1200 fake chart, drawn here and sent as a PNG: far larger than any column, so the viewer has a resolution to state. */
const chartPng = (): string => {
  const canvas = document.createElement('canvas');
  canvas.width = 1_800;
  canvas.height = 1_200;
  const draw = canvas.getContext('2d');
  if (draw === null) throw new Error('no canvas');
  draw.fillStyle = '#101826';
  draw.fillRect(0, 0, 1_800, 1_200);
  draw.strokeStyle = '#2a3a55';
  draw.lineWidth = 2;
  for (let at = 0; at < 11; at += 1) {
    draw.beginPath();
    draw.moveTo(100, 100 + at * 100);
    draw.lineTo(1_700, 100 + at * 100);
    draw.stroke();
  }
  const line = (colour: string, points: readonly (readonly [number, number])[]): void => {
    draw.strokeStyle = colour;
    draw.lineWidth = 8;
    draw.beginPath();
    for (const [index, [x, y]] of points.entries()) {
      if (index === 0) draw.moveTo(x, y);
      else draw.lineTo(x, y);
    }
    draw.stroke();
  };
  line('#4ade80', [
    [100, 1000],
    [400, 820],
    [700, 880],
    [1000, 500],
    [1300, 420],
    [1700, 160],
  ]);
  line('#60a5fa', [
    [100, 1050],
    [400, 980],
    [700, 900],
    [1000, 860],
    [1300, 700],
    [1700, 640],
  ]);
  draw.fillStyle = '#e5e7eb';
  draw.font = '44px sans-serif';
  draw.fillText('Fixture throughput, fake data', 100, 70);
  return canvas.toDataURL('image/png').replace('data:image/png;base64,', '');
};

const entries: readonly TranscriptEntry[] = [
  { id: 'e1', kind: 'user', text: 'Show me the throughput chart.', at: NOW - 600_000 },
  {
    id: 'e2',
    kind: 'assistant',
    label: 'zoe',
    text: [
      'Here it is:',
      '',
      '```fy-render',
      'type: image',
      'alt: Fixture throughput chart',
      'mime: image/png',
      '---',
      chartPng(),
      '```',
    ].join('\n'),
    at: NOW - 300_000,
  },
];

const client = { call: async () => ({}) } as never;
const chat = (
  <SessionChatPage
    client={client}
    daemonId="ws"
    embedded={agenda}
    entries={entries}
    session={ferretView('zoe', { config: { teammate: 'zoe' } })}
  />
);

function Scene() {
  if (!agenda)
    return <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>{chat}</div>;
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      {phone ? null : (
        <nav style={{ width: 168, flex: 'none', borderRight: '1px solid var(--border)', padding: 8 }}>
          <p>Ferrets</p>
          <p>Agenda</p>
          <p>Board</p>
        </nav>
      )}
      <div
        style={{ width: phone ? '100%' : 700, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <section style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <p>Zoe · Fixture running · workshop</p>
          <h2>Review the throughput chart</h2>
        </section>
        <div style={{ flex: 1, minHeight: 0 }}>{chat}</div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
