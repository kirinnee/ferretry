import { basename, isAbsolute, join } from 'node:path';
import {
  COPY_AFTER_MASK_SECONDS,
  COPY_COMMAND_DEFAULT_TIMEOUT_SECONDS,
  COPY_DEFAULT_LIFETIME_SECONDS,
  COPY_MAX_CAPTURES_PER_HOUR,
  COPY_MAX_LIVE_PER_SESSION,
  COPY_STDERR_MAX_CHARS,
  COPY_VALUE_MAX_BYTES,
  COPY_VALUE_MIN_CHARS,
  type CopyCapture,
  type CopyCommandReport,
  type CopyExposure,
  type CopyMeta,
  type CopyName,
  type CopyOrigin,
  type CopySource,
  type CopyState,
  copyHandle,
  copyMask,
} from '@ferretry/protocol';
import { SecureCopyError } from './errors.ts';
import type { CopyPorts } from './ports.ts';

/**
 * SECURE COPY: values an agent may name and never read (docs/secure-copy.md).
 *
 * The agent says where a value is; the daemon reads it into this per-session map, masks it from every read
 * from that moment on, and tells the agent only {@link CopyMeta}. Nothing here returns a value: the map has no
 * accessor for one, and a pasted value will leave through the input bridge's one write (a later phase), never
 * through a result.
 *
 * A copy is RAM only. It lapses at its expiry, is let go of when discarded or when its session ends, and a
 * daemon restart forgets every copy. A copy that ended stays listed — without its value — for the after-mask
 * window, so the agent can tell "discarded" and "expired" from "never existed", and is masked for that window
 * too, because it may still be on a screen it was pasted to.
 */

const HOUR_MS = 3_600_000;
const AFTER_MASK_MS = COPY_AFTER_MASK_SECONDS * 1000;
const encoder = new TextEncoder();

interface Entry {
  readonly name: CopyName;
  /** Present while `live`; dropped the moment the copy ends. */
  readonly value?: string;
  readonly from: CopyOrigin;
  readonly length: number;
  readonly lines: number;
  readonly capturedAt: number;
  readonly expiresAt: number;
  readonly exposure: CopyExposure;
  readonly state: CopyState;
  readonly uses: number;
  /** When it stopped being live: the after-mask window runs from here. */
  readonly endedAt?: number;
}

/** What a capture answers: the copy, and for a command how it ended. Never the value. */
export interface CopyCaptured {
  readonly copy: CopyMeta;
  readonly command?: CopyCommandReport;
}

/** What the daemon read, before it is held. Module-private: it never leaves this file. */
interface Read {
  readonly value: string;
  readonly from: CopyOrigin;
  /** How a command ended, and its stderr AS IT WAS: masked only once the value is held. */
  readonly command?: {
    readonly outcome: CopyCommandReport['outcome'];
    readonly exitCode?: number;
    readonly stderr: string;
    readonly stdout: string;
  };
  readonly pageReadBeforeCapture?: boolean;
}

/** The spellings of a value a reader may meet it in: as read, and with its surrounding white space dropped. */
const spellings = (value: string): readonly string[] =>
  [...new Set([value, value.trimEnd(), value.trim()])].filter(spelling => spelling !== '');

export class SecureCopyService {
  private readonly copies = new Map<string, Map<CopyName, Entry>>();
  private readonly captures = new Map<string, readonly number[]>();
  /** Names a capture is running for now: taken before anything is awaited, so two captures cannot both pass the checks. */
  private readonly capturing = new Map<string, Set<CopyName>>();

  constructor(private readonly ports: CopyPorts) {}

