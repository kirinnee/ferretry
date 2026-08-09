/**
 * The names and the argv: which slice managed agents live under, what one agent's transient scope is
 * called, how a running one is RECOGNISED, and the exact commands that put the limits on both.
 *
 * THE LAYOUT.
 *
 * ```text
 * user@UID.service
 * ├── app.slice/…                       this daemon, never capped here
 * ├── …/…-spawn-*.scope                 the multiplexer's own control processes
 * └── <product>-fleet.slice             the aggregate ceiling
 *     ├── <product>-agent-<id>-<n>.scope   one agent's ceiling
 *     └── …
 * ```
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
import type { CgroupUnitLimits } from './limits.ts';

/** The aggregate every managed agent shares. */
export const FLEET_SLICE = `${productName}-fleet.slice`;

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

/** Puts the aggregate limits on the fleet slice. `--runtime` so a cap never outlives the manager
 *  that was told about it: the durable answer is this daemon's own document, and a unit file left
 *  behind on disk would be a second one. */
export function slicePropertyCommand(slice: string, limits: CgroupUnitLimits): readonly string[] {
  return [
    'systemctl',
    '--user',
    'set-property',
    '--runtime',
    slice,
    `CPUQuota=${limits.cpuQuota}`,
    `MemoryMax=${limits.memoryMax}`,
  ];
}

/**
 * The exact argv a managed pane execs: the harness, inside a transient scope, inside the fleet
 * slice.
 *
 * `--scope` rather than a service, because the agent must keep the pane's terminal; `--collect` so a
 * finished agent leaves no unit behind; `--quiet` because the manager's own banner would otherwise
 * be the first thing in the operator's terminal.
 */
export function agentScopeCommand(input: {
  readonly scope: string;
  readonly slice: string;
  readonly limits: CgroupUnitLimits;
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
    `--property=CPUQuota=${input.limits.cpuQuota}`,
    `--property=MemoryMax=${input.limits.memoryMax}`,
    '--',
    ...input.command,
  ];
}
