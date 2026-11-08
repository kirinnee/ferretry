import { connect } from 'node:net';
import { DAEMON_RUN_FILE, DaemonRunSchema } from '../contract/run.ts';
import { decideHome } from '../contract/home.ts';
import type { HostFs } from './adapters/node-fs.ts';
import { probeHome } from './home.ts';

/** The exit codes `--help` documents: the address is held by something else / by another of this daemon. */
export const EXIT_FOREIGN_HOLDER = 69;
export const EXIT_ALREADY_SERVING = 78;

/** Whether anything accepts a connection at the address. A connection attempt is not a change to this machine. */
export type AddressProbe = (host: string, port: number) => Promise<'free' | 'held'>;

export interface CheckOptions {
  readonly fs: HostFs;
  readonly home: string;
  readonly host: string;
  readonly port: number;
  readonly daemonName: string;
  readonly probe: AddressProbe;
  /** Whether a process exists; `process.kill(pid, 0)` in the real world. */
  readonly alive: (pid: number) => boolean;
  readonly say: (line: string) => void;
}

export const tcpProbe: AddressProbe = (host, port) =>
  new Promise(resolve => {
    const socket = connect({ host, port, timeout: 1500 });
    socket.once('connect', () => (socket.destroy(), resolve('held')));
    socket.once('timeout', () => (socket.destroy(), resolve('held')));
    socket.once('error', error => resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'free' : 'held'));
  });

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * `--check` (R689): whether this daemon would start, saying what it found. It READS the state home and PROBES the
 * address — it creates, locks and binds nothing, so the home is untouched and the port stays free. Returns the exit
 * code: 0 would start, 69 a foreign holder, 78 another daemon / a refused home.
 */
export async function checkHost(options: CheckOptions): Promise<number> {
  const { fs, home, say } = options;
  say(`state home   ${home}`);
  const decision = decideHome(home, await probeHome(fs, home));
  let exit = 0;
  if (decision.kind === 'refuse') {
    say(`! ${decision.sentence}`);
    exit = EXIT_ALREADY_SERVING;
  } else {
    say(
      decision.kind === 'create'
        ? '             (not set up yet — this daemon would create it)'
        : '             (a Ferretry home — this daemon would use it)',
    );
  }
  const owner = decision.kind === 'start' ? await recordedOwner(fs, home, options.alive) : undefined;
  if (options.port === 0) {
    say('address      the operating system will assign the port when this daemon starts, and it is then recorded');
    return exit;
  }
  const where = `${options.host}:${options.port}`;
  if ((await options.probe(options.host, options.port)) === 'free') {
    say(`address      ${where}  (free — this daemon would bind it)`);
    return exit;
  }
  if (owner !== undefined && owner.port === options.port) {
    say(`address      ${where}  (taken — another ${options.daemonName}, pid ${owner.pid})`);
    return Math.max(exit, EXIT_ALREADY_SERVING);
  }
  say(`address      ${where}  (taken — by something that is not a ${options.daemonName})`);
  say(`! Something that is not a ${options.daemonName} holds ${where}. Stop it, or choose another port with --port.`);
  return Math.max(exit, EXIT_FOREIGN_HOLDER);
}

async function recordedOwner(
  fs: HostFs,
  home: string,
  alive: (pid: number) => boolean,
): Promise<{ readonly pid: number; readonly port: number } | undefined> {
  try {
    const parsed = DaemonRunSchema.safeParse(JSON.parse(await fs.readText(`${home}/${DAEMON_RUN_FILE}`)));
    return parsed.success && alive(parsed.data.pid) ? { pid: parsed.data.pid, port: parsed.data.port } : undefined;
  } catch {
    return undefined;
  }
}
