/**
 * The model pins over the plugin's state: written once per (login, harness), pruned with their login, a missing file the
 * first run, and an unreadable file reported (never read as empty, never written over).
 */
import { describe, expect, it } from 'bun:test';
import { statePins } from '../../../daemon/adapters/starter-pins.ts';
import { fakePinState } from '../../support/starters.ts';

describe('the model pins of the derived runtimes', () => {
  it('reads a missing file as the first run (empty) and a file as its pins', async () => {
    const first = await statePins(fakePinState(undefined).state, () => {}).read();
    const held = await statePins(fakePinState({ models: { 'claude:a': 'm1' } }).state, () => {}).read();

    expect(first).toEqual({ state: 'read', pins: new Map() });
    expect(held).toEqual({ state: 'read', pins: new Map([['claude:a', 'm1']]) });
  });

  it('records a pair once and never replaces what is there', async () => {
    const held = fakePinState({ models: { 'claude:a': 'm1' } });

    await statePins(held.state, () => {}).record(
      new Map([
        ['claude:a', 'm2'],
        ['claude:b', 'm3'],
      ]),
      new Set(['a', 'b']),
    );

    expect(held.box.value).toEqual({ models: { 'claude:a': 'm1', 'claude:b': 'm3' } });
  });

  it('prunes the pins of a login that is gone, so a later login of the same id starts fresh', async () => {
    const held = fakePinState({ models: { 'claude:a': 'm1', 'codex:a': 'm1', 'claude:b': 'm2', stray: 'x' } });
    const pins = statePins(held.state, () => {});

    // `a` is removed: its pins go (every harness), and so does a key that belongs to no login.
    await pins.record(new Map(), new Set(['b']));
    expect(held.box.value).toEqual({ models: { 'claude:b': 'm2' } });

    // A new login with the id `a` is seen for the first time: it gets the CURRENT model, not the old one.
    await pins.record(new Map([['claude:a', 'm9']]), new Set(['a', 'b']));
    expect(held.box.value).toEqual({ models: { 'claude:a': 'm9', 'claude:b': 'm2' } });
  });

  it('says so, and reports the file, when it exists and cannot be read', async () => {
    const said: string[] = [];

    const read = await statePins(fakePinState(undefined, true).state, sentence => said.push(sentence)).read();

    expect(read).toEqual({ state: 'unreadable', file: 'starter-pins.json' });
    expect(said.join(' ')).toContain('unparsable');
  });
});
