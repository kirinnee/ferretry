import { describe, it } from 'bun:test';
import type { FleetSeedResult } from '@ferretry/fleet';
import should from 'should';
import {
  decideFleetBootPreparation,
  FLEET_PREPARATION_KEY,
  fleetNothingAddedNotice,
  fleetPreparationDisclosure,
  fleetPreparationFailure,
  fleetPreparationRefusal,
  fleetPreparedDisclosure,
  fleetSeedSentences,
  type PreparableAccount,
  preparationAdded,
  preparationConflicts,
} from '../../../src/lib/fleet/boot-preparation.ts';
import type { HarnessLocation, HarnessPreflight, HarnessReadiness } from '../../../src/lib/core/harness-readiness.ts';
import type { HarnessKind } from '../../../src/lib/core/inventory.ts';

const LOCATIONS = {
  fleetDirectory: '/state/fleet',
  binDirectory: '/state/fleet/bin',
  configPath: '/state/config/daemon.json',
};

const located = (kind: HarnessKind): HarnessLocation => ({
  kind,
  outcome: 'located',
  path: `/usr/local/bin/${kind}`,
  rule: 'inherited environment',
  declaredBy: 'PATH',
});

const absent = (kind: HarnessKind): HarnessLocation => ({ kind, outcome: 'absent', searched: [] });

const harness = (
  kind: HarnessKind,
  command: HarnessLocation,
  extra: Partial<Pick<HarnessReadiness, 'launchable' | 'blocked'>> = {},
): HarnessReadiness => ({ kind, launchable: [], blocked: [], ...extra, command });

const preflight = (harnesses: readonly HarnessReadiness[], manifestRefusal?: string): HarnessPreflight => ({
  harnesses,
  ready: harnesses.some(entry => entry.launchable.length > 0),
  ...(manifestRefusal === undefined ? {} : { manifestRefusal }),
});

/** The host this whole change exists for: Claude installed, nothing published, Codex absent. */
const CLAUDE_ONLY = preflight([harness('claude', located('claude')), harness('codex', absent('codex'))]);

