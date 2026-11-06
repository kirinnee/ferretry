import { absoluteUnitLimits, cgroupsSupported } from '../cgroups/limits.ts';
import type { CgroupHostFacts } from '../cgroups/ports.ts';
import type { VoicePlacement, VoiceOutcome } from './ports.ts';
import type { VoiceRecognizerDescription, VoiceRecognizerSet } from './ipc.ts';

const VOICE_MEMORY_FLOOR_BYTES = 1_500_000_000;
const VOICE_MEMORY_PEAK_FACTOR = 1.25;
const VOICE_MEMORY_HEADROOM_BYTES = 1024 ** 3;
export const VOICE_IDLE_MS = 10 * 60_000;
export const VOICE_FINISH_MS = 5_000;
export const VOICE_LOAD_MS = 30_000;
export function voiceCores(cores: number): number {
  return Math.min(4, Math.max(1, Math.floor(cores / 4)));
}
export function voiceMemoryLimit(descriptions: VoiceRecognizerSet): number {
  return Math.max(
    VOICE_MEMORY_FLOOR_BYTES,
    Math.ceil(descriptions.reduce((total, model) => total + model.peakResidentBytes, 0) * VOICE_MEMORY_PEAK_FACTOR),
  );
}
/** The scope quota is always C whole cores from the host; a recognizer's declared threads are only a wish. */
export function voiceUnitLimits(
  cores: number,
  descriptions: VoiceRecognizerSet,
): { cpuQuota: string; memoryMax: string } {
  return absoluteUnitLimits(voiceCores(cores), voiceMemoryLimit(descriptions));
}
/** Threads handed to the worker: the largest wish, never above the host budget C. */
export function voiceWorkerThreads(cores: number, descriptions: VoiceRecognizerSet): number {
  return Math.min(voiceCores(cores), Math.max(...descriptions.map(model => model.threads)));
}
export function voiceMemoryAdmission(available: number, descriptions: VoiceRecognizerSet): VoiceOutcome<void> {
  return available < descriptions.reduce((total, model) => total + model.modelBytes, 0) + VOICE_MEMORY_HEADROOM_BYTES
    ? { ok: false, code: 'voice_no_memory', message: 'Not enough available memory to load speech with 1 GiB headroom.' }
    : { ok: true, value: undefined };
}
export function voicePlacementSupport(host: CgroupHostFacts): VoicePlacement {
  return cgroupsSupported(host)
    ? { hardCapped: true }
    : {
        hardCapped: false,
        reason: host.platform === 'linux' ? 'cgroup v2 is unavailable' : `${host.platform} has no systemd user scopes`,
      };
}
export function describeVoice(placement: VoicePlacement): string {
  return `engine not installed; hard-capped ${placement.hardCapped ? 'yes' : `no — not hard-capped: ${placement.reason}`}`;
}
/** The same source/compiled command is used for the hidden child entry and tested without spawning. */
export function voiceWorkerCommand(runtime: string, entry: string): readonly string[] {
  return entry.startsWith('/$bunfs/') ? [runtime, 'voice-worker'] : [runtime, entry, 'voice-worker'];
}

/** No model/runtime is installed by the plumbing slice. Threads are the host's already chosen C. */
export function notInstalledVoiceDescription(threads: number): VoiceRecognizerDescription {
  return { modelId: 'not-installed', modelBytes: 0, peakResidentBytes: 0, streaming: false, threads };
}
