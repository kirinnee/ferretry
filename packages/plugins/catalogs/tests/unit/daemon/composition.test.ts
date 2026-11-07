/**
 * THE CATALOGS DAEMON HALF, COMPOSED BY THE KERNEL'S TEST HOST (§3.9, §7.8): the real `daemon/index.ts` built with
 * Gate's, Access's, Vault's and Connections' contract fakes, and asked through the host's own route table.
 */
import { describe, expect, it } from 'bun:test';
import { CatalogsPort } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { browser, catalogsFixture, joinWith, makeCatalog, mintShare } from '../../support/daemon-host.ts';

describe('the Catalogs daemon half on the kernel test host', () => {
  it('should build a handler for every declared route and member route, and take every declared hook', async () => {
    // Arrange
    const fx = await catalogsFixture();

    // Assert — the half the host built answers for each declaration, and nothing undeclared
    expect(Object.keys(fx.half.routes).sort()).toEqual(manifest.actions.routes.map(route => route.key).sort());
    expect(Object.keys(fx.half.memberRoutes).sort()).toEqual(
      manifest.actions.memberRoutes.map(route => route.key).sort(),
    );
    expect(Object.keys(fx.half.hooks).sort()).toEqual(['credentials:member', 'session.modes:member', 'step-up:member']);
    expect(fx.half.hooks['session.modes:member'].principalKind).toBe('member');
  });

  it('should register its boot and periodic jobs', async () => {
    // Arrange
    const fx = await catalogsFixture();

    // Assert
    expect([...fx.host.jobIds()].sort()).toEqual(
      [
        'catalogs-load-members',
        'catalogs-sweep',
        'catalogs-sweep-boot',
        'catalogs-link-reconcile',
        'catalogs-link-reconcile-boot',
        'catalogs-link-refresh',
        'catalogs-link-refresh-boot',
      ].sort(),
    );
  });

  it('should write a catalog to its own declared state file and publish one change', async () => {
    // Arrange
    const fx = await catalogsFixture();

    // Act
    const id = await makeCatalog(fx, 'Team');
    const listed = await fx.host.request('GET', '/v1/catalogs');

    // Assert
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(listed.json<{ catalogs: { id: string; name: string }[] }>().catalogs.map(c => [c.id, c.name])).toEqual([
      [id, 'Team'],
    ]);
    expect(fx.host.published).toContainEqual({ event: 'catalogs.changed', payload: { change: 'catalog' } });
    expect(fx.host.state('catalogs').files.get('catalogs.json')).toContain(id);
  });

  it('should provide its port: the installs Catalogs made, by summary', async () => {
    // Arrange
    const fx = await catalogsFixture();

    // Act
    const installs = await fx.host.provided(CatalogsPort).installs();

    // Assert
    expect(installs).toEqual([]);
  });

  it('should keep the share code out of its state, its audit and every later answer', async () => {
    // Arrange
    const fx = await catalogsFixture();
    const catalog = await makeCatalog(fx);

    // Act
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const listed = await fx.host.request('GET', '/v1/catalog-shares');

    // Assert
    expect(share.code).toMatch(/^fy_share_[A-Za-z0-9_-]{22}$/u);
    expect([...fx.host.state('catalogs').files.values()].join('\n')).not.toContain(share.code);
    expect(JSON.stringify(fx.gate.audits)).not.toContain(share.code);
    expect(listed.body).not.toContain(share.code);
  });

  it('should refuse to mint a share link while Connections cannot describe this machine, spending nothing', async () => {
    // Arrange
    const fx = await catalogsFixture({ advertisement: undefined });
    const catalog = await makeCatalog(fx);

    // Act
    const minted = await fx.host.request('POST', '/v1/catalog-shares', {
      body: {
        catalogIds: [catalog],
        member: { kind: 'new', label: 'Alice' },
        expiresIn: '1h',
        uses: { kind: 'single' },
      },
    });
    const shares = await fx.host.request('GET', '/v1/catalog-shares');

    // Assert
    expect(minted.status).toBeGreaterThanOrEqual(400);
    expect(shares.json<{ shares: unknown[] }>().shares).toEqual([]);
  });

  it('should refuse a ferret the owner-only acts and let it read', async () => {
    // Arrange
    const fx = await catalogsFixture();
    const ferret = { kind: 'ferret', id: 'F1936' } as const;

    // Act
    const made = await fx.host.request('POST', '/v1/catalogs', { body: { name: 'Mine' }, as: ferret });
    const listed = await fx.host.request('GET', '/v1/catalogs', { as: ferret });

    // Assert
    expect(made.status).toBe(403);
    expect(listed.status).toBe(200);
  });

  it('should answer a member key synchronously from memory, with no secret-shaped field, and bump on a change', async () => {
    // Arrange
    const fx = await catalogsFixture();
    const catalog = await makeCatalog(fx);
    const other = await makeCatalog(fx, 'Other');
    const provider = fx.half.hooks['credentials:member'];
    const share = await mintShare(fx, { catalogIds: [catalog, other] });
    const joined = await joinWith(fx, await browser(), share.code);
    const before = provider.generation();

    // Act
    const standing = provider.standing(joined.keyId as never, fx.clock.now());
    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}/catalogs/${other}`);
    const narrowed = provider.generation();
    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}`);

    // Assert
    expect(standing instanceof Promise).toBe(false);
    expect(standing).toMatchObject({ kind: 'member', holder: joined.keyId });
    for (const field of Object.keys(standing as object))
      expect(/token|digest|secret|password|key$/iu.test(field)).toBe(false);
    expect(narrowed).toBeGreaterThan(before);
    expect(provider.generation()).toBeGreaterThan(narrowed);
    // Today a removed key is forgotten, so it reads as never enrolled (Gate refuses both alike).
    expect(provider.standing(joined.keyId as never, fx.clock.now())).toBe('unknown');
    expect(provider.standing('mk_never' as never, fx.clock.now())).toBe('unknown');
  });
});
