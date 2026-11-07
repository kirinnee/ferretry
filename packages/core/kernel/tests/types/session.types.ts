import type { MemberRedemptionBody } from '../../contract/session.ts';

const join: MemberRedemptionBody = {
  act: 'join',
  code: 'fixture',
  clientName: 'page',
  memberKey: 'ed25519',
  boxKey: 'x25519',
};
const options: MemberRedemptionBody = {
  act: 'join-options',
  code: 'fixture',
  memberKey: 'ed25519',
  origin: 'https://fixture.test',
};
// @ts-expect-error join requires the box key
const missingBox: MemberRedemptionBody = { act: 'join', code: 'fixture', clientName: 'page', memberKey: 'ed25519' };
// @ts-expect-error join-options requires an origin
const missingOrigin: MemberRedemptionBody = { act: 'join-options', code: 'fixture', memberKey: 'ed25519' };
void [join, options, missingBox, missingOrigin];
