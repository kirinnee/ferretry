import { describe, it } from 'bun:test';
import { DAEMON_RUN_FILE } from '@ferretry/kernel/contract';
import should from 'should';
import {
  daemonUrlPort,
  foreignListenerRefusal,
  listenerOwnerVerdict,
  parseTcpListeners,
} from '../../src/lib/listener-owner.ts';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
// 127.0.0.1:7431 is 0100007F:1D07; 0.0.0.0:7431 is 00000000:1D07; 8.8.8.8:7431 is 08080808:1D07.
const line = (address: string, uid: number, state = '0A') =>
  `   0: ${address}:1D07 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${String(uid)}        0 12345 1 0000000000000000 100 0 0 10 0`;

describe('listener owner (S57)', () => {
  it('should parse listening sockets and skip anything else', () => {
    const table = [HEADER, line('0100007F', 1000), line('0100007F', 1000, '01'), 'garbage'].join('\n');
    should(parseTcpListeners(table)).deepEqual([{ port: 7431, reachableFromLoopback: true, uid: 1000 }]);
  });

  it('S57 a credential may go to a listener this user owns, or root’s', () => {
    should(listenerOwnerVerdict(7431, 1000, [[HEADER, line('0100007F', 1000)].join('\n')]).kind).equal('own');
    should(listenerOwnerVerdict(7431, 1000, [[HEADER, line('0100007F', 0)].join('\n')]).kind).equal('own');
  });

  it('S57 a credential is refused when another user holds the port, wildcard binds included', () => {
    const verdict = listenerOwnerVerdict(7431, 1000, [[HEADER, line('00000000', 1001)].join('\n')]);
    should(verdict).deepEqual({ kind: 'foreign', uids: [1001] });
    should(foreignListenerRefusal('http://127.0.0.1:7431', 'the session credential', verdict)).containEql(
      'held by another user (uid 1001)',
    );
  });

  it('S57 the refusal points the owner at the kernel run record the client reads, not a file that no longer exists', () => {
    const sentence = foreignListenerRefusal('http://127.0.0.1:7431', 'the session credential', {
      kind: 'foreign',
      uids: [1001],
    });
    should(sentence).containEql(`check FY_HOME and its ${DAEMON_RUN_FILE}`);
    should(sentence).containEql('run/daemon.json');
    should(sentence).not.containEql('config/daemon.json');
  });

  it('should ignore a listener that is not reachable from loopback, and report absence', () => {
    should(listenerOwnerVerdict(7431, 1000, [[HEADER, line('08080808', 1001)].join('\n')]).kind).equal('absent');
    should(listenerOwnerVerdict(7431, 1000, undefined).kind).equal('unknown');
    should(foreignListenerRefusal('http://127.0.0.1:7431', 'x', { kind: 'own' })).be.undefined();
  });

  it('should read IPv6 sockets: loopback and v4-mapped loopback are reachable, other addresses are not', () => {
    const ipv6 = (hex: string, uid = 1001) => [HEADER, line(hex, uid)].join('\n');
    const loopback = '00000000000000000000000001000000';
    const mappedLoopback = '0000000000000000FFFF00000100007F';
    const mappedAny = '0000000000000000FFFF000000000000';
    const mappedOther = '0000000000000000FFFF000008080808';
    const global = '20010DB8000000000000000000000001';
    should(listenerOwnerVerdict(7431, 1000, [ipv6(loopback)]).kind).equal('foreign');
    should(listenerOwnerVerdict(7431, 1000, [ipv6(mappedLoopback)]).kind).equal('foreign');
    should(listenerOwnerVerdict(7431, 1000, [ipv6(mappedAny)]).kind).equal('foreign');
    should(listenerOwnerVerdict(7431, 1000, [ipv6(mappedOther)]).kind).equal('absent');
    should(listenerOwnerVerdict(7431, 1000, [ipv6(global)]).kind).equal('absent');
  });

  it('should name the port a URL means', () => {
    should(daemonUrlPort('https://daemon.example')).equal(443);
    should(daemonUrlPort('ftp://daemon.example')).be.undefined();
    should(daemonUrlPort('http://127.0.0.1:7431')).equal(7431);
    should(daemonUrlPort('http://127.0.0.1')).equal(80);
    should(daemonUrlPort('nope')).be.undefined();
  });
});
