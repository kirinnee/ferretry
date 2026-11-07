import { afterEach, describe, it } from 'bun:test';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import daemon from '../../daemon/index.ts';

/**
 * The daemon half as the kernel builds it: every route, socket and tool the manifest declares has its handler, and
 * building it starts nothing — no Chrome, no worker thread, no timer — until a page is opened.
 */
describe('the browsers daemon half', () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  it('should build over the test host and answer the machine browser state with nothing running', async () => {
    // Arrange
    host = await testHost({ plugins: [daemon] });

    // Act
    const state = await host.request('GET', '/v1/browser/state');

    // Assert
    should(state.status).equal(200);
    should(state.json()).containEql({ state: 'stopped' });
  });
});
