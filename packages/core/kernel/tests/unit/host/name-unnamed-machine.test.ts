import { describe, expect, test } from 'bun:test';
import type { ConfigPort } from '../../../contract/ports/config.ts';
import { nameUnnamedMachine } from '../../../host/machine-name.ts';

/**
 * The pair-time name write is conditional on the file as it is on disk NOW: valid (or absent), unnamed, and written with
 * that disk's etag. Anything else leaves the owner's file untouched and answers the name the machine goes by.
 */

type State = 'valid' | 'absent' | 'invalid' | 'held';

function fakePort(options: { state: State; name?: string; etag?: string; outcome?: 'written' | 'conflict' }) {
  const writes: { edit: unknown; ifMatch: string | undefined }[] = [];
  const port = {
    etag: async () => options.etag ?? 'etag-1',
    fileState: () => ({ state: options.state, inEffect: options.state === 'valid', sentences: [] }),
    file: () => (options.name === undefined ? {} : { name: options.name }),
    write: async (_def: unknown, _name: unknown, edit: unknown, write?: { ifMatch?: string }) => {
      writes.push({ edit, ifMatch: write?.ifMatch });
      return { kind: options.outcome ?? 'written' };
    },
  };
  return { port: port as unknown as ConfigPort, writes };
}

describe('nameUnnamedMachine', () => {
  test('a valid file with no name takes the name, written against the etag just read', async () => {
    const { port, writes } = fakePort({ state: 'valid' });
    await nameUnnamedMachine(port, 'Studio box', () => 'now');
    expect(writes).toEqual([{ edit: { patch: { name: 'Studio box' } }, ifMatch: 'etag-1' }]);
  });

  test('no file at all takes the name too, against the absent etag', async () => {
    const { port, writes } = fakePort({ state: 'absent', etag: 'absent' });
    await nameUnnamedMachine(port, 'Studio box', () => 'now');
    expect(writes).toEqual([{ edit: { patch: { name: 'Studio box' } }, ifMatch: 'absent' }]);
  });

  test('a name the owner already holds is never written over', async () => {
    const { port, writes } = fakePort({ state: 'valid', name: 'pebox' });
    expect(await nameUnnamedMachine(port, 'Studio box', () => 'pebox')).toBe('pebox');
    expect(writes).toEqual([]);
  });

  test('an invalid or held file is not even tried: its unreadable name must not look like "no name"', async () => {
    for (const state of ['invalid', 'held'] as const) {
      const { port, writes } = fakePort({ state });
      expect(await nameUnnamedMachine(port, 'Studio box', () => 'host-box')).toBe('host-box');
      expect(writes).toEqual([]);
    }
  });

  test('a file that moved since the etag was read (conflict) answers the authoritative name, not the typed one', async () => {
    const { port } = fakePort({ state: 'valid', outcome: 'conflict' });
    expect(await nameUnnamedMachine(port, 'Studio box', () => 'pebox')).toBe('pebox');
  });

  test('a name the daemon’s own rule refuses writes nothing', async () => {
    const { port, writes } = fakePort({ state: 'valid' });
    expect(await nameUnnamedMachine(port, 'bell\u0007', () => 'host-box')).toBe('host-box');
    expect(writes).toEqual([]);
  });
});
