import type { CgroupCommandPort, CgroupHostFacts } from '../cgroups/ports.ts';
import { VoiceWorkerResponseSchema } from './ipc.ts';
import type { VoiceRecognizerSet, VoiceWorkerRequest } from './ipc.ts';
import { launchPlacedVoiceWorker, planVoiceLaunch } from './placement.ts';
import { voiceWorkerCommand } from './policy.ts';
import type { VoiceClock, VoicePlacement, VoiceWorkerHandle, VoiceWorkerSpawner } from './ports.ts';
import { VoiceRssWatchdog } from './watchdog.ts';

interface VoiceChildProcess {
  send(message: VoiceWorkerRequest): void;
  kill(): Promise<void>;
  rss(): Promise<number>;
}
export interface VoiceProcessPort {
  spawn(
    command: readonly string[],
    threads: number,
    handlers: {
      message(raw: unknown): void;
      exited(reason: string): void;
    },
  ): VoiceChildProcess;
}
interface Options {
  readonly host: CgroupHostFacts;
  readonly commands: CgroupCommandPort;
  readonly processes: VoiceProcessPort;
  readonly clock: VoiceClock;
  readonly entry: string;
  readonly runtime: string;
  readonly nonce: () => string;
}
/** Startup/fallback/watchdog lifecycle is domain policy, tested entirely through process and clock ports. */
export class VoiceProcessSpawner implements VoiceWorkerSpawner {
  constructor(private readonly options: Options) {}
  async start(
    handlers: Parameters<VoiceWorkerSpawner['start']>[0],
    recognizers: VoiceRecognizerSet,
  ): Promise<VoiceWorkerHandle> {
    const command = voiceWorkerCommand(this.options.runtime, this.options.entry);
    const plan = await planVoiceLaunch({ ...this.options, recognizers, command, nonce: this.options.nonce() });
    return await launchPlacedVoiceWorker(
      plan,
      command,
      async (argv, placement) => await this.spawn(argv, placement, handlers, recognizers),
    );
  }
  private async spawn(
    command: readonly string[],
    placement: VoicePlacement,
    handlers: Parameters<VoiceWorkerSpawner['start']>[0],
    recognizers: VoiceRecognizerSet,
  ): Promise<VoiceWorkerHandle> {
    const ready = Promise.withResolvers<void>();
    let started = false;
    let stopping: Promise<void> | undefined;
    const child = this.options.processes.spawn(command, Math.max(...recognizers.map(model => model.threads)), {
      message: raw => {
        const parsed = VoiceWorkerResponseSchema.safeParse(raw);
        if (!started && parsed.success && parsed.data.type === 'health' && parsed.data.state === 'ready')
          ready.resolve();
        else if (started) handlers.message(raw);
      },
      exited: reason => {
        if (!started) ready.reject(new Error(reason));
        else if (stopping === undefined) handlers.exited(reason);
      },
    });
    const monitor = new VoiceRssWatchdog({
      recognizers,
      hardCapped: placement.hardCapped,
      rss: () => child.rss(),
      stop: async reason => {
        if (started) handlers.exited(reason);
        else ready.reject(new Error(reason));
        await stop();
      },
    });
    let poll: { cancel(): void } | undefined;
    const schedule = (): void => {
      if (stopping !== undefined) return;
      poll = this.options.clock.after(1_000, () => {
        void monitor.check().then(schedule);
      });
    };
    const stop = (): Promise<void> => {
      if (stopping !== undefined) return stopping;
      monitor.close();
      poll?.cancel();
      stopping = Promise.resolve().then(() => child.kill());
      return stopping;
    };
    schedule();
    const deadline = this.options.clock.after(10_000, () =>
      ready.reject(new Error('Speech worker startup did not answer within 10 seconds.')),
    );
    try {
      await ready.promise;
      started = true;
      return { placement, send: message => child.send(message), stop };
    } catch (error) {
      await stop();
      throw error;
    } finally {
      deadline.cancel();
    }
  }
}
