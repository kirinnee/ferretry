/**
 * U4b part 4a (catalogs): an install reads a harness through Catalogs' install-harness table and refuses one it has no row
 * for, by name, as a clean 4xx. `fake-third` is a harness key the table has no row for.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import should from 'should';
import {
  installHarnessFacts,
  installHarnessOfKey,
  installHarnesses,
  InstallHarnessSchema,
  isInstallHarness,
  UnsupportedInstallHarnessError,
} from '../../../contract/wire/index.ts';
import { CatalogInstallTargetSchema, CatalogInstallTargetsSchema } from '../../../contract/wire/index.ts';
import { landedSentence, readsPlace, installPlan } from '../../../app/features/add-skills/add-skills-model.ts';
import { placeQuery, readPlace } from '../../../app/lib/add-skills-address.ts';
import { CatalogInstallRefusalError } from '../../../daemon/lib/catalog-installs/ports.ts';
import type { DaemonIdentity } from '../../../daemon/lib/relay-wire/index.ts';
import { catalogsFixture, mcpServer } from '../../support/daemon-host.ts';
import { installRecord } from '../app/support/catalog-views.ts';
import { mcpItem, newIdentity, skillItem } from '../../support/catalog-fixtures.ts';
import { request, rig, runtimeTarget } from './service-support.ts';

const THIRD = 'fake-third';

let alice: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
});

const refusal = async (work: Promise<unknown>): Promise<CatalogInstallRefusalError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof CatalogInstallRefusalError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('the harnesses Catalogs installs into', () => {
  it('should keep exactly the words, names and folders the two shipped harnesses had', () => {
    expect(installHarnesses()).toEqual(['claude', 'codex']);
    expect(installHarnessFacts('claude')).toMatchObject({
      name: 'Claude Code',
      short: 'Claude',
      projectFolder: '.claude',
      readsProjectMcp: true,
      skillsActiveInRunningFerret: true,
    });
    expect(installHarnessFacts('codex')).toMatchObject({
      name: 'Codex',
      short: 'Codex',
      projectFolder: '.agents',
      readsProjectMcp: false,
      skillsActiveInRunningFerret: false,
    });
    expect(installHarnessOfKey('claude-code')).toBe('claude');
    expect(installHarnessOfKey('codex')).toBe('codex');
  });

  it('should have no row for a harness it was never given, nor for a name that only looks like one', () => {
    expect(installHarnessOfKey(THIRD)).toBeUndefined();
    expect(isInstallHarness(THIRD)).toBe(false);
    expect(isInstallHarness('toString')).toBe(false);
    expect(InstallHarnessSchema.safeParse(THIRD).success).toBe(false);
    expect(new UnsupportedInstallHarnessError(THIRD).message).toMatch(/fake-third/u);
  });

  it('should keep a project target on the wire words and refuse any other at the boundary', () => {
    const target = { scope: 'project', projectRoot: '/work', harness: 'codex' };
    expect(CatalogInstallTargetSchema.safeParse(target).success).toBe(true);
    expect(CatalogInstallTargetSchema.safeParse({ ...target, harness: THIRD }).success).toBe(false);
  });
});

describe('an install into a runtime on a harness Catalogs has no row for', () => {
  it('should be refused by name, whatever harness the item says, and never installed as Claude', async () => {
    const r = rig();
    for (const item of [
      skillItem(alice.daemonId, { harness: 'generic' }),
      skillItem(alice.daemonId),
      skillItem(alice.daemonId, { harness: 'claude' }),
    ]) {
      const error = await refusal(
        r.service.preview('runtime', await request(alice, item, runtimeTarget('third-work'))),
      );
      should(error.code).equal('catalog_not_installable');
      should(error.message).match(/fake-third/u);
    }
    const server = await refusal(
      r.service.preview('runtime', await request(alice, mcpItem(alice.daemonId), runtimeTarget('third-work'))),
    );
    should(server.code).equal('catalog_not_installable');
  });

  it('should still install into the runtimes of the two shipped harnesses', async () => {
    const r = rig();
    await r.service.preview('runtime', await request(alice, skillItem(alice.daemonId), runtimeTarget('claude-work')));
    await r.service.preview(
      'runtime',
      await request(alice, skillItem(alice.daemonId, { harness: 'codex' }), runtimeTarget('codex-work')),
    );
  });

  it('should be listed on the targets route by its own key, so the person sees why it is refused', async () => {
    // Arrange
    const fx = await catalogsFixture({
      mcp: [mcpServer('docs')],
      runtimes: [{ id: 'third', name: 'third', profile: 'default', harness: THIRD }],
    });

    // Act
    const answered = await fx.host.request('GET', '/v1/catalog-installs/targets');

    // Assert
    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({ runtimes: [{ id: 'third', name: 'third', profile: 'default', harness: THIRD }] });
    expect(CatalogInstallTargetsSchema.safeParse(answered.json()).success).toBe(true);
  });
});

describe('the Add skills page for a ferret on a harness Catalogs has no row for', () => {
  const installAt = (target: unknown) => ({ ...installRecord('skill', 'pdf-tools'), target }) as never;
  const projects = [{ name: 'app', path: '/work/app' }];

  it('should not guess Claude from a place that names no known harness: it is unknown', () => {
    const props = { ferret: 'f', folder: '/work/app', scopes: [] as string[] };
    expect(readPlace(placeQuery({ ...props, harness: 'codex' })).harness).toBe('codex');
    expect(readPlace(placeQuery({ ...props, harness: 'claude-code' })).harness).toBe('claude');
    expect(readPlace(`?folder=/work/app&harness=${THIRD}`).harness).toBe('unknown');
    expect(readPlace('').harness).toBeUndefined();
  });

  it('should leave the agent to be picked, and say nothing about when the skill becomes active', () => {
    const place = { cwd: '/work/app', harness: undefined, runtime: undefined };
    const plan = installPlan(place, projects, []);
    expect(plan.scope).toBe('project');
    expect(plan.draft).toEqual({ scope: 'project', projectRoot: '/work/app' });
    const install = installAt({ scope: 'project', projectRoot: '/work/app', harness: 'claude' });
    expect(readsPlace(install, plan, undefined)).toBe(false);
    expect(landedSentence(install, plan, [], undefined)).toMatch(/does not read that place/u);
    const runtime = installAt({ scope: 'runtime', runtime: 'r1', profile: 'p' });
    const runtimePlan = installPlan({ ...place, cwd: '/elsewhere', runtime: 'box' }, projects, [
      { id: 'r1', wrapper: 'box', profile: 'p', harness: 'claude-code' },
    ]);
    expect(landedSentence(runtime, runtimePlan, [], undefined)).toBe(`Installed pdf-tools in ${runtimePlan.sentence}.`);
  });

  it('should say when each shipped harness picks the skill up, as it did', () => {
    const place = { cwd: '/work/app', harness: 'claude' as const, runtime: undefined };
    const plan = installPlan(place, projects, []);
    const install = installAt({ scope: 'project', projectRoot: '/work/app', harness: 'claude' });
    expect(landedSentence(install, plan, ['project'], 'claude')).toMatch(/active in this ferret now/u);
    expect(landedSentence(install, plan, [], 'claude')).toMatch(/\/reload-skills/u);
    const codex = installAt({ scope: 'project', projectRoot: '/work/app', harness: 'codex' });
    const codexPlan = installPlan({ ...place, harness: 'codex' }, projects, []);
    expect(landedSentence(codex, codexPlan, [], 'codex')).toMatch(/next ferret you start/u);
  });
});
