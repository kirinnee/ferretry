/**
 * PEER: today's `packages/fleet/src/lib/{manifest,defaults,state-home-guard}.ts`,
 * `packages/fleet/src/lib/account/{pane-contract,materialise,fixed-layer}.ts` (`@ferretry/fleet`, owner: runtimes) and
 * `packages/daemon/src/lib/fleet/{launch-environment,launch-renewal,codex-runtime}.ts` (owners: logins+runtimes,
 * runtimes).
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */

import type { SessionLaunchInstructions } from '../../protocol/session.ts';

// --- packages/fleet/src/lib/manifest.ts -------------------------------------------------------------------------

/** The agent harness an account drives. */
export type HarnessKind = 'claude' | 'codex';

// --- packages/fleet/src/lib/defaults.ts -------------------------------------------------------------------------

/**
 * How each harness is named to a person, everywhere. EXPORTED because several surfaces put it in front of somebody.
 * Private copies of one label is how "Claude" and "Claude Code" end up on one screen describing the same thing.
 */
export const HARNESS_LABEL: Readonly<Record<HarnessKind, string>> = { claude: 'Claude', codex: 'Codex' };

// --- packages/fleet/src/lib/account/pane-contract.ts ------------------------------------------------------------

/** The launch variable naming a ferret's mode (`interactive` or `auto`). */
export const SESSION_MODE_ENV = 'FY_SESSION_MODE';
/** Whether this ferret was given the hypermedia section. */
export const HYPERMEDIA_ENV = 'FY_HYPERMEDIA';

// --- packages/fleet/src/lib/account/materialise.ts --------------------------------------------------------------

// --- packages/fleet/src/lib/account/fixed-layer.ts --------------------------------------------------------------

/**
 * The launch variable naming the file a ferret's question hook writes, set by the daemon per session
 * (its own state folder). Unset — a person's own terminal — the hook writes nothing.
 */
export const QUESTION_ASKED_FILE_ENV = 'FY_QUESTION_FILE';

/** One section every agent runtime is told, whatever its switches: its id and its exact text. */
export interface AlwaysOnSection {
  readonly id: 'tools' | 'settings' | 'notify' | 'board' | 'sub-ferret';
  readonly text: string;
}

/**
 * A short fingerprint of a section's text (cyrb53, 14 hex digits): enough to tell that the words changed,
 * never enough to carry them. Pure, so the wrapper's description and the daemon's comparison agree.
 */
export function instructionDigest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * INJECTED: today's `launchInstructions(fy, env)` — what an agent launched with `env` is told, by section name and
 * size, never the text. It reads every instruction text the wrapper renders, so it stays the runtimes plugin's and
 * the launchers take it as a dependency.
 */
export type LaunchInstructionsPort = (fy: string, env: Readonly<Record<string, string>>) => SessionLaunchInstructions;

// --- packages/fleet/src/lib/state-home-guard.ts -----------------------------------------------------------------

declare const stateHomesBrand: unique symbol;

// --- packages/daemon/src/lib/fleet/launch-environment.ts --------------------------------------------------------

/**
 * The extra environment one account's launch is entitled to, keyed by the executable it runs.
 *
 * A PORT, so the two launch paths depend on the decision rather than on the store. `wrapper` is the
 * absolute published path a session record carries; the name is derived from it the one sanctioned
 * way, so an account is never located by a string somebody assembled.
 */
export interface AccountLaunchEnvironment {
  /**
   * Empty when this executable is not a published account, binds no secret, and — given the folder the
   * pane starts in — that folder's project has signed in to none of its own MCP servers.
   */
  forWrapper(wrapper: string, cwd?: string): Promise<Readonly<Record<string, string>>>;
}

/**
 * THE SESSION WINS. Its own document carries the credential a task board issued it and any variable a
 * grant delivered, and those name that one session; a profile is shared by every account that lists
 * it. A profile able to overwrite them would let one shared document take a teammate's board
 * capability away from it — so the precedence runs the only direction that cannot do that, and the
 * session id the launcher derives afterwards is still written last.
 *
 * NEITHER MAY SET `HOME`. A runtime keeps the person's real home on macOS and Linux alike: that is
 * where their own Claude and Codex logins are found, and where Claude finds the macOS keychain
 * (docs/design/account-model.md §8.1.1). The config directory the wrapper exports is what keeps a
 * runtime separate, and the wrapper never sets `HOME` — so a value handed to the pane here would be
 * the only one, and it would sign the runtime out. The pane inherits the daemon's own instead.
 */
export function launchEnvironment(
  account: Readonly<Record<string, string>>,
  session: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const { HOME: _accountHome, ...fromAccount } = account;
  const { HOME: _sessionHome, ...fromSession } = session;
  return { ...fromAccount, ...fromSession };
}

// --- packages/daemon/src/lib/fleet/launch-renewal.ts ------------------------------------------------------------

/**
 * A PORT, so both launch paths depend on the decision rather than on the fleet. It takes the absolute
 * published wrapper a session record already carries — the same value {@link AccountLaunchEnvironment}
 * takes — because an account is never located by a string somebody assembled.
 *
 * It answers nothing. A launcher cannot branch on this, which is the point: there is no outcome here that
 * a launch is allowed to act on.
 */
export interface AccountLaunchRenewal {
  beforeLaunch(wrapper: string): Promise<void>;
}

// --- packages/daemon/src/lib/fleet/codex-runtime.ts -------------------------------------------------------------
