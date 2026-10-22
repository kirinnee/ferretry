/**
 * The browser entry for Settings › Appearance › "Open links in": the REAL Settings page and the REAL
 * `Transcript`, sharing ONE `DaemonControlsStore` over this page's own `localStorage` — so a choice
 * made on the settings view is what the chat view reads after a navigation, exactly as the app does.
 * The chat is wrapped the way the session page wraps it: `LinkBehaviourProvider` (the app root's
 * binding) around `InAppBrowserWorkspace` (the session chat's host). Nothing here reads a network:
 * every daemon client is a fake that never answers, and the only link points back at this server.
 *
 * Parameters (all optional):
 *
 *   ?view=settings   Settings, opened at Appearance (the default is the chat)
 *   ?theme=<family>-<mode>
 */

import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { transcriptEntriesFromLog } from '../../../src/components/session-workspace-model.ts';
import { Transcript } from '../../../src/components/transcript.tsx';
import { LinkBehaviourProvider } from '../../../src/features/browser/external-link.tsx';
import { InAppBrowserWorkspace } from '../../../src/features/browser/in-app-browser.tsx';
import { SettingsPage } from '../../../src/features/settings/settings-page.tsx';
import { browserControlsStorage, DaemonControlsStore } from '../../../src/lib/controls.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DEFAULT_STT_SETTINGS } from '../../../src/lib/stt/stt-settings.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SESSION = 'mvlinks1-5e7d0b1e';
const daemon = daemonConnection({ daemonId: 'daemon-links', baseUrl: 'https://links.invalid', deviceId: 'd' });
const record = { ...daemon, label: 'studio', pairedAt: 1, lastSelectedAt: 2 };
const controls = new DaemonControlsStore(browserControlsStorage());

const NOW = Date.now();
const MINUTE = 60_000;
const clock = (at: number): string => new Date(at).toISOString().slice(11, 19);
const GUIDE = `${window.location.origin}/guide`;
const LOG = [
  `[${clock(NOW - 3 * MINUTE)}] user/message: Where do I start with the setup?`,
  `[${clock(NOW - 2 * MINUTE)}] assistant/message: Start with [the setup guide](${GUIDE}) — it walks through pairing a phone. The relay page explains the rest.`,
].join('\n');
const entries = transcriptEntriesFromLog(LOG, NOW);
const answered = async (): Promise<boolean> => true;
const compact = window.matchMedia('(max-width: 767px)').matches;

function Chat() {
  const openLinksIn = useSyncExternalStore(controls.subscribe, () => controls.snapshot().device.openLinksIn);
  return (
    <LinkBehaviourProvider openLinksIn={openLinksIn}>
      <div className="scene-chat" data-open-links-in={openLinksIn}>
        <InAppBrowserWorkspace compact={compact}>
          <div className="kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="fy-chat-log">
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
          </div>
        </InAppBrowserWorkspace>
      </div>
    </LinkBehaviourProvider>
  );
}

function Settings() {
  return (
    <div className="h-dvh overflow-hidden bg-bg">
      <SettingsPage
        connections={[record]}
        controls={controls}
        createWardenClient={async () => Promise.reject(new Error('no Warden in this scene'))}
        daemonId={daemon.daemonId}
        daemonSettingsTabs={[]}
        dictation={{ settings: DEFAULT_STT_SETTINGS, update: () => {}, persisted: true }}
        onAddDaemon={() => {}}
        onRemoveDaemon={() => {}}
        onRenameDaemon={() => {}}
        probeDaemon={() => new Promise(() => undefined)}
      />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  params.get('view') === 'settings' ? <Settings /> : <Chat />,
);
