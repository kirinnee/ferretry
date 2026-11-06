import type { VoiceEngineView, VoiceInstallProgress, VoiceModelEntry } from '@ferretry/protocol';
import type { IVoiceClock, IVoiceGateway, IVoiceOutput } from '../../../src/lib/voice/ports';

const ARCHIVE = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/x.tar.bz2',
  format: 'tar.bz2' as const,
  bytes: 487_170_055,
  sha256: 'a'.repeat(64),
  extractedBytes: 671_239_000,
};

export function entry(overrides: Partial<VoiceModelEntry> & { readonly id: string }): VoiceModelEntry {
  return {
    name: overrides.id.toUpperCase(),
    role: 'batch',
    summary: 'a model',
    weight: 'standard',
    sherpaType: 'nemo-transducer',
    files: { encoder: 'encoder.onnx' },
    languages: ['English'],
    archive: ARCHIVE,
    peakMemory: { bytes: 1_500_000_000, basis: 'estimate' },
    recommended: false,
    install: { state: 'not-installed', partialBytes: 0 },
    active: false,
    ...overrides,
  };
}

export function progress(overrides: Partial<VoiceInstallProgress> = {}): VoiceInstallProgress {
  return {
    modelId: 'parakeet',
    status: 'running',
    component: 'model',
    phase: 'downloading',
    bytesDone: 0,
    bytesTotal: 100_000_000,
    startedAt: '2026-11-05T12:00:00.000Z',
    ...overrides,
  };
}

export function view(overrides: Partial<VoiceEngineView> = {}): VoiceEngineView {
  return {
    target: 'linux-x64',
    runtime: {
      source: 'downloaded',
      version: '2.0.1',
      wrapperVersion: '2.0.1',
      install: { state: 'not-installed', partialBytes: 0 },
    },
    models: [
      entry({ id: 'parakeet', recommended: true }),
      entry({ id: 'nemotron', role: 'streaming', recommended: true }),
    ],
    active: { batch: null, streaming: null },
    install: null,
    warnings: [],
    ...overrides,
  };
}

export class CapturingOutput implements IVoiceOutput {
  readonly reports: string[] = [];
  readonly successes: string[] = [];
  readonly warnings: string[] = [];
  exitCode = 0;
  success(message: string): void {
    this.successes.push(message);
  }
  report(message: string): void {
    this.reports.push(message);
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

export class FakeGateway implements IVoiceGateway {
  readonly calls: string[] = [];
  /** What `status()` answers, one per call; the last repeats. */
  statuses: VoiceEngineView[] = [view()];
  started: VoiceEngineView = view({ install: progress() });
  async status(): Promise<VoiceEngineView> {
    this.calls.push('status');
    return this.statuses.length > 1
      ? (this.statuses.shift() as VoiceEngineView)
      : (this.statuses[0] as VoiceEngineView);
  }
  async install(id: string): Promise<VoiceEngineView> {
    this.calls.push(`install:${id}`);
    return this.started;
  }
  async cancel(): Promise<VoiceEngineView> {
    this.calls.push('cancel');
    return this.statuses[0] as VoiceEngineView;
  }
  async remove(id: string): Promise<VoiceEngineView> {
    this.calls.push(`remove:${id}`);
    return this.statuses[0] as VoiceEngineView;
  }
  async use(id: string): Promise<VoiceEngineView> {
    this.calls.push(`use:${id}`);
    return this.statuses[0] as VoiceEngineView;
  }
}

export class InstantClock implements IVoiceClock {
  readonly slept: number[] = [];
  async sleep(milliseconds: number): Promise<void> {
    this.slept.push(milliseconds);
  }
}
