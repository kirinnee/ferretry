/**
 * Whether STARTING THIS DAEMON should give the host a fleet, and what to say when it does.
 *
 * Until this module, a machine with Claude Code installed and a daemon running could do nothing. The
 * boot resolved `claude` on the `PATH`, said so, and then refused to launch it — accurately, because
 * a start launches the wrappers the fleet manifest publishes and the manifest published none. Every
 * word of that refusal was true and its effect was that a person who had installed a harness, paired
 * a device and started a daemon still had a setup step in front of them before anything worked.
 *
 * SO STARTING THE DAEMON IS THE SETUP, and this is the decision half of that. It is pure: it reads
 * the preflight somebody else took, decides, and composes the sentences a boot must say. It writes
 * nothing, resolves nothing, and does not know what a filesystem is.
 *
 * ## WHY THIS IS ALLOWED TO HAPPEN WITHOUT A PROMPT, said rather than assumed
 *
 * Auto-creating accounts WRITES EXECUTABLE WRAPPERS INTO SOMEBODY'S HOME, which is the exact act the
 * fleet's authority model exists to govern. It is defensible here for one reason and it is worth
 * naming: this runs on the host, at the operator's own command — they typed the start — and this
 * codebase's doctrine is that somebody at the machine already has the machine. It is NOT a widening
 * of what a remote caller may do; no route reaches this, and the operator-password confirmation that
 * governs every browser-driven change is untouched.
 *
 * But it IS a real change in what starting a daemon does, so {@link fleetPreparationDisclosure} and
 * {@link fleetPreparedDisclosure} exist to make it visible: what was created, where, and how to not
 * have it. A first run that silently wrote files somebody did not ask for and could not find would be
 * the same class of defect as the refusal it replaces, pointing the other way.
 *
 * THE SAME ARGUMENT IS MADE AGAIN, SEPARATELY, FOR THE CREDENTIAL SEED. A first run also copies this
 * host's own harness login into the homes it just made, which is a larger act than writing a wrapper:
 * it moves a credential the operator owns. It is defensible on exactly the same ground — on this host,
 * at the operator's own command, reachable from no route — and it is disclosed harder for exactly that
 * reason. {@link fleetSeedSentences} names the directory each login was read from, says that the
 * copies stop tracking their donor the moment they land, and names every account that still has
 * nothing. What it never does, and structurally cannot, is render a credential: it is handed verdicts.
 *
 * ## WHAT IT REFUSES TO GUESS
 *
 * Four skips, and the third is the one that matters most. A manifest this daemon could not READ says
 * nothing about what is published — so preparing a fleet from that state could declare an account
 * beside one that already exists, in a file the daemon cannot parse. Damage is not an empty fleet.
 */

import { type FleetSeedResult, seedDonorGaps, seedFailures, seedImports, seedUnsigned } from '@ferretry/fleet';
import type { HarnessPreflight } from '../core/harness-readiness.ts';
import type { HarnessKind } from '../core/inventory.ts';

/** The exact configuration key that turns this off, named in every sentence that discloses it. */
export const FLEET_PREPARATION_KEY = 'fleet.prepareDefaults';

/**
 * What this boot should do about the fleet.
 *
 * `skipped` CARRIES ITS REASON as text a person reads rather than a code, because every one of the
 * four is a different thing to do next — nothing, install a harness, repair a file, or nothing at
 * all because the fleet is already there — and the boot trail is where that is read.
 */
export type FleetBootPreparation =
  | { readonly kind: 'prepare'; readonly harnesses: readonly HarnessKind[] }
  | { readonly kind: 'skipped'; readonly reason: string };

/**
 * The harnesses this host has that the manifest publishes NO account for.
 *
 * `blocked` counts as published. A blocked entry means "this account exists and a start could not
 * resolve it", which is a fleet somebody already declared and a problem preparation cannot fix —
 * scaffolding is create-if-absent, so it would write nothing and report having helped.
 */
