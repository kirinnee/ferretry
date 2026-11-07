import { describe, it } from 'bun:test';
import type { Instant } from '@ferretry/std';
import { RENDER_MAX_PENDING_SAVES, RENDER_QUOTAS, type StoredRenderMeta } from '../../../contract/index.ts';
import should from 'should';
import { RenderError, renderDigest, renderIdPrefix } from '../../../daemon/renders/lib/index.ts';
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
    should(saved.meta).containEql({ kind: 'svg', alt: 'A circle', bytes: SVG.length, author: { ferret: 's1' } });
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
    should(second.meta.author).deepEqual({ ferret: 's1' });
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
      createdAt: '2026-11-05T00:00:00.000Z' as Instant,
      author: {},
    };
    repository.metas.set(squatter.id, squatter);

    const saved = await renderService(repository).save(svg());

    should(saved.id).have.length(8);
    should(saved.id).equal(renderIdPrefix(digest, 8));
    should((await renderService(repository).save(svg())).id).equal(saved.id);
  });

  it('should find content again under a longer id when the shorter holder of its prefix was lost', async () => {
    const repository = new MemoryRenderRepository();
    const first = await renderService(repository).save(svg());
    const digest = renderDigest('svg', 'A circle', SVG);
    const longer = renderIdPrefix(digest, 8);
    // As if the six-character record was lost: only the eight-character one survives a restart.
    repository.metas.clear();
    repository.payloads.clear();
    repository.metas.set(longer, { ...(first.meta as StoredRenderMeta), id: longer });
    repository.payloads.set(longer, SVG);

    const again = await renderService(repository).save(svg());

    should(again.id).equal(longer);
    should(again.created).be.false();
    should([...repository.metas.keys()]).deepEqual([longer]);
  });

  it('should refuse a picture when every length of its id is held by a record naming other content', async () => {
    const repository = new MemoryRenderRepository();
    const digest = renderDigest('svg', 'A circle', SVG);
    for (let length = 6; length <= 52; length += 2) {
      const id = renderIdPrefix(digest, length);
      repository.metas.set(id, {
        v: 1,
        id,
        kind: 'html',
        alt: 'liar',
        bytes: 1,
        sha256: 'f'.repeat(64),
        createdAt: '2026-11-05T00:00:00.000Z' as Instant,
        author: {},
      });
    }

    should((await refusal(renderService(repository).save(svg()))).code).equal('id_space_exhausted');
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

describe('RenderService saves in flight', () => {
  const settle = async (until: () => boolean): Promise<void> => {
    for (let turns = 0; turns < 100 && !until(); turns += 1) await new Promise(resolve => setTimeout(resolve, 0));
  };

  it('should refuse the next save at once when the bound is in flight, and take saves again after they finish', async () => {
    const repository = new MemoryRenderRepository();
    const release = repository.hold();
    const service = renderService(repository);
    const pending = Array.from(
      { length: RENDER_MAX_PENDING_SAVES },
      async (_, n) => await service.save(svg(`Circle ${n}`)),
    );
    await settle(() => service.saturated());

    should(service.saturated()).be.true();
    should((await refusal(service.save(svg('One too many')))).code).equal('busy');
    should(repository.metas.size).equal(0);

    release();
    should((await Promise.all(pending)).every(saved => saved.created)).be.true();
    should(service.saturated()).be.false();
    should((await service.save(svg('One more'))).created).be.true();
  });

  it('should free its slot when a save is refused or fails', async () => {
    const repository = new MemoryRenderRepository();
    repository.failListing = true;
    const service = renderService(repository);

    for (let n = 0; n < RENDER_MAX_PENDING_SAVES * 2; n += 1) await service.save(svg()).catch(() => undefined);

    should(service.saturated()).be.false();
    repository.failListing = false;
    should((await service.save(svg())).created).be.true();
  });
});

describe('RenderService.admit', () => {
  it('should reserve places up to the bound, refuse the next, and give a place back once however often it is released', () => {
    const service = renderService();
    const slots = Array.from({ length: RENDER_MAX_PENDING_SAVES }, () => service.admit());

    should(service.saturated()).be.true();
    should(() => service.admit()).throw(/retry/u);
    slots[0]?.release();
    slots[0]?.release();
    should(service.saturated()).be.false();
    should(() => {
      service.admit();
      service.admit();
    }).throw(/retry/u);
  });

  it('should release the slot it was handed when the save is refused or ends', async () => {
    const service = renderService();
    const invalid = service.admit();
    should((await refusal(service.save({ kind: 'svg', alt: 'x', payload: '<div/>' }, undefined, invalid))).code).equal(
      'invalid',
    );
    const fine = service.admit();
    await service.save(svg(), undefined, fine);
    for (let n = 0; n < RENDER_MAX_PENDING_SAVES * 2; n += 1) {
      const slot = service.admit();
      await service.save(svg(), undefined, slot);
    }

    should(service.saturated()).be.false();
  });
});

describe('RenderService quotas', () => {
  /** A distinct, well-formed id for each number: base 6 spelled with the digits 2 to 7, padded with `a`. */
  const idOf = (n: number): string =>
    n
      .toString(6)
      .replace(/\d/gu, digit => '234567'[Number(digit)] ?? 'a')
      .padStart(6, 'a');

  const held = (id: string, ferret: string | undefined, bytes: number): StoredRenderMeta => ({
    v: 1,
    id,
    kind: 'svg',
    alt: 'held',
    bytes,
    sha256: id.padEnd(64, '0'),
    createdAt: '2026-11-05T00:00:00.000Z' as Instant,
    author: ferret === undefined ? {} : { ferret },
  });

  it("should refuse a ferret past its count and name the quota, but serve another session's save", async () => {
    const repository = new MemoryRenderRepository();
    for (let n = 0; n < RENDER_QUOTAS.perFerretCount; n += 1) repository.metas.set(idOf(n), held(idOf(n), 's1', 1));
    const service = renderService(repository);
    const error = await refusal(service.save(svg(), 's1'));

    should(error.code).equal('quota_exceeded');
    should(error.message).match(/2000 pictures for this ferret/u);
    should((await service.save(svg(), 's2')).created).be.true();
  });

  it('should refuse a ferret past its bytes', async () => {
    const repository = new MemoryRenderRepository();
    repository.metas.set('aaaaaa', held('aaaaaa', 's1', RENDER_QUOTAS.perFerretBytes - 10));
    const error = await refusal(renderService(repository).save(svg(), 's1'));

    should(error.code).equal('quota_exceeded');
    should(error.message).match(/64 MiB for this ferret/u);
  });

  it("should count a save made at the machine against the owner's own bucket", async () => {
    const repository = new MemoryRenderRepository();
    repository.metas.set('aaaaaa', held('aaaaaa', undefined, RENDER_QUOTAS.perFerretBytes - 10));
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
    repository.metas.set('aaaaaa', held('aaaaaa', 's1', RENDER_QUOTAS.perFerretBytes));
    const again = renderService(repository);

    should((await again.save(svg(), 's1')).created).be.false();
  });
});

describe('RenderService when a write commits and then rejects', () => {
  it('should rebuild its index from the files, so the committed render is found and counted once', async () => {
    const repository = new MemoryRenderRepository();
    const service = renderService(repository);
    repository.failAfterWrite = true;
    const error = await service.save(svg(), 's1').then(
      () => undefined,
      (caught: unknown) => caught,
    );

    should(error).be.an.Error();
    should((error as Error).message).match(/directory could not be synced/u);
    should(repository.metas.size).equal(1);
    repository.failAfterWrite = false;
    const retry = await service.save(svg(), 's1');

    should(retry.created).be.false();
    should(retry.id).equal([...repository.metas.keys()][0]);
    should(repository.listings).equal(2);
    should(repository.metas.size).equal(1);
  });

  it('should count the committed render in the quota totals the next save sees', async () => {
    const repository = new MemoryRenderRepository();
    const held = (n: number): StoredRenderMeta => ({
      v: 1,
      id: `b${n.toString().padStart(5, 'z')}`,
      kind: 'svg',
      alt: 'held',
      bytes: 1,
      sha256: n.toString(16).padStart(64, '0'),
      createdAt: '2026-11-05T00:00:00.000Z' as Instant,
      author: { ferret: 's1' },
    });
    for (let n = 0; n < RENDER_QUOTAS.perFerretCount - 1; n += 1) repository.metas.set(held(n).id, held(n));
    const service = renderService(repository);
    repository.failAfterWrite = true;
    await service.save(svg(), 's1').catch(() => undefined);
    repository.failAfterWrite = false;

    const error = await refusal(service.save(svg('Another picture'), 's1'));

    should(error.code).equal('quota_exceeded');
  });
});

describe('RenderService supersededBy', () => {
  it('should walk a long chain to its last render', async () => {
    const service = renderService();
    const first = await service.save(svg('Version 0'));
    let last = first;
    for (let n = 1; n < 70; n += 1) last = await service.save({ ...svg(`Version ${n}`), supersedes: last.id });

    should((await service.meta(first.id)).supersededBy).equal(last.id);
    should((await service.meta(last.id)).supersededBy).be.undefined();
  });

  it('should stop on a chain of damaged metas that loops', async () => {
    const repository = new MemoryRenderRepository();
    const meta = (id: string, supersedes: string, createdAt: string): StoredRenderMeta => ({
      v: 1,
      id,
      kind: 'svg',
      alt: 'loop',
      bytes: 1,
      sha256: id.padEnd(64, '0'),
      createdAt: createdAt as Instant,
      author: {},
      supersedes,
    });
    repository.metas.set('aaaaaa', meta('aaaaaa', 'bbbbbb', '2026-11-05T00:00:01.000Z'));
    repository.metas.set('bbbbbb', meta('bbbbbb', 'aaaaaa', '2026-11-05T00:00:02.000Z'));
    const service = renderService(repository);

    should((await service.meta('aaaaaa')).supersededBy).equal('bbbbbb');
    should((await service.meta('bbbbbb')).supersededBy).equal('aaaaaa');
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
