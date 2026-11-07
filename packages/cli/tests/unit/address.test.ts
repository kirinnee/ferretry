import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_DAEMON_URL,
  isLocalDaemonUrl,
  isLoopbackHost,
  isWildcardHost,
  recordedBindAddress,
  resolveDaemonUrl,
} from '../../src/lib/address.ts';

describe('loopback', () => {
  it('should read the whole loopback domain', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', 'a.localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])
      should(isLoopbackHost(host)).be.true();
    for (const host of ['128.0.0.1', '127.0.0.256', '10.0.0.1', 'example.com', '::', '::2', ''])
      should(isLoopbackHost(host)).be.false();
  });

  it('should treat every spelling of the unspecified address as a wildcard', () => {
    for (const host of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0']) should(isWildcardHost(host)).be.true();
    should(isWildcardHost('127.0.0.1')).be.false();
  });

  it('S57 should decide locality from the URL, and call an unparseable one remote so no credential leaves the machine', () => {
    should(isLocalDaemonUrl('http://127.0.0.1:9')).be.true();
    should(isLocalDaemonUrl('https://daemon.example:7431')).be.false();
    should(isLocalDaemonUrl('not a url')).be.false();
  });
});

describe('resolveDaemonUrl', () => {
  it('P90 FY_URL wins outright, with no document read', () => {
    should(resolveDaemonUrl(' http://10.0.0.5:9 ', '{"port": 1}')).equal('http://10.0.0.5:9');
  });

  it('should follow the bind the daemon recorded, never an advertisement', () => {
    should(
      resolveDaemonUrl('', JSON.stringify({ host: '127.0.0.1', port: 8123, publicUrl: 'https://x.example' })),
    ).equal('http://127.0.0.1:8123');
  });

  it('should follow the bind carrier of the carriers spelling, and answer loopback for a wildcard bind', () => {
    should(recordedBindAddress({ carriers: [{ kind: 'relay' }, { kind: 'bind', host: '0.0.0.0', port: 9000 }] })).equal(
      'http://127.0.0.1:9000',
    );
    should(recordedBindAddress({ host: '::1', port: 9001 })).equal('http://[::1]:9001');
  });

  it('should fall back to the well-known address when the document is absent, unreadable or names no port', () => {
    should(resolveDaemonUrl('', undefined)).equal(DEFAULT_DAEMON_URL);
    should(resolveDaemonUrl('', '{not json')).equal(DEFAULT_DAEMON_URL);
    should(resolveDaemonUrl('', '{"host":"127.0.0.1"}')).equal(DEFAULT_DAEMON_URL);
  });
});
