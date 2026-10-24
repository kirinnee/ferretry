import { describe, it } from 'bun:test';
import should from 'should';
import {
  MAX_SKILLS_PER_ROOT,
  type SkillDirectoryEntry,
  type SkillFilesPort,
  SkillsInventoryService,
} from '../../../src/lib/skills/inventory.ts';
import { sessionView } from '../runtime/mounts/support.ts';

const FLEET = '/fy/fleet';
const ASSETS = '/fy/fleet/assets';
const HOME_A = '/fy/fleet/homes/a';
const HOME_B = '/fy/fleet/homes/b';

const doc = (name: string): string => `---\nname: ${name}\ndescription: does ${name}\n---\n`;

/** A directory tree held in memory: directory path -> entries, file path -> text. */
class FakeFiles implements SkillFilesPort {
  readonly dirs = new Map<string, SkillDirectoryEntry[]>();
  readonly texts = new Map<string, string>();
  readonly listed: string[] = [];

  skill(directory: string, name: string, linkTarget?: string, text = doc(name)): this {
    const manifest = `${directory}/${name}/SKILL.md`;
    this.dirs.set(directory, [
      ...(this.dirs.get(directory) ?? []),
      { manifest, ...(linkTarget ? { linkTarget } : {}) },
    ]);
    this.texts.set(manifest, text);
    return this;
  }

  async list(directory: string, _confinedTo: string, limit: number): Promise<readonly SkillDirectoryEntry[]> {
    this.listed.push(directory);
    return (this.dirs.get(directory) ?? []).slice(0, limit + 1);
  }

  async read(path: string): Promise<string | undefined> {
    return this.texts.get(path);
  }
}

const homes = [
  { runtimes: ['claude-a'], harness: 'claude' as const, home: HOME_A },
  { runtimes: ['codex-b', 'codex-b-fast'], harness: 'codex' as const, home: HOME_B },
];

function service(files: FakeFiles, projects: { id: string; name: string; path: string }[] = []) {
  return new SkillsInventoryService({
    files,
    homes: async () => homes,
    projects: async () => projects,
    fleetDirectory: FLEET,
    assetsDirectory: ASSETS,
    userHome: '/home/owner',
  });
}

describe('the skills inventory service', () => {
  it('tells a Ferretry component from the home’s own skill by where its link points', async () => {
    const files = new FakeFiles()
      .skill(`${HOME_A}/skills`, 'review', `${ASSETS}/skills/review`)
      .skill(`${HOME_A}/skills`, 'mine');

    const listing = await service(files).machine();

    const skills = listing.homes.find(home => home.home === HOME_A)!.skills;
    should(skills.map(skill => [skill.name, skill.scope])).deepEqual([
      ['mine', 'user'],
      ['review', 'ferretry'],
    ]);
    should(skills[0]!.runtimes).deepEqual(['claude-a']);
    should(skills[0]!.toggle?.supported).equal(false);
  });

  it('lists a registered project under both harnesses’ own directories', async () => {
    const files = new FakeFiles()
      .skill('/work/p/.claude/skills', 'for-claude')
      .skill('/work/p/.agents/skills', 'for-codex')
      .skill('/work/p/.codex/skills', 'ignored');

    const listing = await service(files, [{ id: 'p1', name: 'P', path: '/work/p' }]).machine();

    const project = listing.projects[0]!;
    should(project.skills.map(skill => [skill.name, skill.harness, skill.scope, skill.project])).deepEqual([
      ['for-claude', 'claude', 'project', { id: 'p1', root: '/work/p' }],
      ['for-codex', 'codex', 'project', { id: 'p1', root: '/work/p' }],
    ]);
    should(project.skills.find(skill => skill.harness === 'codex')!.runtimes).deepEqual(['codex-b', 'codex-b-fast']);
  });

  it('shadows a Claude project skill by the home’s skill of the same name, and Codex shadows nothing', async () => {
    const files = new FakeFiles()
      .skill(`${HOME_A}/skills`, 'same')
      .skill('/work/p/.claude/skills', 'same')
      .skill(`${HOME_B}/skills`, 'same')
      .skill('/work/p/.agents/skills', 'same');

    const claude = await service(files).session(
      sessionView('c1', { harness: 'claude', agent: '/fy/fleet/bin/claude-a', cwd: '/work/p' }),
    );
    const codex = await service(files).session(
      sessionView('c2', { harness: 'codex', agent: '/fy/fleet/bin/codex-b', cwd: '/work/p' }),
    );

    should(claude.skills.map(skill => [skill.scope, skill.shadowedBy])).deepEqual([
      ['user', undefined],
      ['project', 'user'],
    ]);
    should(codex.skills.map(skill => [skill.scope, skill.shadowedBy])).deepEqual([
      ['user', undefined],
      ['project', undefined],
    ]);
  });

  it('reads a ferret’s skills from its own runtime home, never the daemon user’s', async () => {
    const files = new FakeFiles()
      .skill(`${HOME_A}/skills`, 'in-ferret-home')
      .skill('/home/owner/.claude/skills', 'owners-own');

    const inventory = await service(files).session(
      sessionView('s1', { harness: 'claude', agent: '/fy/fleet/bin/claude-a', cwd: '/work/none' }),
    );

    should(inventory.skills.map(skill => skill.name)).deepEqual(['in-ferret-home']);
    should(inventory.runtime).equal('claude-a');
    should(inventory.skills[0]!.runtimes).deepEqual(['claude-a']);
    should(files.listed).not.containEql('/home/owner/.claude/skills');
  });

  it('falls back to the daemon’s home only when the session runs no fleet account', async () => {
    const files = new FakeFiles().skill('/home/owner/.codex/skills', 'owners-own');

    const inventory = await service(files).session(
      sessionView('s1', { harness: 'codex', agent: '/usr/bin/not-a-wrapper', cwd: '/work/none' }),
    );

    should(inventory.skills.map(skill => skill.name)).deepEqual(['owners-own']);
    should(inventory.runtime).be.undefined();
  });

  it('skips a manifest without usable front matter', async () => {
    const files = new FakeFiles()
      .skill(`${HOME_A}/skills`, 'good')
      .skill(`${HOME_A}/skills`, 'bad', undefined, 'no front matter');

    const listing = await service(files).machine();

    should(listing.homes[0]!.skills.map(skill => skill.name)).deepEqual(['good']);
  });

  it('caps a directory and says so', async () => {
    const files = new FakeFiles();
    for (let index = 0; index <= MAX_SKILLS_PER_ROOT; index += 1) files.skill(`${HOME_A}/skills`, `s${index}`);

    const listing = await service(files).machine();

    should(listing.homes[0]!.skills).have.length(MAX_SKILLS_PER_ROOT);
    should(listing.truncated).be.true();
  });

  it('serves a SKILL.md only for an exact listed path', async () => {
    const files = new FakeFiles().skill(`${HOME_A}/skills`, 'good');
    const subject = service(files);
    const listed = await subject.machinePaths();

    should(await subject.file(`${HOME_A}/skills/good/SKILL.md`, listed)).equal(doc('good'));
    should(await subject.file(`${HOME_A}/skills/good/../../secret`, listed)).be.undefined();
    should(await subject.file('/etc/passwd', listed)).be.undefined();
  });
});
