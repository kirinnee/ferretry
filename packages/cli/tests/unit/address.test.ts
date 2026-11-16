import { describe, it } from 'bun:test';
import { recordedBindAddress } from '@ferretry/kernel/contract';
import should from 'should';
import {
  DEFAULT_DAEMON_URL,
  isLocalDaemonUrl,
  isLoopbackHost,
  parseDaemonRun,
  resolveDaemonUrl,
} from '../../src/lib/address.ts';

/** A run record as the kernel writes it on listen (`run/daemon.json`, format 1). */
const runRecord = (host: string, port: number) =>
  JSON.stringify({ format: 1, socket: '/home/x/.ferretry/run/fyd.sock', host, port, pid: 4242, version: '5.0.0' });

describe('loopback', () => {
  it('should read the whole loopback domain', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', 'a.localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])
      should(isLoopbackHost(host)).be.true();
    for (const host of ['128.0.0.1', '127.0.0.256', '10.0.0.1', 'example.com', '::', '::2', ''])
      should(isLoopbackHost(host)).be.false();
  });

  it('S57 should decide locality from the URL, and call an unparseable one remote so no credential leaves the machine', () => {
    should(isLocalDaemonUrl('http://127.0.0.1:9')).be.true();
    should(isLocalDaemonUrl('https://daemon.example:7431')).be.false();
    should(isLocalDaemonUrl('not a url')).be.false();
  });
});

describe('resolveDaemonUrl', () => {
  it('P90 FY_URL wins outright, whatever the run record says', () => {
    should(resolveDaemonUrl(' http://10.0.0.5:9 ', parseDaemonRun(runRecord('127.0.0.1', 1)))).equal(
      'http://10.0.0.5:9',
    );
  });

  it('P89 should dial the bind the kernel recorded, through the kernel’s own address function', () => {
    const run = parseDaemonRun(runRecord('127.0.0.1', 8123));
    should(resolveDaemonUrl('', run)).equal('http://127.0.0.1:8123');
    should(resolveDaemonUrl('', run)).equal(recordedBindAddress({ host: '127.0.0.1', port: 8123 }));
  });

  it('P89 should answer loopback at the recorded port for a wildcard bind, as the daemon does', () => {
    should(resolveDaemonUrl('', parseDaemonRun(runRecord('0.0.0.0', 9000)))).equal('http://127.0.0.1:9000');
    should(resolveDaemonUrl('', parseDaemonRun(runRecord('::', 9000)))).equal('http://127.0.0.1:9000');
    should(resolveDaemonUrl('', parseDaemonRun(runRecord('::1', 9001)))).equal('http://[::1]:9001');
  });

  it('should fall back to the daemon’s own default port when there is no run record it can read', () => {
    should(DEFAULT_DAEMON_URL).equal('http://127.0.0.1:7457');
    should(resolveDaemonUrl('', parseDaemonRun(undefined))).equal(DEFAULT_DAEMON_URL);
    should(resolveDaemonUrl('', parseDaemonRun('{not json'))).equal(DEFAULT_DAEMON_URL);
  });

  it('should read no other document: the old config spelling and a record of another format are not a run record', () => {
    should(parseDaemonRun(JSON.stringify({ host: '127.0.0.1', port: 8123 }))).be.undefined();
    should(
      parseDaemonRun(JSON.stringify({ carriers: [{ kind: 'bind', host: '127.0.0.1', port: 9000 }] })),
    ).be.undefined();
    should(parseDaemonRun(runRecord('127.0.0.1', 8123).replace('"format":1', '"format":2'))).be.undefined();
  });
});
