import { beforeEach, describe, expect, it } from 'bun:test';
import { CLAUDE_LIVE, CODEX_NEXT, NOT_HERE } from '../../../../src/features/context-rail/add-skills-model.ts';
import { AddSkillsPage, type AddSkillsPageProps } from '../../../../src/features/context-rail/add-skills-page.tsx';
import {
  CHECK_AGAIN,
  MACHINE_TRUNCATED,
  MACHINE_UNREADABLE,
  NO_MACHINE_MATCH,
  NO_MACHINE_SKILLS,
  READING_MACHINE,
  REVIEW_BEFORE_INSTALLING,
} from '../../../../src/features/context-rail/machine-skills-model.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { crypto } from '../../../support/catalog-files.ts';
import { interact, mount } from '../../../support/dom.ts';
import { click, settle, typeInto } from '../../../support/dom-form.ts';
import {
  CREDENTIAL_SENTENCE,
  localInstall,
  localInstalled,
  localPreview,
  MACHINE,
  OTHER_INSTALL_ID,
  PDF_PATH,
  refusal,
  runtimePreview,
  WARNED_PREVIEW,
} from '../../../support/local-skills.ts';
import { deferred, fakeMembers } from '../../../support/shared-screens.ts';
import { SKILLS } from './context-rail-fixtures.ts';

beforeEach(() => {
  document.body.replaceChildren();
});

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const all = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)];
const text = (): string => document.body.textContent ?? '';
const machineRows = () => all('[data-add-skills-machine-row]');
const pick = async (selector: string, value: string): Promise<void> => {
  const select = q(selector) as HTMLSelectElement;
  select.value = value;
  await interact(() => select.dispatchEvent(new Event('change', { bubbles: true })));
};

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const PROJECTS = [{ name: 'app', path: '/work/app' }];
const PREVIEW_PROJECT = 'POST /v1/skill-installs/local/project/preview';
const PREVIEW_RUNTIME = 'POST /v1/skill-installs/local/runtime/preview';
const APPLY_PROJECT = 'POST /v1/skill-installs/local/project';
const APPLY_RUNTIME = 'POST /v1/skill-installs/local/runtime';

type AddSkillsHost = Omit<AddSkillsPageProps, 'onNavigate' | 'loadInventory'>;

const hostWith = (routes: Parameters<typeof fakeClient>[0], extra: Partial<AddSkillsHost> = {}) => {
  const { members } = fakeMembers({ list: async () => [] });
  const fake = fakeClient({
    'GET /v1/fleet/runtimes': () => ({ runtimes: [{ id: 'rt-work', wrapper: 'claude-work', profile: 'default' }] }),
    'GET /v1/catalog-installs': () => ({ installs: [] }),
    'GET /v1/skills': () => MACHINE,
    'GET /v1/skill-installs/local': () => ({ installs: [] }),
    ...routes,
  });
  const host: AddSkillsHost = {
    connection,
    machineName: 'alpha box',
    sessionId: 'sess-1',
    cwd: '/work/app/src',
    install: { createClient: fake.factory, crypto, projects: PROJECTS },
    members,
    ...extra,
  };
  return { host, calls: fake.calls };
};

const open = async (host: AddSkillsHost, inventory = SKILLS) => {
  const view = await mount(
    <AddSkillsPage {...host} loadInventory={async () => inventory} onNavigate={() => undefined} />,
  );
  await settle();
  await settle();
  return { view };
};

/** Opens the copy sheet for a row, by the skill's name. */
const installRow = async (name: string): Promise<void> => {
  const row = machineRows().find(candidate => candidate.textContent?.includes(name));
  await click(row?.querySelector('[data-add-skills-machine-install]') ?? null);
  await settle();
};

