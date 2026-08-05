/**
 * The proposal lifecycle: a reviewed change that exists only in memory until it is authorized.
 *
 * The alternative — save the configuration, then apply a plan rebuilt from disk — cannot honour
 * "review before anything changes", because by the time the plan is rebuilt the host has already
 * been edited, and the plan applied is not the plan approved. So a proposal holds the whole change:
 * the revision it was derived from, the one mutation asked for, the asset text it carries, the
 * candidate configuration the daemon derived, and the exact preview that was shown. Applying
 * consumes that stored value and never re-reads a request body.
 *
 * Everything a paired client controls is bounded — how many proposals may exist, how long they
 * live, how many approval attempts each tolerates — because a client that can make a daemon hold
 * memory indefinitely has found a way to take the daemon down without any credential at all.
 *
 * Pure apart from injected identity and time.
 */
import { FLEET_APPROVAL_MAX_ATTEMPTS, FLEET_APPROVAL_TTL_SECONDS, FleetApprovalCodeSchema } from '@ferretry/protocol';
import { secretsMatch } from '../api/authentication.ts';
import type { FleetAssetEdit, FleetAssetRevision } from './assets.ts';
import type { FleetMutation } from './mutations.ts';

/** How many proposals one daemon will hold at once, across every client. */
export const MAX_OPEN_PROPOSALS = 8;
/** How many applied changes are remembered, so a repeat apply is told it already happened. */
const MAX_CONSUMED_TOMBSTONES = 16;
/** How many times a repeated handle is tolerated before the identity source is called broken. */
const ID_MINT_ATTEMPTS = 4;
/** How long a reviewed change stays applicable. Long enough to read, short enough to be current. */
export const PROPOSAL_TTL_SECONDS = 15 * 60;

/**
 * Read what a person actually typed — spaces, lower case, a missing dash — and check the grammar.
 *
 * The grammar is the shared one from the protocol package. A second copy here would be a second
 * description of the code the command line prints and the browser submits, and three descriptions
 * of one thing are three things waiting to disagree.
 */