function unservedHarnesses(preflight: HarnessPreflight): readonly HarnessKind[] {
  return preflight.harnesses
    .filter(harness => harness.command.outcome === 'located')
    .filter(harness => harness.launchable.length === 0 && harness.blocked.length === 0)
    .map(harness => harness.kind);
}

/**
 * Decide, from what this host has and what it already publishes.
 *
 * THE ORDER OF THE SKIPS IS THE MEANING. The opt-out is read first so an operator who said no is
 * never told about a harness or a manifest; the manifest refusal comes next because every claim
 * below it would be a claim about a file this daemon could not read.
 */
export function decideFleetBootPreparation(input: {
  /** Whether the operator has left the default preparation on. */
  readonly enabled: boolean;
  readonly preflight: HarnessPreflight;
}): FleetBootPreparation {
  if (!input.enabled) {
    return {
      kind: 'skipped',
      reason: `${FLEET_PREPARATION_KEY} is false, so this daemon created no default accounts`,
    };
  }
  if (input.preflight.manifestRefusal !== undefined) {
    return {
      kind: 'skipped',
      reason: `the fleet manifest could not be read, so this daemon did not create default accounts — it cannot tell what is already published, and declaring an account beside one that exists is worse than declaring none: ${input.preflight.manifestRefusal}`,
    };
  }
  const located = input.preflight.harnesses.filter(harness => harness.command.outcome === 'located');
  if (located.length === 0) {
    return {
      kind: 'skipped',
      reason: 'no agent harness could be located on this host, so this daemon created no default accounts',
    };
  }
  const unserved = unservedHarnesses(input.preflight);
  if (unserved.length === 0) {
    return {
      kind: 'skipped',
      reason: `this fleet already publishes an account for every harness on this host (${located
        .map(harness => harness.kind)
        .join(', ')}), so nothing was created`,
    };
  }
  return { kind: 'prepare', harnesses: unserved };
}

/**
 * One published account, as the only-add assertion below needs to see it.
 *
 * STRUCTURAL rather than the manifest's own type, because the assertion is about the *facts a person
 * would notice being taken away* rather than about a wire shape: which harness it is, whether it may
 * be driven unattended, which file a start launches, which home holds its credential, and what it
 * routes to. A module that imported the manifest schema to say that would also have to be updated
 * every time an unrelated field was added to it.
 */
export interface PreparableAccount {
  readonly id: string;
  readonly kind: string;
  readonly mode: string;
  readonly wrapper: string;
  readonly home: string;
  readonly defaultModel: string | null;
  readonly models: readonly { readonly id: string }[];
  readonly available: boolean;
}

/** One published account a preparation would do something other than leave alone. */
export interface FleetPreparationConflict {
  /** The wrapper as a person reads it — the name they type and the name `fleet ls` prints. */
  readonly account: string;
  readonly reason: string;
}

/** The last segment of a path, so a conflict names the wrapper rather than an absolute file. */
function wrapperName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/** The fields whose change is a person losing something, each with the words for losing it. */
const KEYED_FIELDS: readonly {
  readonly name: string;
  readonly read: (account: PreparableAccount) => string;
}[] = [
  { name: 'harness', read: account => account.kind },
  { name: 'mode', read: account => account.mode },
  { name: 'wrapper', read: account => account.wrapper },
  { name: 'home', read: account => account.home },
  { name: 'default model', read: account => account.defaultModel ?? '(none)' },
  { name: 'models', read: account => account.models.map(model => model.id).join(', ') },
  { name: 'availability', read: account => String(account.available) },
];

