import { afterEach, describe, expect, it } from 'bun:test';
import type {
  ConfigFileView,
  FleetBudgetPeriodView,
  FleetCredentialBudget,
  FleetCredentialView,
} from '@ferretry/protocol';
import { CredentialsTab } from '../../../../../src/features/fleet/credentials/credentials-tab.tsx';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { httpError } from '../../config-files/config-files-support.ts';
import { type Call, CREDENTIALS, credential, NOW, READS, STUDIO, scripted, withStatus } from '../account-support.ts';

const LIST = 'GET /v1/fleet/credentials';
const GET_MACHINE_FILE = 'GET /v1/config/file?path=machine.yaml';
const GET_LOGIN_FILE = 'GET /v1/config/file?path=logins%2Fclaude-personal.yaml';
const PUT = 'PUT /v1/config/file';
const CONFIRM = 'POST /v1/config/confirm';
const PAGE = '#machines/studio-mac/credentials/claude-personal';

afterEach(() => {
  window.location.hash = '';
});

/** America/New_York, EDT: local midnight is 04:00Z, so the reset words are pinned by these instants. */
const period = (overrides: Partial<FleetBudgetPeriodView> = {}): FleetBudgetPeriodView => ({
  trigger: 40,
  hard: 60,
  spentUsd: 12.4,
  level: 'ok',
  startsAt: '2026-10-13T04:00:00.000Z',
  resetsAt: '2026-10-14T04:00:00.000Z',
  ...overrides,
});

const budget = (overrides: Partial<FleetCredentialBudget> = {}): FleetCredentialBudget => ({
  timeZone: 'America/New_York',
  timeZoneSet: true,
  daily: period(),
  weekly: period({ trigger: 200, hard: 300, spentUsd: 150.01, resetsAt: '2026-10-19T04:00:00.000Z' }),
  level: 'ok',
  unpriced: 0,
  measured: true,
  ...overrides,
});

const PERSONAL = credential({
  id: 'claude-personal',
  store: 'host',
  label: 'personal',
  budget: budget(),
});
const WORK = credential({
  id: 'claude-work',
  label: 'work',
  ...withStatus('refresh_due'),
  budget: budget({ level: 'over_trigger', daily: period({ level: 'over_trigger' }) }),
});
const CODEX = credential({
  id: 'codex',
  harness: 'codex',
  store: 'host',
  usage: { fiveHour: {}, weekly: {} },
  budget: budget({ level: 'over_hard', weekly: period({ level: 'over_hard', trigger: 200, hard: 300 }) }),
});

const BUDGETED = { ...CREDENTIALS, credentials: [PERSONAL, CODEX, WORK] };

const MACHINE_FILE: ConfigFileView = {
  path: 'machine.yaml',
  absolutePath: '/home/ernest/.ferretry/config/machine.yaml',
  kind: 'machine',
  schema: 'machine',
  exists: true,
  text: '# machine\nname: studio-mac\n',
  etag: 'etag-machine-1',
  state: 'ok',
  issues: [],
};

const LOGIN_FILE: ConfigFileView = {
  ...MACHINE_FILE,
  path: 'logins/claude-personal.yaml',
  absolutePath: '/home/ernest/.ferretry/config/logins/claude-personal.yaml',
  kind: 'login',
  schema: 'login',
  text: '# the personal account\nlabel: personal\nbudget:\n  daily:\n    trigger: 40\n    hard: 60\n  weekly:\n    trigger: 200\n    hard: 300\n',
  etag: 'etag-login-1',
};

const APPLIED_PUT = (path: string, etag: string): unknown => ({ path, etag, outcome: 'applied' });

interface Options {
  readonly hash?: string;
  readonly credentials?: readonly FleetCredentialView[];
  readonly routes?: Record<string, unknown>;
}

