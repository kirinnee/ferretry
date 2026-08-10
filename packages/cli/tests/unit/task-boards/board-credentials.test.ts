import { describe, it } from 'bun:test';
import should from 'should';
import {
  coordinatorReplaceCommand,
  createBoardCommand,
  grantApproveCommand,
  grantRequestCommand,
  inviteAcceptCommand,
  inviteApproveCommand,
  inviteCommand,
  markDoneCommand,
  membershipCommand,
  relinquishCommand,
  revokeCommand,
} from '../../../src/lib/task-boards/board-command';
import {
  FY_BOARD_ADMIN_CAPABILITY_HEADER,
  FY_BOARD_CAPABILITY_HEADER,
  FY_BOARD_INVITATION_CAPABILITY_HEADER,
  FY_SESSION_BOARD_CAPABILITY_HEADER,
  taskBoardCredentialKind,
  taskBoardHeaders,
} from '../../../src/lib/task-boards/board-credentials';

const everything = { peer: 'peer-proof', admin: 'admin-proof', session: 'session-proof', invitation: 'invite-proof' };

describe('which proof a board command needs', () => {
  it('should let a peer use only its own binding', () => {
    // Act + Assert
    for (const command of [
      membershipCommand(),
      grantRequestCommand('c', { role: 'read' }),
      grantApproveCommand('g-1'),
      inviteCommand('s-9'),
      inviteApproveCommand('i-1'),
      relinquishCommand(),
    ]) {
      should(taskBoardCredentialKind(command)).equal('peer');
    }
  });

  it('should reserve the ACL commands for the operator', () => {
    // Act + Assert
    for (const command of [
      createBoardCommand({ creator: 'a', coordinator: 'b' }),
      markDoneCommand('s-1', { enable: true }),
      coordinatorReplaceCommand('s-1', 's-2', 'root-2'),
      revokeCommand('s-1', 's-2', { reason: 'x' }),
    ]) {
      should(taskBoardCredentialKind(command)).equal('admin');
    }
  });

  it('should treat accepting an invitation as its own credential class', () => {
    // Act + Assert
    should(taskBoardCredentialKind(inviteAcceptCommand())).equal('invitation');
  });
});

describe('the headers a board command carries', () => {
  it('should send only the peer binding for a peer command', () => {
    // Act
    const actual = taskBoardHeaders(membershipCommand(), everything);

    // Assert — the operator and invitation proofs must not ride along.
    should(actual).eql({ [FY_BOARD_CAPABILITY_HEADER]: 'peer-proof' });
  });

  it('should send only the operator capability for an ACL command', () => {
    // Act
    const actual = taskBoardHeaders(revokeCommand('s-1', 's-2', { reason: 'x' }), everything);

    // Assert
    should(actual).eql({ [FY_BOARD_ADMIN_CAPABILITY_HEADER]: 'admin-proof' });
  });

  it('should send both invitation proofs, and nothing else, when accepting', () => {
    // Act
    const actual = taskBoardHeaders(inviteAcceptCommand(), everything);

    // Assert
    should(actual).eql({
      [FY_SESSION_BOARD_CAPABILITY_HEADER]: 'session-proof',
      [FY_BOARD_INVITATION_CAPABILITY_HEADER]: 'invite-proof',
    });
  });

  it('should refuse a peer command when this session has no membership', () => {
    // Act + Assert
    should(() => taskBoardHeaders(membershipCommand(), { admin: 'admin-proof' })).throw(
      /FY_BOARD_CAPABILITY is unset/u,
    );
    should(() => taskBoardHeaders(membershipCommand(), { peer: '   ' })).throw(/FY_BOARD_CAPABILITY is unset/u);
  });

  it('should refuse an ACL command from inside a teammate pane', () => {
    // Act + Assert — holding a peer binding must never stand in for the operator capability.
    should(() => taskBoardHeaders(markDoneCommand('s-1', { enable: true }), { peer: 'peer-proof' })).throw(
      /FY_BOARD_ADMIN_CAPABILITY/u,
    );
  });

  it('should refuse an accept that is missing either proof', () => {
    // Act + Assert
    should(() => taskBoardHeaders(inviteAcceptCommand(), { invitation: 'invite-proof' })).throw(
      /FY_SESSION_BOARD_CAPABILITY/u,
    );
    should(() => taskBoardHeaders(inviteAcceptCommand(), { session: 'session-proof' })).throw(
      /FY_BOARD_INVITATION_CAPABILITY/u,
    );
  });

  it('should trim a proof that arrived with surrounding whitespace', () => {
    // Act
    const actual = taskBoardHeaders(membershipCommand(), { peer: '  peer-proof \n' });

    // Assert
    should(actual).eql({ [FY_BOARD_CAPABILITY_HEADER]: 'peer-proof' });
  });
});
