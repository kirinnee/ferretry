import { describe, it } from 'bun:test';
import should from 'should';
import { readDaemonConfigDocument } from '../../../src/adapters/daemon/daemon-config-file.ts';

describe('readDaemonConfigDocument', () => {
  it('should hand back exactly what the daemon wrote', async () => {
    // Arrange
    const document = JSON.stringify({ host: '127.0.0.1', port: 7_432 });

    // Act
    const actual = await readDaemonConfigDocument('/state/config/daemon.json', {
      readFile: async () => document,
    });

    // Assert — the client parses it; this only fetches it.
    should(actual).equal(document);
  });

  it('should report every failure as an absent document', async () => {
    // Arrange: a machine with no daemon yet, and one whose document cannot be read at all.
    const missing = {
      readFile: async () => await Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' })),
    };
    const unreadable = {
      readFile: async () => await Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
    };

    // Act + Assert — the caller then uses the well-known default, which fails visibly as "the daemon
    // is not answering". A client that refused to run because it could not read a file it does not
    // own would be strictly worse than one that looked in the usual place.
    should(await readDaemonConfigDocument('/state/config/daemon.json', missing)).be.undefined();
    should(await readDaemonConfigDocument('/state/config/daemon.json', unreadable)).be.undefined();
  });
});
