import type { VoiceRecognizerSet } from './ipc.ts';
import { voiceMemoryLimit } from './policy.ts';

/** The fallback's memory protection. IO and cadence are ports; checks never overlap. */
export class VoiceRssWatchdog {
  private reading = false;
  private closed = false;
  constructor(
    private readonly ports: {
      readonly recognizers: VoiceRecognizerSet;
      readonly hardCapped: boolean;
      readonly rss: () => Promise<number>;
      readonly stop: (reason: string) => Promise<void>;
    },
  ) {}
  close(): void {
    this.closed = true;
  }
  async check(): Promise<void> {
    if (this.reading || this.closed) return;
    this.reading = true;
    let reason: string | undefined;
    try {
      const rss = await this.ports.rss();
      if (rss > voiceMemoryLimit(this.ports.recognizers))
        reason = 'Speech worker exceeded its resident memory ceiling.';
    } catch {
      if (!this.ports.hardCapped) reason = 'Speech worker RSS watchdog could not read memory.';
    } finally {
      this.reading = false;
    }
    if (reason !== undefined && !this.closed) {
      this.closed = true;
      await this.ports.stop(reason);
    }
  }
}
