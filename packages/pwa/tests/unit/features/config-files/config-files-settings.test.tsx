import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  absoluteConfigPath,
  CONFIG_HEADLINE,
  CONFIG_SECRET_COMMAND,
  CONFIG_SECRET_REFERENCE,
  CONFLICT_SENTENCE,
  ConfigFilesSurface,
  configFilesSettingsTab,
  configSummaryWords,
  issueLocation,
} from '../../../../src/features/config-files/config-files-settings.tsx';
import { SETTINGS_LINKS, settingsPaletteEntries } from '../../../../src/features/settings/settings-catalog.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { runAsync } from '../../../support/react.ts';
import { settleUntil } from '../../../support/settle.ts';
import { configChangeHarness } from '../../config-change-support.tsx';
import { alpha, DIRECTORY, fakeClients, fileView, type Handler, httpError, STATUS } from './config-files-support.ts';

// biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference, exactly as a file holds one
const EDITED = 'apiKey: ${secret:GLM_KEY}\n';

const textareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

let shown: Mounted | null = null;

afterEach(async () => {
  // A failed assertion must not leave its sheet mounted over the next test.
  await shown?.unmount();
  shown = null;
});

const show = async (handlers: Readonly<Record<string, Handler>>, writes: string[] = []) => {
  const clients = fakeClients({ 'GET /v1/config/status': () => STATUS, ...handlers });
  const machine = configChangeHarness(alpha.daemonId);
  shown = await mount(
    machine.wrap(
      <ConfigFilesSurface
        connection={alpha}
        createClient={clients.createClient}
        write={async text => {
          writes.push(text);
        }}
      />,
    ),
  );
  return { ...clients, move: machine.move, view: shown };
};

const q = <E extends Element = HTMLElement>(selector: string): E | null =>
  must(shown, 'a mounted panel').container.querySelector<E>(selector);

const until = async (selector: string): Promise<HTMLElement> => {
  await settleUntil(() => q(selector) !== null, selector, runAsync);
  return must(q(selector), selector);
};

const click = async (selector: string): Promise<void> => {
  const target = await until(selector);
  await interact(() => target.click());
};

/** Where an editor sheet lives: inside the mounted container, like every other unportalled sheet. */
const editorText = (): HTMLTextAreaElement => must(q<HTMLTextAreaElement>('[data-config-editor-text]'), 'editor');