/**
 * WHICH PUBLISHED ACCOUNTS THIS PREPARATION WOULD NOT MERELY ADD TO.
 *
 * ## THE GUARANTEE IS AN ASSERTION HERE, NOT A HOPE ABOUT THE APPLY
 *
 * Preparation ends in a WHOLE-FLEET apply, and an apply republishes the manifest from `config.yaml`
 * as it stands. That is correct for `fleet apply`, which somebody typed, and wrong for a boot: an
 * operator who had edited their configuration and not yet applied it would have those edits published
 * by the next restart, silently, because an unrelated harness happened to be missing an account. That
 * is the same class of act as replacing somebody's file — the exact thing preparation must never do —
 * and it actually happened: a host whose manifest published one Claude account and whose
 * `config.yaml` did not exist lost that account to a preparation triggered by Codex.
 *
 * So the difference between what is published NOW and what the plan WOULD publish is computed, and
 * anything that is not a pure addition refuses the whole preparation. A refusal is cheap and
 * correct: the operator is told their configuration and their manifest disagree, which is a fact they
 * need anyway, and `fleet apply` is still there to resolve it deliberately.
 *
 * ## JOINED ON `id`, BECAUSE THAT IS THE ONLY KEY EITHER SIDE AGREES ON
 *
 * A wrapper name can move between accounts and a home can be renamed; the identifier is the thing a
 * configuration promises never to change once anything has referenced it. An account whose id has
 * gone is REMOVED however many similar-looking accounts arrived beside it.
 */
export function preparationConflicts(
  published: readonly PreparableAccount[],
  candidate: readonly PreparableAccount[],
): readonly FleetPreparationConflict[] {
  const byId = new Map(candidate.map(account => [account.id, account]));
  return published.flatMap((account): readonly FleetPreparationConflict[] => {
    const next = byId.get(account.id);
    if (next === undefined) {
      return [
        {
          account: wrapperName(account.wrapper),
          reason: `it is published now and the configuration does not declare it, so this would remove it`,
        },
      ];
    }
    const changed = KEYED_FIELDS.filter(field => field.read(account) !== field.read(next));
    if (changed.length === 0) return [];
    return [
      {
        account: wrapperName(account.wrapper),
        reason: `this would republish it with a different ${changed
          .map(field => `${field.name} (${field.read(account)} → ${field.read(next)})`)
          .join(' and a different ')}`,
      },
    ];
  });
}

/**
 * The accounts a preparation would ADD.
 *
 * Reported instead of the whole roster, because "created 1 default account: claude-work" about an
 * account that already existed is a false sentence — and it was reachable: a configuration that
 * already declares agents cannot be extended, so a preparation triggered by the OTHER harness added
 * nothing and said it had created everything the manifest happened to publish.
 *
 * THE ACCOUNTS THEMSELVES rather than their names, because two callers now need this join and only one
 * of them wants names: the disclosure prints them, and the first-run credential seed writes into
 * exactly these homes. Re-deriving "which of these are new" beside the credential copy would be a
 * second opinion about the one question this function answers, and the two would disagree first in the
 * case that matters — a host that already published some of them.
 *
 * Generic over the candidate, so a caller holding whole manifest accounts gets whole manifest accounts
 * back rather than the structural minimum this module compares on.
 */
export function preparationAdded<T extends PreparableAccount>(
  published: readonly PreparableAccount[],
  candidate: readonly T[],
): readonly T[] {
  const existing = new Set(published.map(account => account.id));
  return candidate.filter(account => !existing.has(account.id));
}

/** Where a preparation writes, so a disclosure names paths a person can actually go and look at. */
export interface FleetPreparationLocations {
  readonly fleetDirectory: string;
  readonly binDirectory: string;
  readonly configPath: string;
}

/**
 * Said BEFORE anything is written: that this start is about to create a fleet, and where.
 *
 * It is separate from the after-the-fact sentence because the two are true at different moments and
 * a boot that only spoke afterwards would leave a failed preparation with nothing said about what it
 * had been trying to do.
 */
