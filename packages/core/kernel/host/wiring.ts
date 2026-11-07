import type { Manifest } from '../manifest/types.ts';
import { systemClock } from './adapters/clock.ts';
import { nodeFs } from './adapters/node-fs.ts';
import { hostname } from 'node:os';
import { bunSpawn, bunWebSockets, bunWorkers, globalFetch } from './adapters/process.ts';
import { createConfigFiles } from './config/index.ts';
import type { ConfigJudge, HostAdapters, HostConfig, PluginStateHandle } from './host.ts';
import { type LogSink, scopedLog } from './log.ts';
import {
  createNodeHostFs,
  createStatePort,
  type HostFs as StateFs,
  moveStateAside,
  openPluginState,
} from './state/index.ts';
import type { Clock, Log } from '../contract/ports.ts';
import type { ConfigDef } from '../contract/define.ts';

const random = (): string => crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36) ?? '0';

/** A plugin whose state may describe live terminals, pages or ferrets: a lower format waits, never resets (§9.3). */
const mayHaveLiveTargets = (manifest: Manifest): boolean =>
  manifest.kinds.includes('runner') || manifest.kinds.includes('tool');

/**
 * §7.6 step 3 for one plugin: check every declared file's format; when the ONLY problems are lower formats in a
 * plugin with no live targets, move `state/<id>` aside (fenced, `0700`) and start empty; otherwise the plugin is
 * damaged and answers `store_damaged` naming each file.
 */
export function stateOpener(
  home: string,
  fs: StateFs,
  clock: Clock,
  log: Log,
): (manifest: Manifest) => PluginStateHandle {
  return manifest => {
    const files = manifest.data?.state ?? [];
    let port = createStatePort({ home, pluginId: manifest.id, files, fs, clock });
    return {
      get port() {
        return port;
      },
      open: async () => {
        const kind = manifest.core ? 'core' : 'plugin';
        let opening = await openPluginState({
          home,
          pluginId: manifest.id,
          files,
          fs,
          clock,
          kind,
          liveTargets: mayHaveLiveTargets(manifest),
        });
        if (opening.moveAside !== undefined) {
          await moveStateAside(fs, opening.moveAside);
          log.warn('a plugin folder in an older format was moved aside', { plugin: manifest.id });
          opening = await openPluginState({ home, pluginId: manifest.id, files, fs, clock, kind, liveTargets: true });
        }
        port = createStatePort({ home, pluginId: manifest.id, files, fs, clock, initialDamage: opening.damaged });
        return opening.damaged;
      },
      close: async () => undefined,
    };
  };
}

export function configService(home: string, fs: StateFs, clock: Clock, log: Log, binary: string) {
  return (
    declarations: readonly { readonly plugin: string; readonly def: ConfigDef }[],
    judge?: ConfigJudge,
  ): HostConfig => {
    const service = createConfigFiles({
      home,
      defs: declarations,
      fs,
      clock,
      log,
      binary,
      ...(judge === undefined ? {} : { judge }),
    });
    return {
      port: plugin => service.port(plugin),
      writer: () => service.writer(),
      reload: () => service.reload(),
      startWatching: () => service.startWatching(),
    };
  };
}

/** The real adapters `fyd` boots with. The environment a spawned child sees is only what the host names. */
export function realAdapters(
  home: string,
  logSink: LogSink,
  options: { readonly binary: string; readonly childEnv?: Readonly<Record<string, string>> },
): HostAdapters {
  const clock = systemClock();
  const log = scopedLog(logSink, 'kernel');
  const stateFs = createNodeHostFs();
  return {
    clock,
    logSink,
    fs: nodeFs(random),
    random,
    state: stateOpener(home, stateFs, clock, log.child('state')),
    config: configService(home, stateFs, clock, log.child('config'), options.binary),
    spawn: bunSpawn(options.childEnv ?? {}),
    fetch: globalFetch(),
    workers: bunWorkers(),
    websocket: bunWebSockets(),
    hostname: () => hostname(),
  };
}

/** One JSON line per record to `logs/fyd.log`. Fields are names and ids only. */
export function fileLogSink(append: (line: string) => void): LogSink {
  return record => append(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}
