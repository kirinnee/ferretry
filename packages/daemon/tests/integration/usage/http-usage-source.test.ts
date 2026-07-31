import { describe, it } from 'bun:test';
import should from 'should';
import { HttpUsageSource } from '../../../src/adapters/usage/index.ts';

const respond = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HttpUsageSource', () => {
  it('should read and validate the collector payload', async () => {
    // Arrange
    const source = new HttpUsageSource('http://collector.invalid/usage', {
      fetcher: async () => respond({ at: 1, accounts: [{ agent: 'writer', weeklyPercent: 20 }] }),
    });

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).deepEqual([{ agent: 'writer', weeklyPercent: 20 }]);
  });

  it('should report nothing when the endpoint answers with an error status', async () => {
    // Arrange
    const source = new HttpUsageSource('http://collector.invalid/usage', {
      fetcher: async () => respond({ accounts: [] }, 503),
    });

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).be.undefined();
  });

  it('should report nothing when the transport fails', async () => {
    // Arrange
    const source = new HttpUsageSource('http://collector.invalid/usage', {
      fetcher: async () => {
        throw new Error('connection refused');
      },
    });

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).be.undefined();
  });

  it('should report nothing when the body is not JSON', async () => {
    // Arrange
    const source = new HttpUsageSource('http://collector.invalid/usage', {
      fetcher: async () => new Response('<html>not json</html>', { status: 200 }),
    });

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).be.undefined();
  });

  it("should abort the request when the caller's signal aborts", async () => {
    // Arrange
    const controller = new AbortController();
    const source = new HttpUsageSource('http://collector.invalid/usage', {
      fetcher: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });

    // Act
    const pending = source.read(controller.signal);
    controller.abort();
    const accounts = await pending;

    // Assert
    should(accounts).be.undefined();
  });

  it('should give up on a source that never answers', async () => {
    // Arrange
    const source = new HttpUsageSource('http://collector.invalid/usage', {
      timeoutMs: 5,
      fetcher: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
        }),
    });

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).be.undefined();
  });

  it('should reach a real endpoint over its default transport', async () => {
    // Arrange — an ephemeral port of our own; never a known or shared one
    const server = Bun.serve({ port: 0, fetch: () => respond({ accounts: [{ agent: 'reader' }] }) });
    const source = new HttpUsageSource(`http://127.0.0.1:${server.port}/usage`);

    // Act
    const accounts = await source.read();
    await server.stop(true);

    // Assert
    should(accounts).deepEqual([{ agent: 'reader' }]);
  });
});
