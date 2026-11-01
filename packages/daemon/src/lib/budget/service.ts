/**
 * Spend budgets, enforced (docs/budgets.md).
 *
 * Once a minute, on its own timer — the hard limit must hold with the Warden switched off — it:
 *
 * 1. reads what this machine's sessions on every budgeted login cost this week (`SpendMeter`);
 * 2. works out where each login stands, and REPUBLISHES the fleet when the set of logins its budget holds
 *    moves — a login past its trigger is published unavailable with a reason, so nothing new starts,
 *    resumes or is revived on it, and a period that reset lifts the hold at the next tick;
 * 3. STOPS every live session on a login past its hard limit — interrupted first, then stopped with its
 *    turn saved, so it can be resumed after the reset or moved with `fy migrate` — and tells the owner ONCE
 *    per login per period, with a ping, which ferrets it stopped and where they could go. It never moves a
 *    ferret itself — but before stopping one it offers it to the Warden (`relocate`), which moves it to another
 *    login when, and only when, the owner switched `autoMigrate` on for `budget_exceeded` in warden.yaml.
 *
 * IDEMPOTENT. A session already stopped is not stopped again; one that keeps running (a stop that failed)
 * is tried again next tick. Which (login, period) the owner was told about is kept in the state home, so a
 * restart never tells them twice. One tick runs at a time.
 *
 * ACROSS A RESTART. The first tick after a boot reads the whole week before it can judge anything, and a
 * fleet published in the meantime must not hand a held login back. So the holds last published are kept in
 * the state home too, and a new service starts from them (those whose reset is still ahead).
 *
 * DECLARED: a tick can come up to a minute after the request that crossed a limit, and a turn in flight
 * finishes its current request before the interrupt lands — so the hard limit can be overshot by that much.
 */
import type { BudgetHold, BudgetPeriod } from '@ferretry/fleet';
import { usdWords } from '@ferretry/fleet';
import type { FleetCredentialBudget } from '@ferretry/protocol';
import type { SpendMeter } from './meter.ts';
import {
  type BudgetedLogin,
  budgetView,
  holdsKey,
  type LoginBudgetState,
  loginBudgetState,
  meterSinceMs,
} from './state.ts';

/** How often the budgets are checked. The same minimum the provider quota reads keep. */
export const BUDGET_TICK_MS = 60_000;

/** What the configuration says about budgets now. */
export interface BudgetConfig {
  /** The zone written in machine.yaml, or `undefined` for the host's own. */
  readonly timeZone?: string;
  readonly logins: readonly BudgetedLogin[];
}

/** A live session on a budgeted login. */
export interface BudgetSession {
  readonly id: string;
  /** How the owner knows it: its callsign or label. */
  readonly name: string;
  readonly agent: string;
}

/** The one notice a hard limit sends. */
export interface BudgetNotice {
  /** The session the notice is raised on: the first one stopped, else the login's most recent. */
  readonly anchor: BudgetSession;
  readonly login: string;
  readonly period: BudgetPeriod;
  readonly spentUsd: number;
  readonly hardUsd: number;
  readonly resetsAtMs: number;
  readonly timeZone: string;
  readonly stopped: readonly BudgetSession[];
  /** Sessions the Warden moved to another login instead (`autoMigrate`). Absent: none were. */
  readonly relocated?: readonly BudgetSession[];
  /** Sessions it could not stop this tick: tried again at the next one. */
  readonly failed: readonly BudgetSession[];
  /** A runtime of the same kind on a login within its budget, to suggest for `fy migrate`, when there is one. */
  readonly alternative?: string;
}

export interface BudgetServicePorts {
  /**
   * What the configuration says now. THROWS when any part of it cannot be read (the published manifest
   * included): the tick is then skipped and the last states and holds stay, because a budget judged on
   * missing data would read as nothing spent and lift every hold.
   */
  config(): Promise<BudgetConfig>;
  /** The host's own zone, for a machine.yaml that names none. */
  hostTimeZone(): string;
  readonly meter: SpendMeter;
  nowMs(): number;
  /** Publish the fleet again, so a hold that moved reads as it is now. */
  republish(): Promise<void>;
  /** The live sessions running as any of `agents`. */
  liveSessions(agents: ReadonlySet<string>): Promise<readonly BudgetSession[]>;
  /** Interrupt a session's turn, wait for it to settle, then stop it with its turn saved. */
  stop(session: BudgetSession, reason: string): Promise<void>;
  /**
   * Offer the session to the Warden before it is stopped: answers whether it was moved to another login — then
   * there is nothing left to stop. Absent, or answering `false`, the session is stopped as always.
   */
  readonly relocate?: (session: BudgetSession, reason: string) => Promise<boolean>;
  /** The session most recently active on `agents`, to carry a notice when no ferret was running to stop. */
  recentSession(agents: ReadonlySet<string>): Promise<BudgetSession | undefined>;
  /** A runtime of the same kind as one on `login` whose login nothing holds, for the notice. */
  alternative(login: string, holds: Readonly<Record<string, BudgetHold>>): Promise<string | undefined>;
  notify(notice: BudgetNotice): Promise<void>;
  /** The holds last published, kept so a restart starts from them; `undefined` when it cannot be kept. */
  readonly remember?: (holds: Readonly<Record<string, BudgetHold>>) => Promise<void>;
  /** The (login, period, period start) keys the owner was already told about. */
  readonly told: { read(): Promise<readonly string[]>; write(keys: readonly string[]): Promise<void> };
}

const toldKey = (login: string, period: BudgetPeriod, startMs: number): string =>
  `${login}|${period}|${new Date(startMs).toISOString()}`;

