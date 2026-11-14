import type { Manifest } from '../manifest/types.ts';
import { systemClock } from './adapters/clock.ts';
import { nodeFs } from './adapters/node-fs.ts';
import { homedir, hostname } from 'node:os';
import { platformRootPinner } from './adapters/pinned/index.ts';
import { bunSpawn, bunWebSockets, bunWorkers, globalFetch } from './adapters/process.ts';
import { scratchPort } from './scratch.ts';
import { nodeHostFacts } from './adapters/host-facts.ts';
import { nodeSelfCounters } from './adapters/self-counters.ts';
import { launchGuardFor } from './adapters/launch-guard.ts';
import { NodeGzip } from './adapters/node-gzip.ts';
import { updateHostFor } from './adapters/update-host.ts';
import { createConfigFiles } from './config/index.ts';
import type { ConfigJudge, HostAdapters, HostConfig, PluginStateHandle } from './host.ts';
import { type LogSink, scopedLog } from './log.ts';
import { nodeExecutableProbe } from './adapters/executable.ts';
import { hostProcessTable, PS_SYSTEM_DIRECTORIES } from './adapters/process-table.ts';
import { whichCommand } from './which.ts';
import {
  createNodeHostFs,
  createStatePort,
  acquireHomeLock,
  type HostFs as StateFs,
  moveStateAside,
  openPluginState,
} from './state/index.ts';
import type { PrivatePin } from './state/state-port.ts';
import type { Clock, Log, StateDamage } from '../contract/ports.ts';
import type { ConfigDef } from '../contract/define.ts';

const random = (): string => crypto.randomUUID();

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
): (manifest: Manifest, pin?: PrivatePin) => PluginStateHandle {
  return (manifest, pin) => {
    const files = manifest.data?.state ?? [];
    const listeners = new Set<(damage: readonly StateDamage[]) => void>();
    const changed = (damage: readonly StateDamage[]): void => {
      for (const listener of listeners) listener(damage);
    };
    let port = createStatePort({
      home,
      pluginId: manifest.id,
      files,
      fs,
      clock,
      ...(pin === undefined ? {} : { pin }),
    });
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
        for (const damage of opening.narrowed)
          log.warn('a state file uses its narrower refusal', {
            plugin: manifest.id,
            file: damage.file,
            reason: damage.reason,
          });
        port = createStatePort({
          home,
          pluginId: manifest.id,
          files,
          fs,
          clock,
          initialDamage: opening.damaged,
          initialNarrowed: opening.narrowed,
          ...(pin === undefined ? {} : { pin }),
          changed,
          report: ({ damage, policy }) =>
            log.warn('a state file cannot be read', {
              plugin: manifest.id,
              file: damage.file,
              reason: damage.reason,
              policy,
            }),
        });
        return opening.damaged;
      },
      onDamageChanged: listener => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      narrowed: () => port.narrowed(),
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
      secretReferences: plugin => service.secretReferences(plugin),
      credentialRecordReferences: plugin => service.credentialRecordReferences(plugin),
      writer: () => service.writer(),
      status: () => service.status(),
      reload: () => service.reload(),
      publishSchemas: () => service.publishSchemas(),
      startWatching: () => service.startWatching(),
      onStateChange: listener => service.onStateChange(listener),
    };
  };
}

/** The real adapters `fyd` boots with. The environment a spawned child sees is only what the host names. */
export function realAdapters(
  home: string,
  logSink: LogSink,
  options: {
    readonly binary: string;
    readonly childEnv?: Readonly<Record<string, string>>;
    /** The allow-listed non-secret names `git` and `gh` children get (see `toolEnvironment`). */
    readonly toolEnv?: Readonly<Record<string, string>>;
    /** The names a SEALED child (a secure copy's command capture) inherits (see `sealedEnvironment`). */
    readonly sealedEnv?: Readonly<Record<string, string>>;
    /** The release this build carries, for `kernel.updateHost`; absent, no plugin can launch an update. */
    readonly release?: string;
  },
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
    spawn: bunSpawn(options.childEnv ?? {}, undefined, options.toolEnv ?? {}, options.sealedEnv ?? {}),
    fetch: globalFetch(),
    workers: bunWorkers(),
    websocket: bunWebSockets(),
    hostname: () => hostname(),
    ownerHome: () => homedir(),
    // Today's lookup: the daemon's own PATH, read at each call (`Bun.which(name, { PATH: process.env.PATH })`).
    searchPath: () => process.env.PATH,
    // `kernel.paths.locate`: the ONE override variable a manifest declared (`FY_CLOUDFLARED`), read at each call.
    operatorVariable: name => process.env[name],
    executable: nodeExecutableProbe,
    pinner: platformRootPinner(),
    scratch: scratchPort(),
    hostFacts: nodeHostFacts({ launchGuard: launchGuardFor({ home }) }),
    selfCounters: nodeSelfCounters(),
    // Today's Codex stopper's table: `/proc` on Linux, the kernel's own `ps` (system folders, then PATH) elsewhere.
    processTable: hostProcessTable({
      platform: process.platform,
      uid: process.getuid?.() ?? -1,
      self: process.pid,
      parent: process.ppid,
      locatePs: async () =>
        await whichCommand('ps', { path: process.env.PATH, directories: PS_SYSTEM_DIRECTORIES }, nodeExecutableProbe),
    }),
    compressor: new NodeGzip(),
    ...(options.release === undefined
      ? {}
      : { updateHost: updateHostFor({ home, binary: options.binary, release: options.release }) }),
    homeLock: async lockedHome => await acquireHomeLock({ home: lockedHome, binary: options.binary }),
  };
}

/** One JSON line per record to `logs/fyd.log`. Fields are names and ids only. */
export function fileLogSink(append: (line: string) => void): LogSink {
  return record => append(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}
