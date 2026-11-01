import { describe, it } from 'bun:test';
import should from 'should';
import * as draft from '../../src/lib/shared-draft.ts';
import {
  applyTextOp,
  composeTextOps,
  diffToTextOp,
  isNoopTextOp,
  normalizeTextOp,
  SHARED_DRAFT_MAX_CHARS,
  type TextOp,
  TextOpError,
  textOpBaseLength,
  textOpTargetLength,
  transformTextIndex,
  transformTextOps,
} from '../../src/lib/shared-draft.ts';
import { INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

/** A small seeded generator, so a failing property names the seed that reproduces it. */
const random = (seed: number) => {
  let state = seed >>> 0 || 1;
  return (bound: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % bound;
  };
};

const ALPHABET = 'ab c😀\n';

/** A random edit made for `text`: inserts, deletes and retains in any order. */
const randomOp = (text: string, next: (bound: number) => number): TextOp => {
  const components: (number | string)[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const remaining = text.length - cursor;
    const count = 1 + next(Math.min(remaining, 4));
    const choice = next(3);
    if (choice === 0) components.push(count);
    else if (choice === 1) components.push(-count);
    else {
      let inserted = '';
      for (let index = 0; index <= next(3); index += 1) inserted += ALPHABET[next(ALPHABET.length)];
      components.push(inserted);
      continue;
    }
    cursor += count;
  }
  if (next(2) === 0) components.push('z'.repeat(1 + next(3)));
  return normalizeTextOp(components);
};

const randomText = (next: (bound: number) => number): string => {
  let text = '';
  for (let index = 0; index < next(14); index += 1) text += ALPHABET[next(ALPHABET.length)];
  return text;
};

describe('shared draft text operations', () => {
  it('applies retains, deletes and inserts in order', () => {
    should(applyTextOp('hello world', [6, -5, 'there'])).equal('hello there');
    should(applyTextOp('', ['hi'])).equal('hi');
    should(applyTextOp('abc', [3])).equal('abc');
  });

  it('refuses an edit made for a different length, saying both lengths', () => {
    should(() => applyTextOp('abc', [2, 'x'])).throw(TextOpError, { message: /2 characters.*holds 3/u });
  });

  it('measures the base and target lengths', () => {
    const op: TextOp = [2, -3, 'four', 1];
    should(textOpBaseLength(op)).equal(6);
    should(textOpTargetLength(op)).equal(7);
  });

  it('normalizes to one canonical form: merged neighbours, no zeros, an insert ahead of a delete', () => {
    should(normalizeTextOp([1, 2, 'a', 'b', -1, -2])).deepEqual([3, 'ab', -3]);
    should(normalizeTextOp([-2, 'x'])).deepEqual(['x', -2]);
    should(normalizeTextOp(['a', -2, 'b'])).deepEqual(['ab', -2]);
    should(normalizeTextOp([-1, 'x', -1])).deepEqual(['x', -2]);
    should(normalizeTextOp([0, 'q'])).deepEqual(['q']);
  });

  it('knows an edit that changes nothing', () => {
    should(isNoopTextOp([5])).be.true();
    should(isNoopTextOp([])).be.true();
    should(isNoopTextOp([2, 'x'])).be.false();
  });

  it('diffs one contiguous change into the smallest edit', () => {
    should(diffToTextOp('hello world', 'hello there world')).deepEqual([6, 'there ', 5]);
    should(diffToTextOp('abc', 'abc')).deepEqual([3]);
    should(diffToTextOp('abcdef', 'abef')).deepEqual([2, -2, 2]);
    should(diffToTextOp('aaa', 'aaaa')).deepEqual([3, 'a']);
    should(diffToTextOp('', 'x')).deepEqual(['x']);
    should(diffToTextOp('x', '')).deepEqual([-1]);
  });

  it('breaks a tie in favour of the first edit: its insert comes first', () => {
    const [aPrime, bPrime] = transformTextOps([1, 'A', 1], [1, 'B', 1]);
    should(applyTextOp(applyTextOp('xy', [1, 'A', 1]), bPrime)).equal('xABy');
    should(applyTextOp(applyTextOp('xy', [1, 'B', 1]), aPrime)).equal('xABy');
  });

  it('lets two deletes of the same characters both land once', () => {
    const [aPrime, bPrime] = transformTextOps([1, -2, 1], [2, -2]);
    should(applyTextOp(applyTextOp('abcd', [1, -2, 1]), bPrime)).equal('a');
    should(applyTextOp(applyTextOp('abcd', [2, -2]), aPrime)).equal('a');
  });

  it('refuses to transform or compose edits that were made for different texts', () => {
    should(() => transformTextOps([2], [3])).throw(TextOpError);
    should(() => composeTextOps([2, 'x'], [2])).throw(TextOpError);
  });

  it('composes typed-then-erased text into nothing', () => {
    should(composeTextOps([1, 'abc'], [2, -2])).deepEqual([1, 'a']);
    should(composeTextOps([-1, 2], ['x', 2])).deepEqual(['x', -1, 2]);
  });

  it('CONVERGES: any two edits, transformed, reach the same text from either order (2,000 seeded pairs)', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const next = random(seed);
      const text = randomText(next);
      const a = randomOp(text, next);
      const b = randomOp(text, next);
      const [aPrime, bPrime] = transformTextOps(a, b);
      const left = applyTextOp(applyTextOp(text, a), bPrime);
      const right = applyTextOp(applyTextOp(text, b), aPrime);
      if (left !== right) throw new Error(`seed ${seed}: ${JSON.stringify({ text, a, b, left, right })}`);
    }
  });

  it('COMPOSES: one composed edit does exactly what the two did in turn (2,000 seeded pairs)', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const next = random(seed * 7);
      const text = randomText(next);
      const first = randomOp(text, next);
      const middle = applyTextOp(text, first);
      const second = randomOp(middle, next);
      const together = applyTextOp(text, composeTextOps(first, second));
      if (together !== applyTextOp(middle, second)) throw new Error(`seed ${seed}`);
    }
  });

  it('DIFFS: the diff of any two texts turns the first into the second (2,000 seeded pairs)', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const next = random(seed * 13);
      const before = randomText(next);
      const after = randomText(next);
      if (applyTextOp(before, diffToTextOp(before, after)) !== after) throw new Error(`seed ${seed}`);
    }
  });

  it('moves a caret past what was typed before it, and keeps it before what somebody else typed at it', () => {
    should(transformTextIndex(3, [1, 'xx', 4])).equal(5);
    should(transformTextIndex(3, [3, 'xx', 2])).equal(3);
    should(transformTextIndex(3, [3, 'xx', 2], true)).equal(5);
    should(transformTextIndex(3, [4, 'xx', 1])).equal(3);
  });

  it('pulls a caret back over what was deleted before it, and into the start of a deletion around it', () => {
    should(transformTextIndex(4, [1, -2, 2])).equal(2);
    should(transformTextIndex(2, [1, -3, 1])).equal(1);
    should(transformTextIndex(1, [2, -2])).equal(1);
  });
});

