/**
 * The first run's credential seed — how a fleet a boot just created arrives already signed in.
 *
 * Until this module, `docs/fleet-defaults.md` closed with a gap in its own words: "Nothing signs the
 * new accounts in." A host that had Claude Code installed, signed in, and working got four accounts
 * with four homes and no credential in any of them, and the first thing it could do was ask the
 * person who had already logged in to log in again — three more times. The login they had was sitting
 * on the same machine, in the same shape, readable by the same code that copies a credential between
 * two lanes of one fleet account. So this copies it.
 *
 * ## IT IS AN IMPORT, NOT A SYNC, AND THE DIFFERENCE IS THE WHOLE DESIGN
 *
 * A seeded account's credential is ITS OWN from the moment it lands. Nothing here watches the donor,
 * re-reads it, or repairs a copy that has since expired — {@link FleetFirstRunSeeder} skips any
 * account that already has one, so a second start after a first is a few file reads and no writes.
 *
 * An ongoing sync was the obvious alternative and it is unbuildable: the harness rewrites its own
 * credential whenever it refreshes a token, by writing a temporary file and renaming it over the old
 * one. A synchroniser would be racing that rename forever, would lose, and would lose SILENTLY —
 * replacing a token the harness had just refreshed with the one it had just replaced. The honest
 * shape is one copy at one moment, and everything after it belongs to the account that holds it.
 *
 * The consequence is stated rather than hidden: signing the DONOR out does not sign the fleet out,
 * and re-signing the donor in does not refresh the fleet. Both are properties a person has to be told
 * about, which is why every outcome below is a sentence a boot says rather than a code it swallows.
 *
 * ## WHAT IT REFUSES TO OVERWRITE
 *
 * Only a `missing` credential is seeded. `unreadable` is a state here for the reason it is a state in
 * {@link module:identity}: a locked keychain, a timed-out read and a credential written by a newer
 * harness all produce bytes this build could not classify, and treating "I could not tell" as "there
 * is nothing there" is how a working login gets destroyed by a convenience. So an account whose own
 * credential could not be read is REFUSED and named, never seeded over.
 *
 * ## NO CREDENTIAL CROSSES THIS BOUNDARY
 *
 * Every function here works in {@link CredentialReading}s and {@link CredentialCloneOutcome}s — a
 * verdict and an ok/why — and the copy itself happens end to end inside the store, which is an
 * adapter. Nothing in this module can hold material, so no outcome, message or boot line can carry
 * one. That is a property of the types rather than of anybody's care: there is no accessor to misuse.
 *
 * Nothing here launches a harness or reaches a provider. A seed is at most two local reads and one
 * local write per account, which is what lets it run unconditionally on a boot that must not spend.
 */

import { HARNESS_LABEL } from './defaults.ts';
import {
  type CredentialCloneOutcome,
  type CredentialReading,
  failureMessage,
  fleetIdentityMemberOf,
  type FleetCredentialStore,
  type FleetIdentityMember,
} from './identity.ts';
import { type FleetManifestAccount, type HarnessKind, wrapperNameOf } from './manifest.ts';

/**
 * The host's own harness install, shaped as the member a credential store can read and copy from.
 *
 * IT IS NOT AN ACCOUNT and it never becomes one: it has no id the manifest minted, no wrapper the
 * fleet generated and no lane. The store reads `home` and nothing else, so the remaining fields exist
 * only because the type is the store's — and each is spelled to say what this is rather than to
 * impersonate a fleet member, because a synthesised uuid here would be indistinguishable from an
 * account somebody could go and look for.
 */
export function hostHarnessInstall(kind: HarnessKind, home: string): FleetIdentityMember {
  return {
    accountId: `host:${kind}`,
    wrapper: kind,
    home,
    displayName: `this host's own ${HARNESS_LABEL[kind]} install`,
    mode: 'interactive',
    available: true,
    unavailableReason: null,
  };
}

/**
 * One account a first run may seed.
 *
 * A PUBLISHED MANIFEST ACCOUNT, because that is what the caller holds and what decides everything
 * here: the harness whose credential shape applies, the home the copy lands in, and the wrapper name
 * a person reads in the boot line. {@link fleetIdentityMemberOf} is the one mapping from it to the
 * shape a credential store reads — the same one `identity` uses, rather than a second spelling that
 * could disagree about which field carries the home.
 */
export type FleetSeedTarget = FleetManifestAccount;

