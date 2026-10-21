/**
 * The browser entry for "it keeps refreshing, esp after I typed": the REAL machine settings frame (its
 * Security and Host checks panels) and the REAL dictation clean-up section, re-rendered by a parent that
 * ticks every 40 ms — the way the app re-renders Settings on every background poll and config event —
 * handing down fresh callbacks, a republished pairing record and a fresh clean-up state object each tick.
 * Nothing here reads a network: every client is a fake that answers from memory.
 *
 * `?theme=<family>-<mode>` picks the theme. `window.__settingsTyping` counts the ticks, and lets the
 * test move the machine's values as another device would (`moveElsewhere`).
 */

import type { PasskeysView, SecuritySettingsPatch, SecuritySettingsView } from '@ferretry/protocol';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DaemonSettingsFrame } from '../../../src/features/settings/daemon-settings-frame.tsx';
import type { PasskeyClientFactory } from '../../../src/features/settings/security-settings.tsx';
import { VoiceCleanupSettings } from '../../../src/features/settings/voice-cleanup-settings.tsx';
import type { DaemonConnectionRecord } from '../../../src/lib/connections.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DEFAULT_VOICE_CLEANUP, type VoiceCleanup } from '../../../src/lib/stt/voice-cleanup.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const STUDIO = daemonConnection({
  daemonId: `fy_daemon_${'st'.repeat(21)}A`,
  baseUrl: 'https://studio.example.test',
  deviceId: 'device-on-studio',
});

const PASSKEYS: PasskeysView = {
  passkeys: [{ id: 'Ab'.repeat(16), origin: 'https://ferretry.example.test', createdAt: '2026-10-01T09:00:00.000Z' }],
  registration: 'confirm-existing',
};

let security: SecuritySettingsView = {
  settings: {
    stepUpWindowMinutes: 15,
    deviceKeyRotationDays: 30,
    unlockOnOpen: true,
    unlockValidityHours: 8,
    stepUpOnActions: false,
    idleExpiryDays: 30,
  },
  source: 'document',
  mayWiden: false,
  widenCommand: 'fy daemon security set <field> <value>',
};

/** Module-level, as the app's client pool is: stable across every tick. */
const passkeyClient: PasskeyClientFactory = async () => ({
  request: (async (path: string, _schema: unknown, init?: RequestInit) => {
    if (path === '/v1/security' && init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body)) as SecuritySettingsPatch;
      security = { ...security, settings: { ...security.settings, ...patch } };
      return { view: security, devicesExpiring: 0 };
    }
    return path === '/v1/security' ? security : PASSKEYS;
  }) as Awaited<ReturnType<PasskeyClientFactory>>['request'],
});

interface SceneControl {
  ticks: number;
  label: string;
  cleanup: VoiceCleanup;
  saves: unknown[];
  /** Another device changes the machine's name and its clean-up prompt. */
  moveElsewhere(): void;
}

const control: SceneControl = {
  ticks: 0,
  label: 'studio',
  cleanup: { ...DEFAULT_VOICE_CLEANUP, useConversation: true, conversationMessages: 6 },
  saves: [],
  moveElsewhere() {
    control.label = 'studio (renamed elsewhere)';
    control.cleanup = { ...control.cleanup, prompts: { fix: 'A prompt another device saved.' } };
  },
};
(window as unknown as { __settingsTyping: SceneControl }).__settingsTyping = control;

function Scene() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      control.ticks += 1;
      setTick(control.ticks);
    }, 40);
    return () => clearInterval(timer);
  }, []);
  // A fresh record and fresh callbacks on every tick, exactly what the page hands the frame.
  const record: DaemonConnectionRecord = { ...STUDIO, label: control.label, pairedAt: 0, lastSelectedAt: tick };
  const frame = (panel: string) => (
    <DaemonSettingsFrame
      connection={STUDIO}
      connectionRecord={record}
      name="studio"
      panel={panel}
      onOpenPanel={() => tick}
      createPasskeyClient={passkeyClient}
      probeDaemon={async () => ({ ok: true })}
      onRenameDaemon={() => tick}
      onRemoveDaemon={() => tick}
    />
  );
  return (
    // Its own scroll box: the app stylesheet holds the page itself still, as the shell scrolls its panes.
    <div className="h-dvh overflow-y-auto bg-bg">
      <main className="mx-auto flex max-w-[760px] flex-col gap-6 p-4 text-fg" data-scene-tick={tick}>
        <div data-scene-panel="security">{frame('security')}</div>
        <div data-scene-panel="host-checks">{frame('host-checks')}</div>
        <div data-scene-panel="voice">
          <VoiceCleanupSettings
            state={{
              cleanup: { ...control.cleanup },
              loaded: true,
              save: async patch => {
                control.saves.push(patch);
                return { kind: 'applied' };
              },
            }}
          />
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <Scene />
  </StrictMode>,
);
