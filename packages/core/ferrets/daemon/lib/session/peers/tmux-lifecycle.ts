/**
 * PEER: today's `packages/daemon/src/lib/tmux/{address,commands,contracts,server-absent,pane-proof,pane,delivery,
 * startup,controller}.ts` and `packages/daemon/src/adapters/tmux/pane-delivery.ts` (owner: terminals) — the part the
 * session launch, lifecycle, resume and reap code reads.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */

// --- lib/tmux/address.ts ----------------------------------------------------------------------------------------

/** Input errors are values at the boundary rather than unsafe tmux target strings. */
class TmuxAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxAddressError';
  }
}

const NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

function segment(value: string, label: string): string {
  if (!NAME.test(value)) throw new TmuxAddressError(`${label} must be a lowercase tmux name`);
  return value;
}

export function sessionTarget(session: string): string {
  return segment(session, 'session');
}

// --- lib/tmux/commands.ts ---------------------------------------------------------------------------------------

export function hasSessionArguments(session: string): readonly string[] {
  return ['has-session', '-t', sessionTarget(session)];
}

// --- lib/tmux/contracts.ts --------------------------------------------------------------------------------------

/** The narrow process seam required by the tmux domain. */
export interface TmuxCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Implemented by the process adapter; every command excludes the executable and socket flags. */
export interface TmuxCommandPort {
  /**
   * Run one tmux command.
   *
   * `stdin` exists for `load-buffer -`: a turn brief is longer than any argv limit and would be
   * world-readable through `/proc` if it were passed as an argument. A command whose ARGUMENTS carry a
   * payload — a pane's environment, typed keys — is moved onto stdin by the adapter itself
   * (`script.ts`), so callers keep passing ordinary argv.
   */
  execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult>;
}

interface PaneMetadata {
  readonly dead: boolean;
  readonly exitCode?: number;
  readonly cursorX?: number;
  readonly cursorY?: number;
  readonly height?: number;
  readonly width?: number;
}

export interface PaneState extends PaneMetadata {
  readonly alive: boolean;
  readonly promptReady: boolean;
  readonly history: string;
  readonly visible: string;
}

export interface TmuxLaunch {
  readonly session: string;
  readonly cwd: string;
  readonly command: readonly [string, ...string[]];
  readonly width?: number;
  readonly height?: number;
  /**
   * Environment set on the tmux session itself, for values the launched program must read from its
   * ENVIRONMENT rather than its argv. Every entry becomes one `-e NAME=VALUE` on `new-session`, sent as a
   * script on stdin so the values are in no process's argv.
   */
  readonly env?: Readonly<Record<string, string>>;
}

// --- lib/tmux/server-absent.ts ----------------------------------------------------------------------------------

/**
 * WHETHER TMUX'S REFUSAL MEANS "THERE IS NO SERVER", as opposed to a command that failed.
 *
 * THE PHRASINGS ARE MEASURED, not guessed (tmux 3.6a, `tmux -S <path> list-sessions`):
 *
 * - `error connecting to <path> (No such file or directory)` — no socket file at all;
 * - `no server running on <path>` — a socket file left by a server that is gone;
 * - `failed to connect` — the spelling this listing already recognised, kept for the
 *   releases that print it.
 *
 * `server exited unexpectedly` is measured too and deliberately NOT here: the command reached a server
 * that then went away mid-request, which is a race rather than a statement that nothing is running,
 * and the exit observer must not settle a session on it.
 */
const SERVER_ABSENT = /no server running|failed to connect|error connecting to .*\(No such file or directory\)/iu;

/** True when tmux refused because its server is not running, which means it holds nothing. */
export function isTmuxServerAbsent(stderr: string): boolean {
  return SERVER_ABSENT.test(stderr);
}

// --- lib/tmux/pane-proof.ts -------------------------------------------------------------------------------------

/**
 * WHICH PANE THIS IS, ALIVE OR DEAD — the one proof every reader of a registered pane uses.
 *
 * A registration pins a pane by its id and the pid it ran. A live pane is proven by both. A DEAD pane
 * cannot be, on every tmux: since 3.8 `#{pane_pid}` prints NOTHING once the pane's process is gone.
 * So the proof carries a second stamp that outlives the process: `#{session_created}`, the second the
 * pane's tmux session was made. Wherever tmux still prints a pid, the pid must match too.
 */
export const PANE_PROOF_FORMAT = '#{pane_id}|#{pane_pid}|#{pane_dead}|#{session_created}';

/** Ask tmux the {@link PANE_PROOF_FORMAT} of the pane `-t <session>` names. */
export function paneProofArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', sessionTarget(session), PANE_PROOF_FORMAT];
}

/** What tmux says about a pane right now. */
export interface PaneSighting {
  readonly paneId: string;
  /** The pid the pane runs; absent for a dead pane on tmux 3.8 and later. */
  readonly pid?: number;
  readonly dead: boolean;
  /** The UNIX second the pane's session was created. */
  readonly sessionCreated?: number;
}

/** What a registration pins a pane by. */
export interface PaneStamp {
  readonly paneId: string;
  readonly pid: number;
  readonly sessionCreated: number;
}

const PANE_ID = /^%(?:0|[1-9][0-9]*)$/u;
const WHOLE = /^[1-9][0-9]*$/u;

const positive = (field: string): number | undefined => {
  if (!WHOLE.test(field)) return undefined;
  const value = Number(field);
  return Number.isSafeInteger(value) ? value : undefined;
};

