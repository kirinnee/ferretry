import { describe, it } from 'bun:test';
import { parseRelayTenancy, servesDaemon } from '@ferretry/relay';
import should from 'should';

const first = `fy_daemon_${'a'.repeat(43)}`;
const second = `fy_daemon_${'b'.repeat(43)}`;

describe('relay tenancy', () => {
  it('should accept whichever separator the operator happened to type', () => {
    const tenancy = parseRelayTenancy(` ${first},${second}\n${first} `);
    should([...tenancy.daemonIds].sort()).deepEqual([first, second].sort());
    should(tenancy.rejected).deepEqual([]);
  });

  it('should surface a malformed entry instead of quietly dropping it', () => {
    const tenancy = parseRelayTenancy(`${first} not-a-fingerprint`);
    should(tenancy.rejected).deepEqual(['not-a-fingerprint']);
    should(servesDaemon(tenancy, first)).be.true();
  });

  it('should serve nobody when nobody was configured', () => {
    for (const configured of [undefined, null, '', '   ']) {
      const tenancy = parseRelayTenancy(configured);
      should(tenancy.daemonIds.size).equal(0);
      should(servesDaemon(tenancy, first)).be.false();
    }
  });

  it('should refuse a daemon it was not given, and a value that is not a fingerprint', () => {
    const tenancy = parseRelayTenancy(first);
    should(servesDaemon(tenancy, second)).be.false();
    should(servesDaemon(tenancy, 'fy_daemon_short')).be.false();
  });
});
