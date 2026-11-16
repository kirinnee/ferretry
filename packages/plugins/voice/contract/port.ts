import { definePort } from '@ferretry/kernel/contract';
import type { VoiceConfig } from './config.ts';
import type { SttEnhancementResult } from './stt.ts';
import type { SpeedupProvider, SpeedupsView, SpeedupTestResult } from './speedups.ts';

/**
 * What other plugins and the app read through Voice. Recognition itself is the browser's; the daemon's part is the one
 * JSON exchange a browser cannot perform (a repaired transcript from a hosted chat model, spending a key only the
 * daemon holds) and the speed-up keys' status and Test. No method returns a key, and none takes audio (R626).
 */
export interface VoiceApi {
  /** One transcript in, one repaired transcript out. Throws {@link SttEnhancementError} with a stable code. */
  enhance(input: unknown): Promise<SttEnhancementResult>;
  /** Whether each speed-up key is set, from the secret NAME listing. Never opens a value. */
  speedups(): Promise<SpeedupsView>;
  /** Spends the provider's key once, the cheapest way it can be spent, and remembers the answer. */
  testSpeedup(provider: SpeedupProvider): Promise<SpeedupTestResult>;
  /** The cleanup settings in effect (`voice.yaml`). */
  settings(): VoiceConfig;
}
export const VoicePort = definePort<VoiceApi>('voice');

/** Read models others and the app may call (`manifest.data.readModels`). */
export const VOICE_READ_MODELS = ['speedups', 'cleanup'] as const;
