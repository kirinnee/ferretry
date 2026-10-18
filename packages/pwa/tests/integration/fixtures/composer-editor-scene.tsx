/**
 * The browser entry for the real-browser composer evidence: the SHIPPED `Composer`, mounted alone
 * with the app's whole stylesheet, in whichever editor style, theme and state the URL asks for.
 *
 * No daemon, no transcript, no routing — none of them change how the composer formats, edits or
 * sends. `api.send` records every request on `window.__sent`, which is how a journey proves the exact
 * markdown the agent would receive.
 *
 *   ?editor=on|rich|off   the editor style (Markdown, Notion-style / Rich text / Plain)
 *   ?theme=<family>-<mode> the theme attribute, exactly as the app stamps it
 *   ?busy=1               the agent is working (Interrupt & send shows)
 *   ?vim=1                Vim keys on
 *   ?compact=1            the phone composer
 *   ?draft=<text>         a saved draft to open with
 *   ?layout=chat          a phone chat page: a transcript above the composer, sized by the app's own
 *                         viewport hook, so a (faked) keyboard shrinks it exactly as in the app
 *   ?runtime=your-turn|working   the model and effort chips, for a session whose last send left
 *                         `promptReady: false` behind (see below)
 *   ?entries=1            every Add to chat / quote entry point beside the composer — the shipped
 *                         transcript, terminal list, task row and skills surface, each delivering
 *                         through its own production path, inside a reference surface that proves
 *                         the tokens they add (so a chip is a link, as in the app)
 */
import type { SessionView, TerminalListView } from '@ferretry/protocol';
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../src/components/composer.tsx';
import { ComposerRuntime } from '../../../src/components/composer-runtime.tsx';
import { isPromptKnownBusy, RuntimeModelControls } from '../../../src/components/runtime-controls.tsx';
import { ReferenceSurfaceProvider, sessionReferenceSurface } from '../../../src/components/reference-surface.tsx';
import { SessionSurfaceReferences } from '../../../src/components/session-surface-references.tsx';
import { Transcript } from '../../../src/components/transcript.tsx';
import { SessionSkillsSurface } from '../../../src/features/skills/session-skills-surface.tsx';
import { TaskRow } from '../../../src/features/tasks/task-row.tsx';
import { useAppViewport } from '../../../src/hooks/use-app-viewport.ts';
import { addReferenceToComposer } from '../../../src/lib/composer-references.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DaemonDraftStore } from '../../../src/lib/drafts.ts';
import type { RuntimeModelCatalog } from '../../../src/lib/runtime-models.ts';
import { writeMdComposePref } from '../../../src/lib/md-compose.ts';
import { taskSummary } from '../../support/tasks.ts';

const parameters = new URLSearchParams(location.search);
const editor = parameters.get('editor');
writeMdComposePref(editor === 'rich' ? 'rich' : editor === 'off' ? 'off' : 'on');
document.documentElement.setAttribute('data-theme', parameters.get('theme') ?? 'studio-light');

const sent: unknown[] = [];
(window as unknown as { __sent: unknown[] }).__sent = sent;

const daemon = daemonConnection({ daemonId: 'scene', baseUrl: 'http://127.0.0.1', deviceId: 'scene' });
const scope = daemonSessionScope(daemon, 'scene-session');
const drafts = new DaemonDraftStore();
drafts.save(scope, parameters.get('draft') ?? '');

const root = document.getElementById('root');
if (root === null) throw new Error('the scene has no #root to mount into');

const TRANSCRIPT = Array.from(
  { length: 12 },
  (_unused, index) =>
    `Turn ${index + 1}: the agent explains what it changed and what it will do next, in a paragraph long enough to wrap.`,
);

