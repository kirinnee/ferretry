import { describe, it } from 'bun:test';
import should from 'should';
import {
  MAX_SKILLS_PER_ROOT,
  type SkillDirectoryEntry,
  type SkillFilesPort,
  SkillsInventoryService,
} from '../../daemon/lib/inventory.ts';

const ASSETS = '/fy/fleet/assets/skills';
const HOME_A = '/fy/fleet/homes/a';
const HOME_B = '/fy/fleet/homes/b';

const doc = (name: string): string => `---\nname: ${name}\ndescription: does ${name}\n---\n`;

/** A directory tree held in memory: directory path -> entries, file path -> text. */
class FakeFiles implements SkillFilesPort {
  readonly dirs = new Map<string, SkillDirectoryEntry[]>();
  readonly texts = new Map<string, string>();
  readonly listed: string[] = [];

  skill(directory: string, name: string, managed = false, text = doc(name)): this {
    const manifest = `${directory}/${name}/SKILL.md`;
    this.dirs.set(directory, [...(this.dirs.get(directory) ?? []), { manifest, ...(managed ? { managed } : {}) }]);
    this.texts.set(manifest, text);
    return this;
  }

  async list(directory: string, limit: number): Promise<readonly SkillDirectoryEntry[]> {
    this.listed.push(directory);
    return (this.dirs.get(directory) ?? []).slice(0, limit + 1);
  }

  async read(path: string): Promise<string | undefined> {
    return this.texts.get(path);
  }
}

const homes = [
  { runtimes: ['claude-a'], harness: 'claude-code' as const, home: HOME_A },
  { runtimes: ['codex-b', 'codex-b-fast'], harness: 'codex' as const, home: HOME_B },
];

function service(
  files: FakeFiles,
  projects: { id: string; name: string; path: string }[] = [],
  extra: {
    ferretry?: () => Promise<readonly SkillDirectoryEntry[]>;
    selected?: (runtime: string) => Promise<readonly SkillDirectoryEntry[]>;
  } = {},
) {
  return new SkillsInventoryService({ files, homes: async () => homes, projects: async () => projects, ...extra });
}

