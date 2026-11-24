/**
 * The Voice mode button in the composer's tools (`composer.tools`): starts hands-free chat with THIS ferret.
 *
 * It asks the machine whether its speech is installed before it hides anything, so a machine that cannot do voice mode
 * (nothing installed, or not reachable) leaves the composer where it is and says why in one sentence above it. It never
 * installs: that is Settings › Voice › Voice mode, where the download's size and the memory it uses are shown.
 */
import { AudioLines } from 'lucide-react';
import { useState } from 'react';
import { readVoiceEngine } from '../features/settings/voice-engine-api.ts';
import { useVoiceMode, type VoiceModeStore } from '../lib/voice-mode/voice-mode-store.ts';
import { apiClientOver, Button, type VoicePluginClient } from '../shell-voice.ts';

export interface VoiceModeButtonProps {
  readonly ferretId: string;
  readonly store: VoiceModeStore;
  readonly client: VoicePluginClient;
}

export function VoiceModeButton({ ferretId, store, client }: VoiceModeButtonProps) {
  const state = useVoiceMode(store, ferretId);
  const [checking, setChecking] = useState(false);
  const press = async (): Promise<void> => {
    if (state.active || checking) return;
    setChecking(true);
    try {
      const view = await readVoiceEngine(apiClientOver(client));
      if (view.state === 'ready') store.start(ferretId, view.machine);
      else
        store.end(
          ferretId,
          view.state === 'installing'
            ? `Voice mode is still installing on ${view.machine}. Try again when it is ready (Settings › Voice).`
            : `Voice mode needs its speech installed on ${view.machine}: Settings › Voice › Voice mode.`,
        );
    } catch {
      store.end(ferretId, 'Voice mode runs on your machine, and it cannot be reached right now.');
    } finally {
      setChecking(false);
    }
  };
  return (
    <Button
      aria-label="Start voice mode"
      className="min-h-[44px] min-w-[44px] select-none px-2"
      data-voice-mode-start=""
      disabled={state.active || checking}
      onClick={() => void press()}
      size="sm"
      title="Voice mode: talk hands-free"
      type="button"
      variant="ghost"
    >
      <AudioLines aria-hidden="true" size={18} />
    </Button>
  );
}