describe('decideFleetBootPreparation', () => {
  it('should prepare only the harnesses this host has and publishes nothing for', () => {
    // Act
    const decision = decideFleetBootPreparation({ enabled: true, preflight: CLAUDE_ONLY });

    // Assert — the sentence this replaces was "claude is on this host's PATH, but the fleet manifest
    // publishes no account for it", and it is now something the boot can act on.
    should(decision).deepEqual({ kind: 'prepare', harnesses: ['claude'] });
  });

  it('should prepare both harnesses when the host has both and publishes neither', () => {
    // Act
    const decision = decideFleetBootPreparation({
      enabled: true,
      preflight: preflight([harness('claude', located('claude')), harness('codex', located('codex'))]),
    });

    // Assert
    should(decision).deepEqual({ kind: 'prepare', harnesses: ['claude', 'codex'] });
  });

  it('should prepare only the unserved harness when the other already has an account', () => {
    // Act — a fleet somebody already declared for one harness is not a reason to leave the other one
    // unusable.
    const decision = decideFleetBootPreparation({
      enabled: true,
      preflight: preflight([
        harness('claude', located('claude'), { launchable: ['claude-work'] }),
        harness('codex', located('codex')),
      ]),
    });

    // Assert
    should(decision).deepEqual({ kind: 'prepare', harnesses: ['codex'] });
  });

  it('should honour an explicit opt-out and name the key it read', () => {
    // Act
    const decision = decideFleetBootPreparation({ enabled: false, preflight: CLAUDE_ONLY });

    // Assert — read from the document on every start, so somebody who does not want a daemon writing
    // into their home is obeyed on the FIRST start rather than after the write they were preventing.
    should(decision.kind).equal('skipped');
    should(decision.kind === 'skipped' && decision.reason).containEql(FLEET_PREPARATION_KEY);
    should(decision.kind === 'skipped' && decision.reason).containEql('created no default accounts');
  });

  it('should refuse to prepare from a manifest it could not read, and say why', () => {
    // Act — damage is not an empty fleet: declaring an account beside one that already exists, in a
    // file this daemon cannot parse, is worse than declaring none.
    const decision = decideFleetBootPreparation({
      enabled: true,
      preflight: preflight(
        [harness('claude', located('claude')), harness('codex', absent('codex'))],
        'the fleet manifest at /state/fleet/manifest.json is invalid',
      ),
    });

    // Assert
    should(decision.kind).equal('skipped');
    should(decision.kind === 'skipped' && decision.reason).containEql('could not be read');
    should(decision.kind === 'skipped' && decision.reason).containEql('/state/fleet/manifest.json');
  });

  it('should read the opt-out before the manifest, so somebody who said no hears nothing else', () => {
    // Act
    const decision = decideFleetBootPreparation({
      enabled: false,
      preflight: preflight([harness('claude', located('claude'))], 'unreadable manifest'),
    });

    // Assert
    should(decision.kind === 'skipped' && decision.reason).containEql(FLEET_PREPARATION_KEY);
    should(decision.kind === 'skipped' && decision.reason).not.containEql('unreadable manifest');
  });

  it('should create nothing on a host with no harness at all', () => {
    // Act
    const decision = decideFleetBootPreparation({
      enabled: true,
      preflight: preflight([harness('claude', absent('claude')), harness('codex', absent('codex'))]),
    });

    // Assert
    should(decision.kind).equal('skipped');
    should(decision.kind === 'skipped' && decision.reason).containEql('no agent harness could be located');
  });

  it('should create nothing when every harness on this host already has an account', () => {
    // Act
    const decision = decideFleetBootPreparation({
      enabled: true,
      preflight: preflight([
        harness('claude', located('claude'), { launchable: ['claude-work'] }),
        harness('codex', absent('codex')),
      ]),
    });

    // Assert
    should(decision.kind).equal('skipped');
    should(decision.kind === 'skipped' && decision.reason).containEql('already publishes an account');
    should(decision.kind === 'skipped' && decision.reason).containEql('claude');
  });

  it('should treat a published-but-unusable account as published rather than as an absence', () => {
    // Act — a blocked entry is a fleet somebody already declared, and scaffolding create-if-absent
    // would write nothing while reporting that it had helped.
    const decision = decideFleetBootPreparation({
      enabled: true,
      preflight: preflight([
        harness('claude', located('claude'), { blocked: ['this host cannot run /state/fleet/bin/claude-work'] }),
        harness('codex', absent('codex')),
      ]),
    });

    // Assert
    should(decision.kind).equal('skipped');
  });

  it('should not prepare a harness whose declared path resolves to nothing', () => {
    // Act — an operator who named a path has told this daemon something specific, and creating
    // accounts for a harness it could not find would be acting on a guess.
    const decision = decideFleetBootPreparation({
      enabled: true,
      preflight: preflight([
        harness('claude', {
          kind: 'claude',
          outcome: 'override-absent',
          path: '/opt/claude',
          declaredBy: 'FY_CLAUDE_BIN',
          reason: 'FY_CLAUDE_BIN names /opt/claude and this host cannot run that file',
        }),
        harness('codex', absent('codex')),
      ]),
    });

    // Assert
    should(decision.kind).equal('skipped');
    should(decision.kind === 'skipped' && decision.reason).containEql('no agent harness could be located');
  });
});

describe('fleetPreparationDisclosure', () => {
  it('should say what is about to happen, where, and the key that stops it', () => {
    // Act
    const said = fleetPreparationDisclosure(['claude'], LOCATIONS);

    // Assert — a first run must never silently write files somebody did not ask for.
    should(said).containEql('claude is installed on this host');
    should(said).containEql('creating the default accounts');
    should(said).containEql('/state/fleet');
    should(said).containEql(`"${FLEET_PREPARATION_KEY}": false`);
    should(said).containEql('/state/config/daemon.json');
    should(said).containEql('including a first one');
  });

  it('should read as one sentence about two harnesses when both are being prepared', () => {
    // Act
    const said = fleetPreparationDisclosure(['claude', 'codex'], LOCATIONS);

    // Assert
    should(said).containEql('claude and codex are installed');
    should(said).containEql('no account for either');
  });
});