/** The chat page's shape: the transcript takes what the composer leaves, inside the app viewport. */
function ChatPage({ children }: { readonly children: ReactNode }) {
  useAppViewport();
  return (
    <div className="scene-chat">
      <div className="scene-transcript" data-scene-transcript="">
        {TRANSCRIPT.map(line => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <div className="scene-composer">{children}</div>
    </div>
  );
}

/** One named shell, so the terminal list offers `%terminal:dev`. */
const TERMINALS: TerminalListView = {
  sessionId: scope.sessionId,
  terminals: [
    {
      id: 'a1b2c3d4e5f6',
      sessionId: scope.sessionId,
      name: 'dev',
      title: 'Dev server',
      state: 'running',
      cols: 80,
      rows: 24,
      viewers: 0,
      createdAt: '2026-10-16T10:00:00.000Z',
      lastActivityAt: '2026-10-16T10:05:00.000Z',
    },
  ],
  limits: { perSession: 6, global: 24, runningGlobal: 1, idleTimeoutSeconds: 900, scrollbackLines: 5_000 },
};
const TASK = taskSummary({ id: 'F12' });
const SKILLS = {
  harness: 'claude' as const,
  skills: [
    { name: 'summary', description: 'Recap the work so far.', scope: 'global' as const, origin: 'claude' as const },
  ],
};

/** Every Add to chat / quote entry point, each through its own shipped delivery path. */
function EntryPoints() {
  return (
    <section className="scene-entries" data-scene-entries="">
      <Transcript
        daemonId={daemon.daemonId}
        entries={[{ id: 'turn-1', kind: 'assistant', text: 'The build passed on the second try.' }]}
        sessionId={scope.sessionId}
      />
      <SessionSurfaceReferences connection={daemon} listTerminals={async () => TERMINALS} scope={scope} />
      {/* The session search's own Add to chat, verbatim: the row hands its task up, the host adds it. */}
      <TaskRow
        daemonId={daemon.daemonId}
        onAddToChat={task => addReferenceToComposer({ kind: 'task', id: task.id }, scope)}
        onOpen={() => undefined}
        task={TASK}
      />
      <SessionSkillsSurface connection={daemon} loadCatalog={async () => SKILLS} scope={scope} />
    </section>
  );
}

/**
 * `?runtime=your-turn|working`: the model and effort chips on the composer's status line, exactly as
 * `SessionChatPage` builds them — `busy` is the shared `isPromptKnownBusy` predicate over the session's
 * state — for a session whose last send left `promptReady: false` behind, which is every session after
 * its first message. A choice records its command on `window.__runtime`.
 */
const runtimeTurn = parameters.get('runtime');
const runtimeSent: unknown[] = [];
(window as unknown as { __runtime: unknown[] }).__runtime = runtimeSent;
const RUNTIME_VIEW = {
  config: {
    id: 'scene-session',
    name: 'Scene',
    agent: 'claude-default',
    harness: 'claude',
    mode: 'interactive',
    model: 'claude-opus-5-5',
    cwd: '/work/scene',
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
  },
  state: {
    id: 'scene-session',
    status: 'running',
    turn: 3,
    promptReady: false,
    turnState: runtimeTurn === 'working' ? 'working' : 'your-turn',
  },
} as unknown as SessionView;
const RUNTIME_CATALOG: RuntimeModelCatalog = {
  harness: 'claude',
  source: 'wrapper-inventory',
  choices: [
    { value: 'claude-opus-5-5', label: 'Opus 5.5', isDefault: true, reasoningEfforts: [] },
    { value: 'claude-sonnet-5', label: 'Sonnet 5', reasoningEfforts: [] },
  ],
};
const runtimeSlot =
  runtimeTurn === null ? undefined : (
    <ComposerRuntime
      busy={isPromptKnownBusy(RUNTIME_VIEW.state)}
      canControl
      presentation={parameters.get('compact') === '1' ? 'sheet' : 'popover'}
      renderModelControls={lifecycle => (
        <RuntimeModelControls
          api={{ runtime: async (_daemon, _id, command) => void runtimeSent.push(command) }}
          canControl
          catalogs={{ load: async () => RUNTIME_CATALOG }}
          daemon={daemon}
          view={RUNTIME_VIEW}
          {...lifecycle}
        />
      )}
      view={RUNTIME_VIEW}
    />
  );

const composer = (
  <Composer
    api={{
      send: async (_id, body) => {
        sent.push(body);
        return { disposition: 'queued' } as never;
      },
    }}
    busy={parameters.get('busy') === '1'}
    compact={parameters.get('compact') === '1'}
    daemon={daemon}
    draftStore={drafts}
    enterKeyPreference="send"
    sessionId="scene-session"
    {...(runtimeSlot === undefined ? {} : { statusSlot: runtimeSlot })}
    vimMode={parameters.get('vim') === '1'}
  />
);

const scene =
  parameters.get('layout') === 'chat' ? (
    <ChatPage>{composer}</ChatPage>
  ) : parameters.get('entries') === '1' ? (
    <ReferenceSurfaceProvider
      surface={sessionReferenceSurface({
        connection: daemon,
        fetcher: async () => new Response('not here', { status: 404 }),
        scope,
        skills: SKILLS.skills.map(skill => skill.name),
        tasks: [TASK],
        terminals: TERMINALS,
      })}
    >
      <main className="scene">
        <EntryPoints />
        {composer}
      </main>
    </ReferenceSurfaceProvider>
  ) : (
    <main className="scene">{composer}</main>
  );

createRoot(root).render(<StrictMode>{scene}</StrictMode>);
