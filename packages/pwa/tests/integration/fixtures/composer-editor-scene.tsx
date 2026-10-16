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
 */
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../src/components/composer.tsx';
import { useAppViewport } from '../../../src/hooks/use-app-viewport.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DaemonDraftStore } from '../../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../../src/lib/md-compose.ts';

const parameters = new URLSearchParams(location.search);
const editor = parameters.get('editor');
writeMdComposePref(editor === 'rich' ? 'rich' : editor === 'off' ? 'off' : 'on');
document.documentElement.setAttribute('data-theme', parameters.get('theme') ?? 'studio-light');

const sent: unknown[] = [];
(window as unknown as { __sent: unknown[] }).__sent = sent;

const daemon = daemonConnection({ daemonId: 'scene', baseUrl: 'http://127.0.0.1', deviceId: 'scene' });
const drafts = new DaemonDraftStore();
drafts.save(daemonSessionScope(daemon, 'scene-session'), parameters.get('draft') ?? '');

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
    vimMode={parameters.get('vim') === '1'}
  />
);

createRoot(root).render(
  <StrictMode>
    {parameters.get('layout') === 'chat' ? <ChatPage>{composer}</ChatPage> : <main className="scene">{composer}</main>}
  </StrictMode>,
);