  /** Reads a value from `source` and holds it as `sealed:<name>`; refuses with a sentence when it cannot. */
  async capture(sessionId: string, request: CopyCapture): Promise<CopyCaptured> {
    this.purge();
    const own = this.copies.get(sessionId);
    const running = this.capturing.get(sessionId) ?? new Set<CopyName>();
    if (own?.get(request.name)?.state === 'live' || running.has(request.name))
      throw new SecureCopyError(
        'conflict',
        `${copyHandle(request.name)} is already live: discard it with secure.discard first, or pick another name.`,
      );
    const live = [...(own?.values() ?? [])].filter(entry => entry.state === 'live').length + running.size;
    if (live >= COPY_MAX_LIVE_PER_SESSION)
      throw new SecureCopyError(
        'capacity',
        `This session already holds ${String(COPY_MAX_LIVE_PER_SESSION)} live copies: discard one with secure.discard first.`,
      );
    const now = this.ports.clock.now();
    const recent = (this.captures.get(sessionId) ?? []).filter(at => at > now - HOUR_MS);
    if (recent.length >= COPY_MAX_CAPTURES_PER_HOUR)
      throw new SecureCopyError(
        'capacity',
        `This session has captured ${String(COPY_MAX_CAPTURES_PER_HOUR)} values in the last hour; wait before capturing another.`,
      );
    // Every attempt counts, a failed one included, so a loop of probing captures is bounded too.
    this.captures.set(sessionId, [...recent, now]);
    running.add(request.name);
    this.capturing.set(sessionId, running);
    try {
      return await this.hold(sessionId, request);
    } finally {
      running.delete(request.name);
      if (running.size === 0) this.capturing.delete(sessionId);
    }
  }

  /** Reads the value and holds it: the second half of a capture, run with its name taken. */
  private async hold(sessionId: string, request: CopyCapture): Promise<CopyCaptured> {
    const read = await this.read(sessionId, request.name, request.source);
    const capturedAt = this.ports.clock.now();
    const expiresAt = capturedAt + (request.expiresInSeconds ?? COPY_DEFAULT_LIFETIME_SECONDS) * 1000;
    // Masked BEFORE anything else is awaited or returned, in every spelling a reader may meet it in: no read after
    // this point can carry the value, whether a program printed it with its newline or without.
    for (const spelling of spellings(read.value))
      this.ports.masking.holdUntil(sessionId, spelling, copyMask(request.name), expiresAt + AFTER_MASK_MS);
    const command =
      read.command === undefined
        ? undefined
        : await this.report(read.command, [read.command.stdout, read.value], request.name);
    const found: readonly ('found' | 'clean' | 'unknown')[] = await Promise.all(
      spellings(read.value).map(async spelling => await this.ports.exposure.transcriptHolds(sessionId, spelling)),
    ).catch(() => ['unknown']);
    const transcript = found.includes('found') ? 'found' : found.includes('unknown') ? 'unknown' : 'clean';
    const entry: Entry = {
      name: request.name,
      value: read.value,
      from: read.from,
      length: [...read.value].length,
      lines: read.value.split(/\r\n|\r|\n/u).length,
      capturedAt,
      expiresAt,
      exposure: {
        transcript,
        ...(read.pageReadBeforeCapture === undefined ? {} : { pageReadBeforeCapture: read.pageReadBeforeCapture }),
      },
      state: 'live',
      uses: 0,
    };
    const session = this.copies.get(sessionId) ?? new Map<CopyName, Entry>();
    session.set(request.name, entry);
    this.copies.set(sessionId, session);
    return { copy: meta(entry), ...(command === undefined ? {} : { command }) };
  }

  /** Every copy of this session, live or recently ended, oldest first. */
  list(sessionId: string): readonly CopyMeta[] {
    this.purge();
    return [...(this.copies.get(sessionId)?.values() ?? [])]
      .sort((a, b) => a.capturedAt - b.capturedAt)
      .map(entry => meta(entry));
  }

  /** Lets go of a copy's value now; it stays masked for the after-mask window. Discarding an ended copy is a no-op. */
  discard(sessionId: string, name: CopyName): CopyMeta {
    this.purge();
    const entry = this.copies.get(sessionId)?.get(name);
    if (entry === undefined)
      throw new SecureCopyError(
        'not_found',
        `There is no copy named ${copyHandle(name)} in this session (a daemon restart lets go of every copy).`,
      );
    if (entry.state !== 'live') return meta(entry);
    const now = this.ports.clock.now();
    const ended = end(entry, 'discarded', now);
    this.copies.get(sessionId)?.set(name, ended);
    this.ports.masking.retime(sessionId, copyMask(name), now + AFTER_MASK_MS);
    return meta(ended);
  }

