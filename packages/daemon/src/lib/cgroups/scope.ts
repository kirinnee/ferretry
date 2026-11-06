/**
 * The names and the argv: which slice managed agents live under, what one agent's transient scope is
 * called, how a running one is RECOGNISED, and the exact commands that put the limits on both.
 *
 * THE LAYOUT.
 *
 * ```text
 * user@UID.service
 * ├── app.slice/…                       this daemon, never capped here (weight 100)
 * ├── …/…-spawn-*.scope                 the multiplexer's own control processes
 * └── <product>_fleet.slice             the aggregate ceiling (weight 50)
 *     ├── <product>_fleet-<escaped-id>.slice   one ferret's combined allowance
 *     │   ├── <product>-agent-<id>-<n>.scope   harness
 *     │   └── <product>-agent-<id>-t<n>.scope terminals
 *     └── <product>_fleet-browser.slice       shared Chrome + worker allowance
 * ```
 *
 * THE SLICE NAME HAS NO DASH ON PURPOSE. systemd reads a dash in a slice name as hierarchy
 * (`systemd.slice(5)`): `foo-bar.slice` lives inside `foo.slice`. A `<product>-fleet.slice` would have sat
 * under a `<product>.slice` that is itself a sibling of `app.slice`, and as that parent's only busy child it
 * would have taken the parent's whole weight — the fleet would have competed with the daemon's slice at
 * parity instead of at half. `<product>_fleet.slice` is a direct child of the user manager's root, so its
 * `CPUWeight=50` is weighed against `app.slice`'s 100 and the voice slice's 200 as written. Its cgroup path
 * is still derived through {@link sliceCgroupPath}, which is right for any name.
 *
 * A SCOPE NAME CARRIES A NONCE, so a relaunch cannot collide with a previous transient scope that is
 * still deactivating. `--collect` removes a scope once its agent exits. Nothing ever RECONSTRUCTS a
 * scope name to find a running agent — the nonce makes that impossible on purpose, and
 * {@link agentScopeInPlacement} reads the real one out of the pid's own placement instead.
 *
 * BOTH NAMES DERIVE FROM THE PRODUCT SCOPE rather than being written out. `scripts/local/rename.sh
 * --product` rewrites package scopes and manifests but not a literal inside a `.ts` file, so a
 * renamed product would otherwise keep writing units named after the old one — and the slice a
 * launch puts an agent under would stop being the slice the settings surface configures.
 *
 * Pure: no IO, no clock, no globals.
 */

import { productName } from '../version.ts';

/** The aggregate every managed agent shares. */
export const FLEET_SLICE = `${productName.replaceAll('-', '_')}_fleet.slice`;

/** The speech worker's slice, a sibling of the fleet's (docs/design/voice-modes.md §2.5). */
export const VOICE_SLICE = `${productName.replaceAll('-', '_')}_voice.slice`;

/** A shared allowance for the agent Chrome and its worker, below the fleet ceiling. */
export const BROWSER_SLICE = `${FLEET_SLICE.slice(0, -6)}-browser.slice`;

/** systemd unit-name escaping: notably a literal dash must not introduce another slice ancestor. */
export function escapeUnitPart(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte, index) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9_:]/u.test(char) || (char === '.' && index > 0)
        ? char
        : `\\x${byte.toString(16).padStart(2, '0')}`;
    })
    .join('');
}

/** The harness and all terminals opened by this credential share ONE allowance here. */
export function ferretSliceName(sessionId: string, fleet: string = FLEET_SLICE): string {
  return `${fleet.slice(0, -6)}-${escapeUnitPart(sessionId)}.slice`;
}

/** Session attribution from a per-ferret slice, reversing its escaped UTF-8 bytes. */
export function sessionOfSlice(slice: string): string | undefined {
  const prefix = `${FLEET_SLICE.slice(0, -6)}-`;
  if (!slice.startsWith(prefix) || !slice.endsWith('.slice') || slice === BROWSER_SLICE) return undefined;
  const encoded = slice.slice(prefix.length, -6);
  if (encoded === '' || !/^(?:[A-Za-z0-9_:.]|\\x[0-9a-f]{2})+$/u.test(encoded)) return undefined;
  const bytes = encoded.match(/\\x[0-9a-f]{2}|./gu) as string[];
  return new TextDecoder().decode(
    Uint8Array.from(bytes, part => (part.startsWith('\\x') ? Number.parseInt(part.slice(2), 16) : part.charCodeAt(0))),
  );
}

/**
 * The cgroup directories a slice lives in, outermost first, relative to the user manager: systemd nests
 * `a-b-c.slice` as `a.slice/a-b.slice/a-b-c.slice`, so reading `<manager>/a-b-c.slice` finds nothing. A name
 * with no dash (the fleet's) is its own single component.
 */
export function sliceCgroupPath(slice: string): readonly string[] {
  const stem = slice.endsWith('.slice') ? slice.slice(0, -'.slice'.length) : slice;
  const parts = stem.split('-').filter(part => part !== '');
  return parts.map((_, index) => `${parts.slice(0, index + 1).join('-')}.slice`);
}

/** What every managed agent scope is called before its session and nonce. */
export const AGENT_SCOPE_PREFIX = `${productName}-agent-`;

/** A unit name may hold only these characters, so anything else becomes a dash and a value that
 *  reduces to nothing keeps a readable stand-in rather than producing `--<nonce>.scope`. */
