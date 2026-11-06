/**
 * THE DICTATION SETTINGS A DEVICE ACTUALLY RUNS WITH: its own, with the engine filled in when it has
 * not picked one, and the machine's clean-up settings when its clean-up provider is a hosted one.
 *
 * A device that has not picked an engine dictates with its machine's default (voice.yaml), if it names
 * one, and otherwise with the default for a phone or a computer (`lib/stt/engine-defaults.ts`). The mic
 * button (`dictation-control.tsx`) and Live voice (`live-voice-control.tsx`) both read it from here, so
 * the two can never disagree about which engine this device speaks to.
 *
 * `skip` reads nothing from the machine at all: a Live control that is not offered here must not cost a
 * request.
 */

import { useMemo } from 'react';
import { useMachineVoiceEngine } from '../features/fleet/setup/voice-default.ts';
import { useMachineVoiceCleanup } from '../features/settings/use-machine-voice-cleanup.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import {
  type DeviceClass,
  type DeviceClassGlobalLike,
  deviceClassOf,
  effectiveEngine,
} from '../lib/stt/engine-defaults.ts';
import { isRemoteEnhancementProvider, type SttSettings } from '../lib/stt/stt-settings.ts';
import type { VoiceCleanup } from '../lib/stt/voice-cleanup.ts';

export interface EffectiveDictation {
  readonly settings: SttSettings;
  readonly voiceCleanup: VoiceCleanup;
}

export function useEffectiveDictation(input: {
  readonly deviceSettings: SttSettings;
  readonly daemon: DaemonConnection;
  /** Phone or computer; read from the page when omitted. */
  readonly deviceClass?: DeviceClass | undefined;
  /** Read nothing from the machine. */
  readonly skip?: boolean;
}): EffectiveDictation {
  const { deviceSettings, daemon, skip = false } = input;
  const machineEngine = useMachineVoiceEngine(deviceSettings.engine === null && !skip ? daemon : undefined);
  const pageDeviceClass = useMemo(() => deviceClassOf(globalThis as DeviceClassGlobalLike), []);
  const deviceClass = input.deviceClass ?? pageDeviceClass;
  const voiceCleanup = useMachineVoiceCleanup(
    isRemoteEnhancementProvider(deviceSettings.enhancementProvider) && !skip ? daemon : undefined,
  ).cleanup;
  const settings = useMemo(
    () =>
      deviceSettings.engine === null
        ? { ...deviceSettings, engine: effectiveEngine(null, machineEngine, deviceClass) }
        : deviceSettings,
    [deviceSettings, machineEngine, deviceClass],
  );
  return { settings, voiceCleanup };
}
