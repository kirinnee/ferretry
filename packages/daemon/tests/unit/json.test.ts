import { describe, it } from 'bun:test';
import should from 'should';
import { canonicalJsonValue, jsonObject, parseJsonDocument, serializeJsonDocument } from '../../src/lib/index.ts';

describe('JSON documents', () => {
  it('should parse and serialize canonical JSON values', () => {
    // Arrange
    const input = { text: 'value', nested: [true, null, 3] };

    // Act
    const serialized = serializeJsonDocument(input);
    const parsed = parseJsonDocument(serialized);

    // Assert
    should(serialized).equal('{\n  "text": "value",\n  "nested": [\n    true,\n    null,\n    3\n  ]\n}\n');
    should(parsed).deepEqual({ ok: true, value: input });
    should(jsonObject(parsed.ok ? parsed.value : undefined)).deepEqual(input);
  });

  it('should reject malformed and non-JSON values before serialization', () => {
    // Arrange
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // Act
    const malformed = parseJsonDocument('{broken');
    const nonFinite = parseJsonDocument('1e400');

    // Assert
    should(malformed).deepEqual({ ok: false, message: 'invalid JSON' });
    should(nonFinite).deepEqual({ ok: false, message: 'value is not JSON serializable' });
    should(() => canonicalJsonValue(undefined)).throw();
    should(() => serializeJsonDocument(circular)).throw();
    should(jsonObject(null)).be.undefined();
    should(jsonObject([])).be.undefined();
  });
});
