import { createHash } from 'node:crypto';
import type {
  InputRequestField,
  InputTarget,
  InputTargetFacts,
  LoginEntryId,
  LoginObservation,
  SignInId,
  SurfaceKind,
} from '@ferretry/protocol';

/**
 * WHAT THE DAEMON SEES WHILE A SAVED ACCOUNT SIGNS IN (docs/input-requests.md, "Login recipes"), kept as the facts of
 * the SIGN-IN it was typed at — never of the account as a whole, so two accounts on one host keep their own. Every fact comes from the daemon's own look at the real target, never from what an agent said:
 *
 * - AT THE WRITE, from the facts the owner's card was drawn from: every secret field was a password input, or the
 *   terminal had echo off and a recognised program was reading (`masked`), and the field's identity.
 * - AFTER A SUBMIT, from a short look of the daemon's own: whether the typed value shows in the page text or on the
 *   screen (`noEchoAfterSubmit`; the value never leaves the daemon, the probe answers yes or no), whether the page
 *   showed a new document within {@link NAVIGATION_WINDOW_MS} (`navigatedAway`), and which second factor followed:
 *   a one-time code typed on the same login soon after (`code`), the page leaving the login's hosts only after
 *   waiting there (`push`: an approval elsewhere), or leaving at once (`none`).
 *
 * THE FERRET CAN STEER WHAT A PAGE OR SCREEN SHOWS (it can navigate, clear the screen, click "Continue"), so a fact
 * from after the submit is DROPPED when the ferret drove a surface of that kind in the session meanwhile: only a
 * target nobody but the site touched counts. The facts from the write itself do not depend on the ferret.
 */

/** How long after a submit a new document counts as the page moving on. */
export const NAVIGATION_WINDOW_MS = 10_000;
/** How long the daemon watches a page for the second factor after a submit. */
export const SECOND_FACTOR_WINDOW_MS = 180_000;
/** When the daemon looks for the value on the target after a submit, and when it looks again. */
export const ECHO_LOOK_DELAY_MS = 1_500;
export const ECHO_SECOND_LOOK_MS = 5_000;
/** How often the page's document and host are looked at while watching. */
const POLL_MS = 1_000;

/**
 * Where a sign-in's facts go: the account directory, under its store lock. It keeps a fact only at one of that sign-in's
 * own places (`AccountDirectory.observeSignIn`), so a fact is never misfiled even if it were handed the wrong one.
 */
export interface LoginFactSink {
  observeSignIn(id: SignInId, seen: LoginObservation): Promise<void>;
}

/** The daemon's own looks at a target after a submit. Each answers `undefined` when it cannot tell. */
export interface LoginProbePort {
  /**
   * The page's document and host now. `surfaces` are the names the typed-into page had: a page now under the key
   * that is not that page (closed and opened again) answers `undefined`, never a fact about another page.
   */
  where(
    sessionId: string,
    key: string,
    surfaces: readonly string[],
  ): Promise<{ readonly navigationId: string; readonly host: string } | undefined>;
  /**
   * Whether any of `values` shows on the target now, in everything a ferret's read of it could return. Never published.
   * The same pinning: another surface under the key answers `undefined`.
   */
  shows(
    sessionId: string,
    target: InputTarget,
    surfaces: readonly string[],
    values: readonly string[],
  ): Promise<boolean | undefined>;
}