export function normalizeApprovalCode(candidate: string): string | undefined {
  const parsed = FleetApprovalCodeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** The sentinel revision for a host that has no fleet configuration at all. */
export const MISSING_CONFIG_REVISION = 'absent';

type FleetProposalState = 'pending' | 'consumed';

export interface FleetProposalRecord<Payload> {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Digest of the raw configuration this change was derived from, or the missing sentinel. */
  readonly revision: string;
  readonly mutation: FleetMutation;
  readonly assetEdits: readonly FleetAssetEdit[];
  /** What every edited asset looked like at review time, so a newer one refuses rather than losing. */
  readonly assetRevisions: readonly FleetAssetRevision[];
  /**
   * The exact artifact that produced the preview — the plan, the scaffold and the documents, built
   * once. Apply consumes this and never rebuilds: a rebuilt plan carries a new timestamp at
   * minimum, and may differ in any way the filesystem has changed since, so what landed would not
   * be what was reviewed.
   */
  readonly payload: Payload;
  /** One-line, server-derived description of what is being approved. */
  readonly summary: string;
  state: FleetProposalState;
  approval: { code: string; expiresAt: number; attempts: number } | undefined;
}

/** What a caller may see about a proposal. Never the approval code — see `redact`. */
export interface FleetProposalView<View> {
  readonly id: string;
  readonly revision: string;
  readonly mutation: FleetMutation;
  readonly summary: string;
  readonly expiresAt: string;
  readonly state: FleetProposalState;
  readonly assetEdits: readonly { readonly path: string; readonly bytes: number }[];
  readonly preview: View;
  /** Whether an approval is outstanding, and until when. The value itself is never disclosed. */
  readonly approval: { readonly outstanding: true; readonly expiresAt: string } | undefined;
}

export type FleetProposalProblem = 'unknown' | 'expired' | 'consumed' | 'unauthorized' | 'exhausted';

export class FleetProposalRefusal extends Error {
  constructor(
    readonly problem: FleetProposalProblem,
    message: string,
  ) {
    super(message);
    this.name = 'FleetProposalRefusal';
  }
}

export interface FleetProposalStoreOptions {
  readonly now: () => number;
  /** 22 URL-safe characters, supplied so identity is never derived from a clock. */
  readonly mintId: () => string;
  /**
   * One approval code in the shared grammar. Required, and supplied by the composition root: this
   * layer is not allowed to reach for randomness, and generating a code here would also put the
   * choice of *how* the randomness maps onto the alphabet somewhere nobody reviews it.
   */
  readonly mintCode: () => string;
}

/**
 * Bounded, expiring, single-use proposals for one daemon.
 *
 * Reads are non-destructive but never free: every accessor first retires whatever has expired, so a
 * client cannot keep a stale proposal alive by looking at it, and the bound on open proposals is a
 * bound on live ones rather than on ones ever created.
 */
export class FleetProposalStore<Payload> {
  readonly #proposals = new Map<string, FleetProposalRecord<Payload>>();
  constructor(private readonly options: FleetProposalStoreOptions) {}

  open(
    input: Omit<FleetProposalRecord<Payload>, 'id' | 'createdAt' | 'expiresAt' | 'state' | 'approval'>,
  ): FleetProposalRecord<Payload> {
    this.retireExpired();
    // Only proposals that could still be applied occupy a slot. A consumed one is kept so a repeat
    // apply can be told it already happened, but counting it would mean eight successful changes
    // locked the fleet out of any further change until they timed out — and the refusal would tell
    // a person to apply or abandon something they had already applied.
    if (this.openCount() >= MAX_OPEN_PROPOSALS) {
      throw new FleetProposalRefusal(
        'exhausted',
        `this daemon already holds ${MAX_OPEN_PROPOSALS} fleet changes awaiting review; apply one or let it expire before proposing another`,
      );
    }
    this.retireOldestConsumed();
    const createdAt = this.options.now();
    const record: FleetProposalRecord<Payload> = {
      ...input,
      id: this.freeId(),
      createdAt,
      expiresAt: createdAt + PROPOSAL_TTL_SECONDS * 1000,
      state: 'pending',
      approval: undefined,
    };
    this.#proposals.set(record.id, record);
    return record;
  }

  /**
   * A handle nothing already holds.
   *
   * Storing under a repeated identifier would silently replace a change somebody else is reviewing
   * — and, worse, hand them an approval for a proposal that is no longer the one they read. A few
   * retries cover the accident; beyond that the identity source is broken and saying so is better
   * than looping.
   */
  private freeId(): string {
    for (let attempt = 0; attempt < ID_MINT_ATTEMPTS; attempt += 1) {
      const id = `fy_fprop_${this.options.mintId()}`;
      if (!this.#proposals.has(id)) return id;
    }
    throw new FleetProposalRefusal(
      'exhausted',
      'could not mint an unused fleet proposal handle; the daemon will not replace a change already held',
    );
  }

  /**
   * The live proposal with this id, or a refusal naming exactly why it cannot be used.
   *
   * Expiry is decided for *this* proposal before the sweep runs. Retiring first and then failing to
   * find it would report every timed-out change as one that never existed, and send a person
   * looking for a typo in an id that was correct.
   */
  require(id: string): FleetProposalRecord<Payload> {
    const record = this.#proposals.get(id);
    if (record !== undefined && record.expiresAt <= this.options.now()) {
      this.#proposals.delete(id);
      throw new FleetProposalRefusal(
        'expired',
        `fleet proposal "${id}" expired before it was applied; review the change again`,
      );
    }
    this.retireExpired();
    if (record === undefined) {
      throw new FleetProposalRefusal('unknown', `no open fleet proposal with id "${id}" on this daemon`);
    }
    if (record.state === 'consumed') {
      throw new FleetProposalRefusal('consumed', `fleet proposal "${id}" has already been applied`);
    }
    return record;
  }

  /**
   * Mint an approval for one proposal, replacing any previous one.
   *
   * Replacing matters: two live codes for one change means a code a person abandoned still works,
   * and the attempt budget of the one they are using no longer bounds anything.
   */
  authorize(id: string): { record: FleetProposalRecord<Payload>; code: string; expiresAt: number } {
    const record = this.require(id);
    const code = this.options.mintCode();
    const expiresAt = this.options.now() + FLEET_APPROVAL_TTL_SECONDS * 1000;
    record.approval = { code, expiresAt, attempts: 0 };
    return { record, code, expiresAt };
  }

  /**
   * Check a presented code and consume the proposal in the same synchronous step.
   *
   * Consuming before the caller can await anything is what makes "single use" true: two applies
   * arriving together would otherwise both pass the check and both run.
   */
  consume(id: string, presented: string | undefined): FleetProposalRecord<Payload> {
    const record = this.require(id);
    // Offering nothing is not a guess. Spending a try on it would let a client that never had a
    // code burn the budget of the person who does, which is a denial of the approval, not of the
    // client.
    if (presented === undefined || presented === '') {
      throw new FleetProposalRefusal(
        'unauthorized',
        `applying fleet proposal "${id}" from this device needs an approval code minted on the host`,
      );
    }
    const approval = record.approval;
    if (approval === undefined) {
      throw new FleetProposalRefusal(
        'unauthorized',
        `fleet proposal "${id}" has no approval outstanding; run the authorize command on the host to mint one`,
      );
    }
    if (approval.attempts >= FLEET_APPROVAL_MAX_ATTEMPTS) {
      throw new FleetProposalRefusal(
        'exhausted',
        `fleet proposal "${id}" refused ${FLEET_APPROVAL_MAX_ATTEMPTS} approval codes and accepts no more; mint a new approval`,
      );
    }
    // At the instant it expires it is expired. A boundary that admits one more millisecond is a
    // boundary nobody can state, and the test that pins it would have to encode the same slack.
    if (this.options.now() >= approval.expiresAt) {
      record.approval = undefined;
      throw new FleetProposalRefusal('expired', `the approval for fleet proposal "${id}" has expired; mint a new one`);
    }
    // Counted before the comparison, so a wrong guess costs a try whichever way the compare goes.
    approval.attempts += 1;
    const offered = normalizeApprovalCode(presented);
    if (offered === undefined || !secretsMatch(offered, approval.code)) {
      throw new FleetProposalRefusal('unauthorized', `that approval code is not the one minted for proposal "${id}"`);
    }
    record.state = 'consumed';
    record.approval = undefined;
    this.retireOldestConsumed();
    return record;
  }

  /** Consume without a code, for a caller whose credential already authorises the change. */
  consumeAsHost(id: string): FleetProposalRecord<Payload> {
    const record = this.require(id);
    record.state = 'consumed';
    record.approval = undefined;
    this.retireOldestConsumed();
    return record;
  }

  /** Put a consumed proposal back, when the apply it authorised never reached the host. */
  restore(record: FleetProposalRecord<Payload>): void {
    if (this.#proposals.has(record.id)) record.state = 'pending';
  }

  /** How many changes are still applicable. Consumed records are history, not capacity. */
  private openCount(): number {
    let open = 0;
    for (const record of this.#proposals.values()) {
      if (record.state === 'pending') open += 1;
    }
    return open;
  }

  /**
   * Keep the consumed tombstones bounded. They exist so a repeated apply is told "already applied"
   * rather than "never heard of it", which is worth a little memory and not an unbounded amount.
   */
  private retireOldestConsumed(): void {
    const consumed = [...this.#proposals.values()]
      .filter(record => record.state === 'consumed')
      .toSorted((left, right) => left.createdAt - right.createdAt);
    // Trimmed the moment one is added, not on the next unrelated call: waiting would let the bound
    // be exceeded for as long as nobody happens to propose anything.
    for (const record of consumed.slice(0, Math.max(0, consumed.length - MAX_CONSUMED_TOMBSTONES))) {
      this.#proposals.delete(record.id);
    }
  }

  private retireExpired(): void {
    const now = this.options.now();
    for (const [id, record] of this.#proposals) {
      if (record.expiresAt <= now) this.#proposals.delete(id);
    }
  }
}

/** The disclosable view of a proposal. The approval code is structurally absent, not filtered. */
export function redactProposal<Payload, View>(
  record: FleetProposalRecord<Payload>,
  viewOf: (payload: Payload) => View,
): FleetProposalView<View> {
  return {
    id: record.id,
    revision: record.revision,
    mutation: record.mutation,
    summary: record.summary,
    expiresAt: new Date(record.expiresAt).toISOString(),
    state: record.state,
    assetEdits: record.assetEdits.map(edit => ({
      path: edit.path,
      bytes: new TextEncoder().encode(edit.content).length,
    })),
    preview: viewOf(record.payload),
    approval:
      record.approval === undefined
        ? undefined
        : { outstanding: true, expiresAt: new Date(record.approval.expiresAt).toISOString() },
  };
}
