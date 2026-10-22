import { describe, it } from 'bun:test';
import should from 'should';
import {
  canonicalJsonValue,
  deepFreezeJson,
  type JsonValue,
  jsonObject,
  parseJsonDocument,
  serializeJsonDocument,
} from '../../src/lib/index.ts';

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

describe('deepFreezeJson', () => {
  it('should freeze every object and array, in place, and answer the same value', () => {
    // Arrange
    const input: JsonValue = { tools: [{ name: 'bash' }], status: 'running' };

    // Act
    const actual = deepFreezeJson(input);

    // Assert
    should(actual).equal(input);
    should(Object.isFrozen(input)).be.true();
    const tools = (input as { tools: { name: string }[] }).tools;
    should(Object.isFrozen(tools)).be.true();
    should(Object.isFrozen(tools[0])).be.true();
  });

  it.each([['text'], [3], [true], [null]] as const)('should answer the scalar %p as it is', input => {
    // Act + Assert
    should(deepFreezeJson(input)).equal(input);
  });

  it('should leave an already frozen value alone', () => {
    // Arrange — frozen at the top, so nothing below is walked again.
    const inner = { open: true };
    const input = Object.freeze({ inner });

    // Act
    deepFreezeJson(input);

    // Assert
    should(Object.isFrozen(inner)).be.false();
  });
});