export interface LoginObserverPorts {
  readonly sink: LoginFactSink;
  readonly probe: LoginProbePort;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** One delivery that used a saved login, as the input service hands it over once it was typed. */
export interface LoginDelivery {
  readonly sessionId: string;
  /** The saved account typed; absent for a value the owner typed, which can still be the code a login waits for. */
  readonly login?: LoginEntryId;
  /**
   * The sign-in the facts go to: the one the owner tapped, or the account's sign-in the daemon matched to this target.
   * Absent (an account picked by hand on a place it does not sign in at): nothing is kept.
   */
  readonly signIn?: SignInId;
  /** The sign-in's own login domains: leaving them is the sign-in finishing. */
  readonly domains: readonly string[];
  readonly target: InputTarget;
  readonly facts: InputTargetFacts;
  readonly fields: readonly InputRequestField[];
  /** The values typed that were not plain, for the echo look only. */
  readonly secrets: readonly string[];
  readonly submitted: boolean;
  /** The daemon's key for a terminal target (`sudo@kirin-box`). */
  readonly matchKey?: string;
  /** Every name the typed-into surface had (its key and its id): the looks after the submit are pinned to it. */
  readonly surfaces: readonly string[];
  /** When the request was raised: an act of the ferret on that kind of surface since then voids the after-submit facts. */
  readonly since: number;
  /** When the write returned, taken before anything else is awaited. */
  readonly deliveredAt: number;
}

/** A password submit still waiting to see its second factor. */
interface Awaiting {
  readonly delivery: LoginDelivery;
  readonly place: string;
  readonly at: number;
  settled: boolean;
}

const digest = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

const hostOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/** Where a delivery's facts belong: the page's host, or the terminal's key. */
export function placeOf(facts: InputTargetFacts, matchKey: string | undefined): string | undefined {
  if (facts.kind === 'browser') return hostOf(facts.origin);
  if (facts.kind === 'terminal') return matchKey;
  return undefined;
}

/**
 * The field's identity: what would have to change for these facts to be about another field. A page: its origin and,
 * per field, the frame's origin, the tag and the attributes that say what it is. A terminal: the place and the program.
 */
export function identityOf(facts: InputTargetFacts, place: string): string | undefined {
  if (facts.kind === 'browser')
    return digest([
      'page',
      facts.origin,
      ...facts.fields.map(field => [
        field.frameOrigin,
        field.field.tag,
        field.field.type ?? '',
        field.field.name ?? '',
        field.field.id ?? '',
        field.field.autocomplete ?? '',
      ]),
    ]);
  if (facts.kind === 'terminal') return digest(['terminal', place, facts.foreground.comm]);
  return undefined;
}

/** Every secret field went into a password input, or the terminal hid typing for a program that asks for secrets. */
export function maskedAt(facts: InputTargetFacts, fields: readonly InputRequestField[]): boolean | undefined {
  if (facts.kind === 'terminal') return facts.echo === 'off' && facts.recognisedConsumer;
  if (facts.kind !== 'browser') return undefined;
  const secret = new Set(fields.filter(field => field.sensitivity !== 'plain').map(field => field.id));
  const typed = facts.fields.filter(field => secret.has(field.fieldId));
  return typed.length > 0 && typed.every(field => field.field.tag === 'input' && field.field.type === 'password');
}

export class LoginObserver {
  /** The last time the ferret drove a terminal or a page, per session. */
  private readonly drove = new Map<string, number>();
  /** Sessions whose ferret ran a page script: a script can arm a page to steer what is seen later, so no page fact. */
  private readonly scripted = new Set<string>();
  /** Password submits waiting for a code, per session. */
  private readonly awaiting = new Map<string, Awaiting[]>();

  constructor(private readonly ports: LoginObserverPorts) {}

  /**
   * The ferret is about to do something that may change a surface of `kind` (every tool but the read-only ones), or
   * run a page script: what is seen after a submit there is no longer the site's alone.
   */
  acted(sessionId: string, kind: SurfaceKind, script = false): void {
    this.drove.set(`${sessionId}\u0000${kind}`, this.ports.now());
    if (script) this.scripted.add(sessionId);
  }

  /**
   * Whether the ferret could have steered a surface of `kind`: for a page, it ran a page script in this session; or
   * it acted on that kind of surface at or after `since` (an unreadable `since` counts as acted).
   */
  tainted(sessionId: string, kind: SurfaceKind, since: number): boolean {
    if (kind === 'browser' && this.scripted.has(sessionId)) return true;
    if (Number.isNaN(since)) return true;
    const last = this.drove.get(`${sessionId}\u0000${kind}`);
    return last !== undefined && last >= since;
  }

  /** The sessions it remembers anything about. */
  sessions(): readonly string[] {
    return [
      ...new Set([
        ...this.awaiting.keys(),
        ...this.scripted,
        ...[...this.drove.keys()].map(key => key.slice(0, key.indexOf('\u0000'))),
      ]),
    ];
  }

  /** A session ended: nothing about it is kept. */
  forget(sessionId: string): void {
    this.awaiting.delete(sessionId);
    this.scripted.delete(sessionId);
    for (const kind of ['browser', 'terminal']) this.drove.delete(`${sessionId}\u0000${kind}`);
  }

