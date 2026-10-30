import { describe, it } from 'bun:test';
import { assignedTaskDocument, messageWithAttachments } from '@ferretry/protocol';
import should from 'should';
import { handoffFolders, handoffReadArguments, handoffView } from '../../../../src/lib/session/send/handoff.ts';

const context = { reminder: 'Keep the protocol.', attachmentRoot: '/state/attachments/d/s1' };

describe('a hand-off read back', () => {
  it('should carry who Ferretry wrote it as, when it says, and nothing when it does not', () => {
    const by = { kind: 'ferretry', feature: 'Warden' } as const;

    should(handoffView('turn-009', 'Carry on\n', context, by).by).deepEqual(by);
    should(handoffView('turn-009', 'Carry on\n', context)).not.have.property('by');
  });

  it("should give the person's words and fetchable ids for this session's own attachments", () => {
    const document = `${messageWithAttachments('look at this', [
      { path: '/state/attachments/d/s1/att_1/shot.png', mime: 'image/png' },
      { path: '/state/attachments/d/s2/att_9/other.pdf', mime: 'application/pdf' },
    ])}\n`;

    should(handoffView('turn-008', document, context)).deepEqual({
      name: 'turn-008',
      message: 'look at this',
      attachments: [
        { attachmentId: 'att_1', filename: 'shot.png', mime: 'image/png' },
        // Another session's copy keeps its name and type, and gets no id the app could fetch with.
        { filename: 'other.pdf', mime: 'application/pdf' },
      ],
    });
  });

  it('should read a first turn and a revived turn as what was asked', () => {
    should(handoffView('turn-001', assignedTaskDocument('Build it'), context).message).equal('Build it');
    should(handoffView('turn-004', 'Carry on\n\nKeep the protocol.\n', context)).deepEqual({
      name: 'turn-004',
      message: 'Carry on',
      attachments: [],
    });
  });
});

describe('reading what an agent was sent', () => {
  const folders = handoffFolders('/fy/state/sessions/s1', '/fy/state/attachments/d/s1');

  it("should name exactly the session's own hand-off folders", () => {
    should(folders).deepEqual([
      '/fy/state/sessions/s1/turns',
      '/fy/state/sessions/s1/channel',
      '/fy/state/sessions/s1/attachments',
      '/fy/state/attachments/d/s1',
    ]);
  });

  it('should let Claude read them without asking, and grant no folder or write beyond them', () => {
    should(handoffReadArguments('claude', folders)).deepEqual([
      '--allowedTools=Read(//fy/state/sessions/s1/turns/**)',
      '--allowedTools=Read(//fy/state/sessions/s1/channel/**)',
      '--allowedTools=Read(//fy/state/sessions/s1/attachments/**)',
      '--allowedTools=Read(//fy/state/attachments/d/s1/**)',
    ]);
  });

  it('should add nothing for Codex, whose sandbox already reads anywhere', () => {
    should(handoffReadArguments('codex', folders)).deepEqual([]);
  });
});
