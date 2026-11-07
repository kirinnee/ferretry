import { afterEach, describe, expect, it } from 'bun:test';
import { createSkillReference, proveSkill } from '../../../app/views/skill-reference.tsx';
import { createSkillsSettings } from '../../../app/views/skills-settings.tsx';
import { asView, click, closeAll, pageText, q, settle, show } from './dom-support.tsx';
import { installRecord, machineInventory, refusal, scripted, skill } from './skills-support.ts';

afterEach(closeAll);

const MACHINE = 'GET /v1/skills';
const FILE = 'GET /v1/skills/file';
const INSTALLS = 'GET /v1/skill-installs/local';
const FERRET_SKILLS = 'GET /v1/ferrets/:ferretId/skills';
const REMOVE_PROJECT = 'DELETE /v1/skill-installs/local/project/:installId';

describe('DOM tests: Settings › Skills', () => {
  it('lists every account and project on the machine, with Open, and the copies made from it', async () => {
    const { client } = scripted({ [MACHINE]: machineInventory(), [INSTALLS]: { installs: [installRecord()] } });
    const Settings = asView(createSkillsSettings(client));
    await show(<Settings />);
    await settle(() => q('[data-settings="skills"]') !== null, 'the tab');
    expect(
      [...document.querySelectorAll('[data-skills-group]')].map(node => node.getAttribute('data-skills-group')),
    ).toEqual(['claude-work account', 'Project dojo']);
    expect(document.querySelectorAll('[data-skills-open]').length).toBe(2);
    expect(q('[data-skills-install]')?.textContent).toContain('review · /work/dojo/.claude/skills/review');
  });

  it('opens a listed skill’s SKILL.md by its listed path, machine-wide', async () => {
    const { client, calls } = scripted({
      [MACHINE]: machineInventory(),
      [INSTALLS]: { installs: [] },
      [FILE]: (init: unknown) => ({ path: (init as { query: { path: string } }).query.path, content: '# Deploy it' }),
    });
    const Settings = asView(createSkillsSettings(client));
    await show(<Settings />);
    await settle(() => q('[data-skills-open]') !== null, 'Open');
    await click(document.querySelectorAll('[data-skills-open]')[1] ?? null, 'Open deploy');
    await settle(() => pageText().includes('Deploy it'), 'the SKILL.md');
    expect(calls.at(-1)?.init).toEqual({ query: { path: '/work/dojo/.claude/skills/deploy/SKILL.md' } });
  });

  it('G173 removes a copy through the route of its scope, then reads the copies again', async () => {
    let installs = [installRecord()];
    const { client, calls } = scripted({
      [MACHINE]: machineInventory(),
      [INSTALLS]: () => ({ installs }),
      [REMOVE_PROJECT]: () => {
        installs = [];
        return { installId: installRecord().installId, name: 'review', destination: '/d' };
      },
    });
    const Settings = asView(createSkillsSettings(client));
    await show(<Settings />);
    await settle(() => q('[data-skills-install-remove]') !== null, 'Remove');
    await click(q('[data-skills-install-remove]'), 'Remove');
    await settle(() => q('[data-skills-installs-none]') !== null, 'the empty copies line');
    expect(calls.find(call => call.route === REMOVE_PROJECT)?.init).toEqual({
      params: { installId: installRecord().installId },
    });
  });

  it('says a refused removal in the machine’s words and keeps the copy listed', async () => {
    const { client } = scripted({
      [MACHINE]: machineInventory(),
      [INSTALLS]: { installs: [installRecord()] },
      [REMOVE_PROJECT]: refusal(409, 'local_skill_conflict', 'SKILL.md was edited here'),
    });
    const Settings = asView(createSkillsSettings(client));
    await show(<Settings />);
    await settle(() => q('[data-skills-install-remove]') !== null, 'Remove');
    await click(q('[data-skills-install-remove]'), 'Remove');
    await settle(() => q('[data-skill-failure]') !== null, 'the refusal');
    expect(q('[data-skill-failure]')?.textContent).toContain('SKILL.md was edited here');
    expect(q('[data-skills-install]')).not.toBeNull();
  });

  it('says a failed read in plain words', async () => {
    const { client } = scripted({ [MACHINE]: refusal(500, 'internal', 'did not answer in time') });
    const Settings = asView(createSkillsSettings(client));
    await show(<Settings />);
    await settle(() => q('[data-context-failed]') !== null, 'the failure');
    expect(q('[data-context-failed]')?.textContent).toContain('This machine isn’t answering right now');
  });
});

describe('DOM tests: a /name or $name reference', () => {
  const proved = scripted({
    [MACHINE]: machineInventory({ projects: [{ name: 'dojo', root: '/w', skills: [skill('deploy')] }] }),
  });

  it('proves a skill before it links, and links to Settings › Skills on the daemon it was written in', async () => {
    const Reference = asView(createSkillReference(proved.client, '/'));
    await show(<Reference value={{ name: '/deploy', daemon: 'studio' }} />);
    await settle(() => q('a') !== null, 'the link');
    expect(q('a')?.textContent).toBe('/deploy');
    expect(q('a')?.getAttribute('href')).toBe('/d/studio/settings/skills');
  });

  it('is plain text while it is still being asked, and for a name the daemon does not list', async () => {
    const Reference = asView(createSkillReference(proved.client, '$'));
    await show(<Reference value={{ name: '/nothere', daemon: 'studio' }} />);
    await settle(() => proved.calls.length > 0, 'the proof read');
    expect(q('a')).toBeNull();
    expect(pageText()).toBe('$nothere');
  });

  it('proves against the ferret it was written in when the value names one', async () => {
    const world = scripted({
      [FERRET_SKILLS]: {
        harness: 'claude-code',
        skills: [{ name: 'review', description: 'd', scope: 'global', origin: 'both' }],
      },
    });
    expect(await proveSkill(world.client, 'review', 'f1')).toBe(true);
    expect(await proveSkill(world.client, 'deploy', 'f1')).toBe(false);
    expect(world.calls[0]?.init).toEqual({ params: { ferretId: 'f1' } });
  });

  it('leaves a token unproved when the daemon refuses the read, so a caller without standing gets prose', async () => {
    const world = scripted({ [MACHINE]: refusal(403, 'forbidden', 'no grant') });
    expect(await proveSkill(world.client, 'deploy', undefined)).toBe(false);
  });

  it('never asks about a word the grammar does not read as a skill', async () => {
    const world = scripted({});
    const Reference = asView(createSkillReference(world.client, '$'));
    await show(<Reference value="$HOME" />);
    expect(pageText()).toBe('$HOME');
    expect(world.calls).toEqual([]);
  });

  it('is plain text, though proved, when the value names no daemon to address', async () => {
    const world = scripted({ [MACHINE]: machineInventory() });
    const Reference = asView(createSkillReference(world.client, '/'));
    await show(<Reference value="/review" />);
    await settle(() => world.calls.length > 0, 'the proof read');
    expect(q('a')).toBeNull();
    expect(pageText()).toBe('/review');
  });
});
