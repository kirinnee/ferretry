/**
 * The browser entry for "the double text box (right after sending) still exists": the REAL `Transcript`
 * over the REAL `placeLedgerRows`, fed a fake daemon whose transcript and send ledger change on a
 * timeline — the way a poll sees them when the agent's record and the daemon's confirmation arrive a
 * few hundred milliseconds apart, in either order, on a local or a relayed carrier.
 *
 * Nothing here reads a network: the transcript is a daemon log string, the ledger is records in memory,
 * and the hand-off document a turn-file send points at is answered by a fake source after `?read=` ms.
 *
 * Parameters (all optional):
 *
 *   ?path=direct|turn-file|queued-file|merged   how the message travelled (default direct)
 *   ?harness=claude|codex                       how the harness wrote it down (default claude)
 *   ?order=transcript-first|ledger-first|together
 *   ?land=<ms>    when the first of the two arrives, after the first paint (default 300)
 *   ?gap=<ms>     how long after it the second arrives (default 400)
 *   ?read=<ms>    how long the hand-off document takes to read (default 150)
 *   ?pause=1      run no timeline; `window.__handover.goto(n)` steps it instead (for screenshots)
 *   ?stuck=open|typed  the send went out half a minute ago and is still on its way (or sits typed in
 *                 the agent's composer), so its controls are showing — for screenshots of them
 *   ?theme=<family>-<mode>
 *
 * `window.__handover` is the PROBE. After every DOM mutation and on every animation frame it counts,
 * for each message the reader sent, the reader-side bubbles that show it, and remembers the first
 * element that did. A count other than one, or a different element later, is written down as a
 * violation with the stage it happened in. The probe reads only the DOM, so it is equally honest about
 * a tree that renders both copies.
 */

import { queuedMessageInstruction, turnFileInstruction } from '@ferretry/protocol';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HandoffSourceProvider } from '../../../src/components/handoff-message.tsx';
import { transcriptEntriesFromLog } from '../../../src/components/session-workspace-model.ts';
import { Transcript } from '../../../src/components/transcript.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { placeLedgerRows } from '../../../src/lib/ledger-placement.ts';
import type { LedgerSendRecord } from '../../../src/lib/send-ledger.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

type Path = 'direct' | 'turn-file' | 'queued-file' | 'merged';
const path = (params.get('path') ?? 'direct') as Path;
const harness = params.get('harness') === 'codex' ? 'codex' : 'claude';
const order = params.get('order') ?? 'transcript-first';
const land = Number(params.get('land') ?? 300);
const gap = Number(params.get('gap') ?? 400);
const readDelay = Number(params.get('read') ?? 150);
const paused = params.get('pause') === '1';
const stuck = params.get('stuck');

const SESSION = 'mvhand0v-5e7d0b1e';
const STATE = `/home/owner/.ferretry/state/sessions/${SESSION}`;
const daemon = daemonConnection({ daemonId: 'daemon-handover', baseUrl: 'https://handover.invalid', deviceId: 'd' });

const clock = (at: number): string => new Date(at).toISOString().slice(11, 19);
/** One daemon log record: `[HH:MM:SS] role/kind: first line`, later lines indented four spaces. */
const logLine = (at: number, role: string, text: string): string => {
  const [first = '', ...rest] = text.split('\n');
  return [`[${clock(at)}] ${role}/message: ${first}`, ...rest.map(line => `    ${line}`)].join('\n');
};

const sentAt = Date.now() - (stuck === null ? 1_000 : 30_000);
const recordAt = sentAt + 400;

interface Send {
  /** The words the probe looks for in a bubble. */
  readonly marker: string;
  readonly record: LedgerSendRecord;
  /** What the agent's transcript records for it, when it is a row of its own. */
  readonly row?: string;
}

const LONG = [
  'The **Continue** button is hidden on a phone:',
  '',
  '- open onboarding',
  '- tap the name field',
  '- the keyboard covers the button',
].join('\n');
const ATTACHED = `\n\nAttached files — open them from these paths:\n- ${STATE}/attachments/att_1/onboarding.png (image/png)`;

