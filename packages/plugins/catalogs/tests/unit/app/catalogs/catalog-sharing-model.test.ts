import { describe, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import should from 'should';
import {
  browserLine,
  browserRemovedNote,
  CAP_PROBLEM,
  capFromText,
  catalogTakenNote,
  changeUserIdProblem,
  changeUserIdSentence,
  DEFAULT_CAP_TEXT,
  DEFAULT_EXPIRY,
  EXPIRY_CHOICES,
  effectiveShareState,
  emptyDraft,
  expiryLine,
  formatWhen,
  hasNoPasskeyLeft,
  liveShareCount,
  mintRequest,
  multiShareOf,
  multiSummary,
  newPasskeyChoice,
  newPasskeyHelp,
  newPasskeyPreTicked,
  orderedShares,
  personFacts,
  personWithId,
  recipientName,
  removeBrowserConfirm,
  revokeConfirm,
  revokedNote,
  revokeLabel,
  SHARE_EXPIRED_LINE,
  SHARE_USER_ID_EMPTY,
  SHARE_USER_ID_TOO_LONG,
  type ShareDraft,
  shareCountdown,
  shareEndedNote,
  shareLength,
  shareProblem,
  shareResultTitle,
  shareRow,
  shareSheetTitle,
  sharingRefusal,
  shownOnceLine,
  suggestPeople,
  takeAwayChoices,
  takeAwayConfirm,
  takenUserIdLine,
  userIdChangedNote,
  userIdLine,
  userIdProblem,
  usesNote,
  whatTheyHave,
} from '../../../../app/features/catalogs/catalog-sharing-model.ts';
import { KEY_A1, MEMBER_B, memberView, SHARE_2, shareView, T0, T0_MS } from '../support/catalog-sharing.ts';
import { CATALOG, ownedCatalog } from '../support/catalog-views.ts';

const http = (code: string, status = 409) => new DaemonCallError(status, code, `refused ${code}`);
const alice = memberView();
const bob = memberView({ memberId: MEMBER_B, label: 'Bob', keys: [alice.keys[0]], catalogIds: [] });
const named = (userId: string, change: Partial<ShareDraft> = {}): ShareDraft => ({
  ...emptyDraft(),
  userId,
  ...change,
});
const noPasskey = memberView({
  memberId: MEMBER_B,
  label: 'Sam',
  keys: [{ ...(alice.keys[0] as (typeof alice.keys)[number]), passkeys: 0 }],
});

describe('expiry and how many', () => {
  it('offers exactly five lengths, shortest first, starting at 15 minutes', () => {
    should(EXPIRY_CHOICES.map(choice => choice.label)).eql(['15 minutes', '1 hour', '3 hours', '8 hours', '1 day']);
    should(DEFAULT_EXPIRY).equal('15m');
  });
  it('reads a cap only as a whole number from 2 to 200', () => {
    should(DEFAULT_CAP_TEXT).equal('50');
    should(capFromText(' 50 ')).equal(50);
    should(capFromText('2')).equal(2);
    should(capFromText('200')).equal(200);
    for (const bad of ['1', '201', '', 'ten', '2.5', '-3', '12345']) should(capFromText(bad)).be.null();
  });
  it('says the use in words', () => {
    should(usesNote({ kind: 'single' })).equal('single use');
    should(usesNote({ kind: 'multi', cap: 50 })).equal('up to 50 people');
  });
});

describe('the share draft', () => {
  it('starts with no user ID, one use, fifteen minutes', () => {
    should(emptyDraft()).eql({ userId: '', newPasskey: null, expiresIn: '15m', howMany: { kind: 'single' } });
  });
  it('needs a user ID', () => {
    should(shareProblem(named('  '))).equal(SHARE_USER_ID_EMPTY);
    should(shareProblem(named('carol'))).be.null();
  });
  it('refuses hidden characters, look-alike scripts and a long ID in the machine’s words, never echoing the text', () => {
    should(userIdProblem('Ca\u0000rol')).equal(
      "A user ID can't contain hidden or invisible characters. Type it again.",
    );
    should(shareProblem(named('Ca\u200brol'))).match(/hidden or invisible/);
    should(userIdProblem('Team Москва')).match(/mix scripts/);
    should(userIdProblem('x'.repeat(81))).equal(SHARE_USER_ID_TOO_LONG);
    should(userIdProblem('   ')).be.null();
    should(userIdProblem('alice')).be.null();
  });
  it('checks the cap for many people', () => {
    should(shareProblem(named('crew', { howMany: { kind: 'multi', cap: '1' } }))).equal(CAP_PROBLEM);
    should(shareProblem(named('crew', { howMany: { kind: 'multi', cap: '30' } }))).be.null();
  });
  it('finds the person a typed ID already is, ignoring case and spacing', () => {
    should(personWithId(' alice ', [alice, bob])).equal(alice);
    should(personWithId('ALICE', [alice])).equal(alice);
    should(personWithId('carol', [alice])).be.undefined();
    should(personWithId('  ', [alice])).be.undefined();
  });
  it('suggests people whose ID holds what was typed, those that start with it first, never for an exact match', () => {
    const malice = memberView({ memberId: MEMBER_B, label: 'Malice' });
    should(suggestPeople('ali', [malice, alice]).map(person => person.label)).eql(['Alice', 'Malice']);
    should(suggestPeople('alice', [alice])).eql([]);
    should(suggestPeople('', [alice])).eql([]);
    should(suggestPeople('zed', [alice])).eql([]);
    const many = Array.from({ length: 8 }, (_, index) =>
      memberView({ memberId: `mbr_${String(index).repeat(22)}`, label: `al${String(index)}` }),
    );
    should(suggestPeople('al', many)).have.length(5);
  });
  it('knows a person with no passkey on any browser has none left', () => {
    should(hasNoPasskeyLeft(alice)).be.false();
    should(hasNoPasskeyLeft(noPasskey)).be.true();
    should(hasNoPasskeyLeft(memberView({ keys: [] }))).be.true();
  });
  it('offers the new-passkey box only for an existing person on a single-use invite', () => {
    should(newPasskeyChoice(named('carol'), [alice])).eql({ offered: false, ticked: false, preTicked: false });
    should(newPasskeyChoice(named('alice', { howMany: { kind: 'multi', cap: '5' } }), [alice]).offered).be.false();
    should(newPasskeyChoice(named('alice'), [alice])).eql({ offered: true, ticked: false, preTicked: false });
  });
  it('pre-ticks it when the daemon would say the person has no passkey left, until the owner touches it', () => {
    should(newPasskeyChoice(named('sam'), [noPasskey])).eql({ offered: true, ticked: true, preTicked: true });
    should(newPasskeyChoice(named('sam', { newPasskey: false }), [noPasskey])).eql({
      offered: true,
      ticked: false,
      preTicked: false,
    });
    should(newPasskeyChoice(named('alice', { newPasskey: true }), [alice])).eql({
      offered: true,
      ticked: true,
      preTicked: false,
    });
  });
  it('says the new-passkey words', () => {
    should(newPasskeyHelp('alice')).equal(
      "Only tick this if alice can't use their passkey any more. Whoever opens this invite can then sign in as alice.",
    );
    should(newPasskeyPreTicked('alice')).equal('alice has no passkey left, so this invite lets them create one.');
  });
  it('says what an existing person already has', () => {
    const catalogs = [ownedCatalog()];
    should(whatTheyHave(alice, catalogs)).equal('2 browsers · Team skills');
    should(whatTheyHave(memberView({ keys: [], catalogIds: [] }), catalogs)).equal('no browsers yet');
    should(whatTheyHave(alice, [])).equal('2 browsers · 1 catalog');
  });
  it('says what the typed ID means: the same person, or a new one', () => {
    const catalogs = [ownedCatalog()];
    should(userIdLine(named('alice'), [alice], catalogs)).eql({
      kind: 'existing',
      id: 'Alice',
      before: '',
      after:
        ' already has access here (2 browsers · Team skills). This invite reaches the same person: they sign in with their Alice passkey.',
    });
    should(userIdLine(named(' carol '), [alice], catalogs)).eql({
      kind: 'new',
      id: 'carol',
      before: 'New user ID. The person who opens this invite creates a passkey for ',
      after: '.',
    });
    should(userIdLine(named(''), [alice], catalogs)).be.null();
    should(userIdLine(named('Ca\u200brol'), [alice], catalogs)).be.null();
  });
  it('builds the request with the typed ID as the name, trimmed', () => {
    should(mintRequest(CATALOG, named('  carol ', { expiresIn: '3h' }), [])).eql({
      catalogIds: [CATALOG],
      member: { name: 'carol' },
      expiresIn: '3h',
      uses: { kind: 'single' },
    });
  });
  it('asks for a new passkey only when it is ticked, and never for many', () => {
    should(mintRequest(CATALOG, named('alice'), [alice]).newPasskey).be.undefined();
    should(mintRequest(CATALOG, named('alice', { newPasskey: true }), [alice]).newPasskey).be.true();
    should(mintRequest(CATALOG, named('sam'), [noPasskey]).newPasskey).be.true();
    should(mintRequest(CATALOG, named('sam', { newPasskey: false }), [noPasskey]).newPasskey).be.undefined();
    should(
      mintRequest(CATALOG, named('sam', { newPasskey: true, howMany: { kind: 'multi', cap: '9' } }), [noPasskey])
        .newPasskey,
    ).be.undefined();
  });
  it('builds the request for many people', () => {
    should(mintRequest(CATALOG, named('crew', { howMany: { kind: 'multi', cap: '30' } }), []).uses).eql({
      kind: 'multi',
      cap: 30,
    });
    should(mintRequest(CATALOG, named('crew', { howMany: { kind: 'multi', cap: 'x' } }), []).uses).eql({
      kind: 'multi',
      cap: 50,
    });
  });
  it('names who the invite is for', () => {
    should(recipientName(named(' carol '), [])).equal('carol');
    should(recipientName(named('ALICE'), [alice])).equal('Alice');
  });
  it('titles the sheet', () => {
    should(shareSheetTitle('Team skills')).equal('Invite people to “Team skills”');
    should(shareResultTitle('carol')).equal('Invite for carol');
    should(shownOnceLine('carol')).equal('This is shown once. Send it to carol only.');
  });
});

describe('user IDs on the People list', () => {
  it('writes the facts under a card: since, browsers, passkeys', () => {
    should(personFacts(alice, 'UTC')).equal('since Oct 31 · 2 browsers · 1 passkey');
    should(personFacts(memberView({ keys: [] }), 'UTC')).equal('since Oct 31 · 0 browsers · 0 passkeys');
    should(personFacts(alice).startsWith('since ')).be.true();
  });
  it('says what a rename does before it is done, and after', () => {
    should(changeUserIdSentence('alice', 'alicia')).equal(
      'alice becomes alicia. They keep their browsers, passkeys and installs.',
    );
    should(userIdChangedNote('alice', 'alicia')).equal('alice is now alicia.');
  });
  it('says why a new ID cannot be saved: empty, hidden, the same, or taken by somebody else', () => {
    should(changeUserIdProblem(' ', alice, [alice, bob])).equal(SHARE_USER_ID_EMPTY);
    should(changeUserIdProblem('a\u200bb', alice, [alice, bob])).match(/hidden or invisible/);
    should(changeUserIdProblem('Alice', alice, [alice, bob])).equal('That is already their user ID.');
    should(changeUserIdProblem('bob', alice, [alice, bob])).equal(takenUserIdLine('bob'));
    should(takenUserIdLine('sam')).equal('Someone here already has the user ID sam. Pick another.');
    should(changeUserIdProblem('ALICE', alice, [alice, bob])).be.null();
    should(changeUserIdProblem('alicia', alice, [alice, bob])).be.null();
  });
});

describe('the countdown', () => {
  it('counts minutes and seconds under an hour', () => {
    should(shareCountdown('2026-10-31T09:14:52.000Z', T0_MS)).match({
      expired: false,
      clock: '14:52',
      secondsLeft: 892,
    });
  });
  it('adds hours from one hour up', () => {
    should(shareCountdown('2026-10-31T11:59:10.000Z', T0_MS).clock).equal('2:59:10');
    should(shareCountdown('2026-10-31T10:00:00.000Z', T0_MS).clock).equal('1:00:00');
  });
  it('is over at zero, and for an instant it cannot read', () => {
    should(shareCountdown(T0, T0_MS + 5_000)).match({ expired: true, clock: '0:00', secondsLeft: 0 });
    should(shareCountdown('not a time', T0_MS)).match({ expired: true, clock: '0:00' });
  });
  it('puts the countdown and the use together, or says it ran out', () => {
    const live = shareCountdown('2026-10-31T09:14:52.000Z', T0_MS);
    should(expiryLine(live, { kind: 'single' })).equal('Expires in 14:52 · single use');
    should(expiryLine(live, { kind: 'multi', cap: 50 })).equal('Expires in 14:52 · up to 50 people');
    should(expiryLine(shareCountdown(T0, T0_MS), { kind: 'single' })).equal(SHARE_EXPIRED_LINE);
  });
});

describe('time words', () => {
  it('writes a day, with the time when asked', () => {
    should(formatWhen(T0, { timeZone: 'UTC' })).equal('Oct 31');
    should(formatWhen(T0, { time: true, timeZone: 'UTC' })).equal('Oct 31, 09:00');
    should(formatWhen(T0).length).be.above(3);
    should(formatWhen('nonsense')).equal('an unknown time');
  });
});

describe('shares', () => {
  const later = T0_MS + 2 * 3_600_000;
  it('reads a live share whose time has passed as expired', () => {
    should(effectiveShareState(shareView(), T0_MS)).equal('live');
    should(effectiveShareState(shareView(), later)).equal('expired');
    should(effectiveShareState(shareView({ state: 'spent' }), T0_MS)).equal('spent');
  });
  it('says how long a code was made for, when that is one of the five', () => {
    should(shareLength(shareView())).equal('1 hour');
    should(shareLength(shareView({ expiresAt: '2026-10-31T09:20:00.000Z' }))).be.null();
  });
  it('shows an unused single-use share with its end time and a way to end it', () => {
    const row = shareRow(shareView(), T0_MS, 'UTC');
    should(row.line).equal('for Alice · 1 hour · unused · ends Oct 31, 10:00');
    should(shareRow(shareView({ newPasskey: true }), T0_MS, 'UTC').line).match(/unused · new passkey · ends/);
    should(row).match({ state: 'live', canEnd: true, usedBy: [] });
  });
  it('shows how many of a multi-use share are used, and who used it', () => {
    const share = shareView({
      uses: { kind: 'multi', cap: 50 },
      usedBy: [{ clientName: 'Firefox on a Mac', keyId: KEY_A1, at: T0 }],
    });
    const row = shareRow(share, T0_MS, 'UTC');
    should(row.line).match(/1 of 50 used/);
    should(row.usedBy).eql(['“Firefox on a Mac” Oct 31']);
  });
  it('shows a spent, expired and ended share without an End button', () => {
    should(shareRow(shareView({ state: 'spent' }), T0_MS).line).match(/spent/);
    should(shareRow(shareView(), later).line).match(/expired/);
    const ended = shareRow(shareView({ state: 'ended', expiresAt: '2026-10-31T09:20:00.000Z' }), T0_MS);
    should(ended.line).equal('for Alice · ended by you');
    should(ended.canEnd).be.false();
  });
  it('orders live codes first, soonest to end first, then the rest newest first', () => {
    const soon = shareView({ expiresAt: '2026-10-31T09:30:00.000Z' });
    const soonest = shareView({ shareId: SHARE_2, expiresAt: '2026-10-31T09:15:00.000Z' });
    const old = shareView({
      state: 'spent',
      createdAt: '2026-10-30T09:00:00.000Z',
      expiresAt: '2026-10-30T10:00:00.000Z',
    });
    const newer = shareView({
      state: 'spent',
      createdAt: '2026-10-31T08:00:00.000Z',
      expiresAt: '2026-10-31T09:00:00.000Z',
    });
    should(orderedShares([old, soon, newer, soonest], T0_MS)).eql([soonest, soon, newer, old]);
  });
});

describe('members', () => {
  const catalogs = [ownedCatalog()];
  it('lists only real catalogs to take away', () => {
    should(takeAwayChoices(alice, catalogs).map(catalog => catalog.id)).eql([CATALOG]);
    should(takeAwayChoices(bob, catalogs)).eql([]);
  });
  it('writes a browser line with join day, last seen and passkeys', () => {
    const [seen, fresh] = alice.keys as [(typeof alice.keys)[number], (typeof alice.keys)[number]];
    should(browserLine(seen, T0_MS, 'UTC')).equal('joined Oct 31 · seen 2h ago · 1 passkey');
    should(browserLine(fresh, T0_MS, 'UTC')).equal('joined Oct 30 · not seen yet · no passkey yet');
    should(browserLine(seen, T0_MS).startsWith('joined ')).be.true();
  });
  it('finds the newest multi-use code made for a person', () => {
    const one = shareView({ uses: { kind: 'multi', cap: 5 }, createdAt: '2026-10-30T09:00:00.000Z' });
    const two = shareView({ shareId: SHARE_2, uses: { kind: 'multi', cap: 9 } });
    should(multiShareOf(alice, [one, two, shareView()])).equal(two);
    should(multiShareOf(alice, [shareView()])).be.null();
    should(multiShareOf(bob, [one])).be.null();
  });
  it('summarises a multi-use code, live or over', () => {
    const live = shareView({ uses: { kind: 'multi', cap: 50 }, expiresAt: '2026-10-31T16:00:00.000Z' });
    should(multiSummary(live, T0_MS, 'UTC')).equal('multi-use code, 0 of 50 used, ends Oct 31, 16:00');
    should(multiSummary({ ...live, state: 'ended' }, T0_MS, 'UTC')).match(/ended Oct 31/);
    should(multiSummary(shareView(), T0_MS)).match(/0 of 0 used/);
  });
  it('counts the live codes made for a person', () => {
    should(
      liveShareCount(alice, [shareView(), shareView({ state: 'spent' }), shareView({ memberId: MEMBER_B })], T0_MS),
    ).equal(1);
  });
  it('labels the revoke button, folding a multi-use person into one count', () => {
    should(revokeLabel(alice, false)).equal('Revoke Alice…');
    should(revokeLabel(alice, true)).equal('Revoke all 2…');
    should(revokeLabel(bob, true)).equal('Revoke Bob…');
  });
});

describe('what each act says before it is done', () => {
  it('says what a revoke ends and what stays with the person', () => {
    const words = revokeConfirm(alice, 0);
    should(words.title).equal('Revoke Alice?');
    should(words.lines).eql([
      'Alice’s 2 browsers stop working now, and their open sessions close.',
      'What Alice already downloaded or installed stays with them.',
    ]);
    should(words.yes).equal('Revoke');
  });
  it('counts one browser, none, and the codes that end too', () => {
    should(revokeConfirm(bob, 1).lines).eql([
      'Bob’s 1 browser stops working now, and its open sessions close.',
      '1 code made for Bob ends too.',
      'What Bob already downloaded or installed stays with them.',
    ]);
    should(revokeConfirm(memberView({ keys: [] }), 3).lines.slice(0, 2)).eql([
      'Alice has no browsers yet.',
      '3 codes made for Alice end too.',
    ]);
  });
  it('says removing a browser keeps the others, or warns when it is the last', () => {
    const first = alice.keys[0] as (typeof alice.keys)[number];
    should(removeBrowserConfirm(alice, first)).match({ title: 'Remove Firefox on a Mac?', yes: 'Remove this browser' });
    should(removeBrowserConfirm(alice, first).lines[1]).equal('Alice’s other browsers keep working.');
    should(removeBrowserConfirm(bob, first).lines[1]).match(/only browser Bob has/);
  });
  it('says what taking a catalog away does', () => {
    should(takeAwayConfirm(alice, 'Team skills')).eql({
      title: 'Take Team skills away from Alice?',
      lines: ['Alice stops seeing it now.', 'What they already installed stays with them.'],
      yes: 'Take it away',
    });
  });
  it('writes the notes after each act', () => {
    should(shareEndedNote('Alice')).equal('The code for Alice is ended.');
    should(browserRemovedNote('Alice', 'Chrome')).equal('Chrome is removed. Alice’s other browsers keep working.');
    should(catalogTakenNote('Alice', 'Team skills')).equal('Alice can no longer read Team skills.');
    should(revokedNote('Alice', 2, 0)).equal('Alice is revoked. 2 browsers removed.');
    should(revokedNote('Alice', 1, 2)).equal('Alice is revoked. 1 browser removed and 2 codes ended.');
  });
});

describe('refusals', () => {
  it('gives each sharing refusal a sentence with a next step', () => {
    for (const code of [
      'share_unknown',
      'member_unknown',
      'member_key_unknown',
      'catalog_unknown',
      'members_full',
      'shares_full',
      'catalogs_full',
      'share_link_unavailable',
      'store_damaged',
    ]) {
      const refusal = sharingRefusal(http(code));
      should(refusal.sentence.length).be.above(20);
      should(refusal).match({ previewAgain: false, sharingOff: false });
    }
    should(sharingRefusal(http('share_link_unavailable', 503)).sentence).match(/Nothing was spent/);
    // A machine already on a relay is never told to go and get one.
    should(sharingRefusal(http('share_link_unavailable', 503)).sentence).match(/not on a relay their browser can find/);
  });
  it('falls back to the catalogs’ own wording, and to Sharing being off', () => {
    should(sharingRefusal(http('grant_step_up_required', 403)).sentence).match(/passkey/);
    should(sharingRefusal(new Error('boom')).sharingOff).be.false();
    should(sharingRefusal(http('grant_device_not_granted', 403)).sharingOff).be.true();
  });
});