export function fleetPreparationDisclosure(
  harnesses: readonly HarnessKind[],
  locations: FleetPreparationLocations,
): string {
  return `${harnesses.join(' and ')} ${harnesses.length === 1 ? 'is' : 'are'} installed on this host and this fleet publishes no account for ${harnesses.length === 1 ? 'it' : 'either'}, so starting this daemon is creating the default accounts for ${harnesses.join(' and ')} in ${locations.fleetDirectory}. Set "${FLEET_PREPARATION_KEY}": false in ${locations.configPath} to stop that happening on any start, including a first one.`;
}

/**
 * Said AFTER it landed: what exists now, where the files are, what it does NOT prove, and how to
 * undo it.
 *
 * FOUR THINGS AND ALL FOUR ARE LOAD-BEARING:
 *
 *  - THE NAMES, not a count. "4 accounts created" tells somebody nothing they can act on; the
 *    wrapper names are what they type, what `fleet ls` prints, and what they search for when they
 *    want the files gone.
 *  - THE ABSOLUTE PATHS of both directories. Files were written into somebody's home and a person
 *    who cannot find them has been handed a mess rather than a fleet.
 *  - WHAT IT DOES NOT PROVE. A created account has a home, a wrapper, and whatever credential the
 *    seed below could give it. A person told "your fleet is ready" who then watches a session die on
 *    "not signed in" was misled by a sentence that was technically true, so this says per account
 *    which of the two it is rather than making one claim about all of them. And `PATH` is named for
 *    what it actually is: a convenience for typing a wrapper name in a terminal, NOT a precondition
 *    for a session — a start launches the absolute path the manifest publishes, so these accounts
 *    work the moment the apply lands.
 *  - HOW TO NOT HAVE IT: the key, and the fact that removing the accounts themselves is an edit to
 *    the fleet configuration followed by an apply, because turning the flag off later removes
 *    nothing that was already created.
 */
export function fleetPreparedDisclosure(input: {
  /** The accounts this preparation ADDED. Never the whole roster — see {@link preparationAdded}. */
  readonly wrappers: readonly string[];
  /**
   * Every account the manifest publishes now, so the disclosure is the whole truth rather than only
   * its interesting half.
   *
   * IT IS SAID WHEN IT IS LARGER THAN THE ADDITIONS, because preparation ends in a whole-fleet apply
   * and a reader is entitled to know that the accounts they already had were republished. They were
   * republished IDENTICALLY — {@link preparationConflicts} refuses the preparation otherwise — and
   * saying so is what turns "we also rewrote your manifest" from a discovery into a disclosure.
   */
  readonly published: readonly string[];
  /**
   * What the first-run credential seed did, per account.
   *
   * EMPTY IS A REAL VALUE and it means "nothing was attempted", which is exactly what a preparation
   * that added no account produces. The sentences below then fall back to the claim this disclosure
   * has always made — that these are published and not signed in — rather than claiming a seed ran
   * and found nothing, which is a different and false statement about somebody's host.
   */
  readonly seeded: readonly FleetSeedResult[];
  readonly locations: FleetPreparationLocations;
  readonly pathEntry: string;
  readonly clientName: string;
}): string {
  const untouched = input.published.filter(wrapper => !input.wrappers.includes(wrapper));
  return [
    `created ${String(input.wrappers.length)} default account${input.wrappers.length === 1 ? '' : 's'}: ${input.wrappers.join(', ')}.`,
    `This wrote files: the configuration and instruction documents under ${input.locations.fleetDirectory}, and one executable wrapper per account in ${input.locations.binDirectory}.`,
    ...(untouched.length === 0
      ? []
      : [
          `Publishing them rewrote the whole manifest, and every account already on it came back unchanged — ${untouched.join(', ')}; preparation refuses outright rather than remove or redefine one.`,
        ]),
    'A session can use them now — a start launches the absolute wrapper path the manifest publishes, never a name off your PATH.',
    ...fleetSeedSentences(input.seeded, input.clientName),
    `Add \`${input.pathEntry}\` to your shell profile if you also want to type these names in your own terminal.`,
    `To stop this happening on future starts set "${FLEET_PREPARATION_KEY}": false in ${input.locations.configPath}; to remove the accounts, delete them from ${input.locations.fleetDirectory}/config.yaml and run \`${input.clientName} fleet apply\`.`,
  ].join(' ');
}