const open = async (options: Options = {}) => {
  window.location.hash = options.hash ?? '';
  const calls: Call[] = [];
  const client: FleetClient = scripted(
    {
      ...READS(),
      [LIST]: { ...CREDENTIALS, credentials: [...(options.credentials ?? BUDGETED.credentials)] },
      [GET_MACHINE_FILE]: MACHINE_FILE,
      [GET_LOGIN_FILE]: LOGIN_FILE,
      [PUT]: APPLIED_PUT('logins/claude-personal.yaml', 'etag-login-2'),
      ...options.routes,
    },
    calls,
  );
  const view = await mount(
    <CredentialsTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={null}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={async () => client}
      now={() => NOW}
    />,
  );
  for (let turn = 0; turn < 12; turn += 1) await interact(async () => await Promise.resolve());
  return { view, calls };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

const input = (container: HTMLElement, key: string): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>(`[data-budget-input="${key}"]`), `the ${key} field`);

const button = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent?.trim() === label),
    `the "${label}" button`,
  );

const type = async (field: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const putBodies = (calls: readonly Call[]): { readonly path: string; readonly text: string; readonly etag: string }[] =>
  calls
    .filter(call => `${call.method} ${call.path}` === PUT)
    .map(call => ({
      path: (call.body as { path: string }).path,
      text: (call.body as { text: string }).text,
      etag: call.headers['if-match'] ?? '',
    }));

describe('BudgetEditor · the list', () => {
  it('meters every login with a budget, with its scope note', async () => {
    const { view } = await open();
    const personal = must(view.container.querySelector('[data-credential-row="claude-personal"]'), 'personal row');
    const bars = Array.from(personal.querySelectorAll('[data-credential-budget] [role="img"]'));
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual([
      '$12.40 of $40.00 · resets Wed',
      '$150.01 of $200.00 · resets Mon',
    ]);
    expect(personal.textContent).toContain('Spent on studio-mac only');
    expect(personal.querySelector('[data-credential-budget-badge]')).toBeNull();
  });

  it('badges a login over its budget by what the hold stops', async () => {
    const { view } = await open();
    const work = must(view.container.querySelector('[data-credential-row="claude-work"]'), 'work row');
    expect(work.querySelector('[data-credential-budget-badge]')?.textContent).toBe('Over budget — not routing');
    expect(work.querySelector('[data-credential-budget-badge]')?.getAttribute('data-tone')).toBe('warn');
    const codex = must(view.container.querySelector('[data-credential-row="codex"]'), 'codex row');
    expect(codex.querySelector('[data-credential-budget-badge]')?.textContent).toBe('Hard limit — ferrets stopped');
    expect(codex.querySelector('[data-credential-budget-badge]')?.getAttribute('data-tone')).toBe('err');
  });
});

describe('BudgetEditor · the page', () => {
  it('fills the four fields from the budget and says where its zone comes from', async () => {
    const { view } = await open({ hash: PAGE });
    const c = view.container;
    const editor = must(c.querySelector('[data-budget-editor="claude-personal"]'), 'the budget editor');
    expect(editor.querySelector('h4')?.textContent).toBe('Spend budget');
    expect(['dailyTrigger', 'dailyHard', 'weeklyTrigger', 'weeklyHard'].map(key => input(c, key).value)).toEqual([
      '40',
      '60',
      '200',
      '300',
    ]);
    expect(editor.querySelector('[data-budget-zone]')?.textContent).toBe(
      'Days reset at midnight, weeks on Monday, in America/New_York (written in machine.yaml).',
    );
    expect(editor.querySelector('[data-budget-problem]')).toBeNull();
    // Nothing to save until a field changes.
    expect(editor.querySelector('[data-change-submit]')).toBeNull();
  });

  it('shows the meter and the unpriced, unmeasured notes with it', async () => {
    const { view } = await open({
      hash: PAGE,
      credentials: [credential({ ...PERSONAL, budget: budget({ unpriced: 2, measured: false }) }), CODEX, WORK],
    });
    const editor = must(view.container.querySelector('[data-budget-editor="claude-personal"]'), 'the budget editor');
    expect(editor.querySelector('[data-budget-scope]')?.textContent).toBe(
      'Spent on studio-mac only · 2 requests without a price · Counting…',
    );
    expect(
      Array.from(editor.querySelectorAll('[data-budget-bar]')).map(bar => bar.getAttribute('data-budget-bar')),
    ).toEqual(['$/day', '$/week']);
    // Both limits are marks inside the bar, never at its clipped end.
    expect(
      Array.from(editor.querySelectorAll<HTMLElement>('[data-budget-hard], [data-budget-trigger]')).map(
        mark => mark.style.left,
      ),
    ).toEqual(['56%', '83%', '56%', '83%']);
  });

  it('carries the hold’s own words onto the editor, in their colour', async () => {
    const work = await open({ hash: '#machines/studio-mac/credentials/claude-work' });
    const held = must(work.view.container.querySelector('[data-budget-held]'), 'the held line');
    expect(held.textContent).toBe('Over budget — not routing');
    expect(held.className).toContain('text-warn');
    const codex = await open({ hash: '#machines/studio-mac/credentials/codex' });
    const stopped = must(codex.view.container.querySelector('[data-budget-held]'), 'the held line');
    expect(stopped.textContent).toBe('Hard limit — ferrets stopped');
    expect(stopped.className).toContain('text-err');
  });

  it('refuses a draft that is not dollars, or whose hard limit is below its trigger', async () => {
    const { view } = await open({ hash: PAGE });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), 'lots');
    expect(c.querySelector('[data-budget-problem]')?.textContent).toBe(
      'Give every limit as dollars above 0, like 40 or 12.50.',
    );
    await type(input(c, 'dailyTrigger'), '20');
    await type(input(c, 'dailyHard'), '10');
    expect(c.querySelector('[data-budget-problem]')?.textContent).toBe(
      'The daily hard limit must not be below its trigger.',
    );
    expect(button(c, 'Save budget').disabled).toBe(true);
    // Undo puts the draft back as the daemon last said.
    await interact(() => button(c, 'Undo').click());
    expect(c.querySelector('[data-budget-problem]')).toBeNull();
    expect(input(c, 'dailyTrigger').value).toBe('40');
  });
});

