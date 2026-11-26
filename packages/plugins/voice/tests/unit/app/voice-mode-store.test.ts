import { describe, expect, test } from 'bun:test';
import { createVoiceModeStore } from '../../../app/lib/voice-mode/voice-mode-store.ts';

describe('which ferrets are in voice mode', () => {
  test('a ferret starts off, and starting names the machine', () => {
    const store = createVoiceModeStore();
    expect(store.get('f1')).toEqual({
      active: false,
      engine: 'machine',
      machine: '',
      banner: null,
      notice: null,
      session: '',
    });
    store.start('f1', 'desk');
    expect(store.get('f1')).toEqual({
      active: true,
      engine: 'machine',
      machine: 'desk',
      banner: null,
      notice: null,
      session: expect.stringMatching(/^vm-[0-9a-f-]{36}$/u),
    });
    expect(store.get('f2').active).toBe(false);
  });

  test('ending with a sentence leaves it until it is dismissed, and the next start clears it', () => {
    const store = createVoiceModeStore();
    store.start('f1', 'desk');
    store.end('f1', 'Lost desk.');
    expect(store.get('f1')).toEqual({
      active: false,
      engine: 'machine',
      machine: 'desk',
      banner: null,
      notice: 'Lost desk.',
      session: '',
    });
    store.dismiss('f1');
    expect(store.get('f1').notice).toBeNull();
    store.end('f1', 'again');
    store.start('f1', 'desk');
    expect(store.get('f1').notice).toBeNull();
  });

  test('ending a ferret that is not on says nothing and wakes nobody', () => {
    const store = createVoiceModeStore();
    let woken = 0;
    store.subscribe(() => {
      woken += 1;
    });
    store.end('f1');
    store.dismiss('f1');
    expect(woken).toBe(0);
    store.start('f1', 'desk');
    store.dismiss('f1'); // a running voice mode is not dismissed
    expect(store.get('f1').active).toBe(true);
    store.end('f1');
    expect(store.get('f1').active).toBe(false);
    expect(woken).toBe(2);
  });

  test('a listener stops hearing once it unsubscribes, and a snapshot is stable until something changes', () => {
    const store = createVoiceModeStore();
    let woken = 0;
    const off = store.subscribe(() => {
      woken += 1;
    });
    store.start('f1', 'desk');
    const first = store.get('f1');
    expect(store.get('f1')).toBe(first);
    off();
    store.end('f1');
    expect(woken).toBe(1);
  });
});

describe('V1: a voice-mode session', () => {
  test('is named once when voice mode starts, is kept while it runs (a reconnect reads the same name), and is new the next time', () => {
    let minted = 0;
    const store = createVoiceModeStore(() => {
      minted += 1;
      return `vm-session-${minted}`;
    });
    store.start('f1', 'desk');
    expect(store.get('f1').session).toBe('vm-session-1');
    // Nothing that happens inside the session renames it: not a re-render, not the fall back to the phone.
    expect(store.get('f1').session).toBe('vm-session-1');
    store.fallBack('f1', 'Lost desk.');
    expect(store.get('f1').session).toBe('vm-session-1');
    store.end('f1');
    expect(store.get('f1').session).toBe('');
    store.start('f1', 'desk');
    expect(store.get('f1').session).toBe('vm-session-2');
    expect(minted).toBe(2);
  });

  test('two ferrets are two sessions', () => {
    const store = createVoiceModeStore();
    store.start('f1', 'desk');
    store.start('f2', 'desk');
    expect(store.get('f1').session).not.toBe(store.get('f2').session);
  });

  test('the panel offers its machine voice for live lines, per ferret, and takes it back', () => {
    const store = createVoiceModeStore();
    const sink = { say: () => true, outdate: () => undefined, quiet: () => undefined };
    expect(store.live('f1')).toBeUndefined();
    store.attachLive('f1', sink);
    expect(store.live('f1')).toBe(sink);
    expect(store.live('f2')).toBeUndefined();
    store.attachLive('f1', null);
    expect(store.live('f1')).toBeUndefined();
  });
});

describe('the phone engine, the fallback', () => {
  test('starting on the phone names why, and a start on the machine has no banner', () => {
    const store = createVoiceModeStore();
    store.start('f1', 'desk', 'You chose to keep audio on this phone.');
    expect(store.get('f1')).toEqual({
      active: true,
      engine: 'phone',
      machine: 'desk',
      banner: 'You chose to keep audio on this phone.',
      notice: null,
      session: expect.stringMatching(/^vm-/u),
    });
    store.end('f1');
    store.start('f1', 'desk');
    expect(store.get('f1').banner).toBeNull();
  });

  test('a lost machine hands a running voice mode to the phone with the reason, once', () => {
    const store = createVoiceModeStore();
    let woken = 0;
    store.subscribe(() => {
      woken += 1;
    });
    store.start('f1', 'desk');
    store.fallBack('f1', 'Lost desk.');
    expect(store.get('f1')).toEqual({
      active: true,
      engine: 'phone',
      machine: 'desk',
      banner: 'Lost desk.',
      notice: null,
      session: expect.stringMatching(/^vm-/u),
    });
    store.fallBack('f1', 'Another reason.'); // already on the phone: the first reason stands
    expect(store.get('f1').banner).toBe('Lost desk.');
    expect(woken).toBe(2);
  });

  test('a ferret that is not in voice mode has nothing to fall back from, and ending clears the banner', () => {
    const store = createVoiceModeStore();
    store.fallBack('f1', 'Lost desk.');
    expect(store.get('f1').active).toBe(false);
    store.start('f1', 'desk', 'why');
    store.end('f1', 'The microphone could not be opened.');
    expect(store.get('f1')).toEqual({
      active: false,
      engine: 'machine',
      machine: 'desk',
      banner: null,
      notice: 'The microphone could not be opened.',
      session: '',
    });
  });
});
