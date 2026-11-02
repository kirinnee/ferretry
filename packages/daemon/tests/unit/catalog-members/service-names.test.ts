import { describe, it } from 'bun:test';
import should from 'should';
import type { MembersUpgrade } from '../../../src/lib/catalog-members/ports.ts';
import {
  codeOf,
  DAY,
  HOUR,
  joinOf,
  keyId,
  memberId,
  memberOf,
  membersDoc,
  multiFor,
  multiNamed,
  newKey,
  refusal,
  rig,
  sharesDoc,
  singleFor,
  singleForMember,
  singleNamed,
  storedKey,
  storedMember,
  storedShare,
  T0,
} from './support.ts';

const alice = () => storedMember(1, { label: 'Alice', keys: [storedKey(11), storedKey(12)] });

describe('a name is a user ID: minting', () => {
  it('should reach the person who already has the ID, however it is typed', async () => {
    const r = await rig({ members: membersDoc(alice()) });

    const minted = await r.service.mint(singleNamed('  ALICE '));

    should(minted.share.memberId).equal(memberId(1));
    should(minted.share.memberLabel).equal('Alice');
  });

  it('should make a new person, and keep the name as typed, for an ID nobody has', async () => {
    const r = await rig({ members: membersDoc(alice()) });

    const minted = await r.service.mint(singleNamed('Bob'));

    should(minted.share.memberId).not.equal(memberId(1));
    should(minted.share.memberLabel).equal('Bob');
    should(r.shares.document.shares[0]?.memberKind).equal('new');
    should(r.members.document.members).have.length(1);
  });

  it('should record a reach to someone already in as an existing member', async () => {
    const r = await rig({ members: membersDoc(alice()) });

    await r.service.mint(singleNamed('alice'));

    should(r.shares.document.shares[0]?.memberKind).equal('existing');
  });

  it('should give two invites for one new ID the same person', async () => {
    const r = await rig();

    const first = await r.service.mint(singleNamed('Bob'));
    const second = await r.service.mint(singleNamed('bob'));

    should(second.share.memberId).equal(first.share.memberId);
    should(r.shares.document.shares.map(share => share.memberKind)).eql(['new', 'new']);
  });

  it('should still take the older arms', async () => {
    const r = await rig({ members: membersDoc(alice()) });

    const fresh = await r.service.mint(singleFor('Carol'));
    const known = await r.service.mint(singleForMember(1));

    should(fresh.share.memberLabel).equal('Carol');
    should(known.share.memberId).equal(memberId(1));
  });

  it('should refuse a new person whose ID a member has, naming that member', async () => {
    const r = await rig({ members: membersDoc(alice()) });

    const error = await refusal(() => r.service.mint(singleFor('ALICE')));

    should(error.refusal).equal('member_exists');
    should(error.message).equal('Someone here already has the user ID ALICE. Pick another.');
    should(error.memberId).equal(memberId(1));
    should(r.shares.writes).equal(0);
  });

  it('should refuse a new person whose ID is reserved by a live invite', async () => {
    const r = await rig();
    const first = await r.service.mint(singleFor('Bob'));

    const error = await refusal(() => r.service.mint(singleFor('bob')));

    should(error.refusal).equal('member_exists');
    should(error.memberId).equal(first.share.memberId);
  });

  it('should let a code for many people name someone already in', async () => {
    const r = await rig({ members: membersDoc(alice()) });

    const minted = await r.service.mint(multiNamed('Alice', 10));

    should(minted.share.memberId).equal(memberId(1));
    should(minted.share.uses).eql({ kind: 'multi', cap: 10 });
  });

  it('should still give a code for many people a new person when it names one', async () => {
    const r = await rig();

    const minted = await r.service.mint(multiFor('Team', 5));

    should(minted.share.memberLabel).equal('Team');
  });
});