  /** Ends every copy whose life is over and forgets every one whose after-mask window has passed, in every session. */
  purge(): void {
    const now = this.ports.clock.now();
    for (const [sessionId, session] of this.copies) {
      for (const [name, entry] of session) {
        if (entry.state === 'live' && entry.expiresAt <= now) session.set(name, end(entry, 'expired', now));
        else if (entry.state !== 'live' && (entry.endedAt ?? now) + AFTER_MASK_MS <= now) session.delete(name);
      }
      if (session.size === 0) this.copies.delete(sessionId);
    }
    for (const [sessionId, times] of this.captures) {
      const recent = times.filter(at => at > now - HOUR_MS);
      if (recent.length === 0) this.captures.delete(sessionId);
      else this.captures.set(sessionId, recent);
    }
  }

  /** Lets go of every copy of a session that ended. */
  drop(sessionId: string): void {
    this.copies.delete(sessionId);
    this.captures.delete(sessionId);
  }

  /** The sessions that hold a copy now, live or recently ended. */
  sessions(): readonly string[] {
    return [...this.copies.keys()];
  }

  /** How many values are held, for one session or all: a count, so a test can prove one was let go. */
  heldCount(sessionId?: string): number {
    const sessions = sessionId === undefined ? [...this.copies.values()] : [this.copies.get(sessionId)];
    return sessions.reduce(
      (total, session) => total + [...(session?.values() ?? [])].filter(entry => entry.value !== undefined).length,
      0,
    );
  }

  private async read(sessionId: string, name: CopyName, source: CopySource): Promise<Read> {
    switch (source.kind) {
      case 'command':
        return await this.runCommand(sessionId, name, source);
      case 'browser':
      case 'clipboard':
        throw new SecureCopyError(
          'unavailable',
          'Copying from a page or its clipboard arrives with the browser input bridge; for now copy what a command prints.',
        );
    }
  }

  private async runCommand(
    sessionId: string,
    name: CopyName,
    source: Extract<CopySource, { readonly kind: 'command' }>,
  ): Promise<Read> {
    const cwd = await this.workingFolder(sessionId, source.cwd);
    const [program] = source.argv;
    const from: CopyOrigin = { kind: 'command', program: basename(program ?? '').slice(0, 64) || 'command' };
    const outcome = await this.ports.runner.run({
      command: source.argv,
      cwd,
      env: {},
      timeoutMs: (source.timeoutSeconds ?? COPY_COMMAND_DEFAULT_TIMEOUT_SECONDS) * 1000,
      // One byte over the cap is enough to know the output did not fit.
      maxOutputBytes: COPY_VALUE_MAX_BYTES + 1,
    });
    const value = source.trim === false ? outcome.stdout : outcome.stdout.trim();
    const why = async (): Promise<string> => {
      const stderr = await this.maskedStderr(outcome.stderr, [outcome.stdout, value], name);
      return stderr === undefined ? '' : ` It said on stderr: ${stderr}`;
    };
    if (outcome.outcome === 'spawn_failed')
      throw new SecureCopyError(
        'bad_request',
        `${from.program ?? 'The program'} could not be started; nothing was copied.`,
      );
    if (outcome.outcome === 'timeout')
      throw new SecureCopyError(
        'upstream_failed',
        `The command ran out of time and was stopped; nothing was copied.${await why()}`,
      );
    if (outcome.exitCode !== 0)
      throw new SecureCopyError(
        'upstream_failed',
        `The command exited with ${String(outcome.exitCode)}; nothing was copied.${await why()}`,
      );
    // stdout's OWN size: a long stderr beside a short token is no reason to refuse it.
    if (encoder.encode(outcome.stdout).length > COPY_VALUE_MAX_BYTES)
      throw new SecureCopyError(
        'bad_request',
        `The command printed more than ${String(COPY_VALUE_MAX_BYTES)} bytes; nothing was copied.`,
      );
    if (value === '')
      throw new SecureCopyError('bad_request', 'The command printed nothing on stdout; nothing was copied.');
    if ([...value.trim()].length < COPY_VALUE_MIN_CHARS)
      throw new SecureCopyError(
        'bad_request',
        `The command printed fewer than ${String(COPY_VALUE_MIN_CHARS)} characters: too short to seal and mask safely; nothing was copied.`,
      );
    return {
      value,
      from,
      command: {
        outcome: outcome.outcome,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        stderr: outcome.stderr,
        stdout: outcome.stdout,
      },
    };
  }

