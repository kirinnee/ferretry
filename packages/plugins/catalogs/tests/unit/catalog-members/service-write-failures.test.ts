import { describe, it } from 'bun:test';
import should from 'should';
import {
  catalogId,
  codeOf,
  failure,
  joinOf,
  keyId,
  memberId,
  membersDoc,
  newKey,
  redeemOf,
  refusal,
  rig,
  singleFor,
  singleForMember,
  storedKey,
  storedMember,
  T0,
} from './support.ts';

const holders = () => membersDoc(storedMember(7, { catalogIds: [catalogId(1)], keys: [storedKey(7)] }));

describe('a service that has not loaded its documents', () => {
  it('refuses to admit a join or a redeem, as unknown, and spends nothing', async () => {
    // Arrange
    const r = await rig({ unloaded: true });

    // Act
    const join = r.service.admitJoin(codeOf(1), T0);
    const redeem = r.service.admitRedeem(codeOf(1), memberId(7), T0);
    await join.persisted;
    await redeem.persisted;

    // Assert
    should(join).match({ ok: false, refusal: 'share_refused', reason: 'unknown' });
    should(redeem).match({ ok: false, refusal: 'share_refused', reason: 'unknown' });
    should(r.shares.writes).equal(0);
  });
});

describe('committing a join', () => {
  it('refuses a browser key that is already registered to someone here', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleFor('Alice'));
    const reservation = joinOf(r.service.admitJoin(code, T0));

    // Act
    const error = await refusal(() =>
      r.service.commit(reservation, { ...newKey(70), memberKey: storedKey(7).memberKey }),
    );

    // Assert
    should(error.refusal).equal('share_refused');
    should(error.message).match(/already registered/u);
  });

  it('puts the member side back when the member file cannot be written', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const reservation = joinOf(r.service.admitJoin(code, T0));
    r.members.failing = true;

    // Act
    const error = await failure(() => r.service.commit(reservation, newKey(70)));

    // Assert
    should(error.message).equal('members disk full');
    should((await r.service.listMembers()).members).have.length(0);
  });
});

describe('committing a redeem', () => {
  it('puts the member side back when the member file cannot be written', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));
    r.members.failing = true;

    // Act
    const error = await failure(() =>
      r.service.commitRedeem(reservation, { keyId: keyId(7), clientName: 'Browser 7' }),
    );

    // Assert
    should(error.message).equal('members disk full');
    const [person] = (await r.service.listMembers()).members;
    should(person?.catalogIds).eql([catalogId(1)]);
  });
});
