/**
 * COMPACT MEMORY AT, PER FERRET: where a ferret's harness squeezes its own conversation (docs/compact-at.md).
 * `GET` and `PATCH /v1/sessions/:sessionId/compact-at`. `auto` — the harness's own trigger — unless the ferret's
 * login names a default or the owner set one on the ferret.
 *
 * The value is a LAUNCH fact: Claude reads it from the `--settings` the launch builds and Codex from a `-c`
 * override, so it is recorded as `config.compactAt` on the session document and every relaunch builds it again
 * from there (`launch/argv.ts`). It is deliberately NOT sent to a running harness: Claude's own `/autocompact`
 * writes the login's shared settings file, which would change every other ferret on that login, and a launch value
 * overrides it anyway. A running ferret therefore takes the change at its next restart, and the answer says so —
 * on every read and every repeat of a change, for as long as the process still runs on the value it launched with.
 *
 * The value in force is validated against the model's window, not only the value a person typed: a login default
 * the model cannot honour is not used (a launch falls back to Auto rather than refusing), and dropping a ferret's
 * own value back onto such a default is refused.
 */

import { type CompactAt, checkCompactAt, describeCompactAt } from '../../../seams/protocol.ts';
import { resolveCompactAt } from './resolve.ts';

/** What the setting needs to know about one ferret. */
export interface CompactAtFacts {
  /** The ferret's own value, absent when it follows its login's default. */
  readonly own: CompactAt | undefined;
  /** What its login says, absent when it says nothing. */
  readonly accountDefault: CompactAt | undefined;
  /** The model's context window, when it can be told. */
  readonly window: number | undefined;
  /** Whether a process is running, so a change waits for its next launch. */
  readonly running: boolean;
  /**
   * What the running process was launched with, read from its recorded launch arguments. Absent when it cannot be
   * told (nothing recorded), in which case a change is compared with what was in force before it.
   */
  readonly launched?: CompactAt | undefined;
}

export interface SessionCompactAtPorts {
  /** `undefined` when there is no such session. */
  facts(sessionId: string): Promise<CompactAtFacts | undefined>;
  /** Records the value on the session document (`undefined` drops it, so the login's default applies again). */
  write(sessionId: string, value: CompactAt | undefined, at: string): Promise<void>;
  now(): string;
}

export class SessionCompactAtError extends Error {
  constructor(
    readonly reason: 'not-found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'SessionCompactAtError';
  }
}

export interface CompactAtOutcome {
  readonly effective: CompactAt;
  readonly restartRequired: boolean;
  readonly note: string;
}

export interface CompactAtReading extends CompactAtOutcome {
  readonly own?: CompactAt;
  readonly window?: number;
}

const sentence = (value: CompactAt): string =>
  value === 'auto'
    ? 'memory is compacted at the harness’s own trigger (Auto)'
    : `memory is compacted at ${describeCompactAt(value)} tokens`;

/** Whether the running process is on something other than `effective`. Unknown launches compare with `before`. */
const pending = (facts: CompactAtFacts, effective: CompactAt, before: CompactAt): boolean =>
  facts.running && (facts.launched ?? before) !== effective;

const restartClause = (facts: CompactAtFacts): string =>
  facts.launched === undefined
    ? 'This ferret is running, so it takes effect when the ferret restarts.'
    : `This ferret is running on ${describeCompactAt(facts.launched)}, so it takes effect when the ferret restarts.`;

export class SessionCompactAtService {
  constructor(private readonly ports: SessionCompactAtPorts) {}

  async get(sessionId: string): Promise<CompactAtReading> {
    const facts = await this.require(sessionId);
    const { effective, ignored } = resolveCompactAt(facts, facts.window);
    const source =
      facts.own === undefined && facts.accountDefault !== undefined && ignored === undefined
        ? ' (this login’s default)'
        : '';
    const restartRequired = pending(facts, effective, effective);
    return {
      effective,
      ...(facts.own === undefined ? {} : { own: facts.own }),
      ...(facts.window === undefined ? {} : { window: facts.window }),
      restartRequired,
      note: [
        `${capitalise(sentence(effective))}${source}.`,
        ...(ignored === undefined ? [] : [ignored]),
        ...(restartRequired ? [restartClause(facts)] : []),
      ].join(' '),
    };
  }

  /** `inherit` drops the ferret's own value, so its login's default applies again. */
  async set(sessionId: string, wanted: CompactAt | 'inherit'): Promise<CompactAtOutcome> {
    const facts = await this.require(sessionId);
    const value = wanted === 'inherit' ? undefined : wanted;
    const refusal = this.refusal(facts, value);
    if (refusal !== undefined) throw new SessionCompactAtError('invalid', refusal);
    const before = resolveCompactAt(facts, facts.window).effective;
    await this.ports.write(sessionId, value, this.ports.now());
    // A request that passed `refusal` resolves to a value the model honours, so nothing is dropped here.
    const { effective } = resolveCompactAt({ own: value, accountDefault: facts.accountDefault }, facts.window);
    const restartRequired = pending(facts, effective, before);
    if (restartRequired) {
      const prefix =
        before === effective ? `${capitalise(sentence(effective))} already.` : `Now ${sentence(effective)}.`;
      return { effective, restartRequired, note: `${prefix} ${restartClause(facts)}` };
    }
    if (before === effective)
      return { effective, restartRequired, note: `${capitalise(sentence(effective))} already.` };
    return {
      effective,
      restartRequired,
      note: facts.running
        ? `Now ${sentence(effective)}. This ferret is already running on it, so nothing needs to restart.`
        : `Now ${sentence(effective)}; this ferret is not running, so it takes effect at its next launch.`,
    };
  }

  /**
   * Why the value that WOULD be in force cannot be: an explicit value the model cannot honour, or an `inherit` that
   * would hand the ferret a login default it cannot honour. `undefined` when the request is fine.
   */
  private refusal(facts: CompactAtFacts, value: CompactAt | undefined): string | undefined {
    if (value !== undefined) return checkCompactAt(value, facts.window);
    if (facts.accountDefault === undefined) return undefined;
    const problem = checkCompactAt(facts.accountDefault, facts.window);
    return problem === undefined
      ? undefined
      : `This login’s default can’t be used by this ferret: ${problem} Set a size or Auto on the ferret instead.`;
  }

  private async require(sessionId: string): Promise<CompactAtFacts> {
    const facts = await this.ports.facts(sessionId);
    if (facts === undefined) throw new SessionCompactAtError('not-found', `no session ${sessionId}`);
    return facts;
  }
}

const capitalise = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
