/**
 * The browser entry for a Codex ferret's chat after two messages were handed in through `codex queue`: an agent's
 * send (a banner the app parses off, so it is a normal row with the ferret as its sender) and the owner's own (no
 * banner, no chip). FAKE DATA ONLY (`tests/support/codex-queued-log.ts`).
 *
 *   ?theme=<family>-<mode>
 */
import type { FerretView } from '@ferretry/core-ferrets/contract';
import { createRoot } from 'react-dom/client';
import { type DaemonId, ReferenceSurfaceProvider, ScreenHrefProvider } from '@ferretry/app';
import { transcriptEntriesFromLog } from '../../../../app/chat/chat-refresh.ts';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { fleetAgentResolver } from '../../../support/app/agents.ts';
import { CODEX_QUEUED_LOG } from '../../../support/codex-queued-log.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SESSION = 'mvcodex1-5e7d0b1e';
const daemon = daemonConnection('daemon-chat');

const FLEET = [
  { config: { id: 'mvtorre1-a41c8b02', teammate: 'torrey' }, state: { status: 'running' } },
] as unknown as readonly FerretView[];

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
            entries={transcriptEntriesFromLog(CODEX_QUEUED_LOG, Date.parse('2026-11-16T10:05:00.000Z'))}
            onSubmit={async () => true}
            sessionId={SESSION}
          />
        </ScreenHrefProvider>
      </ReferenceSurfaceProvider>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