describe('the skills inventory service', () => {
  it('R-0197 the machine view is every account home plus every registered project', async () => {
    const files = new FakeFiles()
      .skill(`${HOME_A}/skills`, 'review', true)
      .skill(`${HOME_A}/skills`, 'mine')
      .skill('/work/p/.claude/skills', 'proj');

    const listing = await service(files, [{ id: 'p1', name: 'P', path: '/work/p' }]).machine();

    const skills = listing.homes.find(home => home.home === HOME_A)!.skills;
    should(skills.map(skill => [skill.name, skill.scope])).deepEqual([
      ['mine', 'user'],
      ['review', 'ferretry'],
    ]);
    should(skills[0]!.runtimes).deepEqual(['claude-a']);
    should(skills[0]!.toggle?.supported).equal(false);
    should(listing.homes.map(home => home.runtime)).deepEqual(['claude-a', 'codex-b']);
    should(listing.projects.map(project => [project.id, project.name, project.root])).deepEqual([
      ['p1', 'P', '/work/p'],
    ]);
  });

  it('R-0197 lists a registered project under both harnesses’ own directories', async () => {
    const files = new FakeFiles()
      .skill('/work/p/.claude/skills', 'for-claude')
      .skill('/work/p/.agents/skills', 'for-codex')
      .skill('/work/p/.codex/skills', 'ignored');

    const listing = await service(files, [{ id: 'p1', name: 'P', path: '/work/p' }]).machine();

    const project = listing.projects[0]!;
    should(project.skills.map(skill => [skill.name, skill.harness, skill.scope, skill.project])).deepEqual([
      ['for-claude', 'claude-code', 'project', { id: 'p1', root: '/work/p' }],
      ['for-codex', 'codex', 'project', { id: 'p1', root: '/work/p' }],
    ]);
    should(project.skills.find(skill => skill.harness === 'codex')!.runtimes).deepEqual(['codex-b', 'codex-b-fast']);
  });

  it('R-0175 a Claude ferret’s project skill is shadowed by the home skill of the same name', async () => {
    const files = new FakeFiles().skill(`${HOME_A}/skills`, 'same').skill('/work/p/.claude/skills', 'same');

    const claude = await service(files).ferret({
      id: 'c1',
      harness: 'claude-code',
      runtime: 'claude-a',
      folder: '/work/p',
    });

    should(claude.skills.map(skill => [skill.scope, skill.shadowedBy])).deepEqual([
      ['user', undefined],
      ['project', 'user'],
    ]);
  });

  it('R-0176 a Codex ferret marks neither skill, and reads the project’s .agents/skills folder', async () => {
    const files = new FakeFiles()
      .skill(`${HOME_B}/skills`, 'same')
      .skill('/work/p/.agents/skills', 'same')
      .skill('/work/p/.claude/skills', 'claude-only');

    const codex = await service(files).ferret({ id: 'c2', harness: 'codex', runtime: 'codex-b', folder: '/work/p' });

    should(codex.skills.map(skill => [skill.name, skill.scope, skill.shadowedBy])).deepEqual([
      ['same', 'user', undefined],
      ['same', 'project', undefined],
    ]);
    should(codex.skills[1]!.path).equal('/work/p/.agents/skills/same/SKILL.md');
    should(files.listed).containEql('/work/p/.agents/skills');
    should(files.listed).not.containEql('/work/p/.claude/skills');
  });

  it('reads a ferret’s skills from its own runtime home, never the daemon user’s', async () => {
    const files = new FakeFiles()
      .skill(`${HOME_A}/skills`, 'in-ferret-home')
      .skill('/home/owner/.claude/skills', 'owners-own');

    const inventory = await service(files).ferret({
      id: 's1',
      harness: 'claude-code',
      runtime: 'claude-a',
      folder: '/work/none',
    });

    should(inventory.skills.map(skill => skill.name)).deepEqual(['in-ferret-home']);
    should(inventory.runtime).equal('claude-a');
    should(inventory.skills[0]!.runtimes).deepEqual(['claude-a']);
    should(files.listed).not.containEql('/home/owner/.claude/skills');
  });

  it('a ferret that runs no published account lists its project skills and nothing from any home', async () => {
    const files = new FakeFiles()
      .skill('/home/owner/.codex/skills', 'owners-own')
      .skill('/work/none/.agents/skills', 'proj');

    const inventory = await service(files).ferret({
      id: 's1',
      harness: 'codex',
      runtime: 'not-a-wrapper',
      folder: '/work/none',
    });

    should(inventory.skills.map(skill => [skill.name, skill.scope])).deepEqual([['proj', 'project']]);
    should(inventory.runtime).be.undefined();
    should(files.listed).deepEqual(['/work/none/.agents/skills']);
  });

  it('U11 lists the v4-installed skills straight from the asset tree, once, and a home link to one is not a second', async () => {
    const files = new FakeFiles()
      .skill(`${HOME_A}/skills`, 'review', true)
      .skill(`${HOME_A}/skills`, 'mine')
      .skill(ASSETS, 'review')
      .skill(ASSETS, 'extra');
    const asset = async () => [
      { manifest: `${ASSETS}/review/SKILL.md`, managed: true },
      { manifest: `${ASSETS}/extra/SKILL.md`, managed: true },
    ];

    const listing = await service(files, [], { ferretry: asset }).machine();

    const skills = listing.homes.find(home => home.home === HOME_A)!.skills;
    should(skills.map(skill => [skill.name, skill.scope, skill.path])).deepEqual([
      ['extra', 'ferretry', `${ASSETS}/extra/SKILL.md`],
      ['mine', 'user', `${HOME_A}/skills/mine/SKILL.md`],
      ['review', 'ferretry', `${HOME_A}/skills/review/SKILL.md`],
    ]);
    should(skills.find(skill => skill.name === 'extra')!.toggle?.supported).equal(false);
  });

  it('a skill item the runtime’s profile selects is listed as Ferretry’s, and an unnamed runtime selects none', async () => {
    const files = new FakeFiles().skill('/store', 'chosen');
    const asked: string[] = [];
    const selected = async (runtime: string) => {
      asked.push(runtime);
      return [{ manifest: '/store/chosen/SKILL.md', managed: true }];
    };

    const inventory = await service(files, [], { selected }).ferret({
      id: 's1',
      harness: 'claude-code',
      runtime: 'claude-a',
      folder: '/work/none',
    });
    const without = await service(files, [], { selected }).ferret({ id: 's2', harness: 'claude-code', folder: '/w' });

    should(inventory.skills.map(skill => [skill.name, skill.scope])).deepEqual([['chosen', 'ferretry']]);
    should(without.skills).deepEqual([]);
    should(asked).deepEqual(['claude-a']);
  });

  it('skips a manifest without usable front matter', async () => {
    const files = new FakeFiles()
      .skill(`${HOME_A}/skills`, 'good')
      .skill(`${HOME_A}/skills`, 'bad', false, 'no front matter');

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

  it('G175 serves a SKILL.md only for an exact listed path', async () => {
    const files = new FakeFiles().skill(`${HOME_A}/skills`, 'good');
    const subject = service(files);
    const listed = await subject.machinePaths();

    should(await subject.file(`${HOME_A}/skills/good/SKILL.md`, listed)).equal(doc('good'));
    should(await subject.file(`${HOME_A}/skills/good/../../secret`, listed)).be.undefined();
    should(await subject.file('/etc/passwd', listed)).be.undefined();
  });
});
