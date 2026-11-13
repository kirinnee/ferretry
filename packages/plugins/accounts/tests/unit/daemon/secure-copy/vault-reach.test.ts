import { describe, it } from 'bun:test';
import type { VaultApi } from '@ferretry/core-vault/contract';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import should from 'should';
import { BrowsersCopyPages } from '../../../../daemon/adapters/secure-copy/browsers-pages.ts';
import { VaultCopyMasking, VaultCopyRunner } from '../../../../daemon/adapters/secure-copy/vault-reach.ts';
import { SecureCopyError } from '../../../../daemon/lib/secure-copy/errors.ts';

const SENTINEL = 'FAKE-SC-7f3a91';

const SPEC = { command: ['gh', 'auth', 'token'], cwd: '/work', env: {}, timeoutMs: 30_000, maxOutputBytes: 16_385 };

describe('the sealed command runner', () => {
  it('should hand the Vault the command, folder and limits and nothing of the environment, and answer what it printed', async () => {
    const seen: unknown[] = [];
    const vault = {
      captureCommand: async (spec: unknown) => {
        seen.push(spec);
        return { outcome: 'exited', exitCode: 0, stdout: SENTINEL, stderr: '', truncated: false };
      },
    } as unknown as VaultApi;

    const out = await new VaultCopyRunner(() => vault).run({ ...SPEC, env: { ADMIN_TOKEN: 'never-passed' } });

    should(out.stdout).equal(SENTINEL);
    should(seen).eql([{ command: ['gh', 'auth', 'token'], cwd: '/work', timeoutMs: 30_000, maxOutputBytes: 16_385 }]);
    should(JSON.stringify(seen)).not.containEql('never-passed');
  });

  it('should answer spawn_failed, quoting nothing, when the Vault offers no runner or it throws', async () => {
    const none = await new VaultCopyRunner(() => ({}) as VaultApi).run(SPEC);
    const absent = await new VaultCopyRunner(() => undefined).run(SPEC);
    const throws = await new VaultCopyRunner(
      () =>
        ({
          captureCommand: async () => {
            throw new Error(`could not run gh auth token ${SENTINEL}`);
          },
        }) as unknown as VaultApi,
    ).run(SPEC);

    for (const out of [none, absent, throws]) should(out).match({ outcome: 'spawn_failed', stdout: '', stderr: '' });
    should(JSON.stringify(throws)).not.containEql(SENTINEL);
  });
});

describe('the masking registry through the Vault', () => {
  it('should hold and retime by ferret and marker, and refuse to hold where nothing masks', () => {
    const calls: unknown[] = [];
    const vault = {
      maskCopy: {
        hold: (...args: unknown[]) => void calls.push(['hold', ...args]),
        retime: (...args: unknown[]) => void calls.push(['retime', ...args]),
      },
    } as unknown as VaultApi;
    const masking = new VaultCopyMasking(() => vault);

    masking.holdUntil('F1', SENTINEL, '[sealed:token]', 5);
    masking.retime('F1', '[sealed:token]', 3);

    should(calls).eql([
      ['hold', 'F1', SENTINEL, '[sealed:token]', 5],
      ['retime', 'F1', '[sealed:token]', 3],
    ]);
    const error = (() => {
      try {
        new VaultCopyMasking(() => ({}) as VaultApi).holdUntil('F1', SENTINEL, '[sealed:token]', 5);
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    should(error).be.instanceOf(SecureCopyError);
    should(String((error as Error).message)).not.containEql(SENTINEL);
  });
});

describe('a page copy through Browsers’ reach', () => {
  const queue = { seal: () => undefined };
  const target = { kind: 'ref', ref: 'e3' } as const;

  it('should answer the browser’s read as the copy service reads it', async () => {
    const found = {
      ok: true as const,
      value: SENTINEL,
      pageId: 'p1',
      origin: 'https://example.test',
      frameOrigin: 'https://example.test',
      navigationId: 'n1',
    };
    const browsers = { copy: { copyRead: async () => found } } as unknown as BrowsersApi;

    const read = await new BrowsersCopyPages(() => browsers).read('F1', 'app', target, 'text', undefined, queue);

    should(read).eql(found);
  });

  it('should turn a refusal into the copy’s own error with the browser’s sentence, codes kept', async () => {
    const refused = (code: string, message: string) =>
      ({ copy: { copyRead: async () => ({ ok: false, reason: 'refused', code, message }) } }) as unknown as BrowsersApi;

    for (const [code, expected] of [
      ['taken_over', 'taken_over'],
      ['forbidden', 'forbidden'],
      ['not_found', 'not_found'],
      ['unavailable', 'unavailable'],
    ] as const) {
      const error = await new BrowsersCopyPages(() => refused(code, `words for ${code}`))
        .read('F1', 'app', target, 'text', undefined, queue)
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      should(error).be.instanceOf(SecureCopyError);
      should(error).match({ code: expected, message: `words for ${code}` });
    }
  });

  it('should copy nothing when Browsers is off or offers no reach', async () => {
    for (const browsers of [undefined, {} as BrowsersApi]) {
      const error = await new BrowsersCopyPages(() => browsers)
        .read('F1', 'app', target, 'text', undefined, queue)
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      should(error).match({ code: 'unavailable' });
    }
  });
});