describe('fleetPreparedDisclosure', () => {
  const said = fleetPreparedDisclosure({
    wrappers: ['claude-default', 'claude-auto-default'],
    published: ['claude-default', 'claude-auto-default'],
    seeded: [],
    locations: LOCATIONS,
    pathEntry: 'export PATH="/state/fleet/bin:$PATH"',
    clientName: 'fy',
  });

  it('should name every wrapper it created rather than counting them', () => {
    // Assert — a count is not something a person can act on; the names are what they type.
    should(said).containEql('created 2 default accounts: claude-default, claude-auto-default');
  });

  it('should name both directories it wrote into, by absolute path', () => {
    // Assert — files landed in somebody's home, and a person who cannot find them has been handed a
    // mess rather than a fleet.
    should(said).containEql('/state/fleet');
    should(said).containEql('/state/fleet/bin');
    should(said).containEql('This wrote files');
  });

  it('should say a session works now, and that PATH is only for typing the names yourself', () => {
    // Assert — an account is launched by the absolute path the manifest publishes, so implying that
    // a shell profile edit is a precondition would be false.
    should(said).containEql('A session can use them now');
    should(said).containEql('never a name off your PATH');
    should(said).containEql('if you also want to type these names in your own terminal');
  });

  it('should refuse to imply these accounts are signed in', () => {
    // Assert — a created account has a home and a wrapper and NO credential; being told "your fleet
    // is ready" and then watching a session die on "not signed in" is the same defect pointing the
    // other way.
    should(said).containEql('NOT that they are signed in');
    should(said).containEql('`fy fleet login`');
  });

  it('should say how to stop it happening again and how to remove what it made', () => {
    // Assert — turning the key off later removes nothing already created, so both steps are named.
    should(said).containEql(`"${FLEET_PREPARATION_KEY}": false`);
    should(said).containEql('/state/fleet/config.yaml');
    should(said).containEql('`fy fleet apply`');
  });

  it('should stay singular for a host that earned one account', () => {
    // Act
    const one = fleetPreparedDisclosure({
      wrappers: ['codex-default'],
      published: ['codex-default'],
      seeded: [],
      locations: LOCATIONS,
      pathEntry: 'export PATH="/state/fleet/bin:$PATH"',
      clientName: 'fy',
    });

    // Assert
    should(one).containEql('created 1 default account: codex-default');
  });
});

describe('fleetPreparationFailure', () => {
  it('should name what landed, and that nothing was replaced', () => {
    // Act
    const said = fleetPreparationFailure({
      reason: 'EACCES: permission denied',
      created: ['/state/fleet/config.yaml'],
      clientName: 'fy',
    });

    // Assert — a scaffold has no undo, so the honest report is what is on the host now.
    should(said).containEql('did not finish, and the daemon started anyway');
    should(said).containEql('EACCES: permission denied');
    should(said).containEql('still there: /state/fleet/config.yaml');
    should(said).containEql('Nothing was replaced');
    should(said).containEql('`fy fleet init`');
  });

  it('should say plainly when nothing at all was written', () => {
    // Act
    const said = fleetPreparationFailure({ reason: 'the fleet apply claim is held', created: [], clientName: 'fy' });

    // Assert
    should(said).containEql('nothing was created');
  });
});

/** One published account, at the fields the only-add assertion reads. */
const account = (patch: Partial<PreparableAccount> & { readonly id: string }): PreparableAccount => ({
  kind: 'claude',
  mode: 'interactive',
  wrapper: '/state/fleet/bin/claude-work',
  home: 'claude-work',
  defaultModel: 'claude-opus-5',
  models: [{ id: 'claude-opus-5' }],
  available: true,
  ...patch,
});

const WORK = account({ id: 'id-work' });

