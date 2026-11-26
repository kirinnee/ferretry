import { describe, it } from 'bun:test';
import should from 'should';
import { CODEX_HEADER_BYTES, codexConversationId } from '../../../daemon/reader/lib/transcript/codex.ts';

const header = (id: unknown): string => JSON.stringify({ type: 'session_meta', payload: { id } });

describe('codexConversationId', () => {
  it('should name the conversation by the id of the session_meta header record', () => {
    // Arrange
    const head = `${header('synthetic-native-id')}\n{"type":"event_msg"}\n`;

    // Act
    const actual = codexConversationId(head);

    // Assert
    should(actual).equal('synthetic-native-id');
  });

  it('should skip a line that is not a whole record and keep reading', () => {
    // Arrange
    const head = `{"type":"session_me\n${header('synthetic-after-torn-line')}\n`;

    // Act
    const actual = codexConversationId(head);

    // Assert
    should(actual).equal('synthetic-after-torn-line');
  });

  it('should return undefined when the header is cut off before it is whole', () => {
    // Arrange
    const head = header('synthetic-cut').slice(0, 20);

    // Act
    const actual = codexConversationId(head);

    // Assert
    should(actual).be.undefined();
  });

  it('should return undefined for an empty head', () => {
    // Act
    const actual = codexConversationId('');

    // Assert
    should(actual).be.undefined();
  });

  it('should return undefined when the header record carries no usable id', () => {
    // Arrange
    const heads = [
      JSON.stringify({ type: 'session_meta' }),
      JSON.stringify({ type: 'session_meta', payload: 'not-an-object' }),
      header(42),
      'null',
    ];

    // Act
    const actual = heads.map(codexConversationId);

    // Assert
    should(actual).deepEqual([undefined, undefined, undefined, undefined]);
  });

  it('should ignore records that are not the session_meta header', () => {
    // Arrange
    const head = `${JSON.stringify({ type: 'event_msg', payload: { id: 'synthetic-wrong-record' } })}\n`;

    // Act
    const actual = codexConversationId(head);

    // Assert
    should(actual).be.undefined();
  });

  it('should look only at the first eight lines of the head', () => {
    // Arrange
    const filler = Array.from({ length: 8 }, () => '{"type":"event_msg"}');
    const head = `${filler.join('\n')}\n${header('synthetic-too-late')}\n`;

    // Act
    const actual = codexConversationId(head);

    // Assert
    should(actual).be.undefined();
  });

  it('should read a header region large enough for the session instructions', () => {
    // Assert
    should(CODEX_HEADER_BYTES).equal(32 * 1024);
  });
});
