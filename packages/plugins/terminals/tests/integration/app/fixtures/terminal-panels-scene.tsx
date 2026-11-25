/**
 * The browser entry for "the terminals plugin's three panels, as a person meets them": the REAL deck ledger, the REAL Processes
 * surface and the REAL Console, over fakes (no daemon, no network).
 *
 *   ?panel=deck|processes|console     which panel the page draws (default deck)
 *   ?theme=<family>-<mode>   ?w=<px> ?h=<px>   the box it fills (default 300 x 360)
 *   ?cwd=<path>                       the deck's working directory (a long one by default)
 *   ?refuse=step-up                   the daemon answers every read with the passkey refusal (processes, console)
 *   ?first=read                       console only: with refuse, the first read succeeds and later reads refuse
 *
 * `window.__panel` is set once the panel has drawn what it is going to draw.
 */
import { createRoot } from 'react-dom/client';
import { DaemonCallError } from '@ferretry/app';
import { SessionTerminalDeck } from '../../../../app/components/session-terminal-deck.tsx';
import { ConsoleSurface } from '../../../../app/features/workspace/console-surface.tsx';
import { ProcessesSurface } from '../../../../app/features/workspace/processes-surface.tsx';
import { processErrorText } from '../../../../app/lib/session-processes.ts';
import { daemonConnection, daemonSessionScope } from '../../../../app/shell.ts';
import { fakeDeck, terminalListing, terminalView } from '../../../support/app/terminal-deck.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const number = (name: string, fallback: number): number => Number(params.get(name) ?? fallback);
const done = (): void => {
  (window as unknown as { __panel: boolean }).__panel = true;
};

/** What the daemon says for a read this device must confirm with a passkey: the Gate's own sentence for the capability. */
const passkeyRefusal = (): DaemonCallError =>
  new DaemonCallError(
    403,
    'grant_step_up_required',
    'using session terminals needs a passkey confirmation from this device.',
  );

const daemon = daemonConnection('scene-daemon');
const scope = daemonSessionScope(daemon, 'scene-session');
const panel = params.get('panel') ?? 'deck';
const refuse = params.get('refuse') === 'step-up';

const draw = () => {
  if (panel === 'processes') {
    const reason = processErrorText(passkeyRefusal());
    queueMicrotask(done);
    return (
      <ProcessesSurface
        client={{ call: () => Promise.reject(new Error('the scene never calls a daemon')) }}
        connection={daemon}
        onOpenChange={() => undefined}
        openId={null}
        scope={scope}
        state={refuse ? { status: 'forbidden', reason } : { status: 'loading' }}
      />
    );
  }
  if (panel === 'console') {
    let reads = 0;
    return (
      <ConsoleSurface
        client={{ call: () => Promise.reject(new Error('the scene never calls a daemon')) }}
        connection={daemon}
        readSnapshot={async () => {
          reads += 1;
          queueMicrotask(done);
          if (refuse && (params.get('first') !== 'read' || reads > 1)) throw passkeyRefusal();
          return 'Fake Agent v0.0.0\n~/projects/demo-app\n';
        }}
        scope={scope}
        typeInto={async () => undefined}
      />
    );
  }
  const deck = fakeDeck(async () => terminalListing([terminalView('aaaa1111', { title: 'build' })], 'scene-session'));
  queueMicrotask(() => setTimeout(done, 400));
  return (
    <SessionTerminalDeck
      connection={daemon}
      cwd={params.get('cwd') ?? '/home/user/workspace/personal/ferretry/.worktrees/eb-b11/packages/plugins/terminals'}
      dependencies={deck.dependencies}
      scope={scope}
    />
  );
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div
      className="flex flex-col"
      data-scene-box=""
      style={{ width: `${number('w', 300)}px`, height: `${number('h', 360)}px` }}
    >
      {draw()}
    </div>,
  );