const sends = ((): readonly Send[] => {
  const base = {
    acceptedAt: new Date(sentAt).toISOString(),
    attachmentIds: [] as string[],
    fate: 'accepted' as const,
    ...(stuck === 'typed' ? { typedNotSent: true as const } : {}),
  };
  if (path === 'turn-file')
    return [
      {
        marker: 'keyboard covers the button',
        record: {
          ...base,
          sendId: 'send-turn',
          path: 'turn-file',
          turn: 9,
          message: `${LONG}${ATTACHED}`,
          attachmentIds: ['att_1'],
        },
        row: turnFileInstruction(`${STATE}/turns/turn-009.md`),
      },
    ];
  if (path === 'queued-file')
    return [
      {
        marker: 'keyboard covers the button',
        record: { ...base, sendId: 'send-queued', path: 'native-file', fate: 'queued', message: LONG },
        row: queuedMessageInstruction(`${STATE}/channel/queued-send-queued.md`),
      },
    ];
  if (path === 'merged')
    return [
      {
        marker: 'Check the deploy logs',
        record: { ...base, sendId: 'send-a', path: 'direct', message: 'Check the deploy logs' },
      },
      {
        marker: 'and the error budget',
        record: {
          ...base,
          sendId: 'send-b',
          path: 'direct',
          acceptedAt: new Date(sentAt + 150).toISOString(),
          message: 'and the error budget',
        },
      },
    ];
  const message = 'Ship the retry fix and re-run CI';
  // Codex writes what was submitted bare; this one also arrives with the soft-wrap spacing a composer adds.
  const row = harness === 'codex' ? 'Ship the retry fix  and\nre-run CI ' : message;
  return [{ marker: 'Ship the retry fix', record: { ...base, sendId: 'send-direct', path: 'direct', message }, row }];
})();

/** The row the harness writes: Claude wraps a pasted multi-line message, Codex never does. */
const harnessRow = (text: string): string =>
  harness === 'claude' && text.includes('\n') ? `<pasted_content id="p1">\n${text}\n</pasted_content>` : text;
const landedRow = (): string =>
  path === 'merged' ? 'Check the deploy logsand the error budget' : harnessRow(sends[0]?.row ?? '');

const PRIOR = [
  logLine(sentAt - 120_000, 'user', 'Why is the build red?'),
  logLine(sentAt - 90_000, 'assistant', 'Two tests time out on CI. The retry flag should stabilise them.'),
].join('\n');
const LANDED = `${PRIOR}\n${logLine(recordAt, 'user', landedRow())}`;
const REPLIED = `${LANDED}\n${logLine(recordAt + 2_000, 'assistant', 'On it — re-running CI with the retry flag now.')}`;

const delivered = (record: LedgerSendRecord): LedgerSendRecord => ({
  ...record,
  fate: 'delivered',
  fateAt: new Date(recordAt + 600).toISOString(),
  evidence: {
    key: `proof-${record.sendId}`,
    harness,
    observedAt: new Date(recordAt).toISOString(),
    tier: path === 'merged' ? 'merged-text' : path === 'turn-file' ? 'turn-instruction' : 'exact-text',
  },
});

interface Stage {
  readonly name: string;
  readonly log: string;
  readonly sends: readonly LedgerSendRecord[];
}
const pending = sends.map(send => send.record);
const confirmed = pending.map(delivered);
/** The stages in the order this run sees them, and when each arrives after the first paint. */
const STAGES: readonly Stage[] = [
  { name: 'sent', log: PRIOR, sends: pending },
  ...(order === 'together'
    ? []
    : [
        order === 'ledger-first'
          ? { name: 'confirmed', log: PRIOR, sends: confirmed }
          : { name: 'landed', log: LANDED, sends: pending },
      ]),
  { name: 'delivered', log: LANDED, sends: confirmed },
  { name: 'replied', log: REPLIED, sends: confirmed },
];
const ARRIVALS: readonly number[] = order === 'together' ? [land, land + 200] : [land, land + gap, land + gap + 200];

