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
 *   ?mic=1                the dictation mic beside attach, as the chat and the Inbox draw it
 *   ?dock=stacked|row|auto the phone composer's button layout (Settings › Composer › Button layout)
 *   ?settings=1           Settings › Composer itself (editor style, button layout, Vim) instead of the composer
 *   ?draft=<text>         a saved draft to open with
 *   ?layout=chat          a phone chat page: a transcript above the composer, sized by the app's own
 *                         viewport hook, so a (faked) keyboard shrinks it exactly as in the app
 *   ?runtime=your-turn|working   the model and effort chips, for a session whose last send left
 *                         `promptReady: false` behind (see below)
 *   ?entries=1            every Add to chat / quote entry point beside the composer — the shipped
 *                         transcript, terminal list and skills surface, each delivering
 *                         through its own production path, inside a reference surface that proves
 *                         the tokens they add (so a chip is a link, as in the app)
 *   ?host=1              a location host is present, so "+" opens the add menu (attach, camera on touch, location)
 *   ?upload=1            an uploader that accepts any file, so a chosen picture becomes a ready tray chip
 *   ?messages=<n>        a delivered message with <n> pictures above the composer, loaded the way the app
 *                        loads them (a blob per attachment), so the viewer opens from a message
 *   ?occupied=<text>      the agent's own box already holds the person's unsent <text>: the first send is
 *                         refused `composer_occupied` with it, exactly as the daemon answers, and
 *                         `api.resolveComposerDraft` records each tap on `window.__drafts` and frees the
 *                         box, so the retried send lands on `window.__sent`
 *   ?unconfirmed=1        the first send is typed into the agent's box and never shown there: it is
 *                         answered `send_unconfirmed`, exactly as the daemon answers, and each Send it /
 *                         Clear it / Retry tap is recorded on `window.__unconfirmed`
 */
import {
  COMPOSER_OCCUPIED_CODE,
  type ComposerDraftRequest,
  type ComposerDraftResult,
  SEND_UNCONFIRMED_CODE,
  type SendRecord,
  type SessionView,
  type TerminalListView,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AttachmentGalleryProvider, TranscriptAttachmentGallery } from '../../../src/components/attachment-gallery.tsx';
import { Composer } from '../../../src/components/composer.tsx';
import { ComposerRuntime } from '../../../src/components/composer-runtime.tsx';
import { ReferenceSurfaceProvider, sessionReferenceSurface } from '../../../src/components/reference-surface.tsx';
import { isPromptKnownBusy, RuntimeModelControls } from '../../../src/components/runtime-controls.tsx';
import { SessionSurfaceReferences } from '../../../src/components/session-surface-references.tsx';
import { Transcript } from '../../../src/components/transcript.tsx';
import { SessionSkillsSurface } from '../../../src/features/skills/session-skills-surface.tsx';
import { useAppViewport } from '../../../src/hooks/use-app-viewport.ts';
import { LocationShareContext } from '../../../src/hooks/use-location-share.ts';
import { MarkdownComposerSettings } from '../../../src/features/settings/markdown-composer-settings.tsx';
import { parseComposerDockLayout, writeComposerDockLayout } from '../../../src/lib/composer-dock-layout.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DaemonDraftStore } from '../../../src/lib/drafts.ts';
import type { LocationFix, LocationShareHost } from '../../../src/lib/location-share.ts';
import { writeMdComposePref } from '../../../src/lib/md-compose.ts';
import type { RuntimeModelCatalog } from '../../../src/lib/runtime-models.ts';
import type { SessionCard } from '../../../src/lib/session-cards.ts';
import { DEFAULT_STT_SETTINGS } from '../../../src/lib/stt/stt-settings.ts';

const parameters = new URLSearchParams(location.search);
const editor = parameters.get('editor');
writeMdComposePref(editor === 'rich' ? 'rich' : editor === 'off' ? 'off' : 'on');
writeComposerDockLayout(parseComposerDockLayout(parameters.get('dock')));
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
const TASK: SessionCard = {
  id: 'F12',
  title: 'Fix the transcript scroller',
  summary: '',
  lane: 'Implement',
  closed: false,
  active: true,
  assignee: null,
  touchedAt: '2026-07-02T00:00:00.000Z',
  agentAsked: false,
  legacyId: null,
};
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

/** `?occupied=<text>`: the agent's box holds the person's text until a tap frees it. */
let occupiedDraft = parameters.get('occupied');
const draftTaps: unknown[] = [];
(window as unknown as { __drafts: unknown[] }).__drafts = draftTaps;
const occupiedApi = {
  resolveComposerDraft: async (_id: string, request: ComposerDraftRequest): Promise<ComposerDraftResult> => {
    draftTaps.push(request);
    occupiedDraft = null;
    return { action: request.action, outcome: request.action === 'submit' ? 'submitted' : 'cleared' };
  },
};
const refuseWhileOccupied = (): void => {
  if (occupiedDraft === null) return;
  throw new FyHttpError('the agent’s composer already holds unsent text', 409, COMPOSER_OCCUPIED_CODE, {
    error: 'the agent’s composer already holds unsent text',
    code: COMPOSER_OCCUPIED_CODE,
    draft: occupiedDraft,
  });
};

