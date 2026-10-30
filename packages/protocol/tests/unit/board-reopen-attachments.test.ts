import { describe, it } from 'bun:test';
import should from 'should';
import {
  BoardAttachmentSchema,
  BoardReopenAttachmentsSchema,
  BoardTaskActionRequestSchema,
  BoardTaskEventSchema,
  MAX_BOARD_REOPEN_ATTACHMENTS,
} from '../../src/lib/board.ts';

/** The files the owner sends with "Not good": on the request, and named in the card's history. */

const id = (digit: string): string => `att_${digit.repeat(64)}`;
const FILES = { from: 'child-1', ids: [id('a'), id('b')] };

describe('files on a move back', () => {
  it('should take files on a move and on a reopen, and leave both valid without them', () => {
    // Act
    const move = BoardTaskActionRequestSchema.parse({
      action: 'move',
      to: 'implement',
      reason: 'no',
      attachments: FILES,
    });
    const reopen = BoardTaskActionRequestSchema.parse({
      action: 'reopen',
      to: 'implement',
      reason: 'no',
      ask: { text: 'no', source: 'owner' },
      attachments: FILES,
    });

    // Assert
    should(move).match({ attachments: FILES });
    should(reopen).match({ attachments: FILES });
    should(BoardTaskActionRequestSchema.parse({ action: 'move', to: 'implement' })).not.have.property('attachments');
  });

  it.each([
    { name: 'no files', value: { from: 'child-1', ids: [] } },
    { name: 'a name that is not a stored id', value: { from: 'child-1', ids: ['flicker.png'] } },
    { name: 'the same file twice', value: { from: 'child-1', ids: [id('a'), id('a')] } },
    {
      name: 'more files than one move carries',
      value: {
        from: 'child-1',
        ids: Array.from(
          { length: MAX_BOARD_REOPEN_ATTACHMENTS + 1 },
          (_, index) => `att_${index.toString(16).padStart(64, '0')}`,
        ),
      },
    },
    { name: 'no session', value: { from: '', ids: [id('a')] } },
    { name: 'a stray field', value: { ...FILES, bytes: 'AAAA' } },
  ])('should refuse $name', ({ value }) => {
    should(BoardReopenAttachmentsSchema.safeParse(value).success).be.false();
  });

  it('should carry up to the limit', () => {
    const ids = Array.from(
      { length: MAX_BOARD_REOPEN_ATTACHMENTS },
      (_, index) => `att_${index.toString(16).padStart(64, '0')}`,
    );
    should(BoardReopenAttachmentsSchema.parse({ from: 'child-1', ids }).ids).have.length(10);
  });
});

describe('files named in a reopen', () => {
  const reopened = {
    seq: 2,
    at: '2026-10-30T10:00:00.000Z',
    actor: { kind: 'owner' },
    type: 'reopened',
    from: 'tested',
    to: 'implement',
    reason: 'still flickers',
    ask: { text: 'still flickers', source: 'owner (board move)' },
  } as const;

  it('should keep the name and type of each file, and read an older reopen without any', () => {
    // Arrange
    const file = { id: id('a'), filename: 'flicker.png', mime: 'image/png' };

    // Act / Assert
    should(BoardTaskEventSchema.parse({ ...reopened, attachments: [file] })).match({ attachments: [file] });
    should(BoardTaskEventSchema.parse(reopened)).not.have.property('attachments');
    should(BoardAttachmentSchema.parse(file)).deepEqual(file);
  });

  it('should refuse an empty list and a file with no name', () => {
    should(BoardTaskEventSchema.safeParse({ ...reopened, attachments: [] }).success).be.false();
    should(
      BoardTaskEventSchema.safeParse({ ...reopened, attachments: [{ id: id('a'), filename: '', mime: 'image/png' }] })
        .success,
    ).be.false();
  });
});
