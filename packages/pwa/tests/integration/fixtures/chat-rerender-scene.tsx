/**
 * The browser entry for "new messages reset what I was doing": the REAL `Transcript` fed by the REAL
 * `transcriptEntriesFromLog`, over a log whose window SLIDES — the newest `WINDOW` records of the session,
 * as the daemon's 200-tail does — so every appended message pushes the oldest one off the top.
 *
 * The session holds one assistant message with an interactive `html` block (a tab strip whose choice
 * lives inside the iframe) and a run of tool calls (a tool group). `window.__appendMessages(n)` lands
 * `n` new messages. Nothing here reads a network.
 *
 *   ?theme=<family>-<mode>
 */

import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { transcriptEntriesFromLog } from '../../../src/components/session-workspace-model.ts';
import { Transcript } from '../../../src/components/transcript.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

declare global {
  interface Window {
    __appendMessages: (count: number) => void;
  }
}

const WINDOW = 14;
const INITIAL_TOTAL = 14;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

const clockAt = (second: number): string =>
  `10:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}`;

const record = (second: number, role: string, lines: readonly string[]): string =>
  [`[${clockAt(second)}] ${role}/message: ${lines[0] ?? ''}`, ...lines.slice(1).map(line => `    ${line}`)].join('\n');

const toolCall = (second: number, name: string, input: string): string =>
  `[${clockAt(second)}] assistant/tool-call: ${name}(${input})`;
const toolResult = (second: number): string => `[${clockAt(second)}] tool/tool-result: ok`;

const AGENDA_PAGE = [
  '<style>',
  'body { font: 14px system-ui, sans-serif; margin: 0; padding: 12px; }',
  '.tabs { display: flex; gap: 8px; margin-bottom: 12px; }',
  'button { border: 1px solid #8884; border-radius: 6px; background: #fff; color: #222; padding: 6px 14px; cursor: pointer; }',
  'button[aria-pressed="true"] { background: #2b5cff; border-color: #2b5cff; color: #fff; font-weight: 600; }',
  '</style>',
  '<div class="tabs"><button aria-pressed="true" data-day="1">Day 1</button><button aria-pressed="false" data-day="2">Day 2</button><button aria-pressed="false" data-day="3">Day 3</button></div>',
  '<div id="agenda">Day 1 agenda: arrive in Lisbon, check in, walk the Alfama.</div>',
  '<script>',
  'const agendas = { 1: "Day 1 agenda: arrive in Lisbon, check in, walk the Alfama.", 2: "Day 2 agenda: Belem tower, pasteis de nata, sunset at the miradouro.", 3: "Day 3 agenda: day trip to Sintra and the Pena palace." };',
  'document.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {',
  '  document.querySelectorAll("button").forEach(o => o.setAttribute("aria-pressed", String(o === b)));',
  '  document.getElementById("agenda").textContent = agendas[b.dataset.day];',
  '}));',
  '</script>',
];

const AGENDA_MESSAGE = [
  'Here is the three-day agenda. Pick a day:',
  '',
  '```fy-render',
  'type: html',
  'alt: A three-day agenda with tabs',
  '---',
  ...AGENDA_PAGE,
  '```',
];

/** The session as it would read with no window at all: `total` records, the interesting ones in the middle. */
const fullLog = (total: number): readonly string[] => {
  const records: string[] = [];
  for (let second = 0; second < total; second++) {
    if (second === 8) records.push(record(second, 'assistant', AGENDA_MESSAGE));
    else if (second === 10) records.push(toolCall(second, 'Read', '{"path":"itinerary.md"}'));
    else if (second === 11) records.push(toolResult(second));
    else if (second === 12) records.push(toolCall(second, 'Grep', '{"pattern":"Sintra"}'));
    else if (second === 13) records.push(toolResult(second));
    else if (second % 2 === 0) records.push(record(second, 'user', [`question ${second}`]));
    else records.push(record(second, 'assistant', [`Here is answer ${second}.`]));
  }
  return records;
};

/** What the daemon's `logs()` returns: the newest `WINDOW` records. */
const windowAt = (total: number): string =>
  fullLog(total)
    .slice(Math.max(0, total - WINDOW))
    .join('\n');

function Scene() {
  const [total, setTotal] = useState(INITIAL_TOTAL);
  useEffect(() => {
    window.__appendMessages = (count: number) => setTotal(current => current + count);
  }, []);
  const entries = useMemo(() => transcriptEntriesFromLog(windowAt(total), NOW), [total]);
  return (
    <div className="scene-chat">
      <Transcript agentName="Janella" daemonId="daemon-rerender" entries={entries} sessionId="mvrerend-5e7d0b1e" />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
