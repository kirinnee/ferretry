import { describe, expect, test } from 'bun:test';
import { createVoiceModeStore } from '../../../app/lib/voice-mode/voice-mode-store.ts';

describe('which ferrets are in voice mode', () => {
  test('a ferret starts off, and starting names the machine', () => {
    const store = createVoiceModeStore();
    expect(store.get('f1')).toEqual({ active: false, engine: 'machine', machine: '', banner: null, notice: null });
    store.start('f1', 'desk');
    expect(store.get('f1')).toEqual({ active: true, engine: 'machine', machine: 'desk', banner: null, notice: null });
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
    });
  });
});