describe('the On this machine group', () => {
  it('lists the skills of other accounts and projects, not the ones this session has', async () => {
    const { host } = hostWith({});
    const { view } = await open(host);
    expect(q('[data-add-skills-machine] h2')?.textContent).toBe('On this machine');
    expect(machineRows().map(row => row.querySelector('span')?.textContent)).toEqual([
      'pdf-tools',
      'lint-fix',
      'deploy-notes',
    ]);
    expect(machineRows()[1]?.textContent).toContain('codex-play account · Codex');
    expect(machineRows()[2]?.textContent).toContain('project api · Claude');
    expect(machineRows().every(row => row.querySelector('[data-add-skills-machine-install]') !== null)).toBe(true);
    expect(q('[data-add-skills-machine-truncated]')).toBeNull();
    await view.unmount();
  });

  it('says it is reading until the machine answers', async () => {
    const wait = deferred<typeof MACHINE>();
    const { host } = hostWith({ 'GET /v1/skills': async () => await wait.promise });
    const { view } = await open(host);
    expect(text()).toContain(READING_MACHINE);
    wait.resolve(MACHINE);
    await settle();
    expect(text()).not.toContain(READING_MACHINE);
    expect(machineRows()).toHaveLength(3);
    await view.unmount();
  });

  it('says so when the machine’s skills cannot be read, and leaves the rest of the page alone', async () => {
    const { host } = hostWith({
      'GET /v1/skills': () => {
        throw new Error('offline');
      },
    });
    const { view } = await open(host);
    expect(q('[data-add-skills-machine-failed]')?.textContent).toBe(MACHINE_UNREADABLE);
    expect(q('[data-add-skills-empty]')).not.toBeNull();
    await view.unmount();
  });

  it('says when no other account or project has a skill the session lacks', async () => {
    const { host } = hostWith({ 'GET /v1/skills': () => ({ homes: [], projects: [], truncated: false }) });
    const { view } = await open(host);
    expect(q('[data-add-skills-machine-none]')?.textContent).toBe(NO_MACHINE_SKILLS);
    await view.unmount();
  });

  it('says when the listing was cut short', async () => {
    const { host } = hostWith({ 'GET /v1/skills': () => ({ ...MACHINE, truncated: true }) });
    const { view } = await open(host);
    expect(q('[data-add-skills-machine-truncated]')?.textContent).toBe(MACHINE_TRUNCATED);
    await view.unmount();
  });

  it('narrows by what is typed, and says when nothing matches', async () => {
    const { host } = hostWith({});
    const { view } = await open(host);
    await typeInto(q('[data-add-skills-search]'), 'lint');
    expect(machineRows()).toHaveLength(1);
    await typeInto(q('[data-add-skills-search]'), 'nothing like it');
    expect(q('[data-add-skills-machine-none]')?.textContent).toBe(NO_MACHINE_MATCH);
    await view.unmount();
  });

  it('says Installed, with no Install button, for a skill that was already copied', async () => {
    const { host } = hostWith({
      'GET /v1/skill-installs/local': () => ({ installs: [localInstall()] }),
    });
    const { view } = await open(host);
    expect(machineRows()[0]?.querySelector('[data-add-skills-machine-installed]')?.textContent).toBe('Installed');
    expect(machineRows()[0]?.querySelector('[data-add-skills-machine-install]')).toBeNull();
    expect(machineRows()[1]?.querySelector('[data-add-skills-machine-install]')).not.toBeNull();
    await view.unmount();
  });

  it('lists everything as not copied when the copy records cannot be read', async () => {
    const { host } = hostWith({
      'GET /v1/skill-installs/local': () => {
        throw new Error('offline');
      },
    });
    const { view } = await open(host);
    expect(all('[data-add-skills-machine-install]')).toHaveLength(3);
    await view.unmount();
  });
});

