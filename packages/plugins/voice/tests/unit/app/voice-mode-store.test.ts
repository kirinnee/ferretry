import { describe, expect, test } from 'bun:test';
import { createVoiceModeStore } from '../../../app/lib/voice-mode/voice-mode-store.ts';

describe('which ferrets are in voice mode', () => {
  test('a ferret starts off, and starting names the machine', () => {
    const store = createVoiceModeStore();
    expect(store.get('f1')).toEqual({ active: false, machine: '', notice: null });
    store.start('f1', 'desk');
    expect(store.get('f1')).toEqual({ active: true, machine: 'desk', notice: null });
    expect(store.get('f2').active).toBe(false);
  });

  test('ending with a sentence leaves it until it is dismissed, and the next start clears it', () => {
    const store = createVoiceModeStore();
    store.start('f1', 'desk');
    store.end('f1', 'Lost desk.');
    expect(store.get('f1')).toEqual({ active: false, machine: 'desk', notice: 'Lost desk.' });
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
