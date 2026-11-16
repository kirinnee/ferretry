/**
 * The member-surface hash (§9.6): over a package's member-table routes only, with the JSON schema of the bodies they
 * parse and answer. A change to an owner route, or to a contract schema no member route uses, does not move it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type Fixture, type FixturePackage, SDK, ZOD, fixture, routeDecl } from './fixture.ts';
import { buildModel, generateGlobal } from '../registries.ts';

const made: Fixture[] = [];
afterAll(() => {
  for (const f of made) f.dispose();
});

interface Shape {
  /** The field of the member route's request body. */
  readonly memberField?: string;
  /** The field of an owner route's request body (no member route uses it). */
  readonly ownerField?: string;
  /** An owner route path, so a route can be added or moved. */
  readonly ownerPath?: string;
  readonly memberKeys?: readonly string[];
}

const memberRouteDecl = (key: string, extra = ''): string =>
  `memberRoute('${key}', { member: 'unlocked', noStore: true, audit: { skip: 'fixture' }, guard: { none: 'fixture' }${extra} })`;

const alpha = (shape: Shape = {}): FixturePackage => ({
  id: 'alpha',
  contract: `import { z } from '${ZOD}';\nexport const MemberBody = z.strictObject({ ${shape.memberField ?? 'code'}: z.string() });\nexport const OwnerBody = z.strictObject({ ${shape.ownerField ?? 'name'}: z.string() });\n`,
  manifestImports: `import { route, memberRoute } from '${SDK}';\nimport { MemberBody } from './contract/index.ts';`,
  manifest: `  actions: {\n    routes: [${routeDecl(shape.ownerPath ?? 'GET /v1/alpha')}],\n    memberRoutes: [${(
    shape.memberKeys ?? ['POST /v1/shared/redeem', 'GET /v1/shared/me']
  )
    .map(key => memberRouteDecl(key, key.startsWith('POST') ? ', request: MemberBody' : ''))
    .join(', ')}],\n  },`,
});

const plain: FixturePackage = { id: 'beta' };
/** The generated command registry always carries the Kernel's manifest (§9.6). */
const kernel: FixturePackage = { id: 'kernel', core: true, halves: false };

const hashesOf = async (packages: readonly FixturePackage[]) => {
  const f = fixture(packages, { pending: packages.map(p => p.id) });
  made.push(f);
  return await buildModel(f.root);
};

describe('member-surface hash', () => {
  test('a package with member routes has one, distinct from its effective hash; one without has none', async () => {
    const model = await hashesOf([alpha(), plain]);
    const a = model.hashes.get('alpha');
    expect(a?.member).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.member).not.toBe(a?.effective);
    expect(model.hashes.get('beta')?.member).toBeUndefined();
  });

  test('changing an OWNER route schema or path does not change the member hash (the effective hash moves)', async () => {
    const before = (await hashesOf([alpha(), plain])).hashes.get('alpha');
    const bodyChanged = (await hashesOf([alpha({ ownerField: 'title' }), plain])).hashes.get('alpha');
    const routeMoved = (await hashesOf([alpha({ ownerPath: 'GET /v1/alpha/moved' }), plain])).hashes.get('alpha');
    expect(bodyChanged?.effective).not.toBe(before?.effective);
    expect(bodyChanged?.member).toBe(before?.member as string);
    expect(routeMoved?.effective).not.toBe(before?.effective);
    expect(routeMoved?.member).toBe(before?.member as string);
  });

  test('changing the schema of a member route body, or the member table, changes the member hash', async () => {
    const before = (await hashesOf([alpha(), plain])).hashes.get('alpha');
    const bodyChanged = (await hashesOf([alpha({ memberField: 'token' }), plain])).hashes.get('alpha');
    const routeAdded = (
      await hashesOf([
        alpha({ memberKeys: ['POST /v1/shared/redeem', 'GET /v1/shared/me', 'GET /v1/shared/extra'] }),
        plain,
      ])
    ).hashes.get('alpha');
    expect(bodyChanged?.member).not.toBe(before?.member as string);
    expect(routeAdded?.member).not.toBe(before?.member as string);
  });

  test('deterministic: the same fixture hashes the same, and declaration order is not a change', async () => {
    const first = (await hashesOf([alpha(), plain])).hashes.get('alpha');
    const again = (await hashesOf([alpha(), plain])).hashes.get('alpha');
    const reordered = (
      await hashesOf([alpha({ memberKeys: ['GET /v1/shared/me', 'POST /v1/shared/redeem'] }), plain])
    ).hashes.get('alpha');
    expect(again?.member).toBe(first?.member as string);
    expect(reordered?.member).toBe(first?.member as string);
  });

  test('the generated registry and contract-hashes.json carry the member hash only where there are member routes', async () => {
    const model = await hashesOf([kernel, alpha(), plain]);
    const files = generateGlobal(model);
    const json = JSON.parse(files.get('generated/contract-hashes.json') as string) as {
      hashes: Record<string, { member?: string }>;
    };
    expect(json.hashes['alpha']?.member).toBe(model.hashes.get('alpha')?.member as string);
    expect('member' in (json.hashes['beta'] ?? {})).toBe(false);
    const plugins = files.get('packages/core/kernel/src/generated/plugins.ts') as string;
    expect(plugins).toContain(`member: "${model.hashes.get('alpha')?.member}"`);
  });
});