  /**
   * Whether the ferret could have steered what is seen: it acted on that kind of surface since the request was raised
   * (so an act armed before the card counts too), or, for a page, it ever ran a page script in this session.
   */
  private steered(delivery: LoginDelivery): boolean {
    const kind = delivery.target.kind === 'browser' ? 'browser' : 'terminal';
    if (kind === 'browser' && this.scripted.has(delivery.sessionId)) return true;
    // A raise time that cannot be read counts as steered: no fact is kept on a clock it cannot trust.
    if (!Number.isFinite(delivery.since)) return true;
    const last = this.drove.get(`${delivery.sessionId}\u0000${kind}`);
    return last !== undefined && last >= delivery.since;
  }

  /**
   * A saved login was typed. Records the facts from the write, then, when it was submitted, looks again on its own.
   * Total: a failure to look or to record loses a fact, never the delivery. Resolves once every look is done.
   */
  async delivered(delivery: LoginDelivery): Promise<void> {
    const place = placeOf(delivery.facts, delivery.matchKey);
    if (place === undefined) return;
    const identity = identityOf(delivery.facts, place);
    if (identity === undefined) return;
    const surface = delivery.facts.kind === 'browser' ? 'page' : 'terminal';
    const base = { at: place, surface, identity } as const;
    const codeField = delivery.fields.some(field => field.sensitivity === 'code' || field.sensitivity === 'private');
    const passwordField = delivery.fields.some(field => field.sensitivity === 'secret');
    if (codeField) this.codeSeen(delivery, place);
    const signIn = delivery.signIn;
    if (signIn === undefined) return;
    const masked = maskedAt(delivery.facts, delivery.fields);
    await this.record(signIn, { ...base, ...(masked === undefined ? {} : { masked }) });
    if (!delivery.submitted || !passwordField) return;
    const waiting: Awaiting = { delivery, place, at: delivery.deliveredAt, settled: false };
    if (!codeField) this.awaiting.set(delivery.sessionId, [...(this.awaiting.get(delivery.sessionId) ?? []), waiting]);
    try {
      await this.afterSubmit(signIn, delivery, base, waiting, codeField);
    } finally {
      this.awaiting.set(
        delivery.sessionId,
        (this.awaiting.get(delivery.sessionId) ?? []).filter(other => other !== waiting),
      );
    }
  }

  /** Whether a value shows, looked for twice: seen in either is `true`; `false` only when BOTH looks could tell. */
  private async echoed(delivery: LoginDelivery): Promise<boolean | undefined> {
    const look = async (): Promise<boolean | undefined> =>
      await this.ports.probe
        .shows(delivery.sessionId, delivery.target, delivery.surfaces, delivery.secrets)
        .catch(() => undefined);
    const wait = async (until: number): Promise<void> =>
      await this.ports.sleep(Math.max(0, until - (this.ports.now() - delivery.deliveredAt)));
    await wait(ECHO_LOOK_DELAY_MS);
    const first = await look();
    if (first === true) return true;
    await wait(ECHO_SECOND_LOOK_MS);
    const second = await look();
    if (second === true) return true;
    return first === undefined || second === undefined ? undefined : false;
  }

