/**
 * The browser entry for the chat polish batch: a ferret's bulky message at rest as its first line,
 * several image reads as ONE tool group, and the task picker's "Include agent tasks" switch.
 *
 * Parameters (all optional):
 *
 *   ?update=1    the reader pressed "show changes" on the instructions-updated row
 *   ?open=1      the reader pressed "Show more" on the long ferret message
 *   ?tools=1     the reader opened the image group
 *   ?picker=1    show the task menu instead of the conversation
 *   ?on=1        the picker's switch is on
 *   ?theme=<family>-<mode>
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ComposerAutocompletePopover } from '../../../src/components/composer-autocomplete-popover.tsx';
import type { ComposerAutocompleteCandidate } from '../../../src/components/composer-autocomplete.ts';
import { transcriptEntriesFromLog } from '../../../src/components/session-workspace-model.ts';
import type { TranscriptEntry } from '../../../src/lib/session-screens.ts';
import { Transcript } from '../../../src/components/transcript.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SESSION = 'mvchat01-5e7d0b1e';
const daemon = daemonConnection({ daemonId: 'daemon-chat', baseUrl: 'https://chat.invalid', deviceId: 'd' });
const NOW = Date.now();
const MINUTE = 60_000;

const peer = (id: string, at: number, text: string, name: string): TranscriptEntry => ({
  id,
  kind: 'user',
  text,
  at,
  peer: {
    name,
    sessionId: 'mvb0sw7d-27f71326',
    kind: 'message',
    replyExpected: false,
    note: `No reply needed. To reply: fy send ${name} "<reply>"`,
  },
});

const BULKY = [
  '## Review of the relay change',
  '',
  'I read the whole diff against the protocol document and found three things worth your time:',
  '',
  '- the fingerprint allowlist is checked after the upgrade, not before it',
  '- the retry loop never gives up when the daemon is gone',
  '- the advert cache ignores `no-store` on a 304',
  '',
  'Details and a suggested patch follow below, with the failing test for each.',
].join('\n');

const UPDATE = [
  '[instructions updated] Ferretry changed part of the instructions you were started with. Follow these words in place of the matching part of your system prompt:',
  'Ferretry tools: you can open and drive terminals and browser pages the person watches live.',
  "Board: all work is a card (&F412) on its project's board; agenda items are !A48.",
].join('\n\n');

const IMAGE = (n: number): string => `assistant/attachment: image [fy-image ${4096 * n}.2048.0 image/png]`;
const LOG = [
  `[10:00:00] user/message: Compare the settings screens on phone and desktop`,
  '[10:00:05] assistant/message: Taking the screenshots now.',
  ...[1, 2, 3, 4, 5, 6].map(IMAGE),
  '[10:00:40] assistant/message: All six are captured; the spacing differs in two.',
].join('\n');

const entries = (): readonly TranscriptEntry[] => {
  const log = transcriptEntriesFromLog(LOG, NOW);
  return [
    ...log.slice(0, 1),
    { id: 'instructions', kind: 'user', text: UPDATE, at: NOW - 7 * MINUTE },
    peer('peer-long', NOW - 6 * MINUTE, BULKY, 'torrey'),
    peer('peer-short', NOW - 5 * MINUTE, 'Done — pushed to the branch.', 'lizzette'),
    ...log.slice(1),
  ];
};

const candidate = (id: string, title: string, detail: string): ComposerAutocompleteCandidate => ({
  id: `task-${id}`,
  kind: 'task',
  label: `&${id}`,
  detail: `${title} · ${detail}`,
  replacement: `&${id}`,
});

function Picker() {
  const [included, setIncluded] = useState(params.get('on') === '1');
  const rows = [
    candidate('F12', 'Fix the retry loop', 'Doing · you'),
    candidate('F9', 'Tidy the relay docs', 'Todo · you'),
    ...(included
      ? [
          candidate('F31', 'Review torrey’s diff', 'Doing · ferret'),
          candidate('F40', 'Warden: stuck turn', 'Todo · warden'),
        ]
      : []),
  ];
  return (
    <div
      className="fy-composer-row"
      style={{ left: window.innerWidth > 700 ? 56 : 16, position: 'absolute', right: 16, top: 460 }}
    >
      <ComposerAutocompletePopover
        agentTasks={{ included, onToggle: () => setIncluded(current => !current) }}
        surface={{
          open: true,
          status: 'ready',
          provider: null,
          match: null,
          candidates: rows,
          activeIndex: 0,
          listboxId: 'chat-polish-picker',
          contextLabel: '& tasks',
          accept: () => undefined,
        }}
      />
    </div>
  );
}

function Scene() {
  if (params.get('picker') === '1') return <Picker />;
  return (
    <div className="scene-chat">
      <Transcript
        agentName="Janella"
        daemonId={daemon.daemonId}
        entries={entries()}
        onSubmit={async () => true}
        sessionId={SESSION}
      />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