/**
 * What the first-run credential seed did, as the sentences a boot says about it.
 *
 * ## THIS IS THE HALF OF THE FEATURE A PERSON ACTUALLY MEETS
 *
 * Copying somebody's provider login from one directory on their machine into four others is not a
 * detail. It is the difference between a fleet that works and one that asks for four browser
 * approvals, and it is also a thing that happened to a credential they own. Silence about either half
 * is what makes people think the tool is broken — so this says what was copied, WHERE FROM, what that
 * does and does not mean afterwards, and which accounts still have nothing.
 *
 * ## FOUR SENTENCES, EACH REACHABLE ON ITS OWN
 *
 *  - **The import.** Named per harness with the donor home, because the home is the only thing a
 *    person can go and check, and one login covers every lane of one harness.
 *  - **The independence.** Said WITH the import and never as a footnote: a copy stops tracking its
 *    donor the moment it lands, so signing your own harness out does not sign the fleet out, and
 *    signing it back in does not refresh the fleet. Somebody who assumes the opposite finds out when
 *    a copy expires, which is the worst possible moment to learn it.
 *  - **The gap.** A harness whose own install held no usable login. It names the directory that was
 *    read, because "no login found" without a path is not something anybody can act on.
 *  - **What is still unsigned**, by name — never a count and never a blanket claim over accounts that
 *    differ. The all-unsigned case keeps this disclosure's original sentence word for word, because on
 *    a host with nothing to copy from nothing about the situation has changed.
 *
 * Pure, and it can hold no credential: {@link FleetSeedResult} carries a verdict, a home and a
 * reason — the material never leaves the adapter that copied it.
 */
export function fleetSeedSentences(results: readonly FleetSeedResult[], clientName: string): readonly string[] {
  const imported = seedImports(results);
  const gaps = seedDonorGaps(results);
  const failures = seedFailures(results);
  const unsigned = seedUnsigned(results);
  // An EMPTY result set is "nothing is known about any credential", which is the same claim this
  // disclosure made before a seed existed — so it falls into the all-unsigned arm rather than the
  // vacuously-true "every one of them has a credential" one.
  const nothingSignedIn = unsigned.length === results.length;
  return [
    ...imported.map(
      group =>
        `Signed in without a browser: ${group.accounts.join(', ')} ${group.accounts.length === 1 ? 'now holds' : 'now hold'} a COPY of this host's own ${group.label} login, taken once from ${group.donorHome}.`,
    ),
    // SAID ONCE, however many harnesses were imported. Repeating a two-sentence explanation per
    // harness is what a two-harness host actually produced, and a paragraph somebody has already read
    // is a paragraph they skip — including the second time, when it is about the other harness.
    ...(imported.length === 0
      ? []
      : [
          `Those copies are independent from the moment they land — signing your own ${imported.map(group => group.label).join(' or ')} out does not sign them out, and signing back in does not refresh them; \`${clientName} fleet login\` re-signs any account whose copy expires.`,
        ]),
    ...gaps.map(
      group =>
        `Nothing was copied for ${group.label}: no usable ${group.label} login was found in ${group.donorHome}, so ${group.accounts.join(', ')} ${group.accounts.length === 1 ? 'has' : 'have'} a home and no credential.`,
    ),
    ...(failures.length === 0
      ? []
      : [
          `One credential copy did not happen and the ${failures.length === 1 ? 'account is exactly as it was' : 'accounts are exactly as they were'} — ${failures.map(failure => `${failure.account}: ${failure.reason}`).join('; ')}.`,
        ]),
    ...(nothingSignedIn
      ? [
          `Verified only that these are published and this host can run them; NOT that they are signed in — run \`${clientName} fleet login\` for that.`,
        ]
      : unsigned.length === 0
        ? [
            'Every one of them starts with a credential in place; that is not a promise the provider still accepts it, so a first session is still the real test.',
          ]
        : [
            `Verified only that these are published and this host can run them; NOT that ${unsigned.join(', ')} ${unsigned.length === 1 ? 'is' : 'are'} signed in — run \`${clientName} fleet login\` for ${unsigned.length === 1 ? 'it' : 'those'}.`,
          ]),
  ];
}