export function safeUnitPart(value: string): string {
  const safe = value.replaceAll(/[^A-Za-z0-9_-]/gu, '-').replaceAll(/^-+|-+$/gu, '');
  return (safe || 'session').slice(0, 96);
}

/** The transient scope one launch asks for. */
export function agentScopeName(sessionId: string, nonce: string): string {
  return `${AGENT_SCOPE_PREFIX}${safeUnitPart(sessionId)}-${safeUnitPart(nonce)}.scope`;
}

/** Browser scopes are deliberately outside agent-session attribution. */
export function browserScopeName(nonce: string): string {
  return `${productName}-browser-${safeUnitPart(nonce)}.scope`;
}

/**
 * The managed agent scope a pid is actually in, read out of its own placement.
 *
 * The placement is the verbatim `/proc/<pid>/cgroup` text: one line per hierarchy, each
 * `<id>:<controllers>:<path>`. Only the path is searched, so a controller list that happened to
 * contain the prefix could never be mistaken for a placement.
 */
export function agentScopeInPlacement(placement: string): string | undefined {
  const pattern = new RegExp(`(?:^|/)(${AGENT_SCOPE_PREFIX}[^/]+\\.scope)(?:/|$)`, 'u');
  for (const line of placement.split('\n')) {
    const separator = line.indexOf('/');
    if (separator < 0) continue;
    const match = pattern.exec(line.slice(separator));
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** Whether a pid's placement puts it anywhere beneath `slice`. This is how the daemon's own
 *  exclusion — and a supervision session's — is PROVED rather than asserted. */
export function placedUnderSlice(placement: string, slice: string): boolean {
  return placement.split('\n').some(line => {
    const separator = line.indexOf('/');
    return separator >= 0 && `${line.slice(separator)}/`.includes(`/${slice}/`);
  });
}

/** Puts the aggregate limits on the fleet slice. `--runtime` so a cap never outlives the manager that
 *  was told about it: the durable answer is `limits.yaml`, and a unit file left behind on disk would be
 *  a second one. Idempotent, so every launch may repeat it. */
export function slicePropertyCommand(slice: string, properties: readonly string[]): readonly string[] {
  return ['systemctl', '--user', 'set-property', '--runtime', slice, ...properties];
}

/** What the user manager must answer for a scope launch to work at all. */
export const USER_MANAGER_PROBE: readonly string[] = ['systemctl', '--user', 'show-environment'];

/**
 * The best-effort, lowest-priority disk class: `-c2 -n7`. Not the idle class (`-c3`), which a busy
 * disk under BFQ can starve completely — a ferret that never gets to read would look hung.
 */
export const IONICE_PREFIX: readonly string[] = ['ionice', '-c2', '-n7', '--'];

/** A launch the wrapper can be proven to work with, before any real ferret is wrapped in it. */
export const IONICE_PROBE: readonly string[] = ['ionice', '-c2', '-n7', '--', 'true'];

/**
 * macOS: `taskpolicy -c utility` clamps the QoS (taskpolicy(8): "utility", "background" or
 * "maintenance"), so the ferret keeps every core but yields to the owner's own work; `nice -n 10` lowers
 * the BSD priority beneath it. NOT `-b`: that is `PRIO_DARWIN_BG`, which throttles far below real time
 * (docs/design/voice-modes.md §2.5). No `-d` disk policy: the man page documents only `default` and
 * `throttle` as symbolic values, and an undocumented one would be a guess.
 */
export const MACOS_PREFIX: readonly string[] = ['taskpolicy', '-c', 'utility', 'nice', '-n', '10'];
export const MACOS_PROBE: readonly string[] = [...MACOS_PREFIX, 'true'];
/** What stays when `taskpolicy` is not there or refuses the clamp. */
export const MACOS_NICE_PREFIX: readonly string[] = ['nice', '-n', '10'];
export const MACOS_NICE_PROBE: readonly string[] = [...MACOS_NICE_PREFIX, 'true'];

/**
 * The exact argv a managed pane execs: the harness (with its priority prefix, if any), inside a
 * transient scope, inside the fleet slice.
 *
 * `--scope` rather than a service, because the agent must keep the pane's terminal; `--collect` so a
 * finished agent leaves no unit behind; `--quiet` because the manager's own banner would otherwise be
 * the first thing in the operator's terminal.
 */
export function agentScopeCommand(input: {
  readonly scope: string;
  readonly slice: string;
  readonly properties: readonly string[];
  readonly command: readonly string[];
}): readonly string[] {
  return [
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    `--unit=${input.scope}`,
    `--slice=${input.slice}`,
    ...input.properties.map(property => `--property=${property}`),
    '--',
    ...input.command,
  ];
}

/** The session id a scope name carries, or `undefined` for a name this product did not give. */
export function sessionOfScope(scope: string): string | undefined {
  const match = new RegExp(`^${AGENT_SCOPE_PREFIX}(.+)-[A-Za-z0-9_]+\\.scope$`, 'u').exec(scope);
  return match?.[1];
}

/**
 * The throwaway scope a launch is first proven with. Not an agent scope (no {@link AGENT_SCOPE_PREFIX}), so the
 * watcher and the placement readers never mistake the few milliseconds it lives for a ferret.
 */
export function probeScopeName(nonce: string): string {
  return `${productName}-probe-${safeUnitPart(nonce)}.scope`;
}
