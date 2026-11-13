import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import {
  OPENING_ATTACHMENTS_KEY,
  OpeningAttachments,
  type OpeningAttachmentsSource,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import daemon from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';

/**
 * `fy start -f` (V-0443), Conversation's end of the seam: the REAL daemon half, built on the test host, provides
 * `opening.attachments` under its one key, and what it provides plans the files a start was given. Ferrets' end is
 * pinned in its package (`opening-attachments-route.test.ts`), and both real halves together in the kernel's
 * integration tier (`tests/integration/host/opening-attachments.test.ts`, CI only).
 */

type Half = { readonly hooks?: Readonly<Record<string, unknown>> };

/** The real half as the host builds it, captured on its way out of `build`. */
async function builtHalf(): Promise<Half> {
  let half: Half | undefined;
  const build = daemon.build;
  if (build === undefined) throw new Error('the conversation daemon half has no build');
  const captured = {
    ...daemon,
    build: (ctx: Parameters<typeof build>[0]) => {
      const built = build(ctx);
      half = built as Half;
      return built;
    },
  } as typeof daemon;
  const host = await testHost({ plugins: [captured], fakes: { ferrets: new FakeFerrets(), asks: new FakeAsks() } });
  await host.stop();
  if (half === undefined) throw new Error('the host did not build the conversation half');
  return half;
}

describe('V-0443 Conversation provides opening.attachments', () => {
  test('V-0443 the manifest takes opening.attachments as its one provider, under the hook’s one key', () => {
    expect(manifest.hooks?.takes?.filter(take => take.hook.name === OpeningAttachments.name)).toEqual([
      { hook: OpeningAttachments, key: OPENING_ATTACHMENTS_KEY },
    ]);
    expect(OpeningAttachments.mode).toBe('provide');
    expect(OpeningAttachments.mode === 'provide' && OpeningAttachments.takers).toEqual(['conversation']);
  });

  test('V-0443 the built half’s provider plans a file into the folder it is told and names it in the section', async () => {
    const half = await builtHalf();
    const source = half.hooks?.[`${OpeningAttachments.name}:${OPENING_ATTACHMENTS_KEY}`] as
      | OpeningAttachmentsSource
      | undefined;
    expect(typeof source?.plan).toBe('function');
    const directory = '/state/ferrets/sessions/f1/attachments';
    const planned = source?.plan({
      directory,
      attachments: [{ filename: 'notes.txt', base64: Buffer.from('Ship it.').toString('base64') }],
    });
    expect(planned?.ok).toBe(true);
    if (planned?.ok !== true) return;
    expect(planned.value.files.map(file => file.file)).toEqual([`${directory}/notes.txt`]);
    expect(Buffer.from(planned.value.files[0]?.contents ?? '').toString()).toBe('Ship it.');
    expect(planned.value.section).toContain(`${directory}/notes.txt`);
  });
});
