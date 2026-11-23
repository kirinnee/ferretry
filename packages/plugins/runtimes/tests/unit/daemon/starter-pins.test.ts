/**
 * The first-seen models over the plugin's own state: written once per runtime, never replaced, and an unreadable file
 * answers nothing rather than an empty set.
 */
import { describe, expect, it } from 'bun:test';
import { RUNTIMES_PINS } from '../../../contract/index.ts';
import { statePins } from '../../../daemon/adapters/starter-pins.ts';

type Held = { models: Record<string, string> } | undefined;

const fakeState = (initial: Held, damaged = false) => {
  const box: { value: Held } = { value: initial };
  const state = {
    read: async (file: unknown) => {
      expect(file).toBe(RUNTIMES_PINS);
      return damaged
        ? { ok: false as const, error: { file: 'starter-pins.json', reason: 'unparsable' as const, sentence: 'x' } }
        : { ok: true as const, value: box.value };
    },
    update: async (_file: unknown, fn: (current: Held) => Held) => {
      box.value = fn(box.value);
      return { ok: true as const, value: box.value };
    },
  };
  return { box, state: state as never };
};

describe('the first-seen models of the derived runtimes', () => {
  it('reads nothing as an empty set and a file as its models', async () => {
    expect([...(await statePins(fakeState(undefined).state, () => {}).read())!]).toEqual([]);
    expect([...(await statePins(fakeState({ models: { a: 'm1' } }).state, () => {}).read())!]).toEqual([['a', 'm1']]);
  });

  it('records a runtime once and never replaces what is there', async () => {
    const held = fakeState({ models: { a: 'm1' } });
    const pins = statePins(held.state, () => {});

    await pins.add(
      new Map([
        ['a', 'm2'],
        ['b', 'm3'],
      ]),
    );

    expect(held.box.value).toEqual({ models: { a: 'm1', b: 'm3' } });
  });

  it('says so, and answers undefined, when the file is damaged', async () => {
    const said: string[] = [];

    const read = await statePins(fakeState(undefined, true).state, sentence => said.push(sentence)).read();

    expect(read).toBeUndefined();
    expect(said.join(' ')).toContain('unparsable');
  });
});
