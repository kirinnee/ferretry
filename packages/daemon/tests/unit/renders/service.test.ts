import { describe, it } from 'bun:test';
import { RENDER_QUOTAS, type StoredRenderMeta } from '@ferretry/protocol';
import should from 'should';
import { RenderError, renderDigest, renderIdPrefix } from '../../../src/lib/renders/index.ts';
import { HTML, MemoryRenderRepository, renderService, SVG } from '../../support/renders.ts';

const svg = (alt = 'A circle', payload = SVG) => ({ kind: 'svg' as const, alt, payload });

async function refusal(work: Promise<unknown>): Promise<RenderError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof RenderError) return error;
    throw error;
  }
  throw new Error('expected a render refusal');
}

describe('RenderService.save', () => {
  it('should keep a picture under a short id and answer its token', async () => {
    const repository = new MemoryRenderRepository();
    const saved = await renderService(repository).save(svg(), 's1');

    should(saved.created).be.true();
    should(saved.id).match(/^[0-9a-hjkmnp-tv-z]{6}$/u);
    should(saved.token).equal(`%svg:${saved.id}`);
    should(saved.meta).containEql({ kind: 'svg', alt: 'A circle', bytes: SVG.length, author: { sessionId: 's1' } });
    should(repository.payloads.get(saved.id)).equal(SVG);
  });

  it('should answer the same render for the same content, and write nothing the second time', async () => {
    const repository = new MemoryRenderRepository();
    const service = renderService(repository);
    const first = await service.save(svg(), 's1');
    const second = await service.save(svg(), 's2');

    should(second.id).equal(first.id);
    should(second.created).be.false();
    should(repository.metas.size).equal(1);
    should(second.meta.author).deepEqual({ sessionId: 's1' });
  });

  it('should give an edit a new id, and link it to the one it replaces', async () => {
    const service = renderService();
    const first = await service.save(svg('One'));
    const second = await service.save({ ...svg('One'), alt: 'Two', supersedes: first.id });

    should(second.id).not.equal(first.id);
    should(second.meta.supersedes).equal(first.id);
    should((await service.meta(first.id)).supersededBy).equal(second.id);
    should((await service.meta(second.id)).supersededBy).be.undefined();
    should((await service.body(first.id)).payload).equal(SVG);
  });

  it('should point an old render at the newest of a chain of edits', async () => {
    const service = renderService();
    const a = await service.save(svg('A'));
    const b = await service.save({ ...svg('B'), supersedes: a.id });
    const c = await service.save({ ...svg('C'), supersedes: b.id });

    should((await service.meta(a.id)).supersededBy).equal(c.id);
    should((await service.meta(b.id)).supersededBy).equal(c.id);
  });

  it('should refuse to replace a picture that is not saved', async () => {
    const error = await refusal(renderService().save({ ...svg(), supersedes: 'aaaaaa' }));
    should(error.code).equal('supersedes_not_found');
  });

  it('should refuse an invalid picture before anything is written', async () => {
    const repository = new MemoryRenderRepository();
    const service = renderService(repository);

    const notSvg = await refusal(service.save({ kind: 'svg', alt: 'x', payload: '<div>no</div>' }));
    const script = await refusal(
      service.save({ kind: 'svg', alt: 'x', payload: `<svg viewBox="0 0 1 1"><script>1</script></svg>` }),
    );
    const emptyAlt = await refusal(service.save({ kind: 'html', alt: '', payload: HTML }));
    const emptyHtml = await refusal(service.save({ kind: 'html', alt: 'x', payload: '   ' }));
    const tooBig = await refusal(service.save({ kind: 'html', alt: 'x', payload: 'a'.repeat(200 * 1024 + 1) }));

    for (const error of [notSvg, script, emptyAlt, emptyHtml, tooBig]) should(error.code).equal('invalid');
    should(tooBig.message).match(/200 KiB/u);
    should(repository.metas.size).equal(0);
  });

  it('should take a longer id when a shorter one is held by different content', async () => {
    const repository = new MemoryRenderRepository();
    const digest = renderDigest('svg', 'A circle', SVG);
    const squatter: StoredRenderMeta = {
      v: 1,
      id: renderIdPrefix(digest, 6),
      kind: 'html',
      alt: 'other',
      bytes: 1,
      sha256: 'f'.repeat(64),
      createdAt: '2026-11-05T00:00:00.000Z',
      author: {},
    };
    repository.metas.set(squatter.id, squatter);

    const saved = await renderService(repository).save(svg());

    should(saved.id).have.length(8);
    should(saved.id).equal(renderIdPrefix(digest, 8));
    should((await renderService(repository).save(svg())).id).equal(saved.id);
  });

  it('should rebuild its knowledge from what is on disk and find a saved render again', async () => {
    const repository = new MemoryRenderRepository();
    const saved = await renderService(repository).save(svg());

    const afterRestart = renderService(repository);
    should((await afterRestart.save(svg())).created).be.false();
    should((await afterRestart.meta(saved.id)).id).equal(saved.id);
  });

  it('should not remember a failed listing as an empty store', async () => {
    const repository = new MemoryRenderRepository();
    repository.failListing = true;
    const service = renderService(repository);
    await service.save(svg()).then(
      () => should.fail(undefined, undefined, 'expected the listing to fail'),
      () => undefined,
    );

    repository.failListing = false;
    should((await service.save(svg())).created).be.true();
  });

  it('should keep one save from racing the quota check of another', async () => {
    const repository = new MemoryRenderRepository();
    const service = renderService(repository);
    const saves = await Promise.all([1, 2, 3].map(async n => await service.save(svg(`Circle ${n}`), 's1')));

    should(new Set(saves.map(saved => saved.id)).size).equal(3);
    should(repository.metas.size).equal(3);
  });
});

