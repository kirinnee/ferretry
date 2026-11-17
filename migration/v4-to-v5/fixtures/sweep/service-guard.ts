/**
 * Ownership before STOP (slot.ts user services). A unit named `fy<4|5>-slot<N>.service` or `…-terminals.scope` is only
 * ever stopped, reset or cleaned up once it is PROVED to belong to THIS slot and side; anything else holding the name is
 * refused BEFORE a single stop / reset-failed call. Pure decisions plus the stop sequence over injected ports, so the rule is
 * tested with a mocked systemctl (tests/unit/sweep-service-guard.test.ts) and slot.ts only wires the real ones.
 *
 * Identity of a SERVICE, in this order:
 *   1. its MainPID holds this slot's daemon.lock          -> the daemon itself, nothing stronger exists;
 *   2. otherwise its ExecStart argv names this slot's own env file (`<side dir>/fyd.env`, which the kit wrote) -- the identity
 *      that stays verifiable while the unit is `activating`, `auto-restart` (MainPID=0) or dead -- AND no OTHER process holds
 *      the lock (a different pid on this slot's lock means the unit is not what runs here);
 *   3. anything else is foreign.
 * Identity of a TERMINALS SCOPE: every process in it is the tmux server on THIS slot's socket, a pane that server lists, or
 * a descendant of one of those; an empty scope has nothing to kill. A process of any other kind makes the scope foreign, and so
 * does a control group whose cgroup.procs cannot be read.
 */

export interface UnitInfo {
  readonly loaded: boolean;
  readonly active: string;
  readonly sub: string;
  readonly mainPid: number;
  readonly cgroup: string;
  /** The argv of the unit's ExecStart (empty for a scope, which has none). */
  readonly execArgv: readonly string[];
}

export const UNIT_PROPERTIES = [
  'LoadState',
  'ActiveState',
  'SubState',
  'MainPID',
  'ControlGroup',
  'ExecStart',
] as const;

/** `systemctl show -p …` output to a UnitInfo. ExecStart looks like `{ path=… ; argv[]=a b c ; ignore_errors=no ; … }`. */
export function parseUnitShow(out: string): UnitInfo {
  const fields = new Map<string, string>();
  for (const line of out.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0 && !fields.has(line.slice(0, at))) fields.set(line.slice(0, at), line.slice(at + 1));
  }
  const exec = fields.get('ExecStart') ?? '';
  const argv = /argv\[\]=(.*?) ; ignore_errors=/u.exec(exec)?.[1];
  return {
    loaded: (fields.get('LoadState') ?? 'not-found') !== 'not-found',
    active: fields.get('ActiveState') ?? 'inactive',
    sub: fields.get('SubState') ?? 'dead',
    mainPid: Number(fields.get('MainPID') ?? '0'),
    cgroup: fields.get('ControlGroup') ?? '',
    execArgv: argv === undefined || argv === '' ? [] : argv.split(' '),
  };
}

export type Verdict = { readonly owned: true } | { readonly owned: false; readonly why: string };

/** Whose is a loaded SERVICE named for this slot? See the identity order above. `holders` = pids holding this slot's lock. */
export function judgeService(
  info: UnitInfo,
  who: { readonly name: string; readonly lock: string; readonly envFile: string },
  holders: readonly number[],
): Verdict {
  if (info.mainPid > 0 && holders.includes(info.mainPid)) return { owned: true };
  const named = info.execArgv.includes(who.envFile);
  if (!named)
    return {
      owned: false,
      why: `${who.name} is ${info.active} (${info.sub}) with MainPID ${String(info.mainPid)}, which does not hold this slot's lock ${who.lock}, and its ExecStart does not name this slot's ${who.envFile}; it belongs to something else, so it is left alone`,
    };
  if (holders.length > 0)
    return {
      owned: false,
      why: `${who.name} names this slot's ${who.envFile}, but pid ${holders.join(', ')} holds the lock ${who.lock} and the unit's MainPID is ${String(info.mainPid)}; the lock holder is not this unit, so it is left alone`,
    };
  return { owned: true };
}

/** What the guard needs from the outside; slot.ts wires the real systemctl, /proc and tmux, the tests wire fakes. */
export interface GuardPorts {
  systemctl(args: readonly string[]): Promise<{ code: number; out: string; err: string }>;
  /** Pids holding `lockFile` open. */
  holders(lockFile: string): Promise<number[]>;
  /** The last resort for a daemon that holds the lock outside any unit: SIGTERM to the lock holders only. */
  stopByLock(lockFile: string, label: string): Promise<void>;
  /** Every pid in a control group (cgroup.procs), or `undefined` when cgroup.procs cannot be read (then nothing can be proved). */
  cgroupPids(cgroup: string): Promise<number[] | undefined>;
  /** The tmux server's pid on a socket, or undefined when none runs there. */
  tmuxServerPid(socket: string): Promise<number | undefined>;
  /** The pids of every pane the tmux server on `socket` lists. */
  panePids(socket: string): Promise<number[]>;
  parentOf(pid: number): Promise<number | undefined>;
  log(line: string): void;
  /** Throws the kit's refusal (exit 99). */
  refuse(sentence: string): never;
}