describe('a name is a user ID: the reservation', () => {
  it('should hold the ID while the invite is live and nobody has joined', async () => {
    const r = await rig();
    await r.service.mint(singleNamed('Bob'));

    const taken = await r.service.listMembers('BOB');

    should(taken.match).equal(r.shares.document.shares[0]?.memberId);
  });

  it('should let go when the invite expires', async () => {
    const r = await rig();
    await r.service.mint(singleNamed('Bob'));
    r.clock.now = T0 + HOUR;

    const found = await r.service.listMembers('Bob');
    const again = await r.service.mint(singleFor('Bob'));

    should(found.match).be.undefined();
    should(again.share.memberLabel).equal('Bob');
  });

  it('should let go when the owner ends the only invite', async () => {
    const r = await rig();
    const minted = await r.service.mint(singleNamed('Bob'));
    await r.service.endShare(minted.share.shareId);

    should((await r.service.listMembers('Bob')).match).be.undefined();
    await r.service.mint(singleFor('Bob'));
  });

  it('should hold while any one of two invites is live', async () => {
    const r = await rig();
    const first = await r.service.mint(singleNamed('Bob'));
    r.clock.now = T0 + 30 * 60_000;
    await r.service.mint(singleNamed('Bob'));
    await r.service.endShare(first.share.shareId);
    r.clock.now = T0 + HOUR + 1;

    should((await r.service.listMembers('Bob')).match).be.ok();
  });

  it('should hold the ID while a join with it is in flight', async () => {
    const r = await rig();
    const minted = await r.service.mint(singleNamed('Bob'));
    const reservation = joinOf(r.service.admitJoin(minted.code, T0));
    r.clock.now = T0 + HOUR + 1;

    should((await r.service.listMembers('Bob')).match).equal(reservation.memberId);
    const error = await refusal(() => r.service.mint(singleFor('Bob')));
    should(error.memberId).equal(reservation.memberId);
  });

  it('should belong to the member for good once they join, with no invite left', async () => {
    const r = await rig();
    const minted = await r.service.mint(singleNamed('Bob'));
    const joined = await r.service.commit(joinOf(r.service.admitJoin(minted.code, T0)), newKey(1));
    r.clock.now = T0 + 5 * DAY;

    should((await r.service.listMembers('bob')).match).equal(joined.memberId);
  });

  it('should be free again when the person is removed before anyone joined', async () => {
    const r = await rig({ members: membersDoc(alice()) });
    await r.service.revokeMember(memberId(1));

    should((await r.service.listMembers('Alice')).match).be.undefined();
    await r.service.mint(singleFor('Alice'));
  });

  it('should answer no match when no name is asked about', async () => {
    const r = await rig({ members: membersDoc(alice()) });

    should(await r.service.listMembers()).not.have.property('match');
    should((await r.service.listMembers('Zed')).match).be.undefined();
    should((await r.service.listMembers('alice')).match).equal(memberId(1));
  });
});

describe('a name is a user ID: renaming', () => {
  const pair = () => membersDoc(alice(), storedMember(2, { label: 'Bob' }));

  it('should refuse a name another member has, and write nothing', async () => {
    const r = await rig({ members: pair() });

    const error = await refusal(() => r.service.renameMember(memberId(2), 'ALICE'));

    should(error.refusal).equal('member_exists');
    should(error.message).equal('Someone here already has the user ID ALICE. Pick another.');
    should(error.memberId).equal(memberId(1));
    should(r.log).eql([]);
  });

  it('should refuse a name an invite is waiting for', async () => {
    const r = await rig({ members: pair() });
    const minted = await r.service.mint(singleNamed('Carol'));

    const error = await refusal(() => r.service.renameMember(memberId(2), 'CAROL'));

    should(error.memberId).equal(minted.share.memberId);
  });

  it('should let a person change the case or spacing of their own ID', async () => {
    const r = await rig({ members: pair() });

    const view = await r.service.renameMember(memberId(1), 'ALICE  B');
    const back = await r.service.renameMember(memberId(1), 'alice');

    should(view.memberId).equal(memberId(1));
    should(back.label).equal('alice');
    should(memberOf(r.members.document, 1).keys).have.length(2);
  });

  it('should keep codes already minted for the person reaching them', async () => {
    const r = await rig({ members: pair() });
    const minted = await r.service.mint(singleForMember(1));

    await r.service.renameMember(memberId(1), 'Alicia');

    should(joinOf(r.service.admitJoin(minted.code, T0)).memberId).equal(memberId(1));
    should((await r.service.mint(singleNamed('alicia'))).share.memberId).equal(memberId(1));
  });
});

describe('a name is a user ID: the browsers of one person', () => {
  it('should list the key ids of the person, and none for nobody', async () => {
    const r = await rig({ members: membersDoc(alice()) });

    should(await r.service.keyIdsOf(memberId(1))).eql([keyId(11), keyId(12)]);
    should(await r.service.keyIdsOf(memberId(9))).eql([]);
  });
});

