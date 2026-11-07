import type { ConfigPort, StatePort } from '../contract/ports.ts';
import type { Manifest } from '../manifest/types.ts';
import { systemClock } from './adapters/clock.ts';
import { nodeFs } from './adapters/node-fs.ts';
import { bunSpawn, bunWorkers, globalFetch } from './adapters/process.ts';
import type { HostAdapters, PluginStateHandle } from './host.ts';
import type { LogSink } from './log.ts';

/**
 * Until the store and config modules are wired (`host/state`, `host/config`), a plugin's state and config ports
 * refuse every call rather than answering as empty (§9.3 "damaged is not empty"). Skeleton halves never call them.
 */
const unwired = (what: string): never => {
  throw new Error(`the kernel ${what} is not wired yet`);
};

function unwiredState(): PluginStateHandle {
  const port = new Proxy({}, { get: () => () => unwired('store') }) as StatePort;
  return { port, open: async () => [], close: async () => undefined };
}

const unwiredConfig = (): ConfigPort => ({
  file: () => unwired('config'),
  collection: () => unwired('config'),
  watch: () => unwired('config'),
});

const random = (): string => crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36) ?? '0';

/** The real adapters `fyd` boots with. The environment a spawned child sees is only what the host names. */
export function realAdapters(
  logSink: LogSink,
  overrides: {
    readonly state?: (manifest: Manifest) => PluginStateHandle;
    readonly config?: (manifest: Manifest) => ConfigPort;
    readonly childEnv?: Readonly<Record<string, string>>;
  } = {},
): HostAdapters {
  return {
    clock: systemClock(),
    logSink,
    fs: nodeFs(random),
    random,
    state: overrides.state ?? unwiredState,
    config: overrides.config ?? unwiredConfig,
    spawn: bunSpawn(overrides.childEnv ?? {}),
    fetch: globalFetch(),
    workers: bunWorkers(),
  };
}

/** One JSON line per record to `logs/fyd.log` (and stderr when asked). Fields are names and ids only. */
export function fileLogSink(append: (line: string) => void): LogSink {
  return record => append(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}
