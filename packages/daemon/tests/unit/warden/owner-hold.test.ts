import { describe, it } from 'bun:test';
import should from 'should';
import { ownerHoldReason, type WardenOwnerHoldPorts } from '../../../src/lib/warden/owner-hold.ts';

const SESSION = 's1';

const permission = {
  id: 'aaaaaaaaaaaaaaaa',
  harness: 'claude',
  tool: 'Bash',
  action: 'run',
  what: 'ls',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};

const dialog = (kind: string, title: string) => ({
  id: 'bbbbbbbbbbbbbbbb',
  harness: 'codex',
  kind,
  title,
  options: [{ number: 1, label: 'Continue', grantsTrust: false }],
  selected: 1,
});

const limitedState = { id: SESSION, status: 'rate_limited', turn: 3 };

/** Nothing of the owner's open: every check passes. */
const clear = (overrides: Partial<WardenOwnerHoldPorts> = {}): WardenOwnerHoldPorts => ({
  inputCardOpen: () => false,
  phoneApprovalOpen: () => false,
  planAwaitingOwner: () => false,
  heldSecrets: () => 0,
  surfaceAsked: async () => false,
  state: async () => limitedState,
  ...overrides,
});

describe('ownerHoldReason', () => {
  it('should find nothing when nothing of the owner’s is open, a usage-limit dialog included', async () => {
    // Act
    const none = await ownerHoldReason(clear(), SESSION);
    const limitDialog = await ownerHoldReason(
      clear({ state: async () => ({ ...limitedState, harnessDialog: dialog('usage-limit', 'You hit your limit') }) }),
      SESSION,
    );

    // Assert
    should(none).be.undefined();
    should(limitDialog).be.undefined();
  });

  it.each([
    ['an input card', { inputCardOpen: () => true }, 'it has an input card open for the owner'],
    [
      'a phone approval',
      { phoneApprovalOpen: () => true },
      'it is waiting for the owner to approve a sign-in on their phone',
    ],
    ['a plan card', { planAwaitingOwner: () => true }, 'it has a plan card waiting for the owner'],
    ['a held secret', { heldSecrets: () => 1 }, 'it holds a secret it copied, which a move would drop'],
    [
      'a terminal handed to the owner',
      { surfaceAsked: async (_id: string, surface: string) => surface === 'terminal' },
      'it handed its terminal to the owner, who has not given it back',
    ],
    [
      'a browser handed to the owner',
      { surfaceAsked: async (_id: string, surface: string) => surface === 'browser' },
      'it handed its browser to the owner, who has not given it back',
    ],
    [
      'a surface that cannot be read',
      {
        surfaceAsked: async () => {
          throw new Error('gone');
        },
      },
      'whether it handed its terminal to the owner could not be read',
    ],
    [
      'a permission prompt',
      { state: async () => ({ ...limitedState, permissionRequest: permission }) },
      'it is waiting on a permission prompt',
    ],
    [
      'another dialog',
      { state: async () => ({ ...limitedState, harnessDialog: dialog('hooks-review', 'Hooks need review') }) },
      'it is waiting on a dialog: Hooks need review',
    ],
    ['an unreadable state', { state: async () => ({ status: 'nonsense' }) }, 'its state could not be read'],
    [
      'a state that throws',
      {
        state: async () => {
          throw new Error('EACCES');
        },
      },
      'its state could not be read',
    ],
  ] as const)('should hold for %s', async (_name, overrides, expected) => {
    // Act
    const reason = await ownerHoldReason(clear(overrides as Partial<WardenOwnerHoldPorts>), SESSION);

    // Assert
    should(reason).equal(expected);
  });
});