/** `?unconfirmed=1`: the first send was typed into the agent's box and never shown there. */
let unconfirmedOnce = parameters.get('unconfirmed') === '1';
const unconfirmedTaps: unknown[] = [];
(window as unknown as { __unconfirmed: unknown[] }).__unconfirmed = unconfirmedTaps;
const unconfirmedApi = {
  submitSend: async (_id: string, sendId: string) => {
    unconfirmedTaps.push({ action: 'submit', sendId });
    return { sendId } as SendRecord;
  },
  cancelSend: async (_id: string, sendId: string) => {
    unconfirmedTaps.push({ action: 'clear', sendId });
    return { sendId } as SendRecord;
  },
  retrySend: async (_id: string, sendId: string, force?: boolean) => {
    unconfirmedTaps.push({ action: 'retry', sendId, force });
    return { sendId } as SendRecord;
  },
};
const answerUnconfirmedOnce = (): void => {
  if (!unconfirmedOnce) return;
  unconfirmedOnce = false;
  throw new FyHttpError('the message was typed into the agent’s box', 409, SEND_UNCONFIRMED_CODE, {
    error: 'the message was typed into the agent’s box',
    code: SEND_UNCONFIRMED_CODE,
    sendId: 'scene-send-1',
  });
};

/** A picture a test can see: a labelled gradient drawn on a canvas, as a real PNG. */
const picturePng = (label: string, hue: number): Promise<Blob> => {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 800;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('the scene has no 2d canvas');
  const gradient = context.createLinearGradient(0, 0, 1200, 800);
  gradient.addColorStop(0, `hsl(${hue} 70% 55%)`);
  gradient.addColorStop(1, `hsl(${(hue + 70) % 360} 70% 35%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1200, 800);
  context.fillStyle = 'rgba(255,255,255,0.35)';
  context.beginPath();
  context.arc(900, 250, 120, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#fff';
  context.font = '96px sans-serif';
  context.fillText(label, 80, 700);
  return new Promise((resolve, reject) =>
    canvas.toBlob(blob => (blob === null ? reject(new Error('no png')) : resolve(blob)), 'image/png'),
  );
};

const host: LocationShareHost = { locate: () => new Promise<LocationFix>(() => undefined) };
const uploadAttachment =
  parameters.get('upload') === '1'
    ? async (file: File) => ({
        id: `att-${file.name}`,
        filename: file.name,
        mime: file.type,
        size: file.size,
        sha256: 'a'.repeat(64),
        createdAt: '2026-10-22T00:00:00.000Z',
      })
    : undefined;

const messageCount = Number(parameters.get('messages') ?? '0');
const messagePictures = Array.from({ length: messageCount }, (_unused, at) => ({
  kind: 'attachment' as const,
  sessionId: scope.sessionId,
  attachmentId: `pic-${at + 1}`,
  filename: `photo-${at + 1}.png`,
  mime: 'image/png',
  size: 4_200 + at * 100,
}));
const messageGallery =
  messageCount > 0 ? (
    <AttachmentGalleryProvider
      load={(_daemon, attachment) => picturePng(attachment.attachmentId, Number(attachment.attachmentId.slice(4)) * 80)}
    >
      <section className="scene-entries" data-scene-message="">
        <p>Here are the screenshots from the failing run.</p>
        <TranscriptAttachmentGallery daemon={daemon} images={messagePictures} />
      </section>
    </AttachmentGalleryProvider>
  ) : null;

const composer = (
  <Composer
    {...(uploadAttachment === undefined ? {} : { uploadAttachment })}
    api={{
      ...occupiedApi,
      ...unconfirmedApi,
      send: async (_id, body) => {
        refuseWhileOccupied();
        answerUnconfirmedOnce();
        sent.push(body);
        return { disposition: 'queued' } as never;
      },
    }}
    busy={parameters.get('busy') === '1'}
    compact={parameters.get('compact') === '1'}
    daemon={daemon}
    {...(parameters.get('mic') === '1' ? { dictationSettings: DEFAULT_STT_SETTINGS } : {})}
    draftStore={drafts}
    enterKeyPreference="send"
    sessionId="scene-session"
    {...(runtimeSlot === undefined ? {} : { statusSlot: runtimeSlot })}
    vimMode={parameters.get('vim') === '1'}
  />
);

const scene =
  parameters.get('settings') === '1' ? (
    <div className="bg-bg p-4 text-fg">
      <MarkdownComposerSettings onChangeVim={() => undefined} vimEnabled={false} />
    </div>
  ) : parameters.get('layout') === 'chat' ? (
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

const hosted = (
  <LocationShareContext.Provider value={parameters.get('host') === '1' ? host : null}>
    {messageGallery}
    {scene}
  </LocationShareContext.Provider>
);

createRoot(root).render(<StrictMode>{hosted}</StrictMode>);
