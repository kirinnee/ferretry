/**
 * The browser entry for the chat polish batch: a ferret's bulky message at rest as its first line,
 * several image reads as ONE tool group, and the task picker's "Include agent tasks" switch.
 *
 * Parameters (all optional):
 *
 *   ?update=1    the reader pressed "Show" on the instructions-updated row
 *   ?ferretry=1  one Ferretry system row for each part of Ferretry that writes into a chat
 *   ?open=1      the reader pressed "Show more" on the long ferret message
 *   ?tools=1     the reader opened the image group
 *   ?picker=1    show the task menu instead of the conversation
 *   ?on=1        the picker's switch is on
 *   ?many=1      a busy project (64 cards) through the real provider and ranking; ?q=<text> narrows it
 *   ?theme=<family>-<mode>
 */

import type { SessionView } from '@ferretry/protocol';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type ComposerAutocompleteCandidate,
  type ComposerTriggerMatch,
  rankComposerCandidates,
} from '../../../src/components/composer-autocomplete.ts';
import { ComposerAutocompletePopover } from '../../../src/components/composer-autocomplete-popover.tsx';
import { createDirectReferenceProviders } from '../../../src/components/composer-autocomplete-providers.ts';
import { ReferenceSurfaceProvider } from '../../../src/components/reference-surface.tsx';
import { transcriptEntriesFromLog } from '../../../src/components/session-workspace-model.ts';
import { Transcript } from '../../../src/components/transcript.tsx';
import { createAgentReferenceResolver } from '../../../src/lib/agent-references.ts';
import type { ComposerReferenceTask } from '../../../src/lib/composer-reference-catalogs.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import type { TranscriptEntry } from '../../../src/lib/session-screens.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SESSION = 'mvchat01-5e7d0b1e';
const daemon = daemonConnection({ daemonId: 'daemon-chat', baseUrl: 'https://chat.invalid', deviceId: 'd' });
const NOW = Date.now();
const MINUTE = 60_000;

/** The fleet this scene can prove, so a peer's foot carries its quiet "Open chat" link too. */
const FLEET = [
  { config: { id: 'mvtorre1-a41c8b02', teammate: 'torrey' }, state: { status: 'running' } },
  { config: { id: 'mvlizze2-b93d70f1', teammate: 'lizzette' }, state: { status: 'running' } },
  { config: { id: 'mvryu333-c25e9ad4', teammate: 'ryu' }, state: { status: 'running' } },
] as unknown as readonly SessionView[];

const SESSION_OF: Readonly<Record<string, string>> = {
  torrey: 'mvtorre1-a41c8b02',
  lizzette: 'mvlizze2-b93d70f1',
};

const peer = (id: string, at: number, text: string, name: string): TranscriptEntry => ({
  id,
  kind: 'user',
  text,
  at,
  peer: {
    name,
    sessionId: SESSION_OF[name] ?? 'mvb0sw7d-27f71326',
    kind: 'message',
    replyExpected: false,
    note: `No reply needed. To reply: fy send ${name} "<reply>"`,
  },
  // Arrived, so the foot's row carries the delivered ticks beside its controls.
  send: {
    sendId: `peer-${id}`,
    acceptedAt: new Date(at).toISOString(),
    message: text,
    attachmentIds: [],
    fate: 'delivered',
  },
});

