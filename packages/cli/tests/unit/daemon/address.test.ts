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

  it('should follow the bind and never the advertisement, so the remedy stays followable', () => {
    // THE BLOCKER THIS FIXES. The pairing screen tells an operator to advertise the address other
    // devices reach this machine at. Reading that value here made the next `pair` dial a routed
    // address for a daemon on the same desk, which `isLocalDaemonUrl` then refused to send the
    // owner-only token to — so taking the advice broke the command that gave it.
    const advertised = JSON.stringify({ host: '127.0.0.1', port: 7_432, publicUrl: 'http://192.168.1.10:7432' });

    // Act + Assert
    should(resolveDaemonUrl('', advertised)).equal('http://127.0.0.1:7432');
    should(isLocalDaemonUrl(resolveDaemonUrl('', advertised))).be.true();
  });

  it('should dial loopback at the recorded port when the daemon binds every interface', () => {
    // Arrange — the deployment the remedy now asks for: bound everywhere, advertised once.
    const wildcard = JSON.stringify({ host: '0.0.0.0', port: 9_000, publicUrl: 'http://192.168.1.10:9000' });

    // Act + Assert — the port is the part that must survive. Falling back to the well-known default
    // here reports a healthy daemon down while it serves the port it wrote in that document.
    should(resolveDaemonUrl('', wildcard)).equal('http://127.0.0.1:9000');
    should(isLocalDaemonUrl(resolveDaemonUrl('', wildcard))).be.true();
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

  it('should ask the protocol what this machine is, so one host is not two answers', () => {
    // THE DUPLICATE THIS DELETES. A private copy here read the whole of 127/8 and every `.localhost`
    // name while the protocol read three spellings, so `127.0.0.2` was this machine to the token
    // spent on it and a stranger to the pairing advertisement — which handed a phone a QR code for an
    // address that, on that phone, names the phone. The widened cases are asserted from THIS side so
    // deleting the copy cannot quietly narrow what the client already treated as local.
    for (const url of ['http://127.0.0.2:7431', 'http://127.255.255.255:7431', 'http://fy.localhost:7431']) {
      should(isLocalDaemonUrl(url)).be.true();
    }
    // And the fully written IPv6 loopback, which a URL authority always presents bracketed.
    should(isLocalDaemonUrl('http://[0:0:0:0:0:0:0:1]:7431')).be.true();
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
