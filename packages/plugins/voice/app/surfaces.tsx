/**
 * The voice plugin's surfaces: the Voice and Speed-ups settings tabs and the dictation control that sits in the
 * composer's tools slot. Each is wrapped in a boundary that gives it the plugin client and this device's voice stores.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useMemo } from 'react';
import { DictationControl } from './components/dictation-control.tsx';
import { AutoReadSettings } from './features/settings/auto-read-settings.tsx';
import { DictationDebugSettings } from './features/settings/dictation-debug-settings.tsx';
import { DictationSettings } from './features/settings/dictation-settings.tsx';
import { SpeedupKeysSettings } from './features/settings/speedup-keys-settings.tsx';
import { TranscriptionLogSettings } from './features/settings/transcription-log-settings.tsx';
import { SpeedupsSurface } from './features/speedups/speedups-surface.tsx';
import { useSttSettings } from './hooks/use-stt-settings.ts';
import { createVoiceStore, StoreProvider, useSttSettingsStore, type VoiceStore } from './lib/voice-store.tsx';
import { daemonConnection, useComposerDraft, VoiceClientProvider } from './shell-voice.ts';

/** The daemon every call goes to is the one the shell's client is for; the connection only carries an identity. */
const THIS_DAEMON = daemonConnection({
  daemonId: 'this-daemon',
  baseUrl: 'https://this-daemon.invalid',
  deviceId: 'this-device',
});

/** Builds the surfaces over one plugin client and ONE voice store for the page. */
export function voiceSurfaces(client: PluginClient) {
  let held: VoiceStore | undefined;
  const store = (): VoiceStore => {
    held ??= createVoiceStore();
    return held;
  };

  function Boundary({ children }: { readonly children?: ReactNode }) {
    const created = useMemo(store, []);
    return (
      <VoiceClientProvider client={client}>
        <StoreProvider store={created}>{children}</StoreProvider>
      </VoiceClientProvider>
    );
  }

  function VoiceSettingsBody() {
    const stt = useSttSettingsStore();
    if (stt === null) return null;
    return <VoiceSettingsSections store={stt} />;
  }

  function VoiceSettingsSections({
    store: sttStore,
  }: {
    readonly store: NonNullable<ReturnType<typeof useSttSettingsStore>>;
  }) {
    const dictation = useSttSettings(sttStore);
    return (
      <>
        <DictationSettings {...dictation} daemon={THIS_DAEMON} />
        <AutoReadSettings />
        <SpeedupKeysSettings />
        <TranscriptionLogSettings />
        <DictationDebugSettings />
      </>
    );
  }

  const VoiceTab = () => (
    <Boundary>
      <VoiceSettingsBody />
    </Boundary>
  );

  const SpeedupsTab = () => (
    <Boundary>
      <SpeedupsSurface connection={THIS_DAEMON} />
    </Boundary>
  );

  function DictationPanelBody({ subject }: { readonly subject?: string }) {
    const stt = useSttSettingsStore();
    const binding = useComposerDraft();
    if (stt === null || binding === null) return null;
    return <DictationPanelControl store={stt} binding={binding} subject={subject} />;
  }

  function DictationPanelControl({
    store: sttStore,
    binding,
    subject,
  }: {
    readonly store: NonNullable<ReturnType<typeof useSttSettingsStore>>;
    readonly binding: NonNullable<ReturnType<typeof useComposerDraft>>;
    readonly subject?: string | undefined;
  }) {
    const { settings } = useSttSettings(sttStore);
    const sessionId = subject ?? binding.sessionId;
    return (
      <DictationControl
        daemon={THIS_DAEMON}
        {...(sessionId === undefined ? {} : { sessionId })}
        {...(binding.readConversation === undefined ? {} : { readConversation: binding.readConversation })}
        draft={binding.draft}
        {...(binding.selectionRef === undefined ? {} : { selectionRef: binding.selectionRef })}
        {...(binding.composerRef === undefined ? {} : { composerRef: binding.composerRef })}
        onDraftChange={binding.onDraftChange}
        settings={settings}
      />
    );
  }

  const DictationPanel = (props: { readonly subject?: string }) => (
    <Boundary>
      <DictationPanelBody {...props} />
    </Boundary>
  );

  return { VoiceTab, SpeedupsTab, DictationPanel };
}
