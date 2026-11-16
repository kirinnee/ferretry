import { afterEach, describe, expect, it } from 'bun:test';
import { FerretWorkspaceActionsProvider } from '@ferretry/app';
import { createSkillReference, proveSkill } from '../../../app/views/skill-reference.tsx';
import { createSkillsSettings } from '../../../app/views/skills-settings.tsx';
import { asView, click, closeAll, pageText, q, settle, show } from './dom-support.tsx';
import { machineInventory, refusal, scripted, skill } from './skills-support.ts';

afterEach(closeAll);

const MACHINE = 'GET /v1/skills';
const FILE = 'GET /v1/skills/file';
const FERRET_SKILLS = 'GET /v1/ferrets/:ferretId/skills';

describe('DOM tests: Settings › Skills', () => {
  it('lists every account and project on the machine, with Open', async () => {
    const { client } = scripted({ [MACHINE]: machineInventory() });
    const Settings = asView(createSkillsSettings(client));
    await show(<Settings />);
    await settle(() => q('[data-settings="skills"]') !== null, 'the tab');
    expect(
      [...document.querySelectorAll('[data-skills-group]')].map(node => node.getAttribute('data-skills-group')),
    ).toEqual(['claude-work account', 'Project dojo']);
    expect(document.querySelectorAll('[data-skills-open]').length).toBe(2);
  });

  it('opens a listed skill’s SKILL.md by its listed path, machine-wide', async () => {
    const { client, calls } = scripted({
      [MACHINE]: machineInventory(),
      [FILE]: (init: unknown) => ({ path: (init as { query: { path: string } }).query.path, content: '# Deploy it' }),
    });
    const Settings = asView(createSkillsSettings(client));
    await show(<Settings />);
    await settle(() => q('[data-skills-open]') !== null, 'Open');
    await click(document.querySelectorAll('[data-skills-open]')[1] ?? null, 'Open deploy');
    await settle(() => pageText().includes('Deploy it'), 'the SKILL.md');
    expect(calls.at(-1)?.init).toEqual({ query: { path: '/work/dojo/.claude/skills/deploy/SKILL.md' } });
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

  describe('inside a ferret workspace', () => {
    const inWorkspace = (
      shown: string[],
      daemon: string,
      ferret: string,
      reference: Record<string, string>,
      client: typeof proved.client,
    ) => {
      const Reference = asView(createSkillReference(client, '/'));
      return (
        <FerretWorkspaceActionsProvider
          canControl
          daemon={daemon}
          ferret={ferret}
          showPanel={panel => shown.push(panel)}
        >
          <Reference value={{ name: '/deploy', ...reference }} />
        </FerretWorkspaceActionsProvider>
      );
    };
    const clickLink = async () => {
      await settle(() => q('a') !== null, 'the link');
      await click(q('a'), 'the link');
    };

    it('brings the Skills panel on screen when the reference names this workspace’s daemon', async () => {
      const shown: string[] = [];
      await show(inWorkspace(shown, 'studio', 'f1', { daemon: 'studio' }, proved.client));
      await clickLink();
      expect(shown).toEqual(['skills']);
      expect(q('a')?.getAttribute('title')).toBe('Show the /deploy skill in the Skills panel');
      expect(q('a')?.getAttribute('href')).toBe('/d/studio/settings/skills');
    });

    it('does the same for a reference written in this workspace’s own ferret', async () => {
      const shown: string[] = [];
      const world = scripted({
        [FERRET_SKILLS]: {
          harness: 'claude-code',
          skills: [{ name: 'deploy', description: 'd', scope: 'global', origin: 'both' }],
        },
      });
      await show(inWorkspace(shown, 'studio', 'f1', { daemon: 'studio', ferretId: 'f1' }, world.client));
      await clickLink();
      expect(shown).toEqual(['skills']);
    });

    it('keeps the Settings link for another daemon, and for a reference written in another ferret', async () => {
      const shown: string[] = [];
      await show(inWorkspace(shown, 'other', 'f1', { daemon: 'studio' }, proved.client));
      await clickLink();
      expect(shown).toEqual([]);
      expect(q('a')?.getAttribute('title')).toBe('Open the /deploy skill in Settings › Skills');
      await closeAll();
      const world = scripted({
        [FERRET_SKILLS]: {
          harness: 'claude-code',
          skills: [{ name: 'deploy', description: 'd', scope: 'global', origin: 'both' }],
        },
      });
      await show(inWorkspace(shown, 'studio', 'f1', { daemon: 'studio', ferretId: 'f2' }, world.client));
      await clickLink();
      expect(shown).toEqual([]);
    });
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
