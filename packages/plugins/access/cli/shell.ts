/**
 * STAND-INS for what Access's CLI half needs and nothing in 5.0 provides yet (port brief: "if it has no home yet, keep
 * the import pointing at a single local file `<your half>/shell.ts`"). Every item names where it came from and what
 * should replace it. Nothing here is a design: each is a short copy of today's code or the thinnest typed bridge to
 * the 5.0 shell.
 *
 * 1. `FyHttpError` / `FyTransportError` and `callDaemon` — today's `@ferretry/protocol/client` errors, which the
 *    controllers read refusals by. `PluginClient.call` throws the shell's `DaemonRefusal` (a `ShellError` with
 *    `status` and `code`) for an HTTP refusal and the transport's raw error when the daemon is unreachable; neither
 *    type is exported to a plugin, so `callDaemon` recognises them by shape. REPLACE WITH: a kernel-exported refusal
 *    and unreachable error on `@ferretry/kernel/manifest`.
 * 2. `AdvertisementNotice`, `localOnlyNotice`, `refusalNotice` — today's `protocol/src/lib/advertisement.ts`, copied
 *    verbatim. P84: ONE owner for every remedy sentence. REPLACE WITH: the same functions in `contract/` (the app
 *    half imports them too).
 * 3. Commander's option reading (`readInvocation`) — the manifest declares a verb's words only, so unknown options,
 *    missing arguments and too many arguments are refused here with commander's own sentences and exit code 1.
 * 4. The host facilities `CliContext` does not carry (`hostFacilities`): the binary and product names, a clock, a
 *    terminal prompt, a live progress line and the state home (`<FY_HOME>`). They reach `Date.now`, `setTimeout`,
 *    `process.env` and `homedir` directly, which `banned-globals` refuses: REPLACE WITH CliContext ports.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { PluginClient, TerminalIo, VerbHandler, VerbInvocation } from '@ferretry/kernel/manifest';
import { type Duration, milliseconds } from '@ferretry/std';
import { type AdvertisementRefusal, WILDCARD_BIND_HOST } from '../contract/index.ts';

// ─── 1. the client's errors ───────────────────────────────────────────────────────────────────────────────────────

/** The daemon did not answer at all. Copied from today's `fy-api-client.ts`. */
export class FyTransportError extends Error {
  override readonly name = 'FyTransportError';

