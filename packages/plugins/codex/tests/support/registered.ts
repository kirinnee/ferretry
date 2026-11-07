import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, LaunchSpec, Runner, RunSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { err, instantFromEpochMs, ok } from '@ferretry/std';
import daemon from '../../daemon/index.ts';
import manifest from '../../manifest.ts';

export function registeredCodex() {
  const home = mkdtempSync(join(tmpdir(), 'fy-codex-r1-'));
  const oldHome = process.env.FY_HOME;
  process.env.FY_HOME = home;
  const files = new Map<string, string>();
  const reads: string[] = [];
  const state = new Map<string, unknown>();
  const rootsUsed: { name: string; subfolder?: string }[] = [];
  const commands: RunSpec[] = [];
  let permissionMode = 'auto';
  let redactionFails = false;
  let sleepAction: (() => void) | undefined;
  const at = instantFromEpochMs(0);
  const base = `${home}/state/codex/agent-homes`;
  const root = (name: string, scope?: { subfolder?: string }): RootHandle => {
    rootsUsed.push({ name, subfolder: scope?.subfolder });
    const directory =
      name === 'agent-homes'
        ? `${base}${scope?.subfolder ? `/${scope.subfolder}` : ''}`
        : (scope?.subfolder ?? '/unavailable');
    const resolve = (relative: string) => {
      if (relative.split('/').includes('..')) return err('outside' as const);
      const path = relative.startsWith('/') ? relative : relative === '' ? directory : `${directory}/${relative}`;
      return path === directory || path.startsWith(`${directory}/`) ? ok(path as FencedPath) : err('outside' as const);
    };
    return {
      name: name as RootHandle['name'],
      resolve,
      readText: async path => {
        reads.push(path);
        const text = files.get(path);
        if (text === undefined) throw new Error('missing');
        return text;
      },
      readBytes: async () => {
        throw new Error('not used');
      },
      writeText: async (path, text) => {
        files.set(path, text);
      },
      list: async path => [
        ...new Set(
          [...files.keys()]
            .filter(file => file.startsWith(`${path}/`))
            .map(file => file.slice(path.length + 1).split('/')[0] as string),
        ),
      ],
      stat: async path =>
        files.has(path)
          ? { kind: 'file', size: files.get(path)?.length ?? 0, modified: at }
          : [...files.keys()].some(file => file.startsWith(`${path}/`))
            ? { kind: 'directory', size: 0, modified: at }
            : undefined,
      remove: async path => {
        files.delete(path);
      },
    };
  };
  const kernel = {
    roots: { root },
    state: {
      read: async (_def: unknown, name: string) => ok(state.get(name)),
      write: async (_def: unknown, value: unknown, name: string) => {
        state.set(name, structuredClone(value));
      },
    },
    config: { file: () => ({ permissionMode, searchPaths: [] }) },
    spawn: {
      run: async (program: string, args: string[]) => ({
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout:
          program === 'which'
            ? '/opt/bin/codex\n'
            : program === 'printenv' && args[0] === 'HOME'
              ? '/fixture-owner\n'
              : '',
      }),
    },
    redaction: {
      read: async (fn: (scope: { text(s: string): string }) => unknown) => {
        if (redactionFails) throw new Error('redaction unavailable');
        return await fn({ text: s => s.replaceAll('fixture-sensitive', '[redacted]') });
      },
    },
    clock: {
      now: () => at,
      nowMs: () => 0,
      sleep: async (_delay: unknown, signal?: AbortSignal) => {
        if (!signal?.aborted) {
          if (sleepAction === undefined) throw new Error('unexpected poll');
          sleepAction();
        }
      },
    },
  } as unknown as KernelPorts;
  const build = () => {
    const half = daemon.build?.({ manifest, kernel } as never);
    if (half === undefined) throw new Error('missing daemon half');
    return half.hooks['harnesses:codex'] as Harness;
  };
  const runner = {
    start: async (spec: RunSpec) => {
      commands.push(spec);
      return ok({ handle: '%1', startedAt: at });
    },
    resume: async (spec: RunSpec) => {
      commands.push(spec);
      return ok({ handle: '%1', startedAt: at });
    },
  } as unknown as Runner;
  const spec = (ferret = 'f1'): LaunchSpec =>
    ({
      ferret,
      home: `${base}/${ferret}`,
      folder: '/work/project',
      harness: 'codex',
      name: ferret,
      role: 'worker',
      instructions: [],
      parts: [],
    }) as unknown as LaunchSpec;
  return {
    build,
    files,
    reads,
    rootsUsed,
    commands,
    runner,
    spec,
    at,
    base,
    onSleep: (fn: () => void) => {
      sleepAction = fn;
    },
    mode: (mode: string) => {
      permissionMode = mode;
    },
    failRedaction: () => {
      redactionFails = true;
    },
    cleanup: () => {
      if (oldHome === undefined) delete process.env.FY_HOME;
      else process.env.FY_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
