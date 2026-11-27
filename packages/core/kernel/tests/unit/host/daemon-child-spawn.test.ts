import { describe, expect, spyOn, test } from 'bun:test';
import type { ChildHandle, SpawnOptions, SpawnPort } from '../../../contract/ports.ts';
import { bunSpawn } from '../../../host/adapters/process.ts';
import { allowDetachedSpawn, restrictSpawn } from '../../../host/permissions.ts';
import { programName } from '../../../manifest/reach.ts';

const methods = ['run', 'runBytes', 'start', 'detached'] as const;
const command = ['--plugin-child', 'speech-host', 'speech'];

function granted(base: SpawnPort): SpawnPort {
  return allowDetachedSpawn(
    'voice',
    [programName(process.execPath)],
    ['$daemon'],
    restrictSpawn('voice', ['$daemon'], base),
    base,
  );
}

async function invoke(port: SpawnPort, method: (typeof methods)[number], args: string[], options: SpawnOptions) {
  if (method === 'detached') return port.start(process.execPath, args, { ...options, detached: true });
  return await port[method](process.execPath, args, options);
}

describe('$daemon children have only the kernel environment', () => {
  for (const method of methods) {
    test(`${method}: loader, runtime and arbitrary caller variables never reach spawn`, async () => {
      const seen: Record<string, string>[] = [];
      const spawn = spyOn(Bun, 'spawn').mockImplementation(((
        argv: string[],
        options: { env: Record<string, string> },
      ) => {
        expect(argv).toEqual([process.execPath, ...command]);
        seen.push(options.env);
        return {
          pid: 123,
          stdout: new ReadableStream({ start: controller => controller.close() }),
          stderr: new ReadableStream({ start: controller => controller.close() }),
          stdin: { write: () => undefined, end: () => undefined },
          exited: Promise.resolve(0),
          signalCode: null,
          unref: () => undefined,
        };
      }) as never);
      try {
        const port = granted(bunSpawn({ PATH: '/kernel/bin', HOME: '/kernel/home', LD_PRELOAD: '/bad-base.so' }));
        for (const mode of [{}, { sealed: true as const }, { inheritEnv: false as const }]) {
          await invoke(port, method, [...command], {
            ...mode,
            env: {
              LD_PRELOAD: '/synthetic/injected.so',
              LD_LIBRARY_PATH: '/synthetic/libs',
              BUN_OPTIONS: '--preload=/synthetic/injected.ts',
              NODE_OPTIONS: '--require=/synthetic/injected.js',
              CALLER_VARIABLE: 'synthetic',
              PATH: '/caller/bin',
              HOME: '/caller/home',
            },
          });
        }
        expect(seen).toEqual(Array.from({ length: 3 }, () => ({ PATH: '/kernel/bin', HOME: '/kernel/home' })));
      } finally {
        spawn.mockRestore();
      }
    });
  }
});

describe('$daemon authorization and execution share one frozen argv snapshot', () => {
  for (const method of methods) {
    test(`${method}: a caller mutation after authorization cannot change what runs`, async () => {
      const args = [...command];
      const seen: (readonly string[])[] = [];
      const record = (forwarded: readonly string[]) => {
        seen.push(forwarded);
        return { pid: 123 } as ChildHandle;
      };
      const base: SpawnPort = {
        start: (_program, forwarded) => record(forwarded),
        run: async (_program, forwarded) => {
          record(forwarded);
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        },
        runBytes: async (_program, forwarded) => {
          record(forwarded);
          return {
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
          };
        },
      };
      const options: SpawnOptions = {
        ...(method === 'detached' ? { detached: true as const } : {}),
        get cwd() {
          args.splice(0, args.length, '-e', 'synthetic caller code');
          return undefined;
        },
      };
      // Keep the getter intact: the permission check reads cwd AFTER authorizing the first argument.
      const port = granted(base);
      if (method === 'detached') port.start(process.execPath, args, options);
      else await port[method](process.execPath, args, options);
      args.push('later mutation');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(command);
      expect(seen[0]).not.toBe(args);
      expect(Object.isFrozen(seen[0])).toBe(true);
    });
  }
});