  constructor(
    message: string,
    readonly path: string,
    readonly timedOut: boolean,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

/** The daemon answered with a refusal. Copied from today's `fy-api-client.ts`, without the old-daemon fields. */
export class FyHttpError extends Error {
  override readonly name = 'FyHttpError';

  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

/** The shell's `DaemonRefusal`, by shape: `name`, a numeric `status`, an optional string `code`. */
function refusalOf(
  error: unknown,
): { readonly message: string; readonly status: number; readonly code?: string } | undefined {
  if (!(error instanceof Error) || error.name !== 'DaemonRefusal') return undefined;
  const { status, code } = error as Error & { status?: unknown; code?: unknown };
  if (typeof status !== 'number') return undefined;
  return typeof code === 'string' ? { message: error.message, status, code } : { message: error.message, status };
}

/** A `ShellError` the router prints as it is (a paused plugin, a person-only route from a pane, a usage bug). */
const isShellError = (error: unknown): boolean =>
  error instanceof Error && typeof (error as Error & { exitCode?: unknown }).exitCode === 'number';

/** The init `PluginClient.call` takes. */
export interface DaemonCallInit {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** The only client capability the gateways consume. */
export type DaemonCaller = Pick<PluginClient, 'call'>;

/**
 * One daemon call, with today's two typed failures: a refusal is a `FyHttpError`, a daemon that did not answer is a
 * `FyTransportError`, and a shell refusal that never reached the daemon is rethrown for the router to print.
 */
export async function callDaemon(client: DaemonCaller, route: string, init?: DaemonCallInit): Promise<unknown> {
  try {
    return await client.call<unknown>(route, init);
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal !== undefined) throw new FyHttpError(refusal.message, refusal.status, refusal.code);
    if (isShellError(error)) throw error;
    const message = error instanceof Error ? error.message : 'the daemon did not answer';
    throw new FyTransportError(message, route, error instanceof Error && error.name === 'TimeoutError', error);
  }
}

// ─── 2. the advertisement sentences (today's `advertisement.ts`) ──────────────────────────────────────────────────

/**
 * WHO CAN REDEEM THIS, and the one line that changes it.
 *
 * COMPOSED ONCE, RENDERED BY BOTH SURFACES. `fy pair` and the browser's Add-a-device panel say the
 * same thing about the same fact, and two surfaces wording one fact twice is how they come to
 * disagree — the reason this decision was hoisted out of them in the first place.
 */
export interface AdvertisementNotice {
  /** Who can redeem the link, said plainly. */
  readonly audience: string;
  /**
   * What actually makes it redeemable from another device — which is not one change for every
   * reason, and saying it was is how a remedy came to be printed where it could not work.
   */
  readonly remedy: string;
}

/** The document an operator edits, spelled the way every other user-facing sentence spells it. */
const CONFIG_DOCUMENT = '<FY_HOME>/config/daemon.json';

/** A private address: obviously an example, unmistakably a LAN. */
const EXAMPLE_LAN_HOST = '192.168.1.10';

/**
 * The example address a remedy tells somebody to write, carrying THIS daemon's port.
 *
 * ADVICE WITH THE WRONG PORT IN IT IS ADVICE TO TYPE THE WRONG NUMBER. The port comes from the
 * address the reader was just shown rather than from the compiled-in default. An address this cannot
 * parse still yields an example, because a malformed advertisement is exactly the state somebody most
 * needs a remedy from.
 */
function exampleReachableAddress(daemonUrl: string): string {
  try {
    const url = new URL(daemonUrl);
    url.hostname = EXAMPLE_LAN_HOST;
    return url.origin;
  } catch {
    return `http://${EXAMPLE_LAN_HOST}`;
  }
}

/** The advertise half, shared by the reasons that genuinely need an address written down. */
function advertiseRemedy(example: string): string {
  return `set "publicUrl" in ${CONFIG_DOCUMENT} to the address other devices reach this machine at, e.g. ${example}, then restart the daemon`;
}

/**
 * The two-step remedy for a daemon nothing off this machine can reach: BIND FIRST, then advertise.
 *
 * AND IT SAYS WHAT IT OPENS, IN THE SAME BREATH AS THE INSTRUCTION. "Every interface" means the routed
 * ones too, so following this remedy lets other devices on the network reach the daemon's port.
 */
function bindAndAdvertiseRemedy(example: string): string {
  return (
    `bind every interface by setting "host" to "${WILDCARD_BIND_HOST}" on the bind entry in "carriers" (or the top-level "host" if the document has no bind entry), which accepts connections from other ` +
    `devices on your network, and ${advertiseRemedy(example)}. ` +
    `Commands on this machine keep reaching it on loopback`
  );
}

/**
 * What to say beside a link whose DIRECT address only this machine's own browser can redeem.
 *
 * A DISCOVERABLE RENDEZVOUS CHANGES THE AUDIENCE SENTENCE, NOT THE REACH. A caller whose rendezvous is
 * self-hosted passes nothing and gets the plain sentence — the declared GAP, failing closed.
 */
export function localOnlyNotice(daemonUrl: string, discoveredRelayUrl?: string): AdvertisementNotice {
  if (discoveredRelayUrl === undefined) {
    return {
      audience: `Only a browser on this machine can redeem this link at ${daemonUrl}; no QR is drawn because another device cannot dial it.`,
      remedy: bindAndAdvertiseRemedy(exampleReachableAddress(daemonUrl)),
    };
  }
  return {
    audience:
      `A browser on this machine redeems this link at ${daemonUrl}; another device can redeem it through ` +
      `the rendezvous at ${discoveredRelayUrl}, which observes connection metadata such as timing and sizes ` +
      `but can never read the code or the exchange.`,
    remedy: `for a direct connection that no rendezvous carries, ${bindAndAdvertiseRemedy(exampleReachableAddress(daemonUrl))}`,
  };
}

const REFUSAL_AUDIENCES: Readonly<Record<AdvertisementRefusal, string>> = {
  'loopback-bind': 'This daemon only advertises loopback, so another device has no address to dial.',
  'wildcard-bind': 'This daemon binds every interface, so there is no single address to hand out.',
  'no-port': 'This daemon has no port recorded yet, so there is no address to hand out.',
};

/**
 * WHAT TO DO ABOUT IT, per reason, and no two of these are the same instruction. A REFUSAL HAS NO
 * ADDRESS, so no example here can carry a real port; the wildcard case names the gap rather than
 * guessing at it.
 */
const REFUSAL_REMEDIES: Readonly<Record<AdvertisementRefusal, string>> = {
  'loopback-bind': bindAndAdvertiseRemedy(`http://${EXAMPLE_LAN_HOST}`),
  'wildcard-bind': advertiseRemedy(`http://${EXAMPLE_LAN_HOST}:<the port this daemon bound>`),
  'no-port': `start the daemon once so it records the port it takes, or write "port" on the bind entry in "carriers" of ${CONFIG_DOCUMENT} yourself (or the top-level "port" if the document has no bind entry); "publicUrl" cannot supply an address nothing has bound`,
};

/** What to say when there is no address to hand out at all, per reason. */
export function refusalNotice(refusal: AdvertisementRefusal): AdvertisementNotice {
  return { audience: REFUSAL_AUDIENCES[refusal], remedy: REFUSAL_REMEDIES[refusal] };
}

// ─── 3. reading a verb's words, as commander did ──────────────────────────────────────────────────────────────────

/**
 * What one verb accepts. `switches` lists every spelling commander accepted, with `no-` for the negated form
 * (`--no-wait` without `--wait`, as `fy pair` declared it); `aliases` maps a short flag to its long name.
 */
export interface VerbShape {
  /** The last word of the verb, as commander's sentences name it. */
  readonly command: string;
  /** Required positional arguments, in order. */
  readonly args: readonly string[];
  readonly switches: readonly string[];
  readonly aliases?: Readonly<Record<string, string>>;
}

export type ReadVerb =
  | {
      readonly kind: 'read';
      readonly args: readonly string[];
      /** `true` for `--name`, `false` for `--no-name`; absent when not given. */
      readonly switches: Readonly<Record<string, boolean>>;
    }
  | { readonly kind: 'refused'; readonly message: string };

/** The verb's words, or commander's refusal sentence for them. Pure. */
export function readInvocation(invocation: VerbInvocation, shape: VerbShape): ReadVerb {
  const switches: Record<string, boolean> = {};
  for (const [given, value] of Object.entries(invocation.options)) {
    const name = shape.aliases?.[given] ?? given;
    // How the person typed it: `-y` for a one-letter flag, `--no-wait` for a negation, `--name` otherwise.
    const typed = value === false ? `--no-${given}` : `${given.length === 1 ? '-' : '--'}${given}`;
    if (typeof value !== 'boolean') {
      return shape.switches.includes(name)
        ? { kind: 'refused', message: `error: option '${typed}' takes no value` }
        : { kind: 'refused', message: `error: unknown option '${typed}'` };
    }
    if (!shape.switches.includes(value ? name : `no-${name}`))
      return { kind: 'refused', message: `error: unknown option '${typed}'` };
    switches[name] = value;
  }
  const missing = shape.args[invocation.args.length];
  if (missing !== undefined) return { kind: 'refused', message: `error: missing required argument '${missing}'` };
  if (invocation.args.length > shape.args.length) {
    const expected = shape.args.length;
    return {
      kind: 'refused',
      message: `error: too many arguments for '${shape.command}'. Expected ${String(expected)} argument${expected === 1 ? '' : 's'} but got ${String(invocation.args.length)}.`,
    };
  }
  return { kind: 'read', args: invocation.args, switches };
}

/** The exit status a controller sets; a verb answers it. */
export class ExitStatus {
  #code = 0;

  setExitCode(code: number): void {
    this.#code = code;
  }

  get code(): number {
    return this.#code;
  }
}

/** A verb handler: read the words (refusing as commander did), run, answer the exit status the controller set. */
export function verbHandler(
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
  shape: VerbShape,
  run: (read: Extract<ReadVerb, { kind: 'read' }>) => Promise<void>,
): VerbHandler {
  return async invocation => {
    const read = readInvocation(invocation, shape);
    if (read.kind === 'refused') {
      io.err(`${read.message}\n`);
      return 1;
    }
    await run(read);
    return exit.code;
  };
}

// ─── 4. host facilities CliContext does not carry ─────────────────────────────────────────────────────────────────

/**
 * The binary and product names. Today: `BINARY_NAME` / `PRODUCT_NAME` single-sourced from the package manifests.
 * REPLACE WITH: `CliContext.binary` (the shell has it as `identity.binary`) and a state-home root.
 */
export const BINARY_NAME = 'fy';
const PRODUCT_NAME = 'ferretry';

/** Today's `SystemMillisecondClock`, over the clock and timer the shell hands every half. */
export interface HostClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

/** Today's `world.prompt.ask`. REPLACE WITH: a CliContext prompt. */
export interface HostPrompt {
  ask(message: string): Promise<string>;
}

/** Today's ora spinner: one live line on stderr. REPLACE WITH: a CliContext progress line. */
export interface HostProgress {
  start(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
}

export interface HostFacilities {
  readonly clock: HostClock;
  readonly prompt: HostPrompt;
  readonly progress: HostProgress;
  /** `<FY_HOME>`: `FY_HOME` when set, else `~/.<product>` — today's `resolveDaemonStateHome`. */
  stateHome(): string;
}

/** What the shell hands a half for time (`CliContext.clock` and `.sleep`); both are optional until it fills them in. */
export interface ShellTime {
  readonly clock?: { nowMs(): number };
  sleep?(delay: Duration, signal?: AbortSignal): Promise<void>;
}

/** The facilities, bound to this process. Every global reach of the CLI half is here or in `adapters/`. */
export function hostFacilities(io: TerminalIo, time: ShellTime): HostFacilities {
  return {
    clock: {
      now: () => {
        if (time.clock === undefined) throw new Error('this fy shell has no clock yet; update fy');
        return time.clock.nowMs();
      },
      sleep: async wait => {
        if (time.sleep === undefined) throw new Error('this fy shell has no timer yet; update fy');
        await time.sleep(milliseconds(wait));
      },
    },
    prompt: {
      async ask(message) {
        const reader = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await reader.question(`? ${message} `);
        } finally {
          reader.close();
        }
      },
    },
    progress: {
      // Ora off a terminal prints `- text` per start and the symbol line per ending; on one it rewrites one line.
      start: text => io.err(io.isTty ? `\r\u001b[2K- ${text}` : `- ${text}\n`),
      succeed: text => io.err(`${io.isTty ? '\r\u001b[2K' : ''}✔ ${text}\n`),
      fail: text => io.err(`${io.isTty ? '\r\u001b[2K' : ''}✖ ${text}\n`),
    },
    stateHome() {
      const pinned = process.env.FY_HOME?.trim();
      if (pinned === undefined || pinned === '') return join(homedir(), `.${PRODUCT_NAME}`);
      if (!isAbsolute(pinned)) throw new Error('FY_HOME must be an absolute path');
      return pinned;
    },
  };
}
