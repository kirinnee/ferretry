/**
 * Runtimes' clone review sheet and key choices, parity with today's `clone-review.tsx` and `clone-settings-keys.tsx`
 * (docs/design/rebuild-parity.tsv, owner `runtimes`, kind S). One test per screen state, its title naming every row it
 * proves.
 *
 * Proved here, by drawing 5.0's own pieces (`app/features/fleet/setup/copy-*`) over a scripted source and target:
 *   S-0058 the review sheet of a repeat copy, S-0494 / S-0563 / S-0564 the choice of a settings key.
 * NOT proved, because the behaviour is not on the 5.0 screen: S-0057 and S-0495 (the keys that travel sealed with the
 * logins, and the command that replaces a newer key), S-0060 (the here-beside-the-source compare of an item both
 * machines changed), S-0098 (the line diff of a changed document) and S-0189 (the provider-key runtime of the harness
 * step). See the runtimes ports-pending line.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { DaemonReach } from '@ferretry/app';
import type { ReactNode } from 'react';
import type { CloneReview } from '../../../contract/index.ts';
import { CopySettings } from '../../../app/features/fleet/setup/copy-settings.tsx';
import { useAccountChanges } from '../../../app/features/fleet/shell/apply-change-panel.tsx';
import type { RuntimesClient } from '../../../app/lib/client.ts';
import { type Call, machine, scripted, stagedFrom } from '../app/features/fleet/account-support.ts';

const BUNDLE: Record<string, unknown> = {
  format: 'ferretry-clone',
  version: 1,
  machine: 'work-mac',
  daemon: 'fy_daemon_source',
  exportedAt: '2026-11-14T09:00:00.000Z',
  credentials: [],
  components: {},
  profiles: {},
  runtimes: {},
  files: [],
  notCopied: [],
  keys: {},
};

const review = (overrides: Partial<CloneReview>): CloneReview => ({
  mode: 'update',
  source: { name: 'work-mac', verified: 'browser' },
  items: [],
  settings: [],
  logins: [],
  keys: [],
  same: { count: 0, probable: 0 },
  fingerprint: 'fp-1',
  ...overrides,
});

const item = (ref: string, overrides: Partial<CloneReview['items'][number]> = {}): CloneReview['items'][number] => ({
  ref,
  kind: 'profile',
  outcome: 'theirs',
  match: 'key',
  choice: 'take',
  files: [],
  ...overrides,
});

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

const reach = (client: RuntimesClient): DaemonReach =>
  ({ daemon: 'src', machine: 'work-mac', online: true, locked: false, client }) as unknown as DaemonReach;

function Harness({
  client,
  reaches,
}: {
  readonly client: RuntimesClient;
  readonly reaches: readonly DaemonReach[];
}): ReactNode {
  const changes = useAccountChanges({ client });
  return <CopySettings client={client} machineName="studio" hasSetup={true} changes={changes} reaches={reaches} />;
}

const click = async (root: HTMLElement, selector: string): Promise<void> =>
  interact(() => (must(root.querySelector(selector), selector) as HTMLElement).click());

/** Walks the copy to its review for `answer`; the source shows no settings file, so its settings are read as empty. */
const toReview = async (answer: CloneReview): Promise<{ root: HTMLElement; calls: Call[] }> => {
  const calls: Call[] = [];
  const source = scripted({
    'GET /v1/runtimes/export': BUNDLE,
    'GET /v1/runtimes/machine': machine(),
    'GET /v1/config/file': { path: 'x', exists: true, text: 'a: b\n', etag: 'e', issues: [] },
    'GET /v1/secrets': new Error('no listing'),
  });
  const target = scripted(
    {
      'GET /v1/runtimes/machine': machine(),
      'POST /v1/runtimes/clone/review': answer,
      'POST /v1/runtimes/proposals': (call: Call) => ({
        ...stagedFrom(call),
        summary: 'Update from another machine’s setup',
        consequences: [],
        preview: { kind: 'executor', executor: 'clone', description: 'The copy.' },
      }),
    },
    calls,
  );
  const view = await mount(<Harness client={target} reaches={[reach(source)]} />);
  mounted.push(view);
  const root = view.container;
  await click(root, '[data-copy-source] input[type="radio"]');
  await click(root, '[data-copy-read]');
  await settleUntil(
    () => root.querySelector('[data-copy-review]') !== null,
    () => `the review drew; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return { root, calls };
};

const stage = async (root: HTMLElement): Promise<void> => {
  await click(root, '[data-copy-stage]');
  await settleUntil(
    () => root.querySelector('[data-copy-confirm]') !== null,
    () => `the confirm drew; drew: ${root.textContent ?? ''}`,
    interact,
  );
};

const sentChange = (calls: readonly Call[]): Record<string, unknown> =>
  (
    must(
      calls.find(call => call.route === 'POST /v1/runtimes/proposals'),
      'the staged proposal',
    ).body as { change: Record<string, unknown> }
  ).change;

const stageButton = (root: HTMLElement): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('[data-copy-stage]'), 'Preview the copy');

describe('the clone review sheet of a repeat copy', () => {
  const SHEET = review({
    items: [
      item('mcp/notes', {
        kind: 'mcp',
        outcome: 'theirs',
        files: [{ path: 'mcp/notes.json', change: 'changed', lines: { added: 2, removed: 1 } }],
        runnable: {
          reference: 'mcp/notes',
          kind: 'mcp',
          name: 'notes',
          entries: [{ label: 'Starts', text: 'node ./new-server.js --verbose', document: false }],
        },
      }),
      item('profile/both', { outcome: 'both', choice: undefined as never }),
      item('profile/mine', { outcome: 'mine', choice: 'keep' as never }),
      item('hooks/gone', { kind: 'hooks', outcome: 'gone', choice: 'keep' as never }),
    ],
    logins: [
      { sourceId: 'work', outcome: 'matched', target: 'work-here' },
      { sourceId: 'side', outcome: 'ask', candidates: ['mine-a', 'mine-b'] },
      { sourceId: 'cli-login', outcome: 'slot' },
    ],
    same: { count: 3, probable: 1 },
  });

  it('S-0058 lists only what differs, says how each item stands, and keeps Preview off until a both-changed item is decided', async () => {
    const { root, calls } = await toReview(SHEET);
    // What differs: the counts, one panel per item, each with how it stands (v4's group headings, as words on the item).
    expect(root.querySelector('[data-copy-counts]')?.textContent).toContain('4 items');
    expect(root.querySelector('[data-copy-counts]')?.textContent).toContain('3 things already the same here');
    const stands = (ref: string): string => root.querySelector(`[data-copy-item="${ref}"]`)?.textContent ?? '';
    expect(stands('mcp/notes')).toContain('changed on the source');
    expect(stands('mcp/notes')).toContain('(+2 −1)');
    expect(stands('profile/both')).toContain('changed on both machines');
    expect(stands('profile/mine')).toContain('changed here, kept');
    expect(stands('hooks/gone')).toContain('the source no longer has it');
    // What would be written lists everything it runs, in full.
    expect(root.querySelector('[data-copy-runnable="mcp/notes"] [data-copy-command]')?.textContent).toBe(
      'node ./new-server.js --verbose',
    );
    // An item changed here only stays as it is here: nothing is ticked for it (5.0 lets the person tick it in).
    expect(root.querySelector<HTMLInputElement>('[data-copy-item-tick="profile/mine"]')?.checked).toBe(false);
    // Both changed has no default: neither radio starts chosen, Preview stays off, and the sheet says which to decide.
    const picks = [...root.querySelectorAll<HTMLInputElement>('[data-copy-item-choice="profile/both"] input')];
    expect(picks.map(pick => pick.checked)).toEqual([false, false]);
    expect(root.querySelector('[data-copy-item-choice="profile/both"]')?.textContent).toContain('decide this one');
    expect(stageButton(root).disabled).toBe(true);
    expect(root.querySelector('[data-copy-undecided]')?.textContent).toContain('profile/both');
    await click(root, '[data-copy-item-choice="profile/both"] [data-copy-item-pick="keep"]');
    expect(stageButton(root).disabled).toBe(false);
    await stage(root);
    expect(sentChange(calls)).toMatchObject({
      mode: 'update',
      decisions: { 'mcp/notes': 'take', 'profile/both': 'keep', 'profile/mine': 'keep' },
    });
  });

  it('S-0058 a login is only ever reused or added empty: no control removes one and nothing it holds is shown', async () => {
    const { root, calls } = await toReview(SHEET);
    const list = must(root.querySelector('[data-setup-section="copy-logins-list"]'), 'the Logins list');
    expect(list.querySelector('[data-copy-login="work"]')?.textContent).toContain('uses work-here');
    expect(list.querySelector('[data-copy-login="cli-login"]')?.textContent).toContain('an empty slot to sign in to');
    // The only control of a login is which login here it uses, and an empty slot is always one of its choices.
    expect(list.querySelectorAll('button').length).toBe(0);
    const select = must(list.querySelector<HTMLSelectElement>('[data-copy-login-pick="side"]'), 'the login choice');
    expect([...select.options].map(option => option.value)).toEqual(['mine-a', 'mine-b', 'slot']);
    await interact(() => {
      select.value = 'mine-b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(root, '[data-copy-item-choice="profile/both"] [data-copy-item-pick="take"]');
    await stage(root);
    expect(sentChange(calls)).toMatchObject({ logins: { side: 'mine-b' } });
  });
});

describe('the clone choice of a settings key', () => {
  const KEYS = review({
    settings: [
      {
        path: 'voice.yaml',
        keys: [
          { key: 'engine', outcome: 'both', mine: 'local', theirs: 'cloud' },
          { key: 'language', outcome: 'theirs', choice: 'take', mine: 'en', theirs: 'fr' },
          { key: 'newkey', outcome: 'new', choice: 'take', theirs: 'x' },
          { key: 'oldkey', outcome: 'gone', choice: 'take', mine: 'y' },
        ],
      },
    ],
  });

  it('S-0494 S-0563 a key both machines changed offers keeping this machine’s value or taking the source’s, with none chosen', async () => {
    const { root } = await toReview(KEYS);
    await click(root, '[data-copy-settings-tick="voice.yaml"]');
    const row = must(root.querySelector('[data-copy-settings-key="engine"]'), 'the engine key');
    // Both values are on the row, and the two choices are named for whose value each keeps.
    expect(row.textContent).toContain('local → cloud');
    const labels = [...row.querySelectorAll('label')].map(label => label.textContent);
    expect(labels).toEqual(['Take work-mac’s', 'Keep mine']);
    expect([...row.querySelectorAll<HTMLInputElement>('input')].map(input => input.checked)).toEqual([false, false]);
    expect(row.textContent).toContain('decide this one');
    expect(stageButton(root).disabled).toBe(true);
    expect(root.querySelector('[data-copy-undecided]')?.textContent).toContain('voice.yaml: engine');
  });

  it('S-0494 S-0563 S-0564 each key’s choice is sent as made, and taking a key says what it does to this machine', async () => {
    const { root, calls } = await toReview(KEYS);
    await click(root, '[data-copy-settings-tick="voice.yaml"]');
    const line = (key: string): string => root.querySelector(`[data-copy-settings-key="${key}"]`)?.textContent ?? '';
    // What taking does (S-0564): a changed value is replaced, a key this machine lacks is added, a key the source
    // dropped is removed here too — each said on the row, whose take is checked by the review's own default.
    expect(line('language')).toContain('en → fr');
    expect(line('newkey')).toContain('unset here → x');
    expect(line('oldkey')).toContain('y → removed');
    for (const key of ['language', 'newkey', 'oldkey'])
      expect(
        root.querySelector<HTMLInputElement>(`[data-copy-settings-key="${key}"] [data-copy-key-choice="take"]`)
          ?.checked,
      ).toBe(true);
    await click(root, '[data-copy-settings-key="engine"] [data-copy-key-choice="keep"]');
    await click(root, '[data-copy-settings-key="language"] [data-copy-key-choice="keep"]');
    expect(stageButton(root).disabled).toBe(false);
    await stage(root);
    expect(sentChange(calls)).toMatchObject({
      settingsDecisions: { 'voice.yaml': { engine: 'keep', language: 'keep', newkey: 'take', oldkey: 'take' } },
    });
  });
});