describe('a name is a user ID: a join whose ID was taken meanwhile', () => {
  it('should give the new person a free ID and say so, never a second copy', async () => {
    // A share written before names were IDs: its person was never checked against the members.
    const r = await rig({
      members: membersDoc(storedMember(7, { label: 'Bob' })),
      shares: sharesDoc(storedShare(3, { memberId: memberId(3), memberLabel: 'bob' })),
    });

    const joined = await r.service.commit(joinOf(r.service.admitJoin(codeOf(3), T0)), newKey(1));

    should(memberOf(r.members.document, 3).label).equal('bob (2)');
    should(joined.memberId).equal(memberId(3));
    should(r.renamed).eql([[{ memberId: memberId(3), from: 'bob', to: 'bob (2)' }]]);
    should(r.audit.entries.map(entry => entry.event)).containEql('catalog.member.renamed');
    should(JSON.stringify(r.audit.entries.filter(entry => entry.event === 'catalog.member.renamed'))).not.containEql(
      'bob',
    );
  });

  it('should keep a joining person’s name when it is free', async () => {
    const r = await rig();
    const minted = await r.service.mint(singleNamed('Bob'));

    await r.service.commit(joinOf(r.service.admitJoin(minted.code, T0)), newKey(1));

    should(r.members.document.members[0]?.label).equal('Bob');
    should(r.renamed).eql([]);
  });
});

describe('a name is a user ID: the one-time upgrade', () => {
  const upgrade = (committed: { count: number }, options: { failing?: boolean } = {}): MembersUpgrade => ({
    renames: [{ memberId: memberId(2), from: 'Alice', to: 'Alice (2)' }],
    commit: async () => {
      committed.count += 1;
      if (options.failing === true) throw new Error('disk full');
    },
  });

  it('should audit the rename by ID alone, commit once, and tell the owner once', async () => {
    const committed = { count: 0 };
    const r = await rig({
      members: membersDoc(alice(), storedMember(2, { label: 'Alice (2)' })),
      upgrade: upgrade(committed),
    });

    should(committed.count).equal(1);
    should(r.renamed).eql([[{ memberId: memberId(2), from: 'Alice', to: 'Alice (2)' }]]);
    should(r.audit.entries).have.length(1);
    const [entry] = r.audit.entries;
    should(entry?.event).equal('catalog.member.renamed');
    should(entry?.subject).equal(memberId(2));
    should(entry?.actor).eql({ kind: 'host' });
    should(entry?.detail).eql({ memberId: memberId(2), reason: 'duplicate-name' });
    should(JSON.stringify(r.audit.entries)).not.containEql('Alice');
  });

  it('should carry the new name to an invite that is still waiting', async () => {
    const committed = { count: 0 };
    const r = await rig({
      members: membersDoc(alice(), storedMember(2, { label: 'Alice (2)' })),
      shares: sharesDoc(storedShare(1, { memberId: memberId(2), memberLabel: 'Alice', memberKind: 'existing' })),
      upgrade: upgrade(committed),
    });

    should(r.shares.document.shares[0]?.memberLabel).equal('Alice (2)');
    should(r.shares.writes).equal(1);
  });

  it('should leave the shares alone when nobody was renamed', async () => {
    const r = await rig({
      members: membersDoc(alice()),
      upgrade: { renames: [], commit: async () => undefined },
    });

    should(r.shares.writes).equal(0);
    should(r.audit.entries).have.length(0);
    should(r.renamed).eql([[]]);
  });

  it('should carry on, and still tell the owner, when the disk will not take the write', async () => {
    const committed = { count: 0 };
    const r = await rig({
      members: membersDoc(alice(), storedMember(2, { label: 'Alice (2)' })),
      upgrade: upgrade(committed, { failing: true }),
    });

    should(committed.count).equal(1);
    should(r.renamed).have.length(1);
    should((await r.service.listMembers()).members.map(member => member.label)).eql(['Alice', 'Alice (2)']);
  });

  it('should carry on when the audit log is down', async () => {
    const committed = { count: 0 };
    const r = await rig({
      members: membersDoc(alice(), storedMember(2, { label: 'Alice (2)' })),
      upgrade: upgrade(committed),
      unloaded: true,
    });
    r.audit.failing = true;

    await r.service.ready();

    should(committed.count).equal(1);
  });
});
