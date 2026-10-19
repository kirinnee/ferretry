import { describe, it } from 'bun:test';
import should from 'should';
import { FORBIDDEN_TEST_HOST, OFFLINE_TEST_ENVIRONMENT } from '../support/offline-environment.ts';

describe('the offline test environment', () => {
  it('should switch off every way a booted daemon phones out, for this process and its children', () => {
    for (const [name, value] of Object.entries(OFFLINE_TEST_ENVIRONMENT)) should(process.env[name]).equal(value);
  });

  it('should refuse a fetch to a Ferretry-hosted origin, and only those', async () => {
    await should(fetch('https://ferretry.pages.dev/catalog/version.json')).be.rejectedWith(/tests run offline/);
    should(FORBIDDEN_TEST_HOST.test('ferretry-hosted-relay.someone.workers.dev')).be.true();
    should(FORBIDDEN_TEST_HOST.test('example.com')).be.false();
  });
});