interface Violation {
  readonly stage: string;
  readonly marker: string;
  readonly count?: number;
  readonly remounted?: true;
}
const probe = {
  stage: STAGES[0]?.name ?? 'sent',
  stages: [] as string[],
  checks: 0,
  frames: 0,
  /** Every stage a check ran in: what "watched at every stage" means, whatever the frame rate was. */
  checkedStages: [] as string[],
  violations: [] as Violation[],
  done: false,
  goto: (_index: number): void => undefined,
};
(window as unknown as { __handover: typeof probe }).__handover = probe;

/** Every reader-side bubble that shows `marker`, old row shapes and new alike. */
const bubblesFor = (marker: string): Element[] =>
  [...document.querySelectorAll('[data-transcript-kind="user"], [data-transcript-kind="ledger"]')].filter(node =>
    (node.textContent ?? '').includes(marker),
  );
const first = new Map<string, Element>();
const check = (): void => {
  if (document.querySelector('.fy-transcript-content') === null) return;
  probe.checks += 1;
  if (!probe.checkedStages.includes(probe.stage)) probe.checkedStages.push(probe.stage);
  for (const send of sends) {
    const found = bubblesFor(send.marker);
    if (found.length !== 1) {
      probe.violations.push({ stage: probe.stage, marker: send.marker, count: found.length });
      continue;
    }
    const element = found[0] as Element;
    const seen = first.get(send.marker);
    if (seen === undefined) first.set(send.marker, element);
    // A merged row is a DIFFERENT message from either send's own bubble, so only its count is held.
    else if (seen !== element && path !== 'merged') {
      probe.violations.push({ stage: probe.stage, marker: send.marker, remounted: true });
      first.set(send.marker, element);
    }
  }
};
new MutationObserver(check).observe(document.getElementById('root') as HTMLElement, {
  childList: true,
  subtree: true,
  characterData: true,
});
const frame = (): void => {
  probe.frames += 1;
  check();
  if (!probe.done) requestAnimationFrame(frame);
};

const source = {
  daemon,
  sessionId: SESSION,
  read: async (name: string) => {
    await new Promise(resolve => setTimeout(resolve, readDelay));
    return {
      name,
      message: LONG,
      attachments: path === 'turn-file' ? [{ filename: 'onboarding.png', mime: 'image/png' }] : [],
    };
  },
};

/** Every control answers yes and changes nothing: the scene is about what is drawn, not what is sent. */
const answered = async (): Promise<boolean> => true;

function Scene() {
  const [index, setIndex] = useState(0);
  const stage = STAGES[index] as Stage;
  probe.stage = stage.name;
  probe.goto = setIndex;
  useEffect(() => {
    probe.stages.push(stage.name);
  }, [stage.name]);
  useEffect(() => {
    requestAnimationFrame(frame);
    if (paused) return;
    const timers = ARRIVALS.map((delay, step) =>
      setTimeout(() => setIndex(current => Math.max(current, step + 1)), delay),
    );
    const end = setTimeout(
      () => {
        check();
        probe.done = true;
      },
      (ARRIVALS.at(-1) ?? 0) + Math.max(400, readDelay + 200),
    );
    return () => {
      for (const timer of [...timers, end]) clearTimeout(timer);
    };
  }, []);
  const entries = useMemo(
    () => placeLedgerRows(transcriptEntriesFromLog(stage.log, Date.now() + 60_000), stage.sends),
    [stage],
  );
  return (
    <HandoffSourceProvider source={source}>
      <div className="scene-chat" data-stage={stage.name}>
        <Transcript
          agentName="Janella"
          daemonId={daemon.daemonId}
          entries={entries}
          onCancel={answered}
          onRetry={answered}
          onSubmit={answered}
          sessionId={SESSION}
        />
      </div>
    </HandoffSourceProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