const type = async (text: string): Promise<void> => {
  const editor = editorText();
  await interact(() => {
    textareaValue?.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('Settings › Files', () => {
  it('says where the files are, sums them up, and lists what waits, what is wrong and every file by kind', async () => {
    const writes: string[] = [];
    await show({}, writes);
    const panel = await until('[data-config-files-panel]');

    expect(panel.querySelector('h3')?.textContent).toBe(CONFIG_HEADLINE);
    expect(panel.querySelector('[data-panel-path]')?.textContent).toBe(DIRECTORY);
    expect(q('[data-config-summary]')?.textContent).toBe('4 files · 1 with errors · 1 waiting for you');

    const pending = must(q('[data-config-pending="machine.yaml"]'), 'the held edit');
    expect([...pending.querySelectorAll('ul li')].map(item => item.textContent)).toEqual([
      'agents may now edit Ferretry settings',
      'agents skip every permission check',
    ]);

    const issues = [...must(q('[data-config-section="issues"]'), 'issues').querySelectorAll('[data-config-issue]')];
    expect(issues.map(issue => issue.getAttribute('data-config-issue'))).toEqual(['error', 'error', 'warning']);
    expect(issues.map(issue => issue.querySelector('[data-panel-path]')?.textContent)).toEqual([
      'warden.yaml:3:5',
      'warden.yaml:7',
      'logins/glm.yaml',
    ]);
    expect(issues[0]?.textContent).toContain('Write a number of minutes, such as 5.');

    // Grouped in the order kinds are declared, whatever order the daemon listed them in.
    const groups = [...panel.querySelectorAll('[data-config-group]')];
    expect(groups.map(group => group.querySelector('h4')?.textContent)).toEqual(['Machine', 'AI logins', 'Warden']);
    expect(
      [...panel.querySelectorAll('[data-config-file-state]')].map(chip => [
        chip.getAttribute('data-config-file-state'),
        chip.textContent,
      ]),
    ).toEqual([
      ['pending', 'Waiting'],
      ['ok', 'OK'],
      ['ok', 'OK'],
      ['invalid', 'Invalid — last good in effect'],
    ]);

    // "Open file path" copies the absolute path, and shows it as text rather than as a link.
    const row = must(q('[data-config-file="logins/glm.yaml"]'), 'the glm login row');
    expect(row.querySelector('a')).toBeNull();
    expect(row.textContent).toContain(`${DIRECTORY}/logins/glm.yaml`);
    await interact(() => must(row.querySelector<HTMLButtonElement>('[data-onboarding-copy]'), 'copy').click());
    await interact(() =>
      must(
        panel.querySelector<HTMLButtonElement>('[data-onboarding-copy="Copy the configuration directory"]'),
        'copy',
      ).click(),
    );
    expect(writes).toEqual([`${DIRECTORY}/logins/glm.yaml`, DIRECTORY]);
  });

  it('says so when there are no files and nothing is wrong', async () => {
    await show({ 'GET /v1/config/status': () => ({ ...STATUS, files: [], issues: [], pending: [] }) });
    await until('[data-config-files-empty]');
    expect(q('[data-config-section="pending"]')).toBeNull();
    expect(q('[data-config-section="issues"]')).toBeNull();
    expect(q('[data-config-summary]')?.textContent).toBe('0 files · 0 with errors · 0 waiting for you');
  });

  it('says the files could not be read, and reads them again on Try again', async () => {
    let fails = true;
    await show({
      'GET /v1/config/status': () => {
        if (fails) throw new Error('');
        return STATUS;
      },
    });
    const failed = await until('[data-config-files-failed]');
    expect(failed.textContent).toContain('This machine did not answer.');
    fails = false;
    await click('[data-config-files-retry]');
    await until('[data-config-files-panel]');
  });

  it('confirms a held edit, then reads the status again', async () => {
    let confirmed = false;
    const { calls } = await show({
      'GET /v1/config/status': () => (confirmed ? { ...STATUS, pending: [] } : STATUS),
      'POST /v1/config/confirm': () => {
        confirmed = true;
        return { path: 'machine.yaml', confirmed: true };
      },
    });
    await click('[data-config-confirm="machine.yaml"]');
    await settleUntil(() => q('[data-config-section="pending"]') === null, 'the held edit gone', runAsync);
    expect(calls.find(call => call.route === 'POST /v1/config/confirm')?.body).toEqual({
      path: 'machine.yaml',
      etag: 'etag-machine-held',
    });
    expect(calls.filter(call => call.route === 'GET /v1/config/status')).toHaveLength(2);
  });

  it('says why a confirmation did not happen: a refusal, or an edit that is no longer the one waiting', async () => {
    let answer: () => unknown = () => {
      throw new Error('putting this change into effect needs a passkey confirmation for it');
    };
    await show({ 'POST /v1/config/confirm': () => answer() });
    await click('[data-config-confirm="machine.yaml"]');
    expect((await until('[data-config-confirm-failed]')).textContent).toBe(
      'putting this change into effect needs a passkey confirmation for it',
    );
    answer = () => ({ path: 'machine.yaml', confirmed: false });
    await click('[data-config-confirm="machine.yaml"]');
    await settleUntil(
      () => q('[data-config-confirm-failed]')?.textContent?.startsWith('That edit is no longer') === true,
      'the stale sentence',
      runAsync,
    );
  });

  it('edits a file as YAML: its text and note, then In effect once saved', async () => {
    const { calls } = await show({
      'GET /v1/config/file': () => fileView(),
      'PUT /v1/config/file': () => ({ path: 'logins/glm.yaml', etag: 'etag-glm-2', outcome: 'applied' }),
    });
    await click('[data-config-edit="logins/glm.yaml"]');
    await until('[data-config-editor-text]');
    expect(editorText().value).toBe(fileView().text);
    expect(q('[data-config-secret-note]')?.textContent).toBe(
      `Never paste a key here: store it with ${CONFIG_SECRET_COMMAND} and write ${CONFIG_SECRET_REFERENCE}.`,
    );
    expect(q('[data-config-editor] [data-panel-path]')?.textContent).toBe(`${DIRECTORY}/logins/glm.yaml`);
    expect(q('[data-config-cancel]')?.textContent).toBe('Cancel');

    await type(EDITED);
    await click('[data-config-submit]');
    await until('[data-config-save="applied"]');
    expect(q('[data-config-save="applied"]')?.textContent).toBe('In effect');
    expect(q('[data-config-cancel]')?.textContent).toBe('Close');
    const put = must(
      calls.find(call => call.route === 'PUT /v1/config/file'),
      'the write',
    );
    expect(put.headers.get('if-match')).toBe('etag-glm-1');
    expect(put.body).toEqual({ path: 'logins/glm.yaml', text: EDITED });
    // The panel reads the status again once the file changed.
    expect(calls.filter(call => call.route === 'GET /v1/config/status')).toHaveLength(2);

    await click('[data-config-cancel]');
    expect(q('[data-config-editor]')).toBeNull();
  });

  it('shows the file’s own issues when it opens, and the located issues of a refused save', async () => {
    let withBody = true;
    await show({
      'GET /v1/config/file': () =>
        fileView({ path: 'warden.yaml', state: 'invalid', issues: STATUS.issues.slice(0, 1) }),
      'PUT /v1/config/file': () => {
        throw httpError(
          'the file does not check (2 problems); nothing was written',
          422,
          'config_invalid',
          withBody
            ? {
                error: 'the file does not check (2 problems); nothing was written',
                code: 'config_invalid',
                issues: STATUS.issues.slice(0, 2),
              }
            : undefined,
        );
      },
    });
    await click('[data-config-edit="warden.yaml"]');
    await until('[data-config-editor-text]');
    const issuesShown = () => [...document.querySelectorAll('[data-bottom-sheet] [data-config-issue]')].length;
    expect(issuesShown()).toBe(1);

    await click('[data-config-submit]');
    await until('[data-config-save="invalid"]');
    expect(q('[data-config-save="invalid"]')?.textContent).toBe(
      'the file does not check (2 problems); nothing was written',
    );
    expect(issuesShown()).toBe(2);

    // Typing again puts the file's own issues back, and a refusal with no body still says why.
    await type('intervalMinutes: five\n');
    expect(q('[data-config-save]')).toBeNull();
    expect(issuesShown()).toBe(1);
    withBody = false;
    await click('[data-config-submit]');
    await until('[data-config-save="invalid"]');
    expect(issuesShown()).toBe(0);
  });

  it('holds a loosening edit for confirmation, and confirms it from the editor', async () => {
    let confirmAnswer: () => unknown = () => {
      throw new Error('dismissed');
    };
    let held = true;
    const { calls } = await show({
      'GET /v1/config/file': () => fileView({ path: 'machine.yaml', kind: 'machine', schema: 'machine' }),
      'PUT /v1/config/file': () =>
        held
          ? {
              path: 'machine.yaml',
              etag: 'etag-machine-3',
              outcome: 'pending',
              pending: {
                path: 'machine.yaml',
                etag: 'etag-machine-3',
                changes: ['agents may now edit Ferretry settings'],
              },
            }
          : { path: 'machine.yaml', etag: 'etag-machine-4', outcome: 'pending' },
      'POST /v1/config/confirm': () => confirmAnswer(),
    });
    await click('[data-config-review="machine.yaml"]');
    await until('[data-config-editor-text]');
    await click('[data-config-submit]');
    const pending = await until('[data-config-save="pending"]');
    expect(pending.textContent).toContain(
      'Saved — waiting for your confirmation: agents may now edit Ferretry settings',
    );

    await click('[data-bottom-sheet] [data-config-confirm]');
    expect((await until('[data-bottom-sheet] [data-config-confirm-failed]')).textContent).toBe('dismissed');
    confirmAnswer = () => ({ path: 'machine.yaml', confirmed: true });
    await click('[data-bottom-sheet] [data-config-confirm]');
    await until('[data-config-save="applied"]');
    expect(calls.filter(call => call.route === 'POST /v1/config/confirm').map(call => call.body)).toEqual([
      { path: 'machine.yaml', etag: 'etag-machine-3' },
      { path: 'machine.yaml', etag: 'etag-machine-3' },
    ]);

    // A held write that did not describe itself still says it waits.
    held = false;
    await type('agentPermissions: skip\n');
    await click('[data-config-submit]');
    expect((await until('[data-config-save="pending"]')).textContent).toContain('it loosens what this machine allows');
  });

  it('refuses to overwrite a file that changed since it was opened, and Reload reads the newer one', async () => {
    let version = 1;
    await show({
      'GET /v1/config/file': () => fileView({ text: `version: ${String(version)}\n`, etag: `etag-${String(version)}` }),
      'PUT /v1/config/file': () => {
        throw httpError('logins/glm.yaml changed since it was read', 409, 'config_conflict');
      },
    });
    await click('[data-config-edit="logins/glm.yaml"]');
    await until('[data-config-editor-text]');
    await type('version: mine\n');
    await click('[data-config-submit]');
    expect((await until('[data-config-save="conflict"]')).textContent).toContain(CONFLICT_SENTENCE);

    version = 2;
    await click('[data-config-reload]');
    await settleUntil(
      () => q<HTMLTextAreaElement>('[data-config-editor-text]')?.value === 'version: 2\n',
      'reloaded',
      runAsync,
    );
    expect(q('[data-config-save]')).toBeNull();
  });

  it('says nothing was saved on any other failure, and says so when the file cannot be read', async () => {
    let reads = 0;
    await show({
      'GET /v1/config/file': () => {
        reads += 1;
        if (reads > 1) throw new Error('offline');
        return fileView();
      },
      'PUT /v1/config/file': () => {
        throw new Error('could not reach fyd');
      },
    });
    await click('[data-config-edit="logins/glm.yaml"]');
    await until('[data-config-editor-text]');
    await click('[data-config-submit]');
    expect((await until('[data-config-save="failed"]')).textContent).toBe('Nothing was saved. could not reach fyd');
    await click('[data-config-cancel]');

    await click('[data-config-edit="logins/claude.yaml"]');
    expect((await until('[data-config-editor-failed]')).textContent).toBe(
      'logins/claude.yaml could not be read. offline',
    );
    expect(must(q<HTMLButtonElement>('[data-config-submit]'), 'save').disabled).toBe(true);
  });
});

describe('Settings › Files, when the machine says its files moved', () => {
  const statusReads = (calls: readonly { readonly route: string }[]) =>
    calls.filter(call => call.route === 'GET /v1/config/status').length;
  const fileReads = (calls: readonly { readonly route: string }[]) =>
    calls.filter(call => call.route === 'GET /v1/config/file').length;

  it('reads the status again when a file changed elsewhere, and ignores a move of anything else', async () => {
    let issues = STATUS.issues;
    const { calls, move } = await show({ 'GET /v1/config/status': () => ({ ...STATUS, issues }) });
    await until('[data-config-files-panel]');
    expect(q('[data-config-summary]')?.textContent).toBe('4 files · 1 with errors · 1 waiting for you');

    // A hand edit fixed the warden file; nobody touched this screen.
    issues = [];
    await move(['runtimes']);
    expect(statusReads(calls)).toBe(1);

    await move(['files']);
    await settleUntil(
      () => q('[data-config-summary]')?.textContent?.includes('0 with errors') === true,
      'fixed',
      runAsync,
    );
    expect(statusReads(calls)).toBe(2);
    expect(q('[data-config-section="issues"]')).toBeNull();
  });

  it('shows the newer text in an open editor when the person has not typed', async () => {
    let version = 1;
    const { calls, move } = await show({
      'GET /v1/config/file': () => fileView({ text: `version: ${String(version)}\n`, etag: `etag-${String(version)}` }),
      'PUT /v1/config/file': () => ({ path: 'logins/glm.yaml', etag: 'etag-3', outcome: 'applied' }),
    });
    await click('[data-config-edit="logins/glm.yaml"]');
    await until('[data-config-editor-text]');
    expect(editorText().value).toBe('version: 1\n');

    // `fy` rewrote the file while the editor was open.
    version = 2;
    await move(['files']);
    await settleUntil(() => editorText().value === 'version: 2\n', 'the newer text', runAsync);
    expect(fileReads(calls)).toBe(2);

    // Saving now answers to the newer version, not the one first opened.
    await click('[data-config-submit]');
    await until('[data-config-save="applied"]');
    const put = must(
      calls.find(call => call.route === 'PUT /v1/config/file'),
      'the write',
    );
    expect(put.headers.get('if-match')).toBe('etag-2');
  });

  it('keeps what the person typed and reads nothing when the file moves under their draft', async () => {
    let version = 1;
    const { calls, move } = await show({
      'GET /v1/config/file': () => fileView({ text: `version: ${String(version)}\n`, etag: `etag-${String(version)}` }),
    });
    await click('[data-config-edit="logins/glm.yaml"]');
    await until('[data-config-editor-text]');
    await type('version: mine\n');

    version = 2;
    await move(['files']);
    expect(fileReads(calls)).toBe(1);
    expect(editorText().value).toBe('version: mine\n');
  });

  it('keeps the editor as it was when reading the newer file fails', async () => {
    let reads = 0;
    const { move } = await show({
      'GET /v1/config/file': () => {
        reads += 1;
        if (reads > 1) throw new Error('offline');
        return fileView();
      },
    });
    await click('[data-config-edit="logins/glm.yaml"]');
    await until('[data-config-editor-text]');

    await move(['files']);
    await settleUntil(() => reads === 2, 'the second read', runAsync);
    expect(editorText().value).toBe(fileView().text);
    expect(q('[data-config-editor-failed]')).toBeNull();
    expect(must(q<HTMLButtonElement>('[data-config-submit]'), 'save').disabled).toBe(false);
  });

  it('does not read again while the file is still loading or could not be read', async () => {
    let reads = 0;
    const { calls, move } = await show({
      'GET /v1/config/file': () => {
        reads += 1;
        throw new Error('offline');
      },
    });
    await click('[data-config-edit="logins/glm.yaml"]');
    await until('[data-config-editor-failed]');

    await move(['files']);
    expect(reads).toBe(1);
    expect(fileReads(calls)).toBe(1);
    expect(q('[data-config-editor-failed]')).not.toBeNull();
  });
});

describe('the words the Files panel says', () => {
  it('places an issue as far as the daemon could, and ignores a column without a line', () => {
    const issue = STATUS.issues[0] as (typeof STATUS.issues)[number];
    expect(issueLocation(issue)).toBe('warden.yaml:3:5');
    expect(issueLocation({ ...issue, line: undefined })).toBe('warden.yaml');
    expect(configSummaryWords({ ...STATUS, files: STATUS.files.slice(0, 1) })).toBe(
      '1 file · 1 with errors · 1 waiting for you',
    );
    expect(absoluteConfigPath('/srv/config/', 'machine.yaml')).toBe('/srv/config/machine.yaml');
  });
});

describe('the Files tab', () => {
  it('is the Machine tab panel the composition root mounts, and Settings search finds it', async () => {
    const tab = configFilesSettingsTab(fakeClients({ 'GET /v1/config/status': () => STATUS }).createClient);
    expect({ id: tab.id, label: tab.label, description: tab.description }).toEqual({
      id: 'files',
      label: 'Files',
      description: 'The YAML files this machine’s settings live in.',
    });
    shown = await mount(<tab.Surface connection={alpha} />);
    await until('[data-config-files-panel]');

    expect(SETTINGS_LINKS.find(link => link.id === 'files')?.label).toBe('Configuration files');
    for (const query of ['yaml', 'machine.yaml', 'edit as yaml', 'configuration']) {
      expect(settingsPaletteEntries(alpha.daemonId, query).find(entry => entry.id === 'setting-link-files')?.href).toBe(
        '/d/alpha/settings#files',
      );
    }
  });
});