describe('shared draft schemas', () => {
  const attachment = { kind: 'attachment', id: 'att-1', name: 'login-error.png', mime: 'image/png', bytes: 412 };
  const location = {
    kind: 'location',
    id: 'loc-1',
    latitude: 1.29,
    longitude: 103.85,
    accuracyMeters: 12,
    capturedAt: 1_700_000_000_000,
    place: 'office',
  };
  const snapshot = {
    v: 1,
    sessionId: 's-1',
    generation: 'gen-1',
    epoch: 0,
    rev: 3,
    text: 'hello',
    items: [attachment, location],
    updatedAt: INSTANT,
  };
  const cases: readonly SchemaCase[] = [
    { name: 'text op', schema: draft.TextOpSchema, value: [6, -5, 'there'] },
    { name: 'attachment', schema: draft.SharedDraftAttachmentSchema, value: attachment },
    { name: 'location', schema: draft.SharedDraftLocationSchema, value: location },
    { name: 'item', schema: draft.SharedDraftItemSchema, value: attachment },
    { name: 'snapshot', schema: draft.SharedDraftSnapshotSchema, value: snapshot },
    {
      name: 'edit',
      schema: draft.SharedDraftEditSchema,
      value: {
        generation: 'gen-1',
        epoch: 0,
        base: 3,
        text: [5, '!'],
        add: [attachment],
        remove: ['loc-1'],
        sent: true,
      },
    },
    {
      name: 'edit result',
      schema: draft.SharedDraftEditResultSchema,
      value: { applied: { generation: 'gen-1', epoch: 0, rev: 4, text: [5, '!'], add: [], remove: [] }, snapshot },
    },
    {
      name: 'client edit frame',
      schema: draft.SharedDraftClientFrameSchema,
      value: { kind: 'edit', id: 'e1', edit: { generation: 'gen-1', epoch: 0, base: 3, text: [5, '!'] } },
    },
    {
      name: 'server presence frame',
      schema: draft.SharedDraftServerFrameSchema,
      value: { kind: 'presence', peer: 'p1', device: 'Kirin’s iPhone', typing: true, selection: [2, 4] },
    },
  ];

  it('round-trips every frame either end of the live stream sends', () => {
    const applied = { generation: 'gen-1', epoch: 0, rev: 4, text: [5, '!'], add: [], remove: [] };
    assertRoundTrips([
      { name: 'presence up', schema: draft.SharedDraftClientFrameSchema, value: { kind: 'presence', typing: false } },
      { name: 'snapshot', schema: draft.SharedDraftServerFrameSchema, value: { kind: 'snapshot', snapshot } },
      { name: 'edit', schema: draft.SharedDraftServerFrameSchema, value: { kind: 'edit', applied, epoch: 0, rev: 4 } },
      {
        name: 'ack',
        schema: draft.SharedDraftServerFrameSchema,
        value: { kind: 'ack', id: 'e1', applied, epoch: 1, rev: 0 },
      },
      {
        name: 'error',
        schema: draft.SharedDraftServerFrameSchema,
        value: { kind: 'error', id: 'e1', code: 'shared_draft_stale', message: 'read the draft again' },
      },
      { name: 'left', schema: draft.SharedDraftServerFrameSchema, value: { kind: 'left', peer: 'p1' } },
      { name: 'ready', schema: draft.SharedDraftServerFrameSchema, value: { kind: 'ready' } },
      {
        name: 'own edit, replayed',
        schema: draft.SharedDraftServerFrameSchema,
        value: { kind: 'edit', id: 'e1', applied, epoch: 0, rev: 4 },
      },
    ]);
    assertRejects([
      {
        name: 'a device label on two lines',
        schema: draft.SharedDraftServerFrameSchema,
        value: { kind: 'presence', peer: 'p', device: 'a\nb', typing: true },
      },
      { name: 'an unknown frame', schema: draft.SharedDraftClientFrameSchema, value: { kind: 'snapshot' } },
    ]);
  });

  it('round-trips every schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(draft, cases);
  });

  it('accepts an edit that inserts exactly one whole draft', () => {
    should(draft.TextOpSchema.safeParse(['x'.repeat(SHARED_DRAFT_MAX_CHARS)]).success).be.true();
  });

  it('refuses a zero step, an empty insert, an oversized draft, a missing generation and an unknown field', () => {
    assertRejects([
      { name: 'zero', schema: draft.TextOpSchema, value: [0] },
      { name: 'empty insert', schema: draft.TextOpSchema, value: [''] },
      { name: 'fraction', schema: draft.TextOpSchema, value: [1.5] },
      {
        name: 'too long',
        schema: draft.SharedDraftSnapshotSchema,
        value: { ...snapshot, text: 'x'.repeat(SHARED_DRAFT_MAX_CHARS + 1) },
      },
      {
        name: 'extra',
        schema: draft.SharedDraftEditSchema,
        value: { generation: 'g', epoch: 0, base: 0, by: 'agent' },
      },
      {
        name: 'sent false',
        schema: draft.SharedDraftEditSchema,
        value: { generation: 'g', epoch: 0, base: 0, sent: false },
      },
      { name: 'no generation', schema: draft.SharedDraftEditSchema, value: { epoch: 0, base: 0 } },
      { name: 'empty generation', schema: draft.SharedDraftSnapshotSchema, value: { ...snapshot, generation: '' } },
      {
        name: 'inserts more than a draft holds, spread over many steps',
        schema: draft.TextOpSchema,
        value: Array.from({ length: 3 }, () => 'x'.repeat(SHARED_DRAFT_MAX_CHARS / 2)),
      },
      { name: 'bad latitude', schema: draft.SharedDraftLocationSchema, value: { ...location, latitude: 91 } },
    ]);
  });
});
