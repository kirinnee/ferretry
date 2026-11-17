import { describe, expect, test } from 'bun:test';
import { DAEMON_PATH_WORDS, daemonPathKind, describeDaemonPath } from '../../contract/index.ts';

const LOOPBACK = 'http://127.0.0.1:7617';

describe('describeDaemonPath', () => {
  test('a relayed daemon is its name and "through the relay", never an address', () => {
    const path = describeDaemonPath({ address: LOOPBACK, name: 'studio', via: 'relay' });
    expect(path).toEqual({
      kind: 'relay',
      title: 'studio',
      path: 'through the relay',
      summary: 'studio · through the relay',
    });
    expect(JSON.stringify(path)).not.toContain('127.0.0.1');
    expect(JSON.stringify(path)).not.toContain('7617');
  });

  test('a relayed daemon with no name yet gets a plain stand-in, still no address', () => {
    const path = describeDaemonPath({ address: LOOPBACK, via: 'relay' });
    expect(path.title).toBe(DAEMON_PATH_WORDS.unnamed);
    expect(path.address).toBeUndefined();
    expect(path.summary).not.toContain('127.0.0.1');
  });

  test('a loopback address seen from another machine is judged relayed before anything is exchanged', () => {
    expect(daemonPathKind({ address: LOOPBACK })).toBe('relay');
    expect(describeDaemonPath({ address: LOOPBACK, sameMachine: false }).address).toBeUndefined();
  });

  test("a loopback address on the daemon's own machine is direct, and its address may be shown", () => {
    const path = describeDaemonPath({ address: LOOPBACK, sameMachine: true });
    expect(path).toMatchObject({ kind: 'direct', path: 'direct', address: '127.0.0.1:7617', title: '127.0.0.1:7617' });
  });

  test('an observed direct exchange wins over the guess, even on a loopback address', () => {
    const path = describeDaemonPath({ address: LOOPBACK, name: 'studio', via: 'direct' });
    expect(path).toMatchObject({ kind: 'direct', title: 'studio', address: '127.0.0.1:7617' });
  });

  test('a non-loopback address is dialled directly, named by its host when nobody named it', () => {
    expect(describeDaemonPath({ address: 'https://box.example.test' })).toMatchObject({
      kind: 'direct',
      title: 'box.example.test',
      path: 'direct',
      address: 'box.example.test',
    });
    expect(describeDaemonPath({ address: 'https://box.example.test', name: ' lab ' }).title).toBe('lab');
  });

  test('an address that is not a URL is never taken for loopback', () => {
    expect(daemonPathKind({ address: 'not a url' })).toBe('direct');
  });
});
