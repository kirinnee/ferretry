import type { ChildHandle, SpawnOptions, SpawnPort } from '@ferretry/kernel/contract';
import { stat } from 'node:fs/promises';

/** What a fake `codex app-server` was started with. */
export interface Started {
  readonly program: string;
  readonly cwd: string | undefined;
  /** Whether the folder was a directory at the instant the child was started. */
  readonly cwdExisted: Promise<boolean>;
  readonly env: Readonly<Record<string, string>> | undefined;
  /** How many times the child was told to stop. */
  kills: number;
}

const GPT_6_SOL = {
  model: 'gpt-6-sol',
  displayName: 'GPT-6-Sol',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
  defaultReasoningEffort: 'medium',
};

/**
 * A spawn port whose child speaks just enough of the app-server handshake, noting where and how it was started.
 * `answers: false` makes a child that never answers (a hung read), so only the deadline or an abort ends it.
 */
export function catalogSpawn(started: Started[], options: { readonly answers?: boolean } = {}): SpawnPort {
  const encoder = new TextEncoder();
  const answers = options.answers ?? true;
  return {
    run: async () => {
      throw new Error('not used');
    },
    runBytes: async () => {
      throw new Error('not used');
    },
    start: (program: string, _args: readonly string[], spawnOptions?: SpawnOptions): ChildHandle => {
      const cwd = typeof spawnOptions?.cwd === 'string' ? spawnOptions.cwd : undefined;
      // Asked at the instant of the start: a child started in a folder that is not there does not start at all.
      const cwdExisted =
        cwd === undefined
          ? Promise.resolve(false)
          : stat(cwd).then(
              found => found.isDirectory(),
              () => false,
            );
      const record: Started = { program, cwd, cwdExisted, env: spawnOptions?.env as Started['env'], kills: 0 };
      started.push(record);
      let push: (line: string) => void = () => undefined;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          push = line => controller.enqueue(encoder.encode(`${line}\n`));
        },
      });
      return {
        pid: 1,
        stdout,
        stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
        write: chunk => {
          if (!answers) return;
          const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          if (text.includes('"initialize"')) push(JSON.stringify({ id: 1, result: {} }));
          if (text.includes('"model/list"')) push(JSON.stringify({ id: 2, result: { data: [GPT_6_SOL] } }));
        },
        kill: () => {
          record.kills += 1;
        },
        pipes: [],
        closePipes: () => undefined,
        exited: Promise.resolve(0),
      };
    },
  };
}