describe('preparationConflicts', () => {
  it('should find nothing when every published account comes back identically', () => {
    // Act — this is the ordinary case: the configuration reproduces the manifest and adds to it.
    const conflicts = preparationConflicts(
      [WORK],
      [WORK, account({ id: 'id-new', wrapper: '/state/fleet/bin/codex-default', home: 'codex-default' })],
    );

    // Assert
    should(conflicts).be.empty();
  });

  it('should find nothing at all when this host has published nothing', () => {
    // Act — a first run can take nothing away, because there is nothing there.
    should(preparationConflicts([], [WORK])).be.empty();
  });

  it('should refuse to remove an account the configuration does not declare', () => {
    // Act — the exact reproduction: a manifest publishing one Claude account, and a configuration
    // that declares only what preparation just created.
    const conflicts = preparationConflicts(
      [WORK],
      [account({ id: 'id-new', wrapper: '/state/fleet/bin/codex-default', home: 'codex-default' })],
    );

    // Assert — named by the wrapper a person types, not by an absolute path or an id.
    should(conflicts).deepEqual([
      {
        account: 'claude-work',
        reason: 'it is published now and the configuration does not declare it, so this would remove it',
      },
    ]);
  });

  it('should join on the id rather than on any name that can move', () => {
    // Act — a wrapper name arriving on a different account is not that account coming back.
    const conflicts = preparationConflicts([WORK], [account({ id: 'id-other' })]);

    // Assert
    should(conflicts).have.length(1);
    should(conflicts[0]?.reason).containEql('would remove it');
  });

  it('should refuse a republish that changes the file a start would launch', () => {
    // Act
    const conflicts = preparationConflicts([WORK], [account({ id: 'id-work', wrapper: '/state/fleet/bin/renamed' })]);

    // Assert — the wrapper is the whole of how a start reaches an account.
    should(conflicts[0]?.reason).containEql('a different wrapper');
    should(conflicts[0]?.reason).containEql('renamed');
  });

  it('should refuse a republish that changes the harness, the mode or the home', () => {
    // Assert — each of these is a person losing something: which agent it is, whether it may be
    // driven unattended, and which directory holds its credential.
    should(preparationConflicts([WORK], [account({ id: 'id-work', kind: 'codex' })])[0]?.reason).containEql(
      'a different harness',
    );
    should(preparationConflicts([WORK], [account({ id: 'id-work', mode: 'auto' })])[0]?.reason).containEql(
      'a different mode',
    );
    should(preparationConflicts([WORK], [account({ id: 'id-work', home: 'elsewhere' })])[0]?.reason).containEql(
      'a different home',
    );
  });

  it('should refuse a republish that changes what the account routes to', () => {
    // Assert — "changed a model and got it published by a restart" is one of the edits this exists to
    // stop, so routing is compared as well as identity.
    should(preparationConflicts([WORK], [account({ id: 'id-work', defaultModel: 'other' })])[0]?.reason).containEql(
      'a different default model',
    );
    should(
      preparationConflicts([WORK], [account({ id: 'id-work', models: [{ id: 'a' }, { id: 'b' }] })])[0]?.reason,
    ).containEql('a different models (claude-opus-5 → a, b)');
    should(preparationConflicts([WORK], [account({ id: 'id-work', available: false })])[0]?.reason).containEql(
      'a different availability',
    );
  });

  it('should name every changed field in one sentence rather than only the first', () => {
    // Act
    const conflicts = preparationConflicts([WORK], [account({ id: 'id-work', mode: 'auto', home: 'elsewhere' })]);

    // Assert
    should(conflicts).have.length(1);
    should(conflicts[0]?.reason).containEql('a different mode');
    should(conflicts[0]?.reason).containEql('a different home');
  });

  it('should report every affected account, not just one', () => {
    // Act
    const second = account({ id: 'id-two', wrapper: '/state/fleet/bin/claude-other', home: 'claude-other' });

    // Assert
    should(preparationConflicts([WORK, second], []).map(conflict => conflict.account)).deepEqual([
      'claude-work',
      'claude-other',
    ]);
  });

  it('should name an account with no path separator in its wrapper as written', () => {
    // Act — the manifest publishes an absolute path, but nothing here may assume one.
    const conflicts = preparationConflicts([account({ id: 'id-work', wrapper: 'claude-work' })], []);

    // Assert
    should(conflicts[0]?.account).equal('claude-work');
  });
});

