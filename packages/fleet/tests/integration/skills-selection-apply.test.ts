/**
 * Per-item skills, end to end: the plan builder deciding and the real provisioner writing.
 *
 * The properties per-item selection exists for are properties of the *account home after an apply*, and
 * a pure plan assertion cannot see them. Two of them only appear on the SECOND apply — an edit to a
 * store item reaching every account that selected it, and an item dropped from a selection leaving the
 * home — so each is proved by applying twice against a real filesystem rather than by reading the plan.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import { FleetPlan } from '../../src/lib/plan.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';

const ID_ONE = '00000000-0000-4000-8000-0000000000d1';
const ID_TWO = '00000000-0000-4000-8000-0000000000d2';
const GENERATED_AT = '2027-05-06T07:08:09.000Z';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-skills-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const layoutIn = (root: string): FleetLayout => ({
  stateHome: root,
  userHome: path.join(root, 'user'),
  fleetDirectory: path.join(root, 'fleet'),
  binDirectory: path.join(root, 'fleet', 'bin'),
  homesDirectory: path.join(root, 'fleet', 'homes'),
  assetsDirectory: path.join(root, 'fleet', 'assets'),
  manifestPath: path.join(root, 'fleet', 'manifest.json'),
  defaultHomeDirectories: { claude: path.join(root, 'default-claude'), codex: path.join(root, 'default-codex') },
});

const route = (id: string, wrapper: string, skills: readonly string[]): Record<string, unknown> => ({
  id,
  wrapper,
  home: wrapper,
  defaultModel: 'model-one',
  models: ['model-one'],
  layer: { skills },
});

/** Two Claude accounts, each with its own selection out of one store. */
const fleetOf = (first: readonly string[], second: readonly string[]): FleetConfig =>
  FleetConfigSchema.parse({
    shared: { skills: { review: 'skills/review', deploy: 'skills/deploy', research: 'skills/research' } },
    variants: { default: {} },
    agents: [
      { name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one', first) } },
      { name: 'two', kind: 'claude', routes: { default: route(ID_TWO, 'claude-two', second) } },
    ],
  });

/** The store on disk: one directory per item, each holding the one document that is the skill. */
const writeStore = async (root: string, review: string): Promise<void> => {
  const skills = path.join(root, 'fleet', 'assets', 'skills');
  await Bun.write(path.join(skills, 'review', 'SKILL.md'), review);
  await Bun.write(path.join(skills, 'deploy', 'SKILL.md'), '# Deploy\n');
  await Bun.write(path.join(skills, 'research', 'SKILL.md'), '# Research\n');
};

const itemsIn = async (root: string, wrapper: string): Promise<readonly string[]> =>
  (await readdir(path.join(root, 'fleet', 'homes', wrapper, 'skills'))).toSorted();

const skillTextIn = async (root: string, wrapper: string, item: string): Promise<string> =>
  await readFile(path.join(root, 'fleet', 'homes', wrapper, 'skills', item, 'SKILL.md'), 'utf8');

describe('applying a per-item skills selection', () => {
  it('should give each account exactly its own items, and let two accounts select one item', async () => {
    // Arrange
    const root = await temporaryDirectory();
    await writeStore(root, '# Review\n');
    const subject = new FileFleetProvisioner([root]);
    const plan = new FleetPlan().build(
      fleetOf(['skills/review', 'skills/deploy'], ['skills/review', 'skills/research']),
      layoutIn(root),
      GENERATED_AT,
    );

    // Act
    await subject.apply(plan);

    // Assert — one store item, two homes; and neither home holds the other's extra item.
    should(await itemsIn(root, 'claude-one')).deepEqual(['deploy', 'review']);
    should(await itemsIn(root, 'claude-two')).deepEqual(['research', 'review']);
    should(await skillTextIn(root, 'claude-one', 'review')).equal('# Review\n');
    should(await skillTextIn(root, 'claude-two', 'review')).equal('# Review\n');
  });

  it('should carry an edit to a store item into every account that selected it, on the next apply', async () => {
    // Arrange — both accounts are on `review`; only its source is edited between the two applies.
    const root = await temporaryDirectory();
    await writeStore(root, '# Review\n');
    const subject = new FileFleetProvisioner([root]);
    const config = fleetOf(['skills/review', 'skills/deploy'], ['skills/review']);
    const layout = layoutIn(root);
    await subject.apply(new FleetPlan().build(config, layout, GENERATED_AT));

    // Act
    await Bun.write(path.join(root, 'fleet', 'assets', 'skills', 'review', 'SKILL.md'), '# Review, revised\n');
    await subject.apply(new FleetPlan().build(config, layout, GENERATED_AT));

    // Assert — edit once, and every linking account has it. Nothing else in either home moved.
    should(await skillTextIn(root, 'claude-one', 'review')).equal('# Review, revised\n');
    should(await skillTextIn(root, 'claude-two', 'review')).equal('# Review, revised\n');
    should(await skillTextIn(root, 'claude-one', 'deploy')).equal('# Deploy\n');
  });

  it('should remove an item dropped from a selection rather than leave the account still holding it', async () => {
    // Arrange
    const root = await temporaryDirectory();
    await writeStore(root, '# Review\n');
    const subject = new FileFleetProvisioner([root]);
    const layout = layoutIn(root);
    await subject.apply(
      new FleetPlan().build(fleetOf(['skills/review', 'skills/deploy'], ['skills/review']), layout, GENERATED_AT),
    );

    // Act — the same fleet with `deploy` dropped from the first account's selection.
    await subject.apply(new FleetPlan().build(fleetOf(['skills/review'], ['skills/review']), layout, GENERATED_AT));

    // Assert — a skill executes code, so an item the account was told to give up must not survive the
    // apply that dropped it. The store itself is untouched.
    should(await itemsIn(root, 'claude-one')).deepEqual(['review']);
    should(await readdir(path.join(root, 'fleet', 'assets', 'skills'))).containEql('deploy');
  });

  it('should empty the directory of an account that selects nothing', async () => {
    // Arrange
    const root = await temporaryDirectory();
    await writeStore(root, '# Review\n');
    const subject = new FileFleetProvisioner([root]);
    const layout = layoutIn(root);
    await subject.apply(new FleetPlan().build(fleetOf(['skills/review'], ['skills/review']), layout, GENERATED_AT));

    // Act
    await subject.apply(new FleetPlan().build(fleetOf([], ['skills/review']), layout, GENERATED_AT));

    // Assert
    should(await itemsIn(root, 'claude-one')).deepEqual([]);
    should(await itemsIn(root, 'claude-two')).deepEqual(['review']);
  });

  it('should leave the mutation machinery own entries alone while sweeping', async () => {
    // Arrange — a backup name sitting in the skills directory is the only copy of what a rollback in
    // this very batch would need to put back, so the sweep must step over it.
    const root = await temporaryDirectory();
    await writeStore(root, '# Review\n');
    const subject = new FileFleetProvisioner([root]);
    const layout = layoutIn(root);
    await subject.apply(new FleetPlan().build(fleetOf(['skills/review'], ['skills/review']), layout, GENERATED_AT));
    const reserved = path.join(root, 'fleet', 'homes', 'claude-one', 'skills', '.fy-fleet-backup-keepme');
    await Bun.write(reserved, 'evidence\n');

    // Act
    await subject.apply(new FleetPlan().build(fleetOf([], ['skills/review']), layout, GENERATED_AT));

    // Assert
    should(await itemsIn(root, 'claude-one')).deepEqual(['.fy-fleet-backup-keepme']);
  });

  it('should sweep nothing when the directory it is bounded to does not exist', async () => {
    // Arrange — a bare sweep with no directory operation before it, which is the only way to reach the
    // case the plan builder itself never produces.
    const root = await temporaryDirectory();
    const subject = new FileFleetProvisioner([root]);
    const plan = new FleetPlan().build(fleetOf(['skills/review'], ['skills/review']), layoutIn(root), GENERATED_AT);
    const sweep = plan.operations.filter(operation => operation.kind === 'prune-directory').slice(0, 1);

    // Act / Assert — nothing to read is not a failure; there is simply nothing there to remove.
    await subject
      .apply({ manifest: plan.manifest, manifestPath: plan.manifestPath, operations: sweep })
      .should.be.fulfilled();
  });

  it('should refuse the whole apply when a selected item is missing from the store', async () => {
    // Arrange — the store has no `skills/absent`, and nothing has been written yet.
    const root = await temporaryDirectory();
    await writeStore(root, '# Review\n');
    const subject = new FileFleetProvisioner([root]);
    const layout = layoutIn(root);
    const plan = new FleetPlan().build(fleetOf(['skills/absent'], ['skills/review']), layout, GENERATED_AT);

    // Act / Assert — refused during preflight, so the host is exactly as it was.
    await subject.apply(plan).should.be.rejected();
    should(await readdir(path.join(root, 'fleet', 'homes')).catch(() => [])).deepEqual([]);
  });
});
