import { MemoryStateFolder, fixedClock, type DrivenClock } from '@ferretry/kernel/testing';
import type {
  Cancel,
  ConfigCollectionDef,
  ConfigFileDef,
  ConfigPort,
  KernelPorts,
  StateFileDef,
  StatePort,
} from '@ferretry/kernel/contract';
import { WARDEN_JEV_CHECKS, WARDEN_REMEMBERED, WARDEN_REPORTS, WARDEN_STATE } from '../../contract/index.ts';

const WARDEN_STATE_FILES: readonly StateFileDef[] = [
  WARDEN_STATE,
  WARDEN_REPORTS,
  WARDEN_JEV_CHECKS,
  WARDEN_REMEMBERED,
];

/**
 * A state port for the warden's files: json files through the kernel's in-memory folder (its format and damage rules),
 * and the opaque `reports/*` files in a map, because the in-memory folder does not model opaque bytes.
 */
export function wardenState(folder = new MemoryStateFolder()): StatePort & { readonly folder: MemoryStateFolder } {
  const json = folder.port(WARDEN_STATE_FILES);
  const opaque = new Map<string, Uint8Array>();
  const key = (file: StateFileDef, name?: string): string => file.path.replace('*', name ?? '');
  const isOpaque = (file: StateFileDef): boolean => file.store === 'opaque';
  return {
    folder,
    ...json,
    read: (async (file: StateFileDef, name?: string) => {
      if (!isOpaque(file)) return await json.read(file, name);
      const bytes = opaque.get(key(file, name));
      return { ok: true, value: bytes };
    }) as StatePort['read'],
    write: (async (file: StateFileDef, value: unknown, name?: string) => {
      if (!isOpaque(file)) return await json.write(file, value, name);
      opaque.set(key(file, name), typeof value === 'string' ? new TextEncoder().encode(value) : (value as Uint8Array));
    }) as StatePort['write'],
    list: async (file: StateFileDef) => {
      if (!isOpaque(file)) return await json.list(file);
      const prefix = file.path.replace('*', '');
      return [...opaque.keys()]
        .filter(path => path.startsWith(prefix))
        .map(path => path.slice(prefix.length))
        .sort();
    },
    remove: async (file: StateFileDef, name?: string) => {
      if (!isOpaque(file)) return await json.remove(file, name);
      opaque.delete(key(file, name));
    },
  };
}

/**
 * A config port holding one `warden.yaml` document the test sets, in effect and never held; it cannot write unless
 * the test adds `write` and `remove` itself.
 */
export function wardenConfig(initial: unknown = undefined): ConfigPort & { set(value: unknown): void } {
  let current = initial;
  const listeners = new Set<() => void>();
  const port: Omit<ConfigPort, 'write' | 'writeAsOwner' | 'remove'> & { set(value: unknown): void } = {
    file: (_def: ConfigFileDef<unknown>) => current as never,
    collection: (_def: ConfigCollectionDef<unknown>) => new Map() as never,
    fileState: () =>
      current === undefined
        ? { state: 'absent', inEffect: false, sentences: [] }
        : { state: 'valid', inEffect: true, sentences: [] },
    watch: (_def, listener): Cancel => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: value => {
      current = value;
      for (const listener of listeners) listener();
    },
  };
  // Reads only: a test that needs the kernel config write adds `write`, `writeAsOwner` and `remove` itself.
  return port as ConfigPort & { set(value: unknown): void };
}

export interface FakeKernel {
  readonly kernel: KernelPorts;
  readonly clock: DrivenClock;
  readonly published: { readonly event: string; readonly payload: unknown }[];
  readonly logged: string[];
}

/** The parts of the kernel the warden touches; the rest throw when used, so a stray dependency is loud. */
export function fakeKernel(options: { readonly config?: ConfigPort; readonly start?: string } = {}): FakeKernel {
  const clock = fixedClock(options.start ?? '2026-11-06T09:00:00.000Z');
  const published: { event: string; payload: unknown }[] = [];
  const logged: string[] = [];
  const log = {
    debug: () => undefined,
    info: (message: string) => void logged.push(message),
    warn: (message: string) => void logged.push(message),
    error: (message: string) => void logged.push(message),
    child: () => log,
  };
  const kernel = {
    clock,
    log,
    state: wardenState(),
    config: options.config ?? wardenConfig(),
    events: {
      publish: (event: { name: string }, payload: unknown) => void published.push({ event: event.name, payload }),
    },
    redaction: { read: async (fn: (scope: { text(s: string): string }) => unknown) => await fn({ text: s => s }) },
    jobs: { add: () => undefined, kick: () => undefined },
    lifecycle: { onStop: () => undefined, stopping: () => false, signal: new AbortController().signal },
  } as unknown as KernelPorts;
  return { kernel, clock, published, logged };
}