/** Parse {@link PANE_PROOF_FORMAT}; `undefined` for anything that is not a pane tmux described. */
export function parsePaneSighting(output: string): PaneSighting | undefined {
  const fields = output.trimEnd().split('|');
  if (fields.length !== 4) return undefined;
  const [paneId = '', pidField = '', deadField = '', createdField = ''] = fields;
  if (!PANE_ID.test(paneId) || (deadField !== '0' && deadField !== '1')) return undefined;
  const pid = positive(pidField);
  // An empty pid is how tmux 3.8 describes a dead pane; any other unreadable one is not tmux's.
  if (pidField !== '' && (pid === undefined || pid <= 1)) return undefined;
  const sessionCreated = positive(createdField);
  return {
    paneId,
    dead: deadField === '1',
    ...(pid === undefined ? {} : { pid }),
    ...(sessionCreated === undefined ? {} : { sessionCreated }),
  };
}

/**
 * Whether `sighting` is the pane `stamp` registered:
 *
 * - `proven`: the same id, the same session creation second, and the same pid whenever tmux printed one.
 *   A pane with no pid is proven only when it is dead AND the creation second matches.
 * - `refuted`: anything else, which says nothing about the registered pane.
 */
export function provePane(sighting: PaneSighting, stamp: PaneStamp): 'proven' | 'refuted' {
  if (sighting.paneId !== stamp.paneId) return 'refuted';
  if (sighting.sessionCreated !== stamp.sessionCreated) return 'refuted';
  if (sighting.pid !== undefined) return sighting.pid === stamp.pid ? 'proven' : 'refuted';
  return sighting.dead ? 'proven' : 'refuted';
}

// --- lib/tmux/pane.ts -------------------------------------------------------------------------------------------

/**
 * Resolve a session target the way tmux does for a plain name: the session of exactly that name, else
 * the ONE session the name is a prefix of. Our names hold no glob characters (`sessionTarget` admits
 * none), so tmux's pattern pass can never match anything the exact pass did not. `undefined` when tmux
 * would refuse: nothing matches, or the prefix is ambiguous.
 */
export function resolveSessionTarget(target: string, names: Iterable<string>): string | undefined {
  const candidates: string[] = [];
  for (const name of names) {
    if (name === target) return name;
    if (name.startsWith(target)) candidates.push(name);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** A pane's tmux id and the pid of the process it runs. */
export interface PaneIdentity {
  readonly paneId: string;
  readonly pid: number;
}

// --- lib/tmux/delivery.ts ---------------------------------------------------------------------------------------

/** At most this many of a dead pane's last non-blank lines are quoted in its exit reason. */
const EXIT_OUTPUT_LINES = 3;

/** And at most this many characters of them, so one runaway line cannot flood a card. */
const EXIT_OUTPUT_CHARACTERS = 300;

/**
 * Why a pane is gone, in words a card can show: the exit status tmux kept, and the last thing the
 * process printed. Control characters are dropped so a colour code or a stray escape cannot reach a
 * surface that renders the reason. The scrollback is read when there is one.
 */
export function harnessExitReason(frame: {
  readonly exitCode?: number;
  readonly visible: string;
  readonly history?: string;
}): string {
  const status =
    frame.exitCode === undefined
      ? 'the interactive harness exited; tmux reported no exit code'
      : `the interactive harness exited (${frame.exitCode})`;
  const output = frame.history === undefined || frame.history.trim() === '' ? frame.visible : frame.history;
  const lines = output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^Pane is dead\b/u.test(line));
  const tail = lines.slice(-EXIT_OUTPUT_LINES).join(' / ');
  if (tail.length === 0) return status;
  const quoted = tail.length > EXIT_OUTPUT_CHARACTERS ? `…${tail.slice(-EXIT_OUTPUT_CHARACTERS)}` : tail;
  return `${status}: its last output was "${quoted}"`;
}

/**
 * What happened after a proven composer delivery was submitted.
 *
 * `handled-local` is a success: a slash command the TUI consumes itself is delivered even though no
 * model turn follows it.
 */
export type InjectionOutcome = 'turn-started' | 'handled-local';

// --- lib/tmux/startup.ts ----------------------------------------------------------------------------------------

export interface StartupDialogOptions {
  /**
   * How to answer Claude Code's large-session resume gate. `full` keeps the session's fidelity and is the
   * default; `summary` saves quota. Option 3 is NEVER selected.
   */
  readonly resumeMenuChoice?: 'full' | 'summary';
}

// --- lib/tmux/controller.ts (INJECTED) --------------------------------------------------------------------------

/**
 * INJECTED: the methods of today's `TmuxController` class the session code calls. The class stays the terminals
 * plugin's; the host hands its instance in.
 */
export interface TmuxController {
  alive(session: string): Promise<boolean>;
  state(session: string, options?: { readonly history?: boolean }): Promise<PaneState>;
  paneIdentities(): Promise<ReadonlyMap<string, PaneIdentity> | undefined>;
  paneIdentity(session: string): Promise<PaneIdentity | undefined>;
  paneSighting(session: string): Promise<PaneSighting | undefined>;
  killPaneExact(paneId: string): Promise<void>;
  launch(launch: TmuxLaunch): Promise<void>;
  stop(session: string): Promise<void>;
}

// --- adapters/tmux/pane-delivery.ts (INJECTED) ------------------------------------------------------------------

/**
 * INJECTED: the methods of today's `TmuxPaneDelivery` adapter the session launchers call. The adapter stays the
 * terminals plugin's; the host hands its instance in.
 */
export interface TmuxPaneDelivery {
  waitReady(session: string, options?: StartupDialogOptions): Promise<void>;
  deliver(
    session: string,
    text: string,
    options?: StartupDialogOptions,
    beforeWrite?: () => Promise<void>,
  ): Promise<InjectionOutcome>;
  waitStartupSettled(session: string): Promise<'settled' | 'timed-out'>;
}