export class BudgetService {
  #states: ReadonlyMap<string, LoginBudgetState> = new Map();
  #holds: Readonly<Record<string, BudgetHold>> = {};
  /** The holds last published; `undefined` until the first publish, so a restart publishes once. */
  #publishedKey: string | undefined;
  /**
   * Every notice sent by this process, as well as the record on disk: a state file that cannot be read or
   * written must not turn one notice into one a minute.
   */
  readonly #told = new Set<string>();
  #running: Promise<void> | undefined;

  /** `restored`: the holds the last daemon published, read back at boot; only those still ahead are kept. */
  constructor(
    private readonly ports: BudgetServicePorts,
    restored: Readonly<Record<string, BudgetHold>> = {},
  ) {
    const now = ports.nowMs();
    this.#holds = Object.fromEntries(Object.entries(restored).filter(([, hold]) => hold.resetsAtMs > now));
  }

  /** The logins their budget holds now, for a publish. */
  holds(): Readonly<Record<string, BudgetHold>> {
    return this.#holds;
  }

  /** A login's standing, for its credentials view; `undefined` when it has no budget (or none is read yet). */
  view(login: string): FleetCredentialBudget | undefined {
    const state = this.#states.get(login);
    return state === undefined ? undefined : budgetView(state, this.ports.meter.measured);
  }

  /** One check. A second call while one runs joins it. Never rejects. */
  async tick(): Promise<void> {
    if (this.#running !== undefined) return await this.#running;
    this.#running = this.#tick()
      .catch(() => undefined)
      .finally(() => {
        this.#running = undefined;
      });
    return await this.#running;
  }

  async #tick(): Promise<void> {
    const config = await this.ports.config();
    const now = this.ports.nowMs();
    const timeZone = config.timeZone ?? this.ports.hostTimeZone();
    const agents = new Set(config.logins.flatMap(login => login.agents));
    if (config.logins.length > 0) await this.ports.meter.refresh(meterSinceMs(now, timeZone), agents);

    const states = new Map(
      config.logins.map(login => [
        login.id,
        loginBudgetState(
          login,
          (wanted, span) => this.ports.meter.spent(wanted, span.startMs, Math.min(span.endMs, now + 1)),
          now,
          timeZone,
          config.timeZone !== undefined,
        ),
      ]),
    );
    const holds = Object.fromEntries(
      [...states.values()].flatMap(state => (state.hold === undefined ? [] : [[state.id, state.hold] as const])),
    );
    this.#states = states;
    this.#holds = holds;

    const key = holdsKey(holds);
    try {
      if (key !== this.#publishedKey) {
        await this.ports.remember?.(holds).catch(() => undefined);
        // Remembered only once it landed: a publish that failed is tried again next tick.
        await this.ports.republish();
        this.#publishedKey = key;
      }
    } finally {
      // THE HARD LIMIT NEVER WAITS ON THE PUBLISH. A fleet that will not publish — an unrelated runtime
      // the provisioner refuses — must not keep a login's ferrets running past their hard limit.
      for (const state of states.values()) {
        if (state.level === 'over_hard') await this.#enforce(state, holds).catch(() => undefined);
      }
    }
  }

  /** Stop what runs on a login past its hard limit, and tell the owner once per period. */
  async #enforce(state: LoginBudgetState, holds: Readonly<Record<string, BudgetHold>>): Promise<void> {
    const period = (['weekly', 'daily'] as const).find(name => state.periods[name]?.level === 'over_hard');
    const over = period === undefined ? undefined : state.periods[period];
    if (period === undefined || over === undefined || over.limit.hard === undefined) return;
    const live = await this.ports.liveSessions(new Set(state.agents));
    const reason = `its login "${state.id}" spent ${usdWords(over.spentUsd)} this ${period === 'daily' ? 'day' : 'week'} on this machine, past its ${usdWords(over.limit.hard)} hard limit`;
    const stopped: BudgetSession[] = [];
    const failed: BudgetSession[] = [];
    const relocated: BudgetSession[] = [];
    for (const session of live) {
      const moved = (await this.ports.relocate?.(session, reason).catch(() => false)) === true;
      if (moved) {
        relocated.push(session);
        continue;
      }
      await this.ports.stop(session, reason).then(
        () => stopped.push(session),
        () => failed.push(session),
      );
    }
    const key = toldKey(state.id, period, over.span.startMs);
    if (this.#told.has(key)) return;
    const told = await this.ports.told.read().catch((): readonly string[] => []);
    if (told.includes(key)) {
      this.#told.add(key);
      return;
    }
    const anchor =
      stopped[0] ??
      relocated[0] ??
      failed[0] ??
      (await this.ports.recentSession(new Set(state.agents)).catch(() => undefined));
    // No session ever ran on it here, so nobody to tell it on yet: the next tick looks again.
    if (anchor === undefined) return;
    const alternative = await this.ports.alternative(state.id, holds).catch(() => undefined);
    await this.ports.notify({
      anchor,
      login: state.id,
      period,
      spentUsd: over.spentUsd,
      hardUsd: over.limit.hard,
      resetsAtMs: over.span.endMs,
      timeZone: state.timeZone,
      stopped,
      failed,
      ...(relocated.length === 0 ? {} : { relocated }),
      ...(alternative === undefined ? {} : { alternative }),
    });
    // Keys for periods long gone are let go, so the record stays a handful of lines.
    const recent = told.filter(entry => {
      const at = Date.parse(entry.split('|')[2] ?? '');
      return Number.isFinite(at) && at >= over.span.startMs - 14 * 86_400_000;
    });
    this.#told.add(key);
    await this.ports.told.write([...recent, key]).catch(() => undefined);
  }
}