describe('Install from this machine', () => {
  it('previews into This project, shows the review, and installs after the person confirms', async () => {
    let applied = false;
    const { host, calls } = hostWith({
      [PREVIEW_PROJECT]: () => localPreview(),
      [APPLY_PROJECT]: () => {
        applied = true;
        return localInstalled();
      },
      'GET /v1/skill-installs/local': () => ({ installs: applied ? [localInstall()] : [] }),
    });
    const { view } = await open(host);
    await installRow('pdf-tools');
    expect(q('[data-catalog-sheet="local-skill"] h3')?.textContent).toBe('Install pdf-tools');
    expect(q('[data-catalog-sheet="local-skill"]')).not.toBeNull();
    expect(q('[data-local-source]')?.textContent).toContain('claude-play account · Claude');
    expect((q('[data-catalog-scope]') as HTMLSelectElement).value).toBe('project');
    expect((q('[data-catalog-project]') as HTMLSelectElement).value).toBe('/work/app');
    expect(q('[data-local-confirm]')).toBeNull();

    await click(q('[data-local-preview]'));
    await settle();
    expect(q('[data-local-preview]')?.textContent).toBe(REVIEW_BEFORE_INSTALLING);
    expect(q('[data-local-preview]')?.getAttribute('data-variant')).toBeNull();
    expect(
      [...document.querySelectorAll('[data-catalog-sheet="local-skill"] [data-variant="primary"]')].map(button =>
        button.hasAttribute('data-local-install'),
      ),
    ).toEqual([true]);
    expect(calls.find(call => call.path.endsWith('/preview'))?.body).toEqual({
      source: { path: PDF_PATH },
      target: { scope: 'project', projectRoot: '/work/app', harness: 'claude' },
    });
    const confirm = q('[data-local-confirm]')?.textContent ?? '';
    expect(confirm).toContain('/work/app/.claude/skills/pdf-tools/ (2 files)');
    expect(confirm).toContain('Account claude-play');
    expect(confirm).toContain('echo filled');
    expect(q('[data-review-warnings]')).toBeNull();
    expect(q('[data-local-skipped]')).toBeNull();
    expect(applied).toBe(false);

    await click(q('[data-local-install]'));
    await settle();
    expect(calls.find(call => call.path === '/v1/skill-installs/local/project')?.body).toEqual({
      previewId: localPreview().previewId,
    });
    expect(q('[data-local-installed]')?.textContent).toContain('pdf-tools · copied');
    expect(q('[data-local-destination]')?.textContent).toBe('Put into /work/app/.claude/skills/pdf-tools/ (2 files)');
    expect(q('[data-local-note]')).toBeNull();

    await click(q('[data-local-done]'));
    await settle();
    expect(q('[data-add-skills-page]')).not.toBeNull();
    expect(q('[data-add-skills-landed]')?.textContent).toBe(
      `Installed pdf-tools in this project (every session in this folder). ${CLAUDE_LIVE}`,
    );
    expect(machineRows()[0]?.querySelector('[data-add-skills-machine-installed]')).not.toBeNull();
    await view.unmount();
  });

  it('shows each warning, marks hidden characters, lists what was not copied and what it replaces', async () => {
    const { host } = hostWith({
      [PREVIEW_PROJECT]: () =>
        localPreview({
          ...WARNED_PREVIEW,
          skipped: [{ subject: 'logo.png', reason: 'it is not text' }],
          replaces: { installId: OTHER_INSTALL_ID },
        }),
    });
    const { view } = await open(host);
    await installRow('pdf-tools');
    await click(q('[data-local-preview]'));
    await settle();
    const warnings = q('[data-review-warnings]')?.textContent ?? '';
    expect(warnings).toContain('holds what looks like a raw key');
    expect(warnings).toContain('carries scripts');
    expect(q('[data-local-confirm] [data-hidden-marker]')).not.toBeNull();
    expect(q('[data-local-skipped]')?.textContent).toContain('logo.png: it is not text');
    expect(q('[data-local-confirm]')?.textContent).toContain('It replaces the copy you made from this machine before.');
    expect(q('[data-local-install]')).not.toBeNull();
    await view.unmount();
  });

  it('refuses a source with a password in it, in the machine’s words, with no Install button', async () => {
    const { host } = hostWith({
      [PREVIEW_PROJECT]: () => {
        throw refusal('local_skill_source_invalid', CREDENTIAL_SENTENCE);
      },
    });
    const { view } = await open(host);
    await installRow('pdf-tools');
    expect(q('[data-local-preview]')?.textContent).toBe(REVIEW_BEFORE_INSTALLING);
    await click(q('[data-local-preview]'));
    await settle();
    expect(q('[data-catalog-failure]')?.textContent).toBe(CREDENTIAL_SENTENCE);
    expect(q('[data-local-preview]')?.textContent).toBe(CHECK_AGAIN);
    expect(q('[data-local-preview]')?.getAttribute('data-variant')).toBe('primary');
    expect(q('[data-local-install]')).toBeNull();
    expect(q('[data-local-confirm]')).toBeNull();
    expect(q('[data-catalog-preview-again]')).toBeNull();
    await view.unmount();
  });

  it('says plainly when the folder is over the file cap', async () => {
    const cap = 'This skill has 70 files. A copy holds at most 64.';
    const { host } = hostWith({
      [PREVIEW_PROJECT]: () => {
        throw refusal('local_skill_source_invalid', cap);
      },
    });
    const { view } = await open(host);
    await installRow('pdf-tools');
    await click(q('[data-local-preview]'));
    await settle();
    expect(q('[data-catalog-failure]')?.textContent).toBe(cap);
    await view.unmount();
  });

  it('says what went wrong when the install is refused, and previews again when the preview ran out', async () => {
    let previews = 0;
    let applies = 0;
    const { host } = hostWith({
      [PREVIEW_PROJECT]: () => {
        previews += 1;
        return localPreview();
      },
      [APPLY_PROJECT]: () => {
        applies += 1;
        if (applies === 1) throw refusal('local_skill_preview_expired', 'expired', 410);
        if (applies === 2) throw refusal('grant_step_up_required', 'step up', 403);
        throw refusal('local_skill_conflict', 'A folder is there.', 409);
      },
    });
    const { view } = await open(host);
    await installRow('pdf-tools');
    await click(q('[data-local-preview]'));
    await settle();
    await click(q('[data-local-install]'));
    await settle();
    expect(q('[data-catalog-failure]')?.textContent).toContain('ran out after 10 minutes');
    await click(q('[data-catalog-preview-again]'));
    await settle();
    expect(previews).toBe(2);
    expect(q('[data-catalog-failure]')).toBeNull();

    await click(q('[data-local-install]'));
    await settle();
    expect(q('[data-catalog-failure]')?.textContent).toContain('the passkey wasn’t confirmed');
    expect(q('[data-catalog-preview-again]')).toBeNull();
    expect(q('[data-local-install]')).not.toBeNull();

    await click(q('[data-local-install]'));
    await settle();
    expect(q('[data-catalog-failure]')?.textContent).toContain('Something is already where this would go');
    await view.unmount();
  });

  it('shows Reading… and Installing… while a call is in flight', async () => {
    const preview = deferred<ReturnType<typeof localPreview>>();
    const apply = deferred<ReturnType<typeof localInstalled>>();
    const { host } = hostWith({
      [PREVIEW_PROJECT]: async () => await preview.promise,
      [APPLY_PROJECT]: async () => await apply.promise,
    });
    const { view } = await open(host);
    await installRow('pdf-tools');
    await click(q('[data-local-preview]'));
    expect(q('[data-local-preview]')?.textContent).toBe('Reading…');
    expect((q('[data-local-preview]') as HTMLButtonElement).disabled).toBe(true);
    preview.resolve(localPreview());
    await settle();
    await click(q('[data-local-install]'));
    expect(q('[data-local-install]')?.textContent).toBe('Installing…');
    apply.resolve(localInstalled());
    await settle();
    expect(q('[data-local-installed]')).not.toBeNull();
    await view.unmount();
  });

  it('drops a review when the place is changed, and previews the new place', async () => {
    const { host } = hostWith({
      [PREVIEW_PROJECT]: () => localPreview(),
      [PREVIEW_RUNTIME]: () => runtimePreview(),
    });
    const { view } = await open(host);
    await installRow('pdf-tools');
    await click(q('[data-local-preview]'));
    await settle();
    expect(q('[data-local-confirm]')).not.toBeNull();

    await pick('[data-catalog-scope]', 'runtime');
    expect(q('[data-local-confirm]')).toBeNull();
    expect((q('[data-local-preview]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-local-choice-problem]')?.textContent).toBe('Pick a runtime.');

    await pick('[data-catalog-runtime]', 'rt-work');
    expect(q('[data-local-choice-problem]')).toBeNull();
    await click(q('[data-local-preview]'));
    await settle();
    expect(q('[data-local-confirm]')?.textContent).toContain('the skill pdf-tools, on claude-work (profile default)');
    await view.unmount();
  });

  it('installs into an account and says when, with the machine’s own notes', async () => {
    const note = 'Claude reads it the next time it starts.';
    const { host, calls } = hostWith(
      {
        [PREVIEW_RUNTIME]: () => runtimePreview(),
        [APPLY_RUNTIME]: () =>
          localInstalled(
            {
              target: { scope: 'runtime', runtime: 'rt-work', profile: 'default' },
              destination: 'the skill pdf-tools',
            },
            [note],
          ),
      },
      { cwd: '/tmp/elsewhere' },
    );
    const { view } = await open(host);
    await installRow('pdf-tools');
    expect((q('[data-catalog-scope]') as HTMLSelectElement).value).toBe('runtime');
    await click(q('[data-local-preview]'));
    await settle();
    await click(q('[data-local-install]'));
    await settle();
    expect(calls.some(call => call.path === '/v1/skill-installs/local/runtime')).toBe(true);
    expect(q('[data-local-note]')?.textContent).toBe(note);
    await click(q('button[aria-label="Close Installed"]'));
    await settle();
    expect(q('[data-add-skills-landed]')?.textContent).toBe(
      `Installed pdf-tools in this account (every session on claude-work). ${CLAUDE_LIVE}`,
    );
    await view.unmount();
  });

  it('says a Codex copy is active from the next session, and a copy to another place is not active here', async () => {
    const codexInventory = { ...SKILLS, harness: 'codex' as const };
    const { host } = hostWith({
      [PREVIEW_PROJECT]: () => localPreview(),
      [APPLY_PROJECT]: () =>
        localInstalled({ target: { scope: 'project', projectRoot: '/work/app', harness: 'codex' } }),
    });
    const first = await open(host, codexInventory);
    await installRow('pdf-tools');
    await pick('[data-catalog-harness]', 'codex');
    await click(q('[data-local-preview]'));
    await settle();
    await click(q('[data-local-install]'));
    await settle();
    await click(q('[data-local-done]'));
    await settle();
    expect(q('[data-add-skills-landed]')?.textContent).toContain(CODEX_NEXT);
    await first.view.unmount();

    const elsewhere = hostWith({
      [PREVIEW_PROJECT]: () => localPreview(),
      [APPLY_PROJECT]: () =>
        localInstalled({ target: { scope: 'project', projectRoot: '/work/other', harness: 'claude' } }),
    });
    const second = await open(elsewhere.host);
    await installRow('lint-fix');
    await click(q('[data-local-preview]'));
    await settle();
    await click(q('[data-local-install]'));
    await settle();
    await click(q('[data-local-done]'));
    await settle();
    expect(q('[data-add-skills-landed]')?.textContent).toContain(NOT_HERE);
    await second.view.unmount();
  });

  it('closes without copying anything, and says nothing landed', async () => {
    const { host } = hostWith({});
    const { view } = await open(host);
    await installRow('deploy-notes');
    expect(q('[data-local-source]')?.textContent).toContain('project api · Claude');
    await click(q('button[aria-label="Close Install from this machine"]'));
    await settle();
    expect(q('[data-add-skills-page]')).not.toBeNull();
    expect(q('[data-add-skills-landed]')).toBeNull();
    await view.unmount();
  });

  it('asks for a place when this session has none to start from', async () => {
    const { host } = hostWith({ 'GET /v1/fleet/runtimes': () => ({ runtimes: [] }) }, { cwd: undefined });
    const { view } = await open(host);
    await installRow('pdf-tools');
    expect(q('[data-local-choice-problem]')?.textContent).toBe('Pick where to install it.');
    expect((q('[data-local-preview]') as HTMLButtonElement).disabled).toBe(true);
    await view.unmount();
  });
});
