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
  inviteVerifyCommand,
  markDoneCommand,
  membershipCommand,
  relinquishCommand,
  revokeCommand,
} from '../../../src/lib/task-boards/board-command';

describe('board commands', () => {
  it('should describe membership, acceptance, verification and relinquish with no payload at all', () => {
    // Act + Assert — no board id anywhere: the caller authenticates as itself.
    should(membershipCommand()).eql({ command: 'membership' });
    should(inviteAcceptCommand()).eql({ command: 'invite-accept' });
    should(inviteVerifyCommand()).eql({ command: 'invite-verify' });
    should(relinquishCommand()).eql({ command: 'relinquish' });
  });

  it('should build a create for a creator and its coordinator', () => {
    // Act
    const actual = createBoardCommand({ creator: ' s-1 ', coordinator: 's-2', markDone: true });

    // Assert
    should(actual).eql({
      command: 'create',
      body: { creatorSessionId: 's-1', coordinatorSessionId: 's-2', creatorMarkDone: true },
    });
  });

  it('should default mark-done off when creating', () => {
    // Act
    const actual = createBoardCommand({ creator: 's-1', coordinator: 's-2' });

    // Assert
    should(actual).have.propertyByPath('body', 'creatorMarkDone').equal(false);
  });

  it('should refuse a create missing either session', () => {
    // Act + Assert
    should(() => createBoardCommand({ coordinator: 's-2' })).throw(/--creator is required/u);
    should(() => createBoardCommand({ creator: 's-1', coordinator: '  ' })).throw(/--coordinator is required/u);
  });

  it('should build a grant request for each role a child may hold', () => {
    // Act + Assert
    for (const role of ['read', 'worker', 'coordinator']) {
      should(grantRequestCommand('child-1', { role })).eql({
        command: 'grant-request',
        body: { targetSessionId: 'child-1', role },
      });
    }
  });

  it('should refuse a grant request with no role, an unknown role, or no child', () => {
    // Act + Assert
    should(() => grantRequestCommand('child-1', {})).throw(/--role is required/u);
    should(() => grantRequestCommand('child-1', { role: 'admin' })).throw(/--role must be one of/u);
    should(() => grantRequestCommand('   ', { role: 'read' })).throw(/child session is required/u);
  });

  it('should build the approval and invitation commands from their ids', () => {
    // Act + Assert
    should(grantApproveCommand('g-1')).eql({ command: 'grant-approve', body: { grantRequestId: 'g-1' } });
    should(inviteCommand('s-9')).eql({ command: 'invite', body: { targetSessionId: 's-9' } });
    should(inviteApproveCommand('i-1')).eql({ command: 'invite-approve', body: { invitationRequestId: 'i-1' } });
  });

  it('should refuse an approval or invitation with a blank id', () => {
    // Act + Assert
    should(() => grantApproveCommand('')).throw(/grant request id is required/u);
    should(() => inviteCommand(' ')).throw(/external session is required/u);
    should(() => inviteApproveCommand('')).throw(/invitation request id is required/u);
  });

  it('should require exactly one of --enable and --disable on mark-done', () => {
    // Act + Assert
    should(markDoneCommand('s-1', { enable: true })).eql({
      command: 'mark-done',
      body: { sessionId: 's-1', enabled: true },
    });
    should(markDoneCommand('s-1', { disable: true })).eql({
      command: 'mark-done',
      body: { sessionId: 's-1', enabled: false },
    });
    should(() => markDoneCommand('s-1', {})).throw(/exactly one of --enable or --disable/u);
    should(() => markDoneCommand('s-1', { enable: true, disable: true })).throw(/exactly one of/u);
  });

  it('should refuse mark-done with no session', () => {
    // Act + Assert
    should(() => markDoneCommand('', { enable: true })).throw(/top-level session is required/u);
  });

  it('should build a coordinator replacement', () => {
    // Act
    const actual = coordinatorReplaceCommand('s-1', 's-2');

    // Assert
    should(actual).eql({ command: 'coordinator-replace', body: { sessionId: 's-1', replacementSessionId: 's-2' } });
  });

  it('should refuse a replacement missing either side', () => {
    // Act + Assert
    should(() => coordinatorReplaceCommand('', 's-2')).throw(/current board member is required/u);
    should(() => coordinatorReplaceCommand('s-1', ' ')).throw(/replacement session is required/u);
  });

  it('should build a revocation that records why', () => {
    // Act
    const actual = revokeCommand('s-1', 's-2', { reason: 'left the project' });

    // Assert
    should(actual).eql({
      command: 'revoke',
      body: { sessionId: 's-1', targetSessionId: 's-2', reason: 'left the project' },
    });
  });

  it('should refuse a revocation with no reason or no target', () => {
    // Act + Assert
    should(() => revokeCommand('s-1', 's-2', {})).throw(/--reason is required/u);
    should(() => revokeCommand('s-1', '', { reason: 'x' })).throw(/target session is required/u);
  });
});
