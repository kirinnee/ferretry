/**
 * COMPACT MEMORY AT, PER FERRET: where a ferret's harness squeezes its own conversation (docs/compact-at.md).
 * `GET` and `PATCH /v1/sessions/:sessionId/compact-at`. `auto` — the harness's own trigger — unless the ferret's
 * login names a default or the owner set one on the ferret.
 *
 * The value is a LAUNCH fact: Claude reads it from the `--settings` the launch builds and Codex from a `-c`
 * override, so it is recorded as `config.compactAt` on the session document and every relaunch builds it again
 * from there (`launch/argv.ts`). It is deliberately NOT sent to a running harness: Claude's own `/autocompact`
 * writes the login's shared settings file, which would change every other ferret on that login, and a launch value
 * overrides it anyway. A running ferret therefore takes the change at its next restart, and the answer says so.
 */

import { type CompactAt, checkCompactAt, describeCompactAt } from '@ferretry/protocol';

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

const effectiveOf = (facts: Pick<CompactAtFacts, 'own' | 'accountDefault'>): CompactAt =>
  facts.own ?? facts.accountDefault ?? 'auto';

const sentence = (value: CompactAt): string =>
  value === 'auto'
    ? 'memory is compacted at the harness’s own trigger (Auto)'
    : `memory is compacted at ${describeCompactAt(value)} tokens`;

export class SessionCompactAtService {
  constructor(private readonly ports: SessionCompactAtPorts) {}

  async get(sessionId: string): Promise<CompactAtReading> {
    const facts = await this.require(sessionId);
    const effective = effectiveOf(facts);
    const source = facts.own === undefined && facts.accountDefault !== undefined ? ' (this login’s default)' : '';
    return {
      effective,
      ...(facts.own === undefined ? {} : { own: facts.own }),
      ...(facts.window === undefined ? {} : { window: facts.window }),
      restartRequired: false,
      note: `${capitalise(sentence(effective))}${source}.`,
    };
  }

  /** `inherit` drops the ferret's own value, so its login's default applies again. */
  async set(sessionId: string, wanted: CompactAt | 'inherit'): Promise<CompactAtOutcome> {
    const facts = await this.require(sessionId);
    const value = wanted === 'inherit' ? undefined : wanted;
    if (value !== undefined) {
      const refusal = checkCompactAt(value, facts.window);
      if (refusal !== undefined) throw new SessionCompactAtError('invalid', refusal);
    }
    const before = effectiveOf(facts);
    await this.ports.write(sessionId, value, this.ports.now());
    const effective = effectiveOf({ own: value, accountDefault: facts.accountDefault });
    const changed = before !== effective;
    if (!changed) return { effective, restartRequired: false, note: `${capitalise(sentence(effective))} already.` };
    return {
      effective,
      restartRequired: facts.running,
      note: facts.running
        ? `Now ${sentence(effective)}. This ferret is running, so it takes effect when the ferret restarts.`
        : `Now ${sentence(effective)}; this ferret is not running, so it takes effect at its next launch.`,
    };
  }

  private async require(sessionId: string): Promise<CompactAtFacts> {
    const facts = await this.ports.facts(sessionId);
    if (facts === undefined) throw new SessionCompactAtError('not-found', `no session ${sessionId}`);
    return facts;
  }
}

const capitalise = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