describe('preparationAdded', () => {
  it('should name only what would arrive, never what was already there', () => {
    // Act — "created 1 default account: claude-work" about an account that already existed is a false
    // sentence, and a roster-shaped report produced exactly that.
    const added = preparationAdded(
      [WORK],
      [WORK, account({ id: 'id-new', wrapper: '/state/fleet/bin/codex-default', home: 'codex-default' })],
    );

    // Assert
    should(added.map(entry => entry.id)).deepEqual(['id-new']);
  });

  it('should return the accounts themselves, so the seed and the disclosure share one join', () => {
    // Assert — the credential seed writes into the homes this returns; deriving "which are new" a
    // second time beside the copy is how the two come to disagree on a host that published some.
    should(preparationAdded([], [WORK])).deepEqual([WORK]);
    should(preparationAdded([], [WORK])[0]?.home).equal('claude-work');
  });

  it('should be empty when the configuration adds nothing at all', () => {
    // Assert — this is what makes the "nothing was added" ending reachable rather than theoretical.
    should(preparationAdded([WORK], [WORK])).be.empty();
  });
});

describe('fleetPreparationRefusal', () => {
  it('should say nothing was written, name every conflict, and point at the deliberate remedy', () => {
    // Act
    const said = fleetPreparationRefusal({
      harnesses: ['codex'],
      conflicts: [{ account: 'claude-work', reason: 'this would remove it' }],
      locations: LOCATIONS,
      clientName: 'fy',
    });

    // Assert — "the fleet was not prepared" is not actionable; "your configuration and your manifest
    // disagree" is, and `fleet apply` is how somebody publishes a configuration on purpose.
    should(said).containEql('were NOT created, and nothing was written');
    should(said).containEql('/state/fleet/config.yaml');
    should(said).containEql('claude-work: this would remove it');
    should(said).containEql('Preparation may only add');
    should(said).containEql('`fy fleet apply`');
  });
});

describe('fleetNothingAddedNotice', () => {
  it('should say why no account could be added and what to do instead', () => {
    // Act — reachable, because a configuration that already declares agents is never edited.
    const said = fleetNothingAddedNotice({ harnesses: ['codex'], locations: LOCATIONS, clientName: 'fy' });

    // Assert
    should(said).containEql('codex is installed on this host');
    should(said).containEql('no default account could be added');
    should(said).containEql('already declares its own agents');
    should(said).containEql('run `fy fleet apply`');
  });

  it('should read as one sentence about two harnesses', () => {
    // Act
    const said = fleetNothingAddedNotice({ harnesses: ['claude', 'codex'], locations: LOCATIONS, clientName: 'fy' });

    // Assert
    should(said).containEql('claude and codex are installed');
    should(said).containEql('no account for either');
  });
});

describe('the whole-manifest disclosure', () => {
  it('should say the accounts it did not touch were republished unchanged', () => {
    // Act — preparation ends in a whole-fleet apply, and a reader is entitled to know their existing
    // accounts were rewritten onto the manifest even though nothing about them changed.
    const said = fleetPreparedDisclosure({
      wrappers: ['codex-default'],
      published: ['claude-work', 'codex-default'],
      seeded: [],
      locations: LOCATIONS,
      pathEntry: 'export PATH="/state/fleet/bin:$PATH"',
      clientName: 'fy',
    });

    // Assert
    should(said).containEql('created 1 default account: codex-default');
    should(said).containEql('rewrote the whole manifest');
    should(said).containEql('came back unchanged — claude-work');
    should(said).containEql('refuses outright rather than remove or redefine one');
  });

  it('should stay silent about a roster that is only the additions', () => {
    // Assert — a first run has nothing to reassure anybody about, and a sentence saying so would be
    // noise in the one message that must be read.
    should(
      fleetPreparedDisclosure({
        wrappers: ['claude-default'],
        published: ['claude-default'],
        seeded: [],
        locations: LOCATIONS,
        pathEntry: 'export PATH="/state/fleet/bin:$PATH"',
        clientName: 'fy',
      }),
    ).not.containEql('rewrote the whole manifest');
  });
});

