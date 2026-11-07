import { afterEach, describe, expect, it } from 'bun:test';
import { createSkillsPanel } from '../../../app/views/skills-panel.tsx';
import { interact } from '@ferretry/app/testing';
import { asView, choose, click, closeAll, pageText, q, settle, show, sleep, typeInto } from './dom-support.tsx';
import {
  ferretInventory,
  installRecord,
  machineInventory,
  previewOf,
  refusal,
  scripted,
  skill,
} from './skills-support.ts';

afterEach(closeAll);

const INVENTORY = 'GET /v1/ferrets/:ferretId/skills/inventory';
const MACHINE = 'GET /v1/skills';
const INSTALLS = 'GET /v1/skill-installs/local';
const PREVIEW = 'POST /v1/skill-installs/local/project/preview';
const INSTALL = 'POST /v1/skill-installs/local/project';

const base = {
  [INVENTORY]: ferretInventory([skill('own')]),
  [MACHINE]: machineInventory(),
  [INSTALLS]: { installs: [] },
};

/** Opens the panel and its + Add skills view; waits for the machine rows unless told the read will fail. */
const open = async (answers: Parameters<typeof scripted>[0], expectRows = true) => {
  const world = scripted({ ...base, ...answers });
  const Panel = asView(createSkillsPanel(world.client));
  await show(<Panel subject="f1" />);
  await settle(() => q('[data-context-add-skills]') !== null, 'the panel');
  await click(q('[data-context-add-skills]'), '+ Add skills');
  if (expectRows) await settle(() => q('[data-add-skills-machine-row]') !== null, 'the machine rows');
  return world;
};

const openSheet = async (): Promise<void> => {
  await click(q('[data-add-skills-machine-install]'), 'Install');
  await settle(() => q('[data-skill-project]') !== null, 'the install sheet');
  await choose(q<HTMLSelectElement>('[data-skill-project]'), '/work/dojo', 'the project picker');
};

const review = async (): Promise<void> => {
  await click(q('[data-local-preview]'), 'Review before installing');
};

describe('DOM tests: + Add skills, from this machine', () => {
  it('lists the machine’s other skills, once each, with where they live', async () => {
    await open({});
    const rows = [...document.querySelectorAll('[data-add-skills-machine-row]')].map(row =>
      row.getAttribute('data-add-skills-machine-row'),
    );
    expect(rows).toEqual(['/home/me/.claude-work/skills/review/SKILL.md', '/work/dojo/.claude/skills/deploy/SKILL.md']);
    expect(pageText()).toContain('claude-work account · Claude');
    expect(pageText()).toContain('project dojo · Claude');
  });

  it('marks a skill copied from here as Installed, with no Install button', async () => {
    await open({ [INSTALLS]: { installs: [installRecord()] } });
    expect(document.querySelectorAll('[data-add-skills-machine-installed]').length).toBe(1);
    expect(document.querySelectorAll('[data-add-skills-machine-install]').length).toBe(1);
  });

  it('narrows by search and says honestly when nothing matches', async () => {
    await open({});
    await typeInto(q<HTMLInputElement>('[data-add-skills] input') as HTMLInputElement, 'zzz');
    await interact(() => sleep(250));
    await settle(() => q('[data-add-skills-machine-none]') !== null, 'the empty line');
    expect(q('[data-add-skills-machine-none]')?.textContent).toBe('No skill on this machine matches that.');
  });

  it('says the machine’s skills could not be read, and Refresh reads them again', async () => {
    let answer: unknown = refusal(500, 'internal', 'boom');
    await open({ [MACHINE]: () => answer }, false);
    await settle(() => q('[data-add-skills-machine-failed]') !== null, 'the failure line');
    answer = machineInventory();
    await click(q('[data-add-skills-refresh]'), 'Refresh');
    await settle(() => q('[data-add-skills-machine-row]') !== null, 'the rows after Refresh');
  });

  it('goes back to the list', async () => {
    await open({});
    await click(q('[data-add-skills-back]'), 'Back');
    await settle(() => q('[data-context-list="skills"]') !== null, 'the list');
  });
});

