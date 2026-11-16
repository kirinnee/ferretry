/**
 * The browser entry for a message delivered through Ferretry's MCP channel: what Claude Code RECORDS (a meta user record
 * wrapped in `<channel source="ferretry" …>` when the ferret was idle, a `queued_command` attachment when it was busy)
 * is read by the real transcript parser, and what the parser hands back is drawn by the real `Transcript`. Fake data only.
 *
 * The scene proves the whole claim of the channel's chat row: the wrapper is gone, a ferret's message is a peer message
 * with its sender chip, a daemon notice is "Ferretry · Delivery", and a person's own prompt is untouched beside them.
 *
 * Parameters (all optional): `?theme=<family>-<mode>`.
 */
import type { FerretView } from '@ferretry/core-ferrets/contract';
import { type DaemonId, ReferenceSurfaceProvider, ScreenHrefProvider } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { transcriptEntriesFromLog } from '../../../../app/chat/chat-refresh.ts';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { peerEnvelopePreamble } from '../../../../contract/peer-messages.ts';
import { ClaudeTranscriptParser } from '../../../../daemon/reader/lib/transcript/claude.ts';
import { fleetAgentResolver } from '../../../support/app/agents.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SESSION = 'mvchat01-5e7d0b1e';
const daemon = daemonConnection('daemon-chat');
const NOW = Date.now();
const MINUTE = 60_000;

const FLEET = [
  { config: { id: 'mvtorre1-a41c8b02', teammate: 'torrey' }, state: { status: 'running' } },
  { config: { id: 'mvlizze2-b93d70f1', teammate: 'lizzette' }, state: { status: 'running' } },
] as unknown as readonly FerretView[];

const ORIGIN = { kind: 'channel', server: 'ferretry' } as const;
const wrap = (sendId: string, words: string): string =>
  `<channel source="ferretry" send_id="${sendId}">\n${words}\n</channel>`;

const banner = (name: string, sessionId: string): string =>
  peerEnvelopePreamble({ name, sessionId, kind: 'message', clientName: 'fy' });

const IDLE = `${banner('torrey', 'mvtorre1-a41c8b02')}The relay tests pass on my branch; the retry loop now gives up when the daemon is gone.`;
const BUSY = `${banner('lizzette', 'mvlizze2-b93d70f1')}Done — pushed to the branch.`;
const NOTICE = 'Your message to Ryu did not arrive.\n\nIt was refused: the session had ended.';

/** What Claude Code writes, in the order it wrote it. */
const RECORDS: readonly unknown[] = [
  {
    type: 'user',
    uuid: 'u-person',
    timestamp: new Date(NOW - 9 * MINUTE).toISOString(),
    message: { role: 'user', content: 'Please keep going on the relay review.' },
  },
  {
    type: 'user',
    uuid: 'u-idle',
    timestamp: new Date(NOW - 6 * MINUTE).toISOString(),
    message: { role: 'user', content: wrap('s-1', IDLE) },
    isMeta: true,
    origin: ORIGIN,
  },
  {
    type: 'attachment',
    uuid: 'a-busy',
    timestamp: new Date(NOW - 4 * MINUTE).toISOString(),
    attachment: {
      type: 'queued_command',
      prompt: wrap('s-2', BUSY),
      commandMode: 'prompt',
      origin: ORIGIN,
      isMeta: true,
      timestamp: new Date(NOW - 4 * MINUTE).toISOString(),
    },
  },
  {
    type: 'user',
    uuid: 'u-notice',
    timestamp: new Date(NOW - 2 * MINUTE).toISOString(),
    message: { role: 'user', content: wrap('s-3', NOTICE) },
    isMeta: true,
    origin: ORIGIN,
  },
];

const clock = (iso: string): string => iso.slice(11, 19);

const entries = (): readonly TranscriptEntry[] => {
  const parser = new ClaudeTranscriptParser();
  const messages = RECORDS.flatMap(record => parser.parseRecord(record).events).flatMap(event =>
    event.kind === 'message' && event.role === 'user' && event.timestamp !== undefined
      ? [{ at: event.timestamp, text: event.text, harness: event.inputSource === 'harness' }]
      : [],
  );
  const log = messages.map(message => `[${clock(message.at)}] user/message: ${message.text}`).join('\n');
  // The daemon's own notice has no banner: the chat attributes it from the send's row (`by`), as it does a typed one.
  const [person, idle, busy, notice] = transcriptEntriesFromLog(log, NOW);
  return [person, idle, busy, notice].flatMap((entry, index) =>
    entry === undefined
      ? []
      : [
          index === 3
            ? {
                ...entry,
                send: {
                  sendId: 's-3',
                  acceptedAt: entry.at === undefined ? new Date(NOW).toISOString() : new Date(entry.at).toISOString(),
                  message: NOTICE,
                  attachmentIds: [],
                  fate: 'delivered' as const,
                  senderKind: 'daemon' as const,
                  by: { kind: 'ferretry' as const, feature: 'Delivery' },
                },
              }
            : entry,
        ],
  );
};

const sceneHref = (daemonId: string, plugin: string, screen: string, query: Readonly<Record<string, string>> = {}) =>
  `/${daemonId}/${plugin}/${screen}?${new URLSearchParams(query).toString()}`;

function Scene() {
  return (
    <div className="scene-chat">
      <ReferenceSurfaceProvider
        surface={{
          agentReferenceResolver: fleetAgentResolver(daemon.daemonId as DaemonId, FLEET),
          onNavigate: () => undefined,
        }}
      >
        <ScreenHrefProvider href={sceneHref}>
          <Transcript
            agentName="Janella"
            daemonId={daemon.daemonId}
            entries={entries()}
            onSubmit={async () => true}
            sessionId={SESSION}
          />
        </ScreenHrefProvider>
      </ReferenceSurfaceProvider>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