export async function showUnit(ports: GuardPorts, name: string): Promise<UnitInfo | undefined> {
  let ran: { code: number; out: string; err: string };
  try {
    ran = await ports.systemctl(['show', name, ...UNIT_PROPERTIES.flatMap(property => ['-p', property])]);
  } catch {
    return undefined;
  }
  return ran.code === 0 ? parseUnitShow(ran.out) : undefined;
}

const isDead = (info: UnitInfo): boolean => info.active === 'inactive' || info.active === 'failed';

export interface ServiceIds {
  readonly name: string;
  readonly lock: string;
  readonly envFile: string;
}

/** Refuses (before anything is stopped or reset) when a LOADED unit under this slot's name is not this slot's. */
export async function assertServiceOwned(ports: GuardPorts, who: ServiceIds): Promise<UnitInfo | undefined> {
  const info = await showUnit(ports, who.name);
  if (info?.loaded !== true) return info;
  const verdict = judgeService(info, who, await ports.holders(who.lock));
  if (!verdict.owned) ports.refuse(`refusing: ${verdict.why}`);
  return info;
}

/**
 * Stops this side's daemon: through its unit when there is one (a stale failed unit is reset), then, for whatever still holds
 * the lock (a daemon an older kit started outside any unit), through stopByLock. A unit that is not this slot's is refused
 * first: no stop, no reset-failed, no lock fallback.
 */
export async function stopService(ports: GuardPorts, who: ServiceIds, label: string): Promise<void> {
  const info = await assertServiceOwned(ports, who);
  if (info?.loaded === true) {
    if (!isDead(info)) {
      const ran = await ports.systemctl(['stop', who.name]);
      ports.log(
        `  ${label}: ${ran.code === 0 ? `stopped ${who.name}` : `could not stop ${who.name} (${(ran.err + ran.out).trim().slice(0, 200)})`}`,
      );
    }
    await ports.systemctl(['reset-failed', who.name]);
  }
  if ((await ports.holders(who.lock)).length > 0 || info?.loaded !== true) await ports.stopByLock(who.lock, label);
}

export interface ScopeIds {
  readonly name: string;
  readonly socket: string;
}

/** Is every process in the scope this slot's tmux server, one of its panes, or a descendant of one? Empty = nothing to kill. */
export async function judgeScope(ports: GuardPorts, who: ScopeIds, info: UnitInfo): Promise<Verdict> {
  // A control group whose members cannot be listed cannot be proved empty OR ours: foreign, so nothing is stopped or killed.
  const procs = info.cgroup === '' ? [] : await ports.cgroupPids(info.cgroup);
  if (procs === undefined)
    return {
      owned: false,
      why: `${who.name} has a control group (${info.cgroup}) whose cgroup.procs cannot be read, so its processes cannot be shown to be this slot's; it is left alone`,
    };
  if (procs.length === 0) return { owned: true };
  const server = await ports.tmuxServerPid(who.socket);
  if (server === undefined)
    return {
      owned: false,
      why: `${who.name} has process(es) ${procs.join(', ')} but no tmux server answers on this slot's socket ${who.socket}, so they cannot be shown to be this slot's; it is left alone`,
    };
  const roots = new Set([server, ...(await ports.panePids(who.socket))]);
  const strangers: number[] = [];
  for (const pid of procs) {
    let at: number | undefined = pid;
    for (let hops = 0; at !== undefined && at > 1 && !roots.has(at) && hops < 64; hops += 1)
      at = await ports.parentOf(at);
    if (at === undefined || !roots.has(at)) strangers.push(pid);
  }
  return strangers.length === 0
    ? { owned: true }
    : {
        owned: false,
        why: `${who.name} holds process(es) ${strangers.join(', ')} that are neither this slot's tmux server (socket ${who.socket}), its panes nor their children; it belongs to something else, so it is left alone`,
      };
}

/** Refuses (before any kill or stop) when a live scope under this slot's terminals name is not this slot's. */
export async function assertScopeOwned(ports: GuardPorts, who: ScopeIds): Promise<UnitInfo | undefined> {
  const info = await showUnit(ports, who.name);
  if (info?.loaded !== true || isDead(info)) return info;
  const verdict = await judgeScope(ports, who, info);
  if (!verdict.owned) ports.refuse(`refusing: ${verdict.why}`);
  return info;
}

/**
 * Ends this side's tmux server (`kill`, by its own socket, only after the scope is proved ours) and the scope it lived in.
 * A foreign live scope is refused before the kill, the stop and the reset.
 */
export async function stopScope(ports: GuardPorts, who: ScopeIds, kill: () => Promise<void>): Promise<void> {
  const info = await assertScopeOwned(ports, who);
  await kill();
  if (info?.loaded === true) {
    if (!isDead(info)) await ports.systemctl(['stop', who.name]);
    await ports.systemctl(['reset-failed', who.name]);
  }
}