/**
 * Said when preparation refused because applying would have done more than add.
 *
 * IT NAMES EVERY ACCOUNT AND WHAT WOULD HAVE HAPPENED TO IT, because "the fleet was not prepared" is
 * not something a person can act on and "your configuration and your manifest disagree" is. The
 * remedy is the deliberate one: `fleet apply` publishes the configuration on purpose, which is a
 * different act from a restart doing it silently.
 *
 * A `state` NOTICE AND NEVER A REFUSED BOOT. Nothing was written, the daemon serves, and the accounts
 * that were published stay published.
 */
export function fleetPreparationRefusal(input: {
  readonly harnesses: readonly HarnessKind[];
  readonly conflicts: readonly FleetPreparationConflict[];
  readonly locations: FleetPreparationLocations;
  readonly clientName: string;
}): string {
  return [
    `this host's default ${input.harnesses.join(' and ')} accounts were NOT created, and nothing was written:`,
    `publishing them means applying ${input.locations.fleetDirectory}/config.yaml, and that would not only add —`,
    `${input.conflicts.map(conflict => `${conflict.account}: ${conflict.reason}`).join('; ')}.`,
    'Preparation may only add, so it refused the whole thing.',
    `The configuration on this host and the manifest it published disagree; \`${input.clientName} fleet ls\` shows what is published and \`${input.clientName} fleet apply\` publishes the configuration deliberately.`,
  ].join(' ');
}

/**
 * Said when preparation could not add anything, and why.
 *
 * REACHABLE, WHICH IS WHY IT EXISTS. Scaffolding only extends a configuration whose `agents` list is
 * empty, so a host that already declares agents and is missing an account for the OTHER harness gets
 * a preparation that can add nothing at all. Reporting that as "created N accounts" — which is what a
 * roster-shaped disclosure did — is a plainly false sentence about somebody's home directory.
 */
export function fleetNothingAddedNotice(input: {
  readonly harnesses: readonly HarnessKind[];
  readonly locations: FleetPreparationLocations;
  readonly clientName: string;
}): string {
  return `${input.harnesses.join(' and ')} ${input.harnesses.length === 1 ? 'is' : 'are'} installed on this host and this fleet publishes no account for ${input.harnesses.length === 1 ? 'it' : 'either'}, and no default account could be added: ${input.locations.fleetDirectory}/config.yaml already declares its own agents, and preparation never edits a configuration that does. Declare an account for ${input.harnesses.join(' and ')} there and run \`${input.clientName} fleet apply\`.`;
}

/**
 * Said when preparation was attempted and did not finish.
 *
 * A `state` NOTICE AND NEVER A REFUSED BOOT, by the same doctrine as the absent-harness warning: a
 * daemon that will not start because it could not scaffold a convenience is strictly worse than one
 * that starts and says what did not happen. The paths that DID land are named because a scaffold has
 * no undo — every file it wrote was one that was absent — so the honest report is what is on the host
 * now, plus the fact that running it again finishes the job.
 */
export function fleetPreparationFailure(input: {
  readonly reason: string;
  readonly created: readonly string[];
  readonly clientName: string;
}): string {
  const landed =
    input.created.length === 0
      ? 'nothing was created'
      : `these files were created and are still there: ${input.created.join(', ')}`;
  return `preparing this host's default fleet did not finish, and the daemon started anyway: ${input.reason}. ${landed}. Nothing was replaced — preparation only ever creates what is absent — so \`${input.clientName} fleet init\` or the next start finishes the remainder.`;
}
