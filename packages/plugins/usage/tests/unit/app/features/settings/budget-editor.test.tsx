import { describe, expect, it } from 'bun:test';
import { type LoginBudget, LoginBudgetSchema } from '@ferretry/plugin-logins/contract';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { BudgetStanding } from '../../../../../contract/index.ts';
import { BudgetsSettings } from '../../../../../app/features/settings/budgets-settings.tsx';
import { interact, mount, must } from '../../support/dom.ts';
import { fakeClient, type RecordedCall } from '../../support/client.ts';
import { DaemonCallError, daemonConnection } from '../../support/shell.ts';

const LOGINS = 'GET /v1/logins';
const STANDING = 'GET /v1/usage/budgets';
const GET_FILE = 'GET /v1/config/file';
const PUT = 'PUT /v1/config/file';
const CONFIRM = 'POST /v1/config/confirm';
const USAGE_FILE = 'usage.yaml';

/** America/New_York, EDT: local midnight is 04:00Z, so the reset words are pinned by these instants. */
const period = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  trigger: 40,
  hard: 60,
  spentUsd: 12.4,
  level: 'ok',
  startsAt: '2026-10-13T04:00:00.000Z',
  resetsAt: '2026-10-14T04:00:00.000Z',
  ...overrides,
});

const budget = (overrides: Readonly<Record<string, unknown>> = {}): LoginBudget =>
  LoginBudgetSchema.parse({
  timeZone: 'America/New_York',
  timeZoneSet: true,
  daily: period(),
  weekly: period({ trigger: 200, hard: 300, spentUsd: 150.01, resetsAt: '2026-10-19T04:00:00.000Z' }),
  level: 'ok',
  unpriced: 0,
  measured: true,
  ...overrides,
  });

const PERSONAL_BUDGET = budget();
const WORK_BUDGET = budget({ level: 'over_trigger', daily: period({ level: 'over_trigger' }) });
const CODEX_BUDGET = budget({ level: 'over_hard', weekly: period({ level: 'over_hard', trigger: 200, hard: 300 }) });

const standing = (...entries: readonly (readonly [string, LoginBudget])[]): readonly BudgetStanding[] =>
  entries.map(([login, value]) => ({ login: login as BudgetStanding['login'], budget: value }));

const DEFAULT_STANDING = standing(
  ['claude-personal', PERSONAL_BUDGET],
  ['claude-work', WORK_BUDGET],
  ['codex', CODEX_BUDGET],
);

const USAGE_TEXT =
  '# usage\nbudgets:\n  claude-personal:\n    daily:\n      trigger: 40\n      hard: 60\n    weekly:\n      trigger: 200\n      hard: 300\ntimeZone: America/New_York\n';

const applied = (etag: string): unknown => ({ path: USAGE_FILE, etag, outcome: 'applied' });
const held = (etag: string, ...changes: string[]): unknown => ({
  path: USAGE_FILE,
  etag,
  outcome: 'pending',
  pending: { path: USAGE_FILE, etag, changes },
});

interface Options {
  readonly standing?: readonly BudgetStanding[];
  readonly fileText?: string;
  readonly put?: unknown;
  readonly confirm?: unknown;
  readonly deviceTimeZone?: string;
}

const open = async (options: Options = {}) => {
  const client = fakeClient({
    [LOGINS]: {
      format: 1,
      machine: 'studio-mac',
      logins: [
        sampleLogin('claude-personal', { label: 'personal' }),
        sampleLogin('codex', { harness: 'codex', harnesses: ['codex'] }),
        sampleLogin('claude-work', { label: 'work' }),
      ],
    },
    [STANDING]: { budgets: options.standing ?? DEFAULT_STANDING },
    [GET_FILE]: { path: USAGE_FILE, exists: true, text: options.fileText ?? USAGE_TEXT, etag: 'etag-usage-1' },
    [PUT]: options.put ?? applied('etag-usage-2'),
    [CONFIRM]: options.confirm ?? { path: USAGE_FILE, confirmed: true },
  });
  const view = await mount(
    <BudgetsSettings
      connection={daemonConnection({ daemonId: 'studio' })}
      client={client}
      deviceTimeZone={options.deviceTimeZone ?? 'Asia/Tokyo'}
    />,
  );
  for (let turn = 0; turn < 12; turn += 1) await interact(async () => await Promise.resolve());
  return { view, client };
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1)
    await interact(async () => {
      for (let inner = 0; inner < 10; inner += 1) await Promise.resolve();
    });
};