  /**
   * The looks after a submit. Each fact is decided AT ITS OWN MOMENT, and kept only if the ferret had not steered
   * anything by then: the echo once both looks are in, the page moving on at the end of its window, the second factor
   * when the page leaves the sign-in hosts. A later act of the ferret does not undo a fact already decided.
   */
  private async afterSubmit(
    signIn: SignInId,
    delivery: LoginDelivery,
    base: Pick<LoginObservation, 'at' | 'surface' | 'identity'>,
    waiting: Awaiting,
    codeField: boolean,
  ): Promise<void> {
    const startDocument = delivery.facts.kind === 'browser' ? delivery.facts.navigationId : undefined;
    const elapsed = (): number => this.ports.now() - delivery.deliveredAt;
    const keep = async (seen: Omit<LoginObservation, 'at' | 'surface' | 'identity'>): Promise<void> => {
      if (!this.steered(delivery)) await this.record(signIn, { ...base, ...seen });
    };
    const echo = async (): Promise<void> => {
      const shown = await this.echoed(delivery);
      if (shown !== undefined) await keep({ noEchoAfterSubmit: !shown });
    };
    // The page is watched from the submit, so a page that moves on before the echo looks is seen moving.
    const watch = async (): Promise<void> => {
      if (delivery.target.kind !== 'browser' || startDocument === undefined) return;
      let moved: boolean | undefined;
      const settleMove = async (): Promise<void> => {
        if (moved === undefined) return;
        await keep({ navigatedAway: moved });
      };
      while (elapsed() < SECOND_FACTOR_WINDOW_MS && !waiting.settled) {
        const where = await this.ports.probe
          .where(delivery.sessionId, delivery.target.key, delivery.surfaces)
          .catch(() => undefined);
        // Another page under the name, or none: nothing more is said about this sign-in.
        if (where === undefined) return;
        if (moved === undefined && where.navigationId !== startDocument) {
          moved = elapsed() <= NAVIGATION_WINDOW_MS;
          await settleMove();
        }
        if (moved === undefined && elapsed() >= NAVIGATION_WINDOW_MS) {
          moved = false;
          await settleMove();
        }
        if (!delivery.domains.includes(where.host) && where.host !== base.at) {
          if (codeField || waiting.settled || moved === undefined) return;
          waiting.settled = true;
          await keep({ secondFactor: elapsed() <= NAVIGATION_WINDOW_MS ? 'none' : 'push' });
          return;
        }
        if (moved === false) return;
        await this.ports.sleep(POLL_MS);
      }
    };
    await Promise.all([echo(), watch()]);
  }

  /** A one-time code was typed: the password submit it follows, on the same account and place, had a code as its second factor. */
  private codeSeen(delivery: LoginDelivery, place: string): void {
    const now = this.ports.now();
    for (const waiting of this.awaiting.get(delivery.sessionId) ?? []) {
      if (waiting.settled) continue;
      if (delivery.login !== undefined && waiting.delivery.login !== delivery.login) continue;
      if (now - waiting.at > SECOND_FACTOR_WINDOW_MS) continue;
      if (place !== waiting.place && !waiting.delivery.domains.includes(place)) continue;
      waiting.settled = true;
      const identity = identityOf(waiting.delivery.facts, waiting.place);
      if (identity === undefined) continue;
      const signIn = waiting.delivery.signIn;
      if (signIn === undefined) continue;
      void this.record(signIn, {
        at: waiting.place,
        surface: waiting.delivery.facts.kind === 'browser' ? 'page' : 'terminal',
        identity,
        secondFactor: 'code',
      });
    }
  }

  private async record(signIn: SignInId, seen: LoginObservation): Promise<void> {
    await this.ports.sink.observeSignIn(signIn, seen).catch(() => undefined);
  }
}

/**
 * The daemon's looks, from the two targets: the page's document, host and text through the page's own queue, and
 * the terminal's screen through tmux. `shows` answers only whether a value is in what was read; the text itself is
 * dropped here and goes nowhere.
 */
export class InputLoginProbe implements LoginProbePort {
  constructor(
    private readonly pages: {
      where(
        sessionId: string,
        key: string,
        surfaces: readonly string[],
      ): Promise<{ navigationId: string; host: string } | undefined>;
      text(sessionId: string, key: string, surfaces: readonly string[]): Promise<string | undefined>;
    },
    private readonly terminals:
      | { screen(sessionId: string, key: string, surfaces: readonly string[]): Promise<string | undefined> }
      | undefined,
  ) {}

  async where(
    sessionId: string,
    key: string,
    surfaces: readonly string[],
  ): Promise<{ navigationId: string; host: string } | undefined> {
    return await this.pages.where(sessionId, key, surfaces);
  }

  async shows(
    sessionId: string,
    target: InputTarget,
    surfaces: readonly string[],
    values: readonly string[],
  ): Promise<boolean | undefined> {
    if (values.length === 0) return undefined;
    const text =
      target.kind === 'browser'
        ? await this.pages.text(sessionId, target.key, surfaces)
        : target.kind === 'terminal'
          ? await this.terminals?.screen(sessionId, target.key, surfaces)
          : undefined;
    if (text === undefined) return undefined;
    return values.some(value => value !== '' && text.includes(value));
  }
}