describe('RenderService quotas', () => {
  /** A distinct, well-formed id for each number: base 6 spelled with the digits 2 to 7, padded with `a`. */
  const idOf = (n: number): string =>
    n
      .toString(6)
      .replace(/\d/gu, digit => '234567'[Number(digit)] ?? 'a')
      .padStart(6, 'a');

  const held = (id: string, sessionId: string | undefined, bytes: number): StoredRenderMeta => ({
    v: 1,
    id,
    kind: 'svg',
    alt: 'held',
    bytes,
    sha256: id.padEnd(64, '0'),
    createdAt: '2026-11-05T00:00:00.000Z',
    author: sessionId === undefined ? {} : { sessionId },
  });

  it("should refuse a session past its count and name the quota, but serve another session's save", async () => {
    const repository = new MemoryRenderRepository();
    for (let n = 0; n < RENDER_QUOTAS.perSessionCount; n += 1) repository.metas.set(idOf(n), held(idOf(n), 's1', 1));
    const service = renderService(repository);
    const error = await refusal(service.save(svg(), 's1'));

    should(error.code).equal('quota_exceeded');
    should(error.message).match(/2000 pictures for this session/u);
    should((await service.save(svg(), 's2')).created).be.true();
  });

  it('should refuse a session past its bytes', async () => {
    const repository = new MemoryRenderRepository();
    repository.metas.set('aaaaaa', held('aaaaaa', 's1', RENDER_QUOTAS.perSessionBytes - 10));
    const error = await refusal(renderService(repository).save(svg(), 's1'));

    should(error.code).equal('quota_exceeded');
    should(error.message).match(/64 MiB for this session/u);
  });

  it("should count a save made at the machine against the owner's own bucket", async () => {
    const repository = new MemoryRenderRepository();
    repository.metas.set('aaaaaa', held('aaaaaa', undefined, RENDER_QUOTAS.perSessionBytes - 10));
    const service = renderService(repository);

    should((await refusal(service.save(svg()))).message).match(/the owner's own saves/u);
    should((await service.save(svg(), 's1')).created).be.true();
  });

  it('should refuse past the whole machine whoever asks', async () => {
    const repository = new MemoryRenderRepository();
    for (let n = 0; n < 40; n += 1)
      repository.metas.set(idOf(n), held(idOf(n), `s${n}`, RENDER_QUOTAS.machineBytes / 40));
    const error = await refusal(renderService(repository).save(svg(), 'fresh'));

    should(error.code).equal('quota_exceeded');
    should(error.message).match(/1 GiB on this machine/u);
  });

  it('should refuse past the machine’s count whoever asks', async () => {
    const repository = new MemoryRenderRepository();
    for (let n = 0; n < RENDER_QUOTAS.machineCount; n += 1) repository.metas.set(idOf(n), held(idOf(n), `s${n}`, 1));
    const error = await refusal(renderService(repository).save(svg(), 'fresh'));

    should(error.code).equal('quota_exceeded');
    should(error.message).match(/20000 pictures on this machine/u);
  });

  it('should not charge a repeated save against any quota', async () => {
    const repository = new MemoryRenderRepository();
    const service = renderService(repository);
    await service.save(svg(), 's1');
    repository.metas.set('aaaaaa', held('aaaaaa', 's1', RENDER_QUOTAS.perSessionBytes));
    const again = renderService(repository);

    should((await again.save(svg(), 's1')).created).be.false();
  });
});

describe('RenderService reads', () => {
  it('should answer not found for an id nothing holds', async () => {
    const service = renderService();
    should((await refusal(service.meta('zzzzzz'))).code).equal('not_found');
    should((await refusal(service.body('zzzzzz'))).code).equal('not_found');
  });

  it('should refuse bytes that no longer match what was saved, and a payload that is gone', async () => {
    const repository = new MemoryRenderRepository();
    const service = renderService(repository);
    const saved = await service.save(svg());

    repository.payloads.set(saved.id, SVG.replace('r="4"', 'r="5"'));
    should((await refusal(service.body(saved.id))).code).equal('damaged');
    repository.payloads.delete(saved.id);
    should((await refusal(service.body(saved.id))).code).equal('damaged');
  });
});
