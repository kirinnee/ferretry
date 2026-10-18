import { describe, it } from 'bun:test';
import should from 'should';
import {
  assignedTaskDocument,
  messageWithAttachments,
  parseHandoffPointer,
  parseMessageAttachments,
  queuedMessageInstruction,
  readHandoffDocument,
  SessionHandoffNameSchema,
  SessionHandoffSchema,
  turnFileInstruction,
} from '../../src/lib/turn-handoff.ts';

const TURN_FILE = '/home/kirin/.ferretry/state/sessions/ms0v8vgc-d445a669/turns/turn-008.md';
const QUEUED_FILE = '/home/kirin/.ferretry/state/sessions/ms0v8vgc-d445a669/channel/queued-req_7f-2.md';

describe('the turn pointer', () => {
  it('should write the exact sentence a ready pane is given', () => {
    should(turnFileInstruction(TURN_FILE)).equal(
      `Read the file ${TURN_FILE} now, then carefully follow every instruction inside it. This is your complete task for this turn.`,
    );
  });

  it('should write the exact sentence a busy pane is given', () => {
    should(queuedMessageInstruction(QUEUED_FILE)).equal(
      `Read the queued message file at ${QUEUED_FILE} completely now, then follow every instruction inside it.`,
    );
  });

  it('should read back the turn and the queued send it wrote, on any home and platform', () => {
    should(parseHandoffPointer(turnFileInstruction(TURN_FILE))).deepEqual({
      kind: 'turn',
      name: 'turn-008',
      turn: 8,
      path: TURN_FILE,
    });
    should(parseHandoffPointer(`  ${queuedMessageInstruction(QUEUED_FILE)}\n`)).deepEqual({
      kind: 'queued',
      name: 'queued-req_7f-2',
      sendId: 'req_7f-2',
      path: QUEUED_FILE,
    });
    const windows = 'C:\\Users\\me\\fy\\state\\sessions\\abc\\turns\\turn-042.md';
    should(parseHandoffPointer(turnFileInstruction(windows))?.name).equal('turn-042');
  });

  it("should leave a person's own prose alone, even when it quotes a pointer", () => {
    should(parseHandoffPointer(`is this legit? ${turnFileInstruction(TURN_FILE)}`)).be.null();
    should(parseHandoffPointer(`${turnFileInstruction(TURN_FILE)} Also, fix the tests.`)).be.null();
    should(parseHandoffPointer(turnFileInstruction('/tmp/notes.md'))).be.null();
    should(parseHandoffPointer(queuedMessageInstruction('/tmp/turns/turn-001.md'))).be.null();
    should(parseHandoffPointer(turnFileInstruction(''))).be.null();
    should(parseHandoffPointer('Read the file  now, then carefully follow every instruction inside it.')).be.null();
  });
});

describe('the hand-off name', () => {
  it('should accept only a turn or a queued send, so no caller can name a path', () => {
    for (const name of ['turn-001', 'turn-123456789', 'queued-req_1-a']) should(SessionHandoffNameSchema.parse(name));
    for (const name of ['turn-', 'turn-1a', '../turn-001', 'queued-a/b', 'queued-', 'state', 'turn-0010000000'])
      should(SessionHandoffNameSchema.safeParse(name).success).be.false();
  });

  it('should carry a message and its attachments, with an id only where one is fetchable', () => {
    const handoff = {
      name: 'turn-002',
      message: 'see',
      attachments: [
        { attachmentId: 'att_1', filename: 'a.png', mime: 'image/png' },
        { filename: 'b', mime: 'x/y' },
      ],
    };
    should(SessionHandoffSchema.parse(handoff)).deepEqual(handoff);
    should(SessionHandoffSchema.safeParse({ ...handoff, path: '/etc' }).success).be.false();
  });
});

describe('the attachment list', () => {
  const files = [
    { path: '/state/attachments/d/s/att_1/shot.png', mime: 'image/png' },
    { path: '/state/attachments/d/s/att_2/note.m4a', mime: 'audio/mp4' },
  ];

  it('should leave a message with nothing attached exactly as it was', () => {
    should(messageWithAttachments('hello', [])).equal('hello');
  });

  it('should list every attached file by path and type after the message', () => {
    should(messageWithAttachments('see these', files)).equal(
      'see these\n\nAttached files — open them from these paths:\n' +
        '- /state/attachments/d/s/att_1/shot.png (image/png)\n' +
        '- /state/attachments/d/s/att_2/note.m4a (audio/mp4)',
    );
  });

  it('should read back the words and the files it wrote', () => {
    should(parseMessageAttachments(messageWithAttachments('line one\n\nline two', files))).deepEqual({
      message: 'line one\n\nline two',
      files,
    });
    should(parseMessageAttachments(`${messageWithAttachments('x', files)}\n\n`).files).deepEqual(files);
  });

  it('should keep text whole when the list is not exactly the written shape', () => {
    const odd = 'see\n\nAttached files — open them from these paths:\n- /a.png (image/png)\nand then more prose';
    should(parseMessageAttachments(odd)).deepEqual({ message: odd, files: [] });
    should(parseMessageAttachments('plain words')).deepEqual({ message: 'plain words', files: [] });
  });
});

describe('the hand-off document', () => {
  const reminder = 'Continue using the same completion and interaction protocol.';

  it('should read a sent turn back as the message and its files', () => {
    const document = `${messageWithAttachments('look', [{ path: '/x/att_1/a.png', mime: 'image/png' }])}\n`;
    should(readHandoffDocument(document, reminder)).deepEqual({
      message: 'look',
      files: [{ path: '/x/att_1/a.png', mime: 'image/png' }],
    });
  });

  it('should take the turn-one heading off an assigned task', () => {
    should(readHandoffDocument(assignedTaskDocument('Do the work'))).deepEqual({ message: 'Do the work', files: [] });
  });

  it("should take a revived turn's protocol reminder off, and only when it ends the document", () => {
    should(readHandoffDocument(`Pick it up again\n\n${reminder}\n`, reminder).message).equal('Pick it up again');
    should(readHandoffDocument(`${reminder} is what I said`, reminder).message).equal(`${reminder} is what I said`);
    should(readHandoffDocument('hello\n', '  ').message).equal('hello');
  });
});