/**
 * What happened to one account, as six distinct facts rather than a boolean.
 *
 * Each one sends a reader somewhere different — nowhere, to their own harness to sign in, to a
 * keychain prompt they dismissed, to a disk that is full — so collapsing any pair of them into "not
 * seeded" would produce the one thing this feature exists to remove: a person who cannot tell whether
 * their fleet is ready and has nothing to act on either way.
 */
export type FleetSeedOutcome =
  /** The host's own login was copied into this account's home. It is this account's own from now on. */
  | { readonly kind: 'seeded'; readonly donorHome: string }
  /** It already had a credential. Seeding is an import, so an existing one is never replaced. */
  | { readonly kind: 'kept' }
  /** Nothing to copy from: this host's own install of that harness holds no usable login. */
  | { readonly kind: 'no-donor'; readonly donorHome: string }
  /** There are bytes there and this build could not classify them. Never treated as an absence. */
  | { readonly kind: 'donor-unreadable'; readonly donorHome: string; readonly reason: string }
  /** THIS ACCOUNT'S own credential could not be read, so nothing was written over it. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The copy was attempted and did not land. The account is exactly as it was. */
  | { readonly kind: 'failed'; readonly reason: string };

export interface FleetSeedResult {
  /** The wrapper NAME a person reads — what a boot line says and what `fleet ls` prints. */
  readonly account: string;
  readonly kind: HarnessKind;
  readonly outcome: FleetSeedOutcome;
}

/** Where each harness's own credential lives on this host, by the fleet's one owner of that fact. */
export type FleetSeedDonorHomes = Readonly<Record<HarnessKind, string>>;

/**
 * Copies this host's own harness login onto the accounts a first run just created.
 *
 * Sequential, because every step of it writes or may prompt: on macOS a Claude read is a keychain
 * read, and a keychain the operator has locked shows a dialog. Concurrent reads there would stack
 * dialogs on somebody starting a daemon.
 *
 * The DONOR IS READ ONCE PER HARNESS, not once per account. Four default accounts share two donors,
 * and asking the same keychain item four questions is four chances to block a boot for the answer it
 * already had. The copy itself re-reads and re-classifies the donor inside the store, which is the
 * point at which a credential that changed between the survey and the write is refused — so the
 * memoised verdict here decides only whether to ATTEMPT a copy, never whether one is safe.
 */
export class FleetFirstRunSeeder {
  constructor(private readonly store: FleetCredentialStore) {}

  async seed(targets: readonly FleetSeedTarget[], donors: FleetSeedDonorHomes): Promise<readonly FleetSeedResult[]> {
    const surveyed = new Map<HarnessKind, CredentialReading>();
    const results: FleetSeedResult[] = [];
    for (const target of targets) {
      results.push({
        account: wrapperNameOf(target.wrapper),
        kind: target.kind,
        outcome: await this.#seedOne(target, donors[target.kind], surveyed),
      });
    }
    return results;
  }

  /**
   * One account, in the order that makes a re-run cheap and safe.
   *
   * THE TARGET IS READ FIRST. A host that has already been seeded then asks its donor nothing at all,
   * which on macOS is the difference between a silent second start and one that raises a keychain
   * prompt for a copy it was never going to make.
   */
  async #seedOne(
    target: FleetSeedTarget,
    donorHome: string,
    surveyed: Map<HarnessKind, CredentialReading>,
  ): Promise<FleetSeedOutcome> {
    const member = fleetIdentityMemberOf(target);
    const own = await this.#read(target.kind, member);
    if (own.state === 'unreadable') {
      return { kind: 'refused', reason: own.reason ?? 'this account credential could not be read' };
    }
    if (own.state !== 'missing') return { kind: 'kept' };

    const donor = await this.#donor(target.kind, donorHome, surveyed);
    if (donor.state === 'unreadable') {
      return {
        kind: 'donor-unreadable',
        donorHome,
        reason: donor.reason ?? 'the credential could not be read',
      };
    }
    if (donor.state === 'missing') return { kind: 'no-donor', donorHome };

    const copied = await this.#clone(target.kind, hostHarnessInstall(target.kind, donorHome), member);
    return copied.ok ? { kind: 'seeded', donorHome } : { kind: 'failed', reason: copied.reason };
  }

  async #donor(
    kind: HarnessKind,
    home: string,
    surveyed: Map<HarnessKind, CredentialReading>,
  ): Promise<CredentialReading> {
    const already = surveyed.get(kind);
    if (already !== undefined) return already;
    const reading = await this.#read(kind, hostHarnessInstall(kind, home));
    surveyed.set(kind, reading);
    return reading;
  }

  /** A store that throws is a read that failed, not a home with no credential. */
  async #read(kind: HarnessKind, member: FleetIdentityMember): Promise<CredentialReading> {
    try {
      return await this.store.read(kind, member);
    } catch (error) {
      return { state: 'unreadable', reason: failureMessage(error, 'the credential could not be read') };
    }
  }

  async #clone(
    kind: HarnessKind,
    donor: FleetIdentityMember,
    target: FleetIdentityMember,
  ): Promise<CredentialCloneOutcome> {
    try {
      return await this.store.clone(kind, donor, target);
    } catch (error) {
      return { ok: false, reason: failureMessage(error, 'the credential could not be copied') };
    }
  }
}

