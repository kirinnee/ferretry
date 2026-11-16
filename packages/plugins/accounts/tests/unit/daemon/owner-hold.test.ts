import { describe, it } from 'bun:test';
import should from 'should';
import { holdsOwner, type OwnerHoldReads } from '../../../daemon/lib/owner-hold.ts';

const clear = (over: Partial<OwnerHoldReads> = {}): OwnerHoldReads => ({
  inputCardOpen: () => false,
  phoneApprovalOpen: () => false,
  planAwaitingOwner: () => false,
  heldSecrets: () => 0,
  ...over,
});

describe('whether anything of the owner’s is open on a ferret', () => {
  it('should answer no when nothing is open', () => {
    should(holdsOwner(clear(), 'f1')).equal(false);
  });

  it.each([
    ['an input card', { inputCardOpen: () => true }],
    ['a phone approval', { phoneApprovalOpen: () => true }],
    ['a plan card', { planAwaitingOwner: () => true }],
    ['a secret it copied', { heldSecrets: () => 2 }],
  ] as const)('should answer yes for %s', (_name, over) => {
    should(holdsOwner(clear(over), 'f1')).equal(true);
  });

  it('should ask each read about the ferret and no other', () => {
    const asked: string[] = [];
    holdsOwner(
      clear({
        inputCardOpen: id => (asked.push(id), false),
        phoneApprovalOpen: id => (asked.push(id), false),
        planAwaitingOwner: id => (asked.push(id), false),
        heldSecrets: id => (asked.push(id), 0),
      }),
      'f9',
    );
    should(asked).eql(['f9', 'f9', 'f9', 'f9']);
  });

  it('should answer yes when the Vault offers no answer, because a hold that cannot be checked is a hold', () => {
    should(holdsOwner(clear({ inputCardOpen: () => undefined }), 'f1')).equal(true);
  });

  it('should answer yes when a read throws', () => {
    const broken = clear({
      phoneApprovalOpen: () => {
        throw new Error('unreadable');
      },
    });
    should(holdsOwner(broken, 'f1')).equal(true);
  });
});
