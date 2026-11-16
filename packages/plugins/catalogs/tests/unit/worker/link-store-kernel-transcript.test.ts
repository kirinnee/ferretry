/** R594: the kernel signs the link-store transcript the Worker verifies — the two spellings are the same bytes. */
import { describe, expect, test } from 'bun:test';
import { linkStoreTranscript as kernelTranscript } from '@ferretry/kernel/wire';
import { linkStoreTranscript as workerTranscript } from '../../../worker/src/lib/index.ts';

const nonce = Uint8Array.from({ length: 32 }, (_, index) => index);
const common = { daemonId: `fy_daemon_${'A'.repeat(43)}`, host: 'links.example.test', nonce };

describe('R594 the kernel link-store transcript is the Worker’s', () => {
  const bodies = [
    {
      request: 'upload',
      bundleId: 'lnk_abc',
      action: 'replace',
      kind: 'catalog',
      sequence: 4,
      expectSequence: 3,
      notAfter: '2026-11-08T00:00:00.000Z',
      expiresAt: '2026-11-09T00:00:00.000Z',
      installCap: 5,
      fetchVerifier: 'verifier',
      envelopeSha256: 'digest',
      envelopeBytes: 100,
    },
    {
      request: 'upload',
      bundleId: 'lnk_abc',
      action: 'create',
      kind: 'catalog',
      sequence: 1,
      notAfter: '2026-11-08T00:00:00.000Z',
      fetchVerifier: 'verifier',
      envelopeSha256: 'digest',
      envelopeBytes: 100,
    },
    { request: 'delete', bundleId: 'lnk_abc' },
    { request: 'status', bundleIds: ['lnk_b', 'lnk_a'] },
  ] as const;
  for (const body of bodies)
    test(`${body.request} ${'action' in body ? body.action : ''}`.trim(), () => {
      expect(kernelTranscript({ ...common, body: body as never })).toEqual(
        workerTranscript({ ...common, body: body as never }),
      );
    });
});
