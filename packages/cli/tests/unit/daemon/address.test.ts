import { describe, it } from 'bun:test';
import { FY_DEFAULT_DAEMON_URL } from '@ferretry/protocol';
import should from 'should';
import { isLocalDaemonUrl, resolveDaemonUrl } from '../../../src/lib/daemon/address.ts';

describe('where the client looks for the daemon', () => {
  it('should follow the address the daemon recorded rather than assuming the default', () => {
    // Arrange: a daemon whose preferred port was taken bound the next one and wrote it down.
    const recorded = JSON.stringify({ host: '127.0.0.1', port: 7_432 });

    // Act + Assert — this is the failure it prevents: the client reported "did not become ready"
    // against a daemon that was serving perfectly one port along.
    should(resolveDaemonUrl('', recorded)).equal('http://127.0.0.1:7432');
  });

  it('should let an operator who pinned an address keep it', () => {
    // Arrange
    const recorded = JSON.stringify({ host: '127.0.0.1', port: 7_432 });

    // Act + Assert — somebody who pins an address is telling you something.
    should(resolveDaemonUrl('http://10.0.0.5:9999', recorded)).equal('http://10.0.0.5:9999');
    should(resolveDaemonUrl('  http://10.0.0.5:9999  ', recorded)).equal('http://10.0.0.5:9999');
  });

  it('should fall back to the well-known address when no document says otherwise', () => {
    // Act + Assert — a machine where no daemon has ever written a document, and one whose document
    // this client cannot read. Both leave it looking in the usual place rather than refusing to run.
    should(resolveDaemonUrl('', undefined)).equal(FY_DEFAULT_DAEMON_URL);
    should(resolveDaemonUrl('', 'not json at all')).equal(FY_DEFAULT_DAEMON_URL);
    should(resolveDaemonUrl('', '{}')).equal(FY_DEFAULT_DAEMON_URL);
  });

  it('should decide local from the URL, not from whether one was given', () => {
    // Act + Assert — the defect: testing "is FY_URL set" classified a daemon on this very machine as
    // remote and demanded FY_TOKEN, while the owner-only token file sat unread beside it.
    should(isLocalDaemonUrl('http://127.0.0.1:7432')).be.true();
    should(isLocalDaemonUrl('http://localhost:9999')).be.true();
    should(isLocalDaemonUrl('http://LOCALHOST:9999')).be.true();
    should(isLocalDaemonUrl('http://box.localhost:9999')).be.true();
    should(isLocalDaemonUrl('http://127.9.9.9:80')).be.true();
    should(isLocalDaemonUrl('http://[::1]:7431')).be.true();
  });

  it('should never call a remote or unreadable address local', () => {
    // Act + Assert — guessing wrong in this direction sends an admin credential off the machine, so
    // anything that is not provably loopback takes the refusal.
    should(isLocalDaemonUrl('http://10.0.0.5:9999')).be.false();
    should(isLocalDaemonUrl('https://daemon.example.test')).be.false();
    // A host that merely CONTAINS a loopback spelling is not loopback.
    should(isLocalDaemonUrl('http://127.0.0.1.example.test')).be.false();
    should(isLocalDaemonUrl('http://notlocalhost')).be.false();
    should(isLocalDaemonUrl('nonsense')).be.false();
    should(isLocalDaemonUrl('')).be.false();
  });
});