  private async workingFolder(sessionId: string, cwd: string | undefined): Promise<string> {
    if (cwd !== undefined && isAbsolute(cwd)) return cwd;
    const folder = await this.ports.folders.folderOf(sessionId);
    if (folder === undefined)
      throw new SecureCopyError('bad_request', 'This session has no folder of its own: give an absolute cwd.');
    return cwd === undefined ? folder : join(folder, cwd);
  }

  /**
   * stderr with what stdout held masked first, then through the vault redactor, then cut. A redactor that fails
   * withholds the text rather than hand back what it could not check.
   */
  /** How a command that worked ended, for the agent: its stderr masked once the value is held. */
  private async report(
    command: NonNullable<Read['command']>,
    values: readonly string[],
    name: CopyName,
  ): Promise<CopyCommandReport> {
    const stderr = await this.maskedStderr(command.stderr, values, name);
    return {
      outcome: command.outcome,
      ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
      ...(stderr === undefined ? {} : { stderr }),
    };
  }

  private async maskedStderr(stderr: string, values: readonly string[], name: CopyName): Promise<string | undefined> {
    const trimmed = stderr.trim();
    if (trimmed === '') return undefined;
    // Every spelling of the value, longest first: masked whole, and any piece left over withholds the lot.
    const whole = [...new Set(values.flatMap(value => spellings(value)))].sort((a, b) => b.length - a.length);
    const rest = whole.reduce((text, value) => text.replaceAll(value, ' '), trimmed);
    if (whole.some(value => holdsPieceOf(rest, value))) return `[withheld: it held part of ${copyHandle(name)}]`;
    const marker = copyMask(name);
    const masked = whole.reduce((text, value) => text.replaceAll(value, marker), trimmed);
    try {
      const redacted = await this.ports.redact(masked);
      return redacted.length > COPY_STDERR_MAX_CHARS ? `${redacted.slice(0, COPY_STDERR_MAX_CHARS - 1)}…` : redacted;
    } catch {
      return undefined;
    }
  }
}

/** The shortest run of a value that counts as a piece of it. */
const PIECE = 6;

/** Whether `text` holds any run of `value` at least {@link PIECE} characters long (all of a shorter one). */
function holdsPieceOf(text: string, value: string): boolean {
  const characters = [...value];
  if (characters.length <= PIECE) return text.includes(characters.join(''));
  const pieces = new Set<string>();
  for (let at = 0; at + PIECE <= characters.length; at += 1) pieces.add(characters.slice(at, at + PIECE).join(''));
  const scanned = [...text];
  for (let at = 0; at + PIECE <= scanned.length; at += 1)
    if (pieces.has(scanned.slice(at, at + PIECE).join(''))) return true;
  return false;
}

function end(entry: Entry, state: 'discarded' | 'expired', at: number): Entry {
  const { value: _dropped, ...rest } = entry;
  return { ...rest, state, endedAt: at };
}

function meta(entry: Entry): CopyMeta {
  return {
    handle: copyHandle(entry.name),
    name: entry.name,
    from: entry.from,
    length: entry.length,
    lines: entry.lines,
    capturedAt: new Date(entry.capturedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    state: entry.state,
    exposure: entry.exposure,
    uses: entry.uses,
  };
}