/** A message this ferret sent another ("Sent to :ryu"): the same one-row foot, on its own card. */
const sentCard = (at: number): TranscriptEntry => ({
  id: 'sent-card',
  kind: 'tool',
  text: 'sent to ryu',
  at,
  tools: [
    {
      key: 'sent-card',
      use: { name: 'Bash', input: { command: 'fy send ryu "Ship it when CI is green"' } },
      result: { text: 'delivered' },
    },
  ],
  sent: { to: 'ryu', body: 'Ship it when CI is green — I will watch it.', ask: false, state: 'delivered' },
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
    sentCard(NOW - 4 * MINUTE),
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

const LANES = ['Todo', 'In progress', 'To test', 'In review'] as const;
const TITLES = [
  'Fix the retry loop',
  'Tidy the relay docs',
  'Pair a second phone',
  'Warden remedy copy',
  'Board filter chips',
  'Terminal resize jitter',
  'Cache the fleet read',
  'Rename the daemon flag',
];

const busyProject = (): ComposerReferenceTask[] =>
  Array.from({ length: 64 }, (_, index) => ({
    id: `F${index + 1}`,
    title: `${TITLES[index % TITLES.length]} ${index + 1}`,
    summary: index % 5 === 0 ? 'relay fingerprint allowlist' : '',
    lane: LANES[index % LANES.length] ?? 'Todo',
    closed: false,
    active: index % 7 === 0,
    assignee: index % 2 === 0 ? null : 'zelda',
    touchedAt: new Date(NOW - index * MINUTE).toISOString(),
    agentAsked: index >= 50,
    legacyId: null,
  }));

const manyRows = (included: boolean, query: string): ComposerAutocompleteCandidate[] => {
  const scope = daemonSessionScope(daemon, SESSION);
  const [, , sigil] = createDirectReferenceProviders({
    daemon,
    scope,
    getTasks: busyProject,
    getIncludeAgentTasks: () => included,
  });
  const match: ComposerTriggerMatch = {
    trigger: '&',
    triggerText: '&',
    query,
    start: 0,
    end: query.length + 1,
    caret: query.length + 1,
  };
  const result = sigil?.initialCandidates?.({ query, match, signal: new AbortController().signal });
  return rankComposerCandidates(result?.candidates ?? [], result?.filterQuery ?? query, result?.limit);
};

function Picker() {
  const [included, setIncluded] = useState(params.get('on') === '1');
  const many = params.get('many') === '1';
  const rows = many
    ? manyRows(included, params.get('q') ?? '')
    : [
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

const FERRETRY_SENDS: readonly (readonly [string, string])[] = [
  [
    'Warden',
    'You have been quiet for 12 minutes. Are you still working?\n\nIf you are blocked, say what on; run `fy signal working` if you are busy.',
  ],
  ['Agenda', 'You have an open agenda item waiting on the owner.'],
  [
    'Monitor',
    'The command you were watching finished with exit code 1.\n\nLast output: 3 tests failed in packages/daemon.',
  ],
  ['Lessons', 'The owner reviewed a lesson you suggested and accepted it.'],
  [
    'Migrate',
    'Ferretry is moving this session to another runtime; stop long-running jobs and say when they are stopped.',
  ],
  ['Restart', 'Ferretry restarted this session after the daemon updated.\n\nPick up where you left off.'],
  ['Delivery', 'Your message to Torrey did not arrive.\n\nIt was refused: the session had ended.'],
];

const ferretryEntries = (): TranscriptEntry[] =>
  FERRETRY_SENDS.map(([feature, text], index) => ({
    id: `fx-${feature}`,
    kind: 'user' as const,
    text,
    at: NOW - (FERRETRY_SENDS.length - index) * MINUTE,
    send: {
      sendId: `fx-${feature}`,
      acceptedAt: new Date(NOW - (FERRETRY_SENDS.length - index) * MINUTE).toISOString(),
      message: text,
      attachmentIds: [],
      fate: 'accepted' as const,
      path: 'direct' as const,
      senderKind: 'daemon' as const,
      by: { kind: 'ferretry' as const, feature },
    },
  }));
function Scene() {
  if (params.get('picker') === '1') return <Picker />;
  return (
    <div className="scene-chat">
      {/* The surface a session page assembles: enough of one to prove the peers by their sessions,
          so the foot shows its quiet "Open chat" link beside "Show more" and the ticks. */}
      <ReferenceSurfaceProvider
        surface={{
          agentReferenceResolver: createAgentReferenceResolver(daemon.daemonId, FLEET),
          onNavigate: () => undefined,
        }}
      >
        <Transcript
          agentName="Janella"
          daemonId={daemon.daemonId}
          entries={params.get('ferretry') === '1' ? ferretryEntries() : entries()}
          onSubmit={async () => true}
          sessionId={SESSION}
        />
      </ReferenceSurfaceProvider>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