const editorOf = (container: HTMLElement, login = 'claude-personal'): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[data-budget-editor="${login}"]`), `the ${login} budget editor`);

const input = (container: HTMLElement, key: string, login = 'claude-personal'): HTMLInputElement =>
  must(editorOf(container, login).querySelector<HTMLInputElement>(`[data-budget-input="${key}"]`), `the ${key} field`);

const button = (container: HTMLElement, label: string, login = 'claude-personal'): HTMLButtonElement =>
  must(
    Array.from(editorOf(container, login).querySelectorAll('button')).find(
      candidate => candidate.textContent?.trim() === label,
    ),
    `the "${label}" button`,
  );

const type = async (field: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const press = async (container: HTMLElement, label: string): Promise<void> => {
  await interact(() => button(container, label).click());
  await settle();
};

const writes = (calls: readonly RecordedCall[]): { readonly path: string; readonly text: string; readonly etag: string }[] =>
  calls
    .filter(call => call.route === PUT)
    .map(call => call.body as { path: string; text: string; etag: string });

const refusal = (status: number, code: string, message: string) => () => {
  throw new DaemonCallError(status, code, message);
};

describe('BudgetsSettings · the list', () => {
  it('meters every login with a budget, with its scope note', async () => {
    const { view } = await open();
    const personal = editorOf(view.container);
    const bars = Array.from(personal.querySelectorAll('[data-credential-budget] [role="img"]'));
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual([
      '$12.40 of $40.00 · resets Wed',
      '$150.01 of $200.00 · resets Mon',
    ]);
    expect(personal.textContent).toContain('Spent on studio-mac only');
    expect(personal.querySelector('[data-budget-held]')).toBeNull();
    await view.unmount();
  });

  it('says what the hold stops for a login over its budget', async () => {
    const { view } = await open();
    const work = editorOf(view.container, 'claude-work').querySelector('[data-budget-held]');
    expect(work?.textContent).toBe('Over budget — not routing');
    expect(work?.className).toContain('text-warn');
    const codex = editorOf(view.container, 'codex').querySelector('[data-budget-held]');
    expect(codex?.textContent).toBe('Hard limit — ferrets stopped');
    expect(codex?.className).toContain('text-err');
    await view.unmount();
  });

  it('names each login by its label, and says so when there are none', async () => {
    const { view } = await open();
    expect(
      Array.from(view.container.querySelectorAll('[data-budgets-login] > h4')).map(heading => heading.textContent),
    ).toEqual(['personal', 'codex', 'work']);
    await view.unmount();

    const none = fakeClient({ [LOGINS]: { format: 1, machine: 'studio-mac', logins: [] }, [STANDING]: { budgets: [] } });
    const empty = await mount(<BudgetsSettings connection={daemonConnection({ daemonId: 'studio' })} client={none} />);
    await settle();
    expect(empty.container.querySelector('[data-budgets-empty]')).not.toBeNull();
    await empty.unmount();
  });

  it('says why the budgets could not load', async () => {
    const client = fakeClient({ [LOGINS]: refusal(503, 'daemon_unreachable', 'the studio daemon is offline') });
    const view = await mount(<BudgetsSettings connection={daemonConnection({ daemonId: 'studio' })} client={client} />);
    await settle();
    expect(view.container.querySelector('[data-budgets-failed]')?.textContent).toBe(
      'Budgets could not load: the studio daemon is offline',
    );
    await view.unmount();
  });
});

describe('BudgetEditor · the fields', () => {
  it('fills the four fields from the budget and says where its zone comes from', async () => {
    const { view } = await open();
    const c = view.container;
    const editor = editorOf(c);
    expect(editor.querySelector('h4')?.textContent).toBe('Spend budget');
    expect(['dailyTrigger', 'dailyHard', 'weeklyTrigger', 'weeklyHard'].map(key => input(c, key).value)).toEqual([
      '40',
      '60',
      '200',
      '300',
    ]);
    expect(editor.querySelector('[data-budget-zone]')?.textContent).toBe(
      'Days reset at midnight, weeks on Monday, in America/New_York (written in usage.yaml).',
    );
    expect(editor.querySelector('[data-budget-problem]')).toBeNull();
    // Nothing to save until a field changes.
    expect(editor.querySelector('[data-change-submit]')).toBeNull();
    await view.unmount();
  });

  it('shows the meter and the unpriced, unmeasured notes with it', async () => {
    const { view } = await open({
      standing: standing(['claude-personal', budget({ unpriced: 2, measured: false })]),
    });
    const editor = editorOf(view.container);
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
    await view.unmount();
  });

  it('refuses a draft that is not dollars, or whose hard limit is below its trigger', async () => {
    const { view } = await open();
    const c = view.container;
    const editor = editorOf(c);
    await type(input(c, 'dailyTrigger'), 'lots');
    expect(editor.querySelector('[data-budget-problem]')?.textContent).toBe(
      'Give every limit as dollars above 0, like 40 or 12.50.',
    );
    await type(input(c, 'dailyTrigger'), '20');
    await type(input(c, 'dailyHard'), '10');
    expect(editor.querySelector('[data-budget-problem]')?.textContent).toBe(
      'The daily hard limit must not be below its trigger.',
    );
    expect(button(c, 'Save budget').disabled).toBe(true);
    // Undo puts the draft back as the daemon last said.
    await interact(() => button(c, 'Undo').click());
    expect(editor.querySelector('[data-budget-problem]')).toBeNull();
    expect(input(c, 'dailyTrigger').value).toBe('40');
    await view.unmount();
  });
});

describe('BudgetEditor · saving', () => {
  it('writes the budget key and, the first time, the device zone, in one usage.yaml write', async () => {
    const { view, client } = await open({ standing: [], fileText: '# usage\nnote: kept\n' });
    const c = view.container;
    expect(editorOf(c).querySelector('[data-budget-zone]')?.textContent).toContain('counted in your zone');
    await type(input(c, 'dailyTrigger'), '10');
    await press(c, 'Save budget');

    const [write] = writes(client.calls);
    expect(writes(client.calls)).toHaveLength(1);
    expect(write?.path).toBe(USAGE_FILE);
    // One key at a time: the comment and the other keys survive, the zone and the budget are added.
    expect(write?.text).toContain('# usage');
    expect(write?.text).toContain('note: kept');
    expect(write?.text).toContain('timeZone: Asia/Tokyo');
    expect(write?.text).toContain('trigger: 10');
    expect(write?.etag).toBe('etag-usage-1');
    expect(editorOf(c).querySelector('[data-budget-save="applied"]')?.textContent).toBe('In effect');
    // The standing was read again so the meter shows what is in effect.
    expect(client.calls.filter(call => call.route === STANDING).length).toBeGreaterThan(1);
    await view.unmount();
  });

  it('keeps every other login, and the zone, when it changes one login’s budget', async () => {
    const { view, client } = await open();
    await type(input(view.container, 'dailyTrigger'), '30');
    await press(view.container, 'Save budget');
    const [write] = writes(client.calls);
    expect(write?.text).toContain('# usage');
    expect(write?.text).toContain('timeZone: America/New_York');
    expect(write?.text).toContain('trigger: 30');
    expect(write?.text).not.toContain('trigger: 40');
    expect(write?.text).toContain('hard: 300');
    await view.unmount();
  });

  it('holds a loosening for the owner and confirms it by its digest', async () => {
    const { view, client } = await open({
      put: held('etag-usage-2', 'this login may spend more each day'),
    });
    const c = view.container;
    await type(input(c, 'dailyHard'), '90');
    await press(c, 'Save budget');
    expect(editorOf(c).querySelector('[data-budget-save="pending"]')?.textContent).toContain(
      'Saved — waiting for your confirmation: this login may spend more each day',
    );
    // The save row stands down while an edit waits.
    expect(editorOf(c).querySelector('[data-change-submit]')).toBeNull();

    await press(c, 'Confirm');
    expect(client.calls.filter(call => call.route === CONFIRM).map(call => call.body)).toEqual([
      { path: USAGE_FILE, etag: 'etag-usage-2' },
    ]);
    expect(editorOf(c).querySelector('[data-budget-save="applied"]')?.textContent).toBe('In effect');
    await view.unmount();
  });

  it('shows a first zone the daemon held, and confirms it — a zone can never move a day unseen', async () => {
    // The first timeZone is a loosening too: the daemon holds the write, and the editor must say so.
    const { view, client } = await open({
      standing: [],
      fileText: '# usage\n',
      put: held('etag-usage-2', "budgets now reset in Asia/Tokyo instead of the host's time zone"),
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '10');
    await press(c, 'Save budget');
    expect(editorOf(c).querySelector('[data-budget-save="pending"]')?.textContent).toContain(
      "Saved — waiting for your confirmation: budgets now reset in Asia/Tokyo instead of the host's time zone",
    );
    await press(c, 'Confirm');
    expect(client.calls.filter(call => call.route === CONFIRM).map(call => call.body)).toEqual([
      { path: USAGE_FILE, etag: 'etag-usage-2' },
    ]);
    expect(editorOf(c).querySelector('[data-budget-save="applied"]')?.textContent).toBe('In effect');
    await view.unmount();
  });

  it('says when the edit it confirmed is no longer the one waiting', async () => {
    const { view } = await open({
      put: held('etag-usage-2', 'this login may spend more each day'),
      confirm: { path: USAGE_FILE, confirmed: false },
    });
    const c = view.container;
    await type(input(c, 'dailyHard'), '90');
    await press(c, 'Save budget');
    await press(c, 'Confirm');
    expect(editorOf(c).querySelector('[data-budget-confirm-failed]')?.textContent).toContain(
      'no longer the one waiting',
    );
    await view.unmount();
  });

  it('says a confirm the daemon refused in the daemon’s own words', async () => {
    const { view } = await open({
      put: held('etag-usage-2', 'this login may spend more each day'),
      confirm: refusal(403, 'step_up_required', 'this device may not confirm'),
    });
    const c = view.container;
    await type(input(c, 'dailyHard'), '90');
    await press(c, 'Save budget');
    await press(c, 'Confirm');
    expect(editorOf(c).querySelector('[data-budget-confirm-failed]')?.textContent).toBe('this device may not confirm');
    await view.unmount();
  });

  it('says a conflict plainly and saves nothing', async () => {
    const { view, client } = await open({
      put: refusal(409, 'config_conflict', 'usage.yaml changed since it was read'),
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '30');
    await press(c, 'Save budget');
    expect(editorOf(c).querySelector('[data-budget-save="conflict"]')?.textContent).toContain('changed on the machine');
    expect(client.calls.filter(call => call.route === CONFIRM)).toEqual([]);
    await view.unmount();
  });

  it('never overwrites a usage.yaml that does not parse, or is not a mapping of keys', async () => {
    const broken = await open({ fileText: 'budgets: [unclosed\n' });
    await type(input(broken.view.container, 'dailyTrigger'), '30');
    await press(broken.view.container, 'Save budget');
    expect(editorOf(broken.view.container).querySelector('[data-budget-save="failed"]')?.textContent).toContain(
      'usage.yaml does not parse',
    );
    expect(writes(broken.client.calls)).toEqual([]);
    await broken.view.unmount();

    const list = await open({ fileText: '- only\n- a list\n' });
    await type(input(list.view.container, 'dailyTrigger'), '30');
    await press(list.view.container, 'Save budget');
    expect(editorOf(list.view.container).querySelector('[data-budget-save="failed"]')?.textContent).toContain(
      'usage.yaml could not be edited',
    );
    expect(writes(list.client.calls)).toEqual([]);
    await list.view.unmount();
  });

  it('removes the budget when every field is emptied', async () => {
    const { view, client } = await open();
    const c = view.container;
    for (const key of ['dailyTrigger', 'dailyHard', 'weeklyTrigger', 'weeklyHard']) await type(input(c, key), '');
    await press(c, 'Remove budget');
    const [write] = writes(client.calls);
    expect(write?.text).not.toContain('budgets');
    expect(write?.text).toContain('timeZone: America/New_York');
    await view.unmount();
  });

  it('says a failure that is not about the file in the machine’s own words', async () => {
    const { view } = await open({ put: refusal(503, 'daemon_unreachable', 'the studio daemon is offline') });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '30');
    await press(c, 'Save budget');
    expect(editorOf(c).querySelector('[data-budget-save="failed"]')?.textContent).toBe(
      'Nothing was saved. the studio daemon is offline',
    );
    await view.unmount();
  });

  it('shows the daemon’s sentence when a write is refused as invalid', async () => {
    const { view } = await open({
      put: refusal(422, 'config_invalid', 'usage.yaml:3: unknown key "spend"'),
    });
    const c = view.container;
    await type(input(c, 'dailyTrigger'), '30');
    await press(c, 'Save budget');
    expect(editorOf(c).querySelector('[data-budget-save="invalid"]')?.textContent).toBe(
      'usage.yaml:3: unknown key "spend"',
    );
    await view.unmount();
  });
});