describe('DOM tests: installing one skill from this machine', () => {
  it('G175 asks to preview exactly the SKILL.md path the inventory listed, for the place and agent chosen', async () => {
    const world = await open({ [PREVIEW]: previewOf() });
    await openSheet();
    expect(q<HTMLButtonElement>('[data-local-preview]')?.disabled).toBe(false);
    await review();
    await settle(() => q('[data-local-confirm]') !== null, 'the review');
    const call = world.calls.find(entry => entry.route === PREVIEW);
    expect(call?.init).toEqual({
      body: {
        source: { path: '/home/me/.claude-work/skills/review/SKILL.md' },
        target: { scope: 'project', projectRoot: '/work/dojo', harness: 'claude-code' },
      },
    });
  });

  it('G175 starts the install at the ferret’s own project and agent, not the source skill’s agent', async () => {
    const world = await open({
      [INVENTORY]: ferretInventory([skill('own')], { harness: 'codex', folder: '/work/dojo/api' }),
      [PREVIEW]: previewOf(),
    });
    await click(q('[data-add-skills-machine-install]'), 'Install');
    await settle(() => q('[data-skill-project]') !== null, 'the install sheet');
    expect(q<HTMLSelectElement>('[data-skill-project]')?.value).toBe('/work/dojo');
    expect(q<HTMLSelectElement>('[data-skill-harness]')?.value).toBe('codex');
    expect(q('[data-local-choice-problem]')).toBeNull();
    await review();
    await settle(() => q('[data-local-confirm]') !== null, 'the review');
    expect(world.calls.find(entry => entry.route === PREVIEW)?.init).toEqual({
      body: {
        source: { path: '/home/me/.claude-work/skills/review/SKILL.md' },
        target: { scope: 'project', projectRoot: '/work/dojo', harness: 'codex' },
      },
    });
  });

  it('G175 writes a hidden character in a machine skill’s name out as a marker, in the list and in the sheet title', async () => {
    const machine = machineInventory();
    await open({
      [MACHINE]: {
        ...machine,
        homes: [
          {
            ...machine.homes[0]!,
            skills: [skill('rev\u202Eiew', { path: '/home/me/.claude-work/skills/review/SKILL.md' })],
          },
        ],
        projects: [],
      },
    });
    expect(pageText()).toContain('rev⟨U+202E⟩iew');
    expect(pageText()).not.toContain('\u202E');
    await click(q('[data-add-skills-machine-install]'), 'Install');
    await settle(() => q('[data-skill-project]') !== null, 'the install sheet');
    expect(pageText()).toContain('Install rev⟨U+202E⟩iew');
    expect(pageText()).not.toContain('\u202E');
  });

  it('asks for the place before it will read anything', async () => {
    // A ferret that works outside every registered project: nothing to pre-select.
    const world = await open({ [INVENTORY]: ferretInventory([skill('own')], { folder: '/somewhere/else' }) });
    await click(q('[data-add-skills-machine-install]'), 'Install');
    await settle(() => q('[data-skill-project]') !== null, 'the install sheet');
    expect(q<HTMLButtonElement>('[data-local-preview]')?.disabled).toBe(true);
    expect(q('[data-local-choice-problem]')?.textContent).toBe('Pick a project.');
    expect(world.calls.some(call => call.route === PREVIEW)).toBe(false);
  });

  it('shows the whole review before anything is written — files, origin, destination, warnings — and no install yet', async () => {
    const world = await open({
      [PREVIEW]: previewOf({
        warnings: [{ code: 'carries-scripts', text: 'run.sh is a script' }],
        skipped: [{ subject: 'big.bin', reason: 'a binary file' }],
        review: [
          { label: 'Skill file SKILL.md', text: '# review\nUse it.', document: true },
          { label: 'Skill file run.sh', text: 'echo‮hi', document: true },
        ],
        replaces: { installId: installRecord().installId },
      }),
    });
    await openSheet();
    await review();
    await settle(() => q('[data-local-confirm]') !== null, 'the review');
    const text = pageText();
    expect(text).toContain('run.sh is a script');
    expect(text).toContain('big.bin: a binary file');
    expect(text).toContain('/work/dojo/.claude/skills/review');
    expect(text).toContain('It replaces the copy you made from this machine before.');
    expect(document.querySelectorAll('[data-review-file]').length).toBe(2);
    // The hidden character is written out and marked, never rendered raw.
    expect(q('[data-hidden-marker]')?.textContent).toBe('⟨U+202E⟩');
    expect(text).not.toContain('‮');
    expect(world.calls.some(call => call.route === INSTALL)).toBe(false);
  });

  it('G174 applies exactly the preview that was reviewed, then says where it was put', async () => {
    const preview = previewOf();
    const world = await open({
      [PREVIEW]: preview,
      [INSTALL]: { install: installRecord(), notes: ['Active in a new ferret.'] },
    });
    await openSheet();
    await review();
    await settle(() => q('[data-local-install]') !== null, 'the Install button');
    await click(q('[data-local-install]'), 'Install');
    await settle(() => q('[data-local-installed]') !== null, 'the installed line');
    expect(world.calls.find(call => call.route === INSTALL)?.init).toEqual({ body: { previewId: preview.previewId } });
    expect(q('[data-local-installed]')?.textContent).toContain('review · copied');
    expect(q('[data-local-destination]')?.textContent).toBe('Put into /work/dojo/.claude/skills/review');
    expect(q('[data-local-note]')?.textContent).toBe('Active in a new ferret.');
  });

  it('G174 a passkey that was not confirmed says nothing was installed and leaves Install to press again', async () => {
    await open({
      [PREVIEW]: previewOf(),
      [INSTALL]: refusal(403, 'grant_step_up_required', 'step up'),
    });
    await openSheet();
    await review();
    await settle(() => q('[data-local-install]') !== null, 'the Install button');
    await click(q('[data-local-install]'), 'Install');
    await settle(() => q('[data-skill-failure]') !== null, 'the failure');
    expect(q('[data-skill-failure]')?.textContent).toContain('Nothing was installed');
    expect(q('[data-local-install]')).not.toBeNull();
    expect(q('[data-local-installed]')).toBeNull();
  });

  it('a source the machine will not copy is a plain refusal with no Install button at all', async () => {
    await open({ [PREVIEW]: refusal(400, 'local_skill_source_invalid', 'a.sh line 3 looks like a password') });
    await openSheet();
    await review();
    await settle(() => q('[data-skill-failure]') !== null, 'the failure');
    expect(q('[data-skill-failure]')?.textContent).toContain('a.sh line 3 looks like a password');
    expect(q('[data-local-install]')).toBeNull();
    expect(q('[data-skill-preview-again]')).toBeNull();
  });

  it('a preview that ran out offers to preview again', async () => {
    await open({ [PREVIEW]: previewOf(), [INSTALL]: refusal(410, 'local_skill_preview_expired', 'gone') });
    await openSheet();
    await review();
    await settle(() => q('[data-local-install]') !== null, 'the Install button');
    await click(q('[data-local-install]'), 'Install');
    await settle(() => q('[data-skill-preview-again]') !== null, 'Preview again');
    expect(q('[data-skill-failure]')?.textContent).toContain('10 minutes');
  });

  it('refreshes the list when a copy landed, so the row says Installed', async () => {
    let installs: readonly unknown[] = [];
    const world = await open({
      [INSTALLS]: () => ({ installs }),
      [PREVIEW]: previewOf(),
      [INSTALL]: { install: installRecord(), notes: [] },
    });
    await openSheet();
    await review();
    await settle(() => q('[data-local-install]') !== null, 'the Install button');
    await click(q('[data-local-install]'), 'Install');
    await settle(() => q('[data-local-done]') !== null, 'Done');
    installs = [installRecord()];
    await click(q('[data-local-done]'), 'Done');
    await settle(() => q('[data-add-skills-machine-installed]') !== null, 'the Installed mark');
    expect(world.calls.filter(call => call.route === MACHINE).length).toBeGreaterThan(1);
  });
});
