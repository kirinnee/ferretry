/**
 * A SESSION'S AGENDA HOME (docs/agenda.md § Sub-ferret agenda): the one session whose agenda the daemon asks the
 * owner on behalf of `sessionId`. Never a sub-ferret.
 *
 * 1. Walk `parent` up to the root. A walk that stops short of a root (a parent that cannot be read, a loop, a chain
 *    past the bound) found no owner: it is BROKEN, not rooted at the last session it reached.
 * 2. A root the owner started (origin `human`, or no stamp: never hide an item on a guess) is the home.
 * 3. Else (a Warden's or another session's orphan, or a broken lineage): the owner's most recently updated
 *    interactive session on the same project.
 * 4. Else the machine-wide agenda, when it exists.
 * 5. Else the root itself; a broken lineage keeps the item on the session it was raised for, and says so.
 */
import type { AgendaItem } from '@ferretry/protocol';
import type { AgendaActor, RaiseAgendaRequest } from './state-machine.ts';

/** Deepest lineage the walk follows; a longer chain is a loop or an accident. */
export const MAX_HOME_CHAIN = 16;

/** What the home rule reads of one session: its configuration document. */
export interface HomeSession {
  readonly id: string;
  readonly parent?: string;
  readonly origin?: 'human' | 'session' | 'warden';
  readonly mode: string;
  readonly projectId?: string;
  /** `config.updatedAt`: the recency the rule picks the owner's latest interactive session by. */
  readonly updatedAt: string;
}

export interface HomeSessions {
  /** `undefined` for a session the daemon cannot read. */
  get(sessionId: string): Promise<HomeSession | undefined>;
  all(): Promise<readonly string[]>;
}

/** The machine-wide agenda's session. */
export interface MachineAgendaHome {
  /** `undefined` until the machine-wide agenda exists. */
  home(): Promise<string | undefined>;
}

// TODO(F439 PR 4b): wire the machine-wide agenda (feat/machine-agenda) in place of this.
export const NO_MACHINE_AGENDA: MachineAgendaHome = { home: async () => undefined };

/** Where the daemon asks the owner for a session. */
export interface AgendaHomeResolver {
  of(sessionId: string): Promise<string>;
}

/** Every session is its own home: the default for a service built without lineage. */
export const SELF_AGENDA_HOME: AgendaHomeResolver = { of: async sessionId => sessionId };

const ownerStarted = (session: HomeSession): boolean => session.origin === undefined || session.origin === 'human';

/** Where a daemon diagnostic goes: the daemon's log. */
export interface AgendaHomeDiagnostics {
  warn(message: string): void;
}

export class AgendaHomes implements AgendaHomeResolver {
  constructor(
    private readonly sessions: HomeSessions,
    private readonly machine: MachineAgendaHome = NO_MACHINE_AGENDA,
    private readonly diagnostics: AgendaHomeDiagnostics = { warn: () => undefined },
  ) {}

  async of(sessionId: string): Promise<string> {
    const { first, last, rooted } = await this.walk(sessionId);
    if (first === undefined || last === undefined) return sessionId;
    if (rooted && ownerStarted(last)) return last.id;
    const latest = await this.latestInteractive((rooted ? last : first).projectId);
    if (latest !== undefined) return latest.id;
    const machine = await this.machine.home().catch(() => undefined);
    if (machine !== undefined) return machine;
    if (rooted) return last.id;
    this.diagnostics.warn(
      `the lineage of ${sessionId} is broken at ${last.id} (its parent cannot be read, or the chain loops), and the owner has no interactive session for its project: its asks stay on ${sessionId}`,
    );
    return sessionId;
  }

  /** The session itself, the last one the walk reached, and whether that one is a root (has no parent). */
  private async walk(sessionId: string): Promise<{
    readonly first?: HomeSession;
    readonly last?: HomeSession;
    readonly rooted: boolean;
  }> {
    const seen = new Set<string>();
    let first: HomeSession | undefined;
    let last: HomeSession | undefined;
    let rooted = false;
    let next: string | undefined = sessionId;
    while (next !== undefined && !seen.has(next) && seen.size < MAX_HOME_CHAIN) {
      const session: HomeSession | undefined = await this.sessions.get(next).catch(() => undefined);
      if (session === undefined) break;
      seen.add(next);
      first ??= session;
      last = session;
      next = session.parent === undefined || session.parent === '' ? undefined : session.parent;
      rooted = next === undefined;
    }
    return { ...(first === undefined ? {} : { first }), ...(last === undefined ? {} : { last }), rooted };
  }

  private async latestInteractive(projectId: string | undefined): Promise<HomeSession | undefined> {
    let latest: HomeSession | undefined;
    for (const id of await this.sessions.all().catch(() => [] as readonly string[])) {
      const session: HomeSession | undefined = await this.sessions.get(id).catch(() => undefined);
      if (
        session === undefined ||
        session.mode !== 'interactive' ||
        (session.parent !== undefined && session.parent !== '') ||
        !ownerStarted(session) ||
        session.projectId !== projectId
      )
        continue;
      if (latest === undefined || Date.parse(session.updatedAt) > Date.parse(latest.updatedAt)) latest = session;
    }
    return latest;
  }
}

/** Daemon causes whose card only the session it names can consume: the owner's answer goes into its pane or form. */
const HANDS_ON_CAUSES: ReadonlySet<string> = new Set([
  'harness-prompt',
  'input-request',
  'phone-approval',
  'secure-copy',
  'login-recipe',
]);

/** Whether a daemon raise is a hands-on card: it stays on the session it is about, sub-ferret or not. */
export const handsOnRaise = (request: RaiseAgendaRequest, actor: AgendaActor): boolean =>
  actor.kind === 'daemon' &&
  (HANDS_ON_CAUSES.has(actor.cause) ||
    request.input !== undefined ||
    request.phoneApproval !== undefined ||
    request.copyPlan !== undefined ||
    request.taskPlan !== undefined ||
    request.signInRuleSuggestion !== undefined ||
    request.twoFactorSeed !== undefined ||
    request.confirms !== undefined);

/** Whether a daemon's resolve-by-source is about a hands-on card (only the cause is known there). */
export const handsOnSource = (actor: AgendaActor): boolean =>
  actor.kind === 'daemon' && HANDS_ON_CAUSES.has(actor.cause);

/** Whether an open item is a hands-on card, read from the item itself (the migration has no raiser to ask). */
export const handsOnItem = (item: AgendaItem): boolean =>
  item.source === 'question' ||
  item.input !== undefined ||
  item.phoneApproval !== undefined ||
  item.copyPlan !== undefined ||
  item.taskPlan !== undefined ||
  item.signInRuleSuggestion !== undefined ||
  item.signInRuleSuspended !== undefined ||
  item.twoFactorSeed !== undefined ||
  item.confirms !== undefined;
