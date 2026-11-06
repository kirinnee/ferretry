import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { CgroupCommandPort } from '../../lib/cgroups/ports.ts';
import { VOICE_WORKER_THREADS_ENV, VoiceWorkerRequestSchema } from '../../lib/voice/ipc.ts';
import type { VoiceProcessPort } from '../../lib/voice/process-spawner.ts';

/** The only real process/IPC/proc IO. No decode, timers, or placement policy lives here. */
export class BunVoiceWorkerProcesses implements VoiceProcessPort {
  constructor(
    private readonly commands: CgroupCommandPort,
    private readonly platform: string = process.platform,
  ) {}
  spawn(
    command: readonly string[],
    threads: number,
    handlers: Parameters<VoiceProcessPort['spawn']>[2],
  ): ReturnType<VoiceProcessPort['spawn']> {
    let stderr = '';
    const child = Bun.spawn([...command], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      serialization: 'advanced',
      env: { ...process.env, [VOICE_WORKER_THREADS_ENV]: String(threads) },
      ipc: raw => handlers.message(raw),
      onExit: (_child, code, signal) =>
        handlers.exited(`Speech worker exited (${code ?? signal ?? 'unknown'}): ${stderr}`),
    });
    void (async () => {
      for await (const chunk of child.stderr) stderr = (stderr + new TextDecoder().decode(chunk)).slice(-2_000);
    })().catch(() => undefined);
    return {
      send: message => child.send(VoiceWorkerRequestSchema.parse(message)),
      kill: async () => {
        child.kill('SIGKILL');
        await child.exited;
      },
      rss: async () => {
        if (this.platform === 'linux') {
          const text = await readFile(`/proc/${child.pid}/status`, 'utf8');
          return (
            z.coerce
              .number()
              .int()
              .nonnegative()
              .parse(/^VmRSS:\s+(\d+) kB$/mu.exec(text)?.[1]) * 1024
          );
        }
        const reading = await this.commands.execute(['ps', '-o', 'rss=', '-p', String(child.pid)]);
        if (reading.code !== 0) throw new Error('Could not read speech worker RSS.');
        return (
          z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(reading.stdout.trim() || undefined) * 1024
        );
      },
    };
  }
}
