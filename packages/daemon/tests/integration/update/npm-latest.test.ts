import { describe, it } from 'bun:test';
import should from 'should';
import { NpmHarnessLatest, type ReleaseFetch } from '../../../src/adapters/index.ts';

/** A fetcher that answers and records how it was asked. */
function answering(respond: () => Response | Promise<Response>) {
  const calls: { input: string; init: RequestInit | undefined }[] = [];
  const fetcher: ReleaseFetch = async (input, init) => {
    calls.push({ input, init });
    return await respond();
  };
  return { calls, fetcher };
}

const source = (fetcher: ReleaseFetch) => new NpmHarnessLatest({ fetcher, userAgent: 'fyd/4.49.1', timeoutMs: 1_000 });

describe('the npm newest-version read', () => {
  it('asks the registry’s latest tag uncached, with a user agent, for the harness’s own package', async () => {
    const { calls, fetcher } = answering(() => Response.json({ name: '@openai/codex', version: '0.163.0' }));
    should(await source(fetcher).latest('codex')).deepEqual({
      kind: 'ok',
      release: { version: '0.163.0', url: 'https://github.com/openai/codex/releases/tag/rust-v0.163.0' },
    });
    should(calls[0]?.input).equal('https://registry.npmjs.org/@openai/codex/latest');
    should(calls[0]?.init).containDeep({ cache: 'no-store', headers: { 'user-agent': 'fyd/4.49.1' } });
  });

  it('turns every failure into one sentence, never a throw', async () => {
    const down = answering(() => {
      throw new TypeError('network down');
    });
    should(await source(down.fetcher).latest('claude')).deepEqual({ kind: 'failed', reason: 'could not reach npm' });
    const refused = answering(() => new Response('nope', { status: 503 }));
    should(await source(refused.fetcher).latest('claude')).deepEqual({ kind: 'failed', reason: 'npm answered 503' });
    const garbled = answering(() => new Response('<html>', { status: 200 }));
    should(await source(garbled.fetcher).latest('claude')).deepEqual({
      kind: 'failed',
      reason: 'npm did not name a stable version',
    });
  });

  it('defaults to the real fetch without being handed one', () => {
    should(new NpmHarnessLatest({ userAgent: 'fyd/x' })).be.instanceOf(NpmHarnessLatest);
  });
});