/**
 * What a boot says about the credential it copied.
 *
 * This is the half of the first-run seed a person actually meets. The copy itself is proved in
 * `packages/fleet/tests/unit/credential-seed.test.ts`; what is proved here is that every ending
 * reaches a sentence, that the sentence names the directory somebody can go and check, and that the
 * disclosure never claims a fleet is signed in when part of it is not.
 */
describe('fleetSeedSentences', () => {
  const seeded = (account: string, kind: 'claude' | 'codex', donorHome: string): FleetSeedResult => ({
    account,
    accountId: `id-${account}`,
    kind,
    outcome: { kind: 'seeded', donorHome },
  });
  const noDonor = (account: string, kind: 'claude' | 'codex', donorHome: string): FleetSeedResult => ({
    account,
    accountId: `id-${account}`,
    kind,
    outcome: { kind: 'no-donor', donorHome },
  });

  it('should name the accounts it signed in, and the directory the login came from', () => {
    // Act
    const said = fleetSeedSentences(
      [
        seeded('claude-default', 'claude', '/home/me/.claude'),
        seeded('claude-auto-default', 'claude', '/home/me/.claude'),
      ],
      'fy',
    ).join(' ');

    // Assert — one login covers both lanes, so it is said once, with the home a person can check.
    should(said).containEql('Signed in without a browser: claude-default, claude-auto-default now hold');
    should(said).containEql("a COPY of this host's own Claude login, taken once from /home/me/.claude");
  });

  it('should say the copies are independent, in the same breath as saying they were made', () => {
    // Assert — somebody who assumes a copy tracks its donor finds out when it expires, which is the
    // worst possible moment to learn it. It is not a footnote.
    const said = fleetSeedSentences([seeded('codex-default', 'codex', '/home/me/.codex')], 'fy').join(' ');
    should(said).containEql('codex-default now holds');
    should(said).containEql('signing your own Codex out does not sign them out');
    should(said).containEql('signing back in does not refresh them');
  });

  it('should explain what a copy means exactly once, however many harnesses it copied', () => {
    // Act — the two-harness host is what caught this: the same two-sentence explanation appeared
    // twice, and a paragraph somebody has already read is a paragraph they skip.
    const said = fleetSeedSentences(
      [
        seeded('claude-default', 'claude', '/home/me/.claude'),
        seeded('claude-auto-default', 'claude', '/home/me/.claude'),
        seeded('codex-default', 'codex', '/home/me/.codex'),
        seeded('codex-auto-default', 'codex', '/home/me/.codex'),
      ],
      'fy',
    ).join(' ');

    // Assert — each harness's import is named with its own donor home, and the consequence is said
    // once, covering both.
    should(said).containEql("this host's own Claude login, taken once from /home/me/.claude");
    should(said).containEql("this host's own Codex login, taken once from /home/me/.codex");
    should(said.split('Those copies are independent')).have.length(2);
    should(said).containEql('signing your own Claude or Codex out does not sign them out');
    should(said).containEql('`fy fleet login` re-signs any account whose copy expires');
  });

  it('should claim nothing more than a credential being in place once everything is seeded', () => {
    // Assert — a credential on disk is not a promise the provider still honours it.
    const said = fleetSeedSentences([seeded('claude-default', 'claude', '/home/me/.claude')], 'fy').join(' ');
    should(said).containEql('Every one of them starts with a credential in place');
    should(said).not.containEql('NOT that');
  });

  it('should name the harness and the directory it found nothing in', () => {
    // Act
    const said = fleetSeedSentences(
      [noDonor('codex-default', 'codex', '/home/me/.codex'), noDonor('codex-auto-default', 'codex', '/home/me/.codex')],
      'fy',
    ).join(' ');

    // Assert — "no login found" without a path is not something anybody can act on.
    should(said).containEql('Nothing was copied for Codex: no usable Codex login was found in /home/me/.codex');
    should(said).containEql('codex-default, codex-auto-default have a home and no credential');
  });

  it('should keep the original unsigned sentence when nothing at all gained a credential', () => {
    // Assert — on a host with nothing to copy from, nothing about the situation has changed, so the
    // sentence this disclosure has always said is the honest one.
    const said = fleetSeedSentences([noDonor('claude-default', 'claude', '/home/me/.claude')], 'fy').join(' ');
    should(said).containEql('NOT that they are signed in');
    should(said).containEql('run `fy fleet login` for that');
  });

  it('should make the same claim when it is handed nothing at all', () => {
    // Assert — an empty result set is "nothing is known about any credential", never "every one of
    // them has one". The vacuous reading is the one that would tell somebody their fleet is ready.
    const said = fleetSeedSentences([], 'fy').join(' ');
    should(said).containEql('NOT that they are signed in');
    should(said).not.containEql('Every one of them starts with a credential');
    should(said).not.containEql('Signed in without a browser');
  });

  it('should name exactly the accounts that are still unsigned when some were seeded', () => {
    // Act — the case a blanket claim gets wrong in both directions.
    const said = fleetSeedSentences(
      [seeded('claude-default', 'claude', '/home/me/.claude'), noDonor('codex-default', 'codex', '/home/me/.codex')],
      'fy',
    ).join(' ');

    // Assert
    should(said).containEql('NOT that codex-default is signed in');
    should(said).containEql('run `fy fleet login` for it');
    should(said).not.containEql('NOT that they are signed in');
  });

  it('should use plural words for two unsigned accounts beside a seeded one', () => {
    // Act
    const said = fleetSeedSentences(
      [
        seeded('claude-default', 'claude', '/home/me/.claude'),
        noDonor('codex-default', 'codex', '/home/me/.codex'),
        noDonor('codex-auto-default', 'codex', '/home/me/.codex'),
      ],
      'fy',
    ).join(' ');

    // Assert
    should(said).containEql('NOT that codex-default, codex-auto-default are signed in');
    should(said).containEql('run `fy fleet login` for those');
  });

  it('should count an account that already had a credential as signed in rather than as a gap', () => {
    // Assert — seeding is an import, so an account that already had one is left alone; reporting it
    // as unsigned would send somebody to log in to an account that is already logged in.
    const said = fleetSeedSentences(
      [{ account: 'claude-default', accountId: 'id-claude-default', kind: 'claude', outcome: { kind: 'kept' } }],
      'fy',
    ).join(' ');
    should(said).containEql('Every one of them starts with a credential in place');
  });

  it('should name every account whose copy could not be made, with the reason for each', () => {
    // Act — three different failures, all of which leave the account exactly as it was.
    const said = fleetSeedSentences(
      [
        {
          account: 'claude-default',
          accountId: 'id-claude-default',
          kind: 'claude',
          outcome: { kind: 'donor-unreadable', donorHome: '/home/me/.claude', reason: 'the keychain read failed' },
        },
        {
          account: 'claude-auto-default',
          accountId: 'id-claude-auto-default',
          kind: 'claude',
          outcome: { kind: 'refused', reason: 'the credential has an access token but no readable expiry' },
        },
        {
          account: 'codex-default',
          accountId: 'id-codex-default',
          kind: 'codex',
          outcome: { kind: 'failed', reason: 'ENOSPC: no space left' },
        },
      ],
      'fy',
    ).join(' ');

    // Assert
    should(said).containEql('accounts are exactly as they were');
    should(said).containEql('claude-default: /home/me/.claude could not be read (the keychain read failed)');
    should(said).containEql('claude-auto-default: its own credential could not be read');
    should(said).containEql('codex-default: ENOSPC: no space left');
  });

  it('should stay singular for one failed copy', () => {
    // Assert
    const said = fleetSeedSentences(
      [
        {
          account: 'codex-default',
          accountId: 'id-codex-default',
          kind: 'codex',
          outcome: { kind: 'failed', reason: 'ENOSPC' },
        },
      ],
      'fy',
    ).join(' ');
    should(said).containEql('One credential copy did not happen and the account is exactly as it was');
  });

  it('should stay singular for one harness with a single unseeded account', () => {
    // Assert
    const said = fleetSeedSentences([noDonor('codex-default', 'codex', '/home/me/.codex')], 'fy').join(' ');
    should(said).containEql('codex-default has a home and no credential');
  });
});