describe('BudgetEditor · saving', () => {
  it('writes machine.yaml the device zone first, then only the budget key of the login file', async () => {
    const { view, calls } = await open({
      hash: PAGE,
      credentials: [credential({ ...PERSONAL, budget: undefined }), CODEX, WORK],
    });
    const c = view.container;
    expect(c.querySelector('[data-budget-zone]')?.textContent).toContain('counted in your zone');
    await type(input(c, 'dailyTrigger'), '10');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();

    const writes = putBodies(calls);
    expect(writes.map(write => write.path)).toEqual(['machine.yaml', 'logins/claude-personal.yaml']);
    expect(writes[0]?.text).toContain('timeZone: ');
    // The login write edits one key: the comment and the label survive, only the budget changed.
    expect(writes[1]?.text).toContain('# the personal account');
    expect(writes[1]?.text).toContain('label: personal');
    expect(writes[1]?.text).toContain('trigger: 10');
    expect(writes[1]?.text).not.toContain('trigger: 40');
    expect(writes[1]?.etag).toBe('etag-login-1');
    expect(c.querySelector('[data-budget-save="applied"]')?.textContent).toBe('In effect');
    // The machine's reads were made again so the meter shows what is in effect.
    expect(calls.filter(call => `${call.method} ${call.path}` === LIST).length).toBeGreaterThan(1);
  });

  it('shows a first zone the daemon held, and confirms it — a zone can never move a day unseen', async () => {
    // Security regression: the first timeZone is a loosening too. The daemon holds the machine.yaml write
    // and applies the (tightening) budget write; the editor must say so and confirm the held zone.
    const { view, calls } = await open({
      hash: PAGE,
      credentials: [credential({ ...PERSONAL, budget: undefined }), CODEX, WORK],
      routes: {
        [PUT]: (call: Call) =>
          (call.body as { path: string }).path === 'machine.yaml'
            ? {
                path: 'machine.yaml',
                etag: 'etag-machine-2',
                outcome: 'pending',
                pending: {
                  path: 'machine.yaml',
                  etag: 'etag-machine-2',
                  changes: ["budgets now reset in Asia/Tokyo instead of the host's time zone"],
                },
              }
            : APPLIED_PUT('logins/claude-personal.yaml', 'etag-login-2'),
        [CONFIRM]: (call: Call) => ({ path: (call.body as { path: string }).path, confirmed: true }),
      },
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '10');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-save="pending"]')?.textContent).toContain(
      "Saved — waiting for your confirmation: budgets now reset in Asia/Tokyo instead of the host's time zone",
    );

    await interact(() => button(c, 'Confirm').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(calls.filter(call => `${call.method} ${call.path}` === CONFIRM).map(call => call.body)).toEqual([
      { path: 'machine.yaml', etag: 'etag-machine-2' },
    ]);
    expect(c.querySelector('[data-budget-save="applied"]')?.textContent).toBe('In effect');
  });

  it('keeps a held zone in front of the owner when the login write then fails, and confirms it there', async () => {
    // The zone was written (held); the login write lost a race. The failure must not hide the held zone.
    const { view, calls } = await open({
      hash: PAGE,
      credentials: [credential({ ...PERSONAL, budget: undefined }), CODEX, WORK],
      routes: {
        [PUT]: (call: Call) =>
          (call.body as { path: string }).path === 'machine.yaml'
            ? {
                path: 'machine.yaml',
                etag: 'etag-machine-2',
                outcome: 'pending',
                pending: { path: 'machine.yaml', etag: 'etag-machine-2', changes: ['budgets now reset in Asia/Tokyo'] },
              }
            : httpError('the file changed', 409, 'config_conflict'),
        [CONFIRM]: (call: Call) => ({ path: (call.body as { path: string }).path, confirmed: true }),
      },
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '10');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-save="conflict"]')).not.toBeNull();
    expect(c.querySelector('[data-budget-save="pending"]')?.textContent).toContain(
      'Written — waiting for your confirmation: budgets now reset in Asia/Tokyo',
    );

    await interact(() => button(c, 'Confirm').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(calls.filter(call => `${call.method} ${call.path}` === CONFIRM).map(call => call.body)).toEqual([
      { path: 'machine.yaml', etag: 'etag-machine-2' },
    ]);
    // The zone is in effect now; the conflict is still said, and nothing is left waiting.
    expect(c.querySelector('[data-budget-save="pending"]')).toBeNull();
    expect(c.querySelector('[data-budget-save="conflict"]')).not.toBeNull();
  });

  it('says only the budget was not saved when a held zone was written before a failure', async () => {
    const { view } = await open({
      hash: PAGE,
      credentials: [credential({ ...PERSONAL, budget: undefined }), CODEX, WORK],
      routes: {
        [GET_LOGIN_FILE]: { ...LOGIN_FILE, text: 'label: [broken\n' },
        [PUT]: {
          path: 'machine.yaml',
          etag: 'etag-machine-2',
          outcome: 'pending',
          pending: { path: 'machine.yaml', etag: 'etag-machine-2', changes: ['budgets now reset in Asia/Tokyo'] },
        },
      },
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '10');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-save="failed"]')?.textContent).toContain('The budget was not saved.');
    expect(c.querySelector('[data-budget-save="pending"]')).not.toBeNull();
  });

  it('confirms every held file in turn, and stops at the first that fails', async () => {
    const held = (path: string, etag: string) => ({
      path,
      etag,
      outcome: 'pending',
      pending: { path, etag, changes: [`${path} loosens`] },
    });
    const { view, calls } = await open({
      hash: PAGE,
      credentials: [credential({ ...PERSONAL, budget: undefined }), CODEX, WORK],
      routes: {
        [PUT]: (call: Call) => {
          const path = (call.body as { path: string }).path;
          return held(path, path === 'machine.yaml' ? 'etag-machine-2' : 'etag-login-2');
        },
        [CONFIRM]: (call: Call) => ({
          path: (call.body as { path: string }).path,
          confirmed: (call.body as { path: string }).path === 'machine.yaml',
        }),
      },
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '10');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-save="pending"]')?.textContent).toContain(
      'machine.yaml loosens; logins/claude-personal.yaml loosens',
    );

    await interact(() => button(c, 'Confirm').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(calls.filter(call => `${call.method} ${call.path}` === CONFIRM).map(call => call.body)).toEqual([
      { path: 'machine.yaml', etag: 'etag-machine-2' },
      { path: 'logins/claude-personal.yaml', etag: 'etag-login-2' },
    ]);
    expect(c.querySelector('[data-budget-confirm-failed]')?.textContent).toContain('no longer the one waiting');
  });

  it('leaves machine.yaml alone when it already names a zone', async () => {
    const { view, calls } = await open({
      hash: PAGE,
      routes: { [GET_MACHINE_FILE]: { ...MACHINE_FILE, text: 'name: studio-mac\ntimeZone: Asia/Singapore\n' } },
    });
    await type(input(view.container, 'dailyTrigger'), '30');
    await interact(() => button(view.container, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(putBodies(calls).map(write => write.path)).toEqual(['logins/claude-personal.yaml']);
    expect(view.container.querySelector('[data-budget-save="applied"]')?.textContent).toBe('In effect');
  });

  it('holds a loosening budget for the owner and confirms it by its digest', async () => {
    const { view, calls } = await open({
      hash: PAGE,
      routes: {
        [GET_MACHINE_FILE]: { ...MACHINE_FILE, text: 'name: studio-mac\ntimeZone: America/New_York\n' },
        [PUT]: {
          path: 'logins/claude-personal.yaml',
          etag: 'etag-login-2',
          outcome: 'pending',
          pending: {
            path: 'logins/claude-personal.yaml',
            etag: 'etag-login-2',
            changes: ['this login may spend more each day'],
          },
        },
        [CONFIRM]: { path: 'logins/claude-personal.yaml', confirmed: true },
      },
    });
    const c = view.container;
    await type(input(c, 'dailyHard'), '90');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-save="pending"]')?.textContent).toContain(
      'Saved — waiting for your confirmation: this login may spend more each day',
    );
    // The save panel stands down while an edit waits.
    expect(
      must(c.querySelector('[data-budget-editor="claude-personal"]'), 'the editor').querySelector(
        '[data-change-submit]',
      ),
    ).toBeNull();

    await interact(() => button(c, 'Confirm').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    const confirm = calls.find(call => `${call.method} ${call.path}` === CONFIRM);
    expect(confirm?.body).toEqual({ path: 'logins/claude-personal.yaml', etag: 'etag-login-2' });
    expect(c.querySelector('[data-budget-save="applied"]')?.textContent).toBe('In effect');
  });

  it('says when the edit it confirmed is no longer the one waiting', async () => {
    const { view } = await open({
      hash: PAGE,
      routes: {
        [PUT]: {
          path: 'logins/claude-personal.yaml',
          etag: 'etag-login-2',
          outcome: 'pending',
          pending: {
            path: 'logins/claude-personal.yaml',
            etag: 'etag-login-2',
            changes: ['this login may spend more each day'],
          },
        },
        [CONFIRM]: { path: 'logins/claude-personal.yaml', confirmed: false },
      },
    });
    const c = view.container;
    await type(input(c, 'dailyHard'), '90');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    await interact(() => button(c, 'Confirm').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-confirm-failed]')?.textContent).toContain('no longer the one waiting');
  });

  it('says a conflict plainly and saves nothing', async () => {
    const { view, calls } = await open({
      hash: PAGE,
      routes: { [PUT]: httpError('logins/claude-personal.yaml changed since it was read', 409, 'config_conflict') },
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '30');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-save="conflict"]')?.textContent).toContain('changed on the machine');
    expect(calls.filter(call => `${call.method} ${call.path}` === CONFIRM)).toEqual([]);
  });

  it('never overwrites a login file that does not parse', async () => {
    const { view, calls } = await open({
      hash: PAGE,
      routes: { [GET_LOGIN_FILE]: { ...LOGIN_FILE, text: 'label: [unclosed\n' } },
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '30');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-save="failed"]')?.textContent).toContain('does not parse');
    // The zone write may have landed; the login's own file was never touched.
    expect(putBodies(calls).map(write => write.path)).toEqual(['machine.yaml']);
  });

  it('removes the budget when every field is emptied', async () => {
    const { view, calls } = await open({ hash: PAGE });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '');
    await type(input(c, 'dailyHard'), '');
    await type(input(c, 'weeklyTrigger'), '');
    await type(input(c, 'weeklyHard'), '');
    expect(button(c, 'Remove budget')).toBeTruthy();
    await interact(() => button(c, 'Remove budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    const write = putBodies(calls).find(candidate => candidate.path === 'logins/claude-personal.yaml');
    expect(write?.text).not.toContain('budget');
    expect(write?.text).toContain('label: personal');
  });

  it('never writes anything when machine.yaml cannot be read or edited', async () => {
    const unparseable = await open({
      hash: PAGE,
      routes: { [GET_MACHINE_FILE]: { ...MACHINE_FILE, text: 'name: [unclosed\n' } },
    });
    const c1 = unparseable.view.container;
    await type(input(c1, 'dailyTrigger'), '30');
    await interact(() => button(c1, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c1.querySelector('[data-budget-save="failed"]')?.textContent).toContain('machine.yaml does not parse');
    expect(putBodies(unparseable.calls)).toEqual([]);

    // A file that parses but is a list, not a mapping of keys: no zone to read, none to write either.
    const notAMapping = await open({
      hash: PAGE,
      routes: { [GET_MACHINE_FILE]: { ...MACHINE_FILE, text: '- only\n- a list\n' } },
    });
    const c2 = notAMapping.view.container;
    await type(input(c2, 'dailyTrigger'), '30');
    await interact(() => button(c2, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c2.querySelector('[data-budget-save="failed"]')?.textContent).toContain('machine.yaml could not be edited');
    expect(putBodies(notAMapping.calls)).toEqual([]);
  });

  it('says a failure that is not about the file in the machine’s own words', async () => {
    const { view } = await open({
      hash: PAGE,
      routes: {
        [GET_MACHINE_FILE]: { ...MACHINE_FILE, text: 'name: studio-mac\ntimeZone: Asia/Singapore\n' },
        [PUT]: httpError('the studio daemon is offline', 503, 'daemon_unreachable'),
      },
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '30');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-save="failed"]')?.textContent).toBe(
      'Nothing was saved. the studio daemon is offline',
    );
  });

  it('shows the daemon’s located problem when a write is refused as invalid', async () => {
    const { view } = await open({
      hash: PAGE,
      routes: {
        [GET_MACHINE_FILE]: { ...MACHINE_FILE, text: 'name: studio-mac\ntimeZone: Asia/Singapore\n' },
        [PUT]: httpError('the file has problems', 422, 'config_invalid', {
          error: 'the file has problems',
          code: 'config_invalid',
          issues: [
            {
              path: 'logins/claude-personal.yaml',
              line: 3,
              severity: 'error',
              message: 'unknown key "spend"',
              fix: 'Remove it.',
            },
          ],
        }),
      },
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '30');
    await interact(() => button(c, 'Save budget').click());
    for (let turn = 0; turn < 12; turn += 1) await settle();
    expect(c.querySelector('[data-budget-save="invalid"]')?.textContent).toBe('the file has problems');
  });
});
