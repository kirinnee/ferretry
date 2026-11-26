import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineState } from '../../../contract/index.ts';
import { decodeJson } from '../../../host/state/format.ts';

const named = defineState({
  name: 'devices',
  path: 'devices.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({
    format: z.literal(1),
    devices: z.array(z.strictObject({ id: z.string(), grants: z.strictObject({ voice: z.boolean() }) })),
  }),
});
const unnamed = defineState({
  name: 'plain',
  path: 'plain.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ count: z.number() }),
});

const sentence = (text: string, def: typeof named | typeof unnamed): string => {
  const read = decodeJson(def as typeof named, 'demo/file.json', text);
  if (read.ok) throw new Error('expected the document to be refused');
  return read.error.sentence;
};

describe('shapeOf: which issue a refused document names', () => {
  test('a schema that names `format` reports the nested fault, not "format: expected 1"', () => {
    const text = sentence('{"format":1,"devices":[{"id":"x","grants":{}}]}', named);
    expect(text).toContain('devices.0.grants.voice');
    expect(text).not.toContain('format: expected 1');
  });

  test('a schema without `format` still reports its own first issue', () => {
    expect(sentence('{"format":1,"count":"many"}', unnamed)).toContain('count');
  });
});