/**
 * One harness's share of a seed: which accounts it covered and the home it read.
 *
 * GROUPED BY HARNESS rather than listed per account, because both the good news and the bad news are
 * facts about the HOST. Two Claude accounts that were not seeded were not seeded for ONE reason, and
 * saying it twice reads as two problems; two that were seeded carry one login, and naming the donor
 * home once is what lets somebody go and check it.
 */
export interface FleetSeedGroup {
  readonly kind: HarnessKind;
  /** The harness as a person reads it — `Claude`, not `claude`. */
  readonly label: string;
  /** The home the credential was read from, absolute. */
  readonly donorHome: string;
  readonly accounts: readonly string[];
}

function groupByHarness(
  results: readonly FleetSeedResult[],
  select: (outcome: FleetSeedOutcome) => string | undefined,
): readonly FleetSeedGroup[] {
  const grouped = new Map<HarnessKind, { donorHome: string; accounts: string[] }>();
  for (const result of results) {
    const donorHome = select(result.outcome);
    if (donorHome === undefined) continue;
    const existing = grouped.get(result.kind);
    if (existing === undefined) grouped.set(result.kind, { donorHome, accounts: [result.account] });
    else existing.accounts.push(result.account);
  }
  return [...grouped].map(([kind, group]) => ({
    kind,
    label: HARNESS_LABEL[kind],
    donorHome: group.donorHome,
    accounts: group.accounts,
  }));
}

/** The accounts a first run actually signed in, by the harness whose login they now carry. */
export function seedImports(results: readonly FleetSeedResult[]): readonly FleetSeedGroup[] {
  return groupByHarness(results, outcome => (outcome.kind === 'seeded' ? outcome.donorHome : undefined));
}

/** The harnesses a seed found nothing to copy from, each with the home it looked in. */
export function seedDonorGaps(results: readonly FleetSeedResult[]): readonly FleetSeedGroup[] {
  return groupByHarness(results, outcome => (outcome.kind === 'no-donor' ? outcome.donorHome : undefined));
}

/**
 * The accounts that came out of a seed with no credential at all.
 *
 * `kept` counts as signed in — it means the account already had one — so this is the list a person
 * still has to do something about, and it is what decides whether the disclosure claims a ready fleet
 * or names the accounts that are not one.
 */
export function seedUnsigned(results: readonly FleetSeedResult[]): readonly string[] {
  return results
    .filter(result => result.outcome.kind !== 'seeded' && result.outcome.kind !== 'kept')
    .map(result => result.account);
}

/**
 * The accounts a seed could not finish, each with the one sentence that says why.
 *
 * Every arm that is neither `seeded` nor `kept` nor `no-donor` lands here: those three are ordinary
 * endings a person needs told once, and these are the ones where something on this host is in a state
 * they may want to look at.
 */
export function seedFailures(results: readonly FleetSeedResult[]): readonly {
  readonly account: string;
  readonly reason: string;
}[] {
  return results.flatMap(result => {
    const outcome = result.outcome;
    if (outcome.kind === 'donor-unreadable') {
      return [{ account: result.account, reason: `${outcome.donorHome} could not be read (${outcome.reason})` }];
    }
    if (outcome.kind === 'refused') {
      return [{ account: result.account, reason: `its own credential could not be read (${outcome.reason})` }];
    }
    if (outcome.kind === 'failed') return [{ account: result.account, reason: outcome.reason }];
    return [];
  });
}
