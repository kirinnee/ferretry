import { describe, it } from 'bun:test';
import type { RuntimeModelChoice } from '@ferretry/protocol';
import should from 'should';
import {
  CODEX_CATALOG_TTL_MS,
  CodexRuntimeCatalogCache,
} from '../../../../src/lib/session/harness/codex-catalog-cache.ts';

/**
 * Holding one account's catalog.
 *
 * The two properties worth a test are the two that are not about speed: two simultaneous readers must
 * share ONE probe, because a second app-server is a second speaker to a live account; and a failure
 * must not be remembered, because an account that was briefly unreachable would otherwise report an
 * outage for five minutes.
 */

const choices = (value: string): readonly RuntimeModelChoice[] => [{ value, label: value, reasoningEfforts: [] }];

/** A probe whose completion the test decides. */
function deferredProbe() {
  const calls: string[] = [];
  let release: (value: readonly RuntimeModelChoice[]) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const probe = async (binary: string, cwd: string) => {
    calls.push(`${binary}|${cwd}`);
    return await new Promise<readonly RuntimeModelChoice[]>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
  };
  return {
    calls,
    probe,
    release: (value: readonly RuntimeModelChoice[]) => release(value),
    fail: (error: unknown) => fail(error),
  };
}

describe('the Codex runtime catalog cache', () => {
  it('should probe once and answer the second read from what it holds', async () => {
    // Arrange
    let probes = 0;
    const subject = new CodexRuntimeCatalogCache(async () => {
      probes++;
      return choices('gpt-5.6-codex');
    });

    // Act
    const first = await subject.get('/fleet/bin/codex-auto', '/work');
    const second = await subject.get('/fleet/bin/codex-auto', '/work');

    // Assert
    should(probes).equal(1);
    should(first).equal(second);
  });

  it('should coalesce readers that arrive while a probe is in flight', async () => {
    // Two app-servers against one account is the hazard; sharing the promise is what prevents it.
    // Arrange
    const deferred = deferredProbe();
    const subject = new CodexRuntimeCatalogCache(deferred.probe);

    // Act
    const both = Promise.all([subject.get('/bin/codex', '/work'), subject.get('/bin/codex', '/work')]);
    deferred.release(choices('gpt-5.6-codex'));
    const [first, second] = await both;

    // Assert
    should(deferred.calls).have.length(1);
    should(first).equal(second);
  });

  it('should keep one entry per executable and working directory', async () => {
    // Both decide which models Codex offers, so neither may be dropped from the key.
    // Arrange
    const seen: string[] = [];
    const subject = new CodexRuntimeCatalogCache(async (binary, cwd) => {
      seen.push(`${binary}|${cwd}`);
      return choices(binary);
    });

    // Act
    await subject.get('/bin/a', '/work');
    await subject.get('/bin/b', '/work');
    await subject.get('/bin/a', '/other');

    // Assert
    should(seen).deepEqual(['/bin/a|/work', '/bin/b|/work', '/bin/a|/other']);
  });

  it('should re-probe once the held catalog is older than the harness holds its own', async () => {
    // Arrange
    let probes = 0;
    let now = 1_000;
    const subject = new CodexRuntimeCatalogCache(
      async () => {
        probes++;
        return choices(`probe-${probes}`);
      },
      CODEX_CATALOG_TTL_MS,
      () => now,
    );

    // Act
    await subject.get('/bin/codex', '/work');
    now += CODEX_CATALOG_TTL_MS;
    const afterExpiry = await subject.get('/bin/codex', '/work');

    // Assert
    should(probes).equal(2);
    should(afterExpiry[0]?.value).equal('probe-2');
  });

  it('should not remember a probe that failed', async () => {
    // Arrange
    let probes = 0;
    const subject = new CodexRuntimeCatalogCache(async () => {
      probes++;
      if (probes === 1) throw new Error('the account was briefly unreachable');
      return choices('gpt-5.6-codex');
    });

    // Act
    const refused = await subject.get('/bin/codex', '/work').catch((error: unknown) => error);
    const retried = await subject.get('/bin/codex', '/work');

    // Assert
    should(refused).match({ message: 'the account was briefly unreachable' });
    should(retried[0]?.value).equal('gpt-5.6-codex');
    should(probes).equal(2);
  });

  it('should leave a newer probe alone when an older one fails', async () => {
    // The failing probe drops the entry only if it is still the one on record. Deleting a successor's
    // entry would make a reader that is already waiting on a good probe start a third one.
    // Arrange
    const first = deferredProbe();
    const second = deferredProbe();
    let call = 0;
    const subject = new CodexRuntimeCatalogCache(async (binary, cwd) => {
      call++;
      return await (call === 1 ? first.probe(binary, cwd) : second.probe(binary, cwd));
    });

    // Act
    const failing = subject.get('/bin/codex', '/work').catch((error: unknown) => error);
    first.fail(new Error('probe one died'));
    should(await failing).match({ message: 'probe one died' });
    const replacement = subject.get('/bin/codex', '/work');
    second.release(choices('gpt-5.6-codex'));

    // Assert
    should((await replacement)[0]?.value).equal('gpt-5.6-codex');
    should(await subject.get('/bin/codex', '/work')).have.length(1);
    should(call).equal(2);
  });
});
