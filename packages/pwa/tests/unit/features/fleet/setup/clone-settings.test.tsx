import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactElement } from 'react';
import {
  CloneItemsChoices,
  CloneLoginsSection,
  CloneNeedsList,
  CloneOutcomes,
} from '../../../../../src/features/fleet/setup/clone-settings.tsx';
import {
  CLONE_ITEMS,
  type CloneItem,
  type CloneItemId,
  type CloneItemOutcome,
  type CloneLogin,
  type CloneNeed,
} from '../../../../../src/features/fleet/setup/clone-settings-model.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';

const mounts: Mounted[] = [];
afterEach(async () => {
  for (const view of mounts.splice(0)) await view.unmount();
});

const show = async (element: ReactElement): Promise<Mounted> => {
  const view = await mount(element);
  mounts.push(view);
  return view;
};

const q = (view: Mounted, selector: string): Element | null => view.container.querySelector(selector);
const text = (view: Mounted): string => view.container.textContent ?? '';

const type = async (input: Element, value: string): Promise<void> => {
  await interact(() => {
    const element = input as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const secretNeed = (overrides: Partial<CloneNeed> = {}): CloneNeed => ({
  key: 'secret:JEV_API_KEY',
  kind: 'secret',
  name: 'JEV_API_KEY',
  secretName: 'JEV_API_KEY',
  why: 'the Warden’s Jev guard',
  held: false,
  ...overrides,
});

const signInNeed = (overrides: Partial<CloneNeed> = {}): CloneNeed => ({
  key: 'sign-in:claude-work',
  kind: 'sign-in',
  name: 'Claude Code login (claude-work)',
  credentialId: 'claude-work',
  why: 'me@work.example',
  held: false,
  ...overrides,
});

const item = (id: CloneItemId): CloneItem => CLONE_ITEMS.find(candidate => candidate.id === id) as CloneItem;

describe('CloneItemsChoices', () => {
  const choices = (overrides: Partial<Parameters<typeof CloneItemsChoices>[0]> = {}) => (
    <CloneItemsChoices
      chosen={['fleet', 'warden']}
      summaries={{ warden: 'triage: jev', fleet: '2 profiles' }}
      unavailable={{}}
      source="work-linux"
      onToggle={() => undefined}
      {...overrides}
    />
  );

  it('lists every item that can be copied, names the source and shows each one-line summary', async () => {
    const view = await show(choices());
    for (const clone of CLONE_ITEMS) {
      expect(q(view, `[data-setup-choice="${clone.id}"]`)).not.toBeNull();
      expect(text(view)).toContain(clone.label);
    }
    expect(text(view)).toContain('work-linux');
    const summaries = [...view.container.querySelectorAll('[data-clone-item-summary]')].map(node => node.textContent);
    expect(summaries).toEqual(['2 profiles', 'triage: jev']);
    expect((must(q(view, '[data-setup-choice="fleet"] input'), 'fleet box') as HTMLInputElement).checked).toBe(true);
    expect((must(q(view, '[data-setup-choice="voice"] input'), 'voice box') as HTMLInputElement).checked).toBe(false);
  });

  it('disables an item that could not be read and says why', async () => {
    const view = await show(choices({ unavailable: { voice: 'voice.yaml could not be read.' } }));
    const box = must(q(view, '[data-setup-choice="voice"] input'), 'voice box') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(must(q(view, '[data-clone-item-unavailable="voice"]'), 'reason').textContent).toBe(
      'voice.yaml could not be read.',
    );
    expect((must(q(view, '[data-setup-choice="learning"] input'), 'learning box') as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(q(view, '[data-clone-item-unavailable="learning"]')).toBeNull();
  });

  it('reports a toggle with the item and whether it is now on', async () => {
    const toggles: [CloneItemId, boolean][] = [];
    const view = await show(choices({ onToggle: (id, on) => toggles.push([id, on]) }));
    await interact(() =>
      (must(q(view, '[data-setup-choice="learning"] input'), 'learning box') as HTMLElement).click(),
    );
    await interact(() => (must(q(view, '[data-setup-choice="warden"] input'), 'warden box') as HTMLElement).click());
    expect(toggles).toEqual([
      ['learning', true],
      ['warden', false],
    ]);
  });
});

describe('CloneNeedsList', () => {
  const onAddNothing = async (): Promise<string | null> => null;

  it('says so when the copied settings need nothing', async () => {
    const view = await show(<CloneNeedsList needs={[]} machineName="studio-mac" onAdd={onAddNothing} />);
    expect(must(q(view, '[data-clone-needs-none]'), 'none line').textContent).toBe(
      'The copied settings need no secret and no sign-in.',
    );
    expect(q(view, '[data-clone-need]')).toBeNull();
  });

  it('says everything is already here when every need is held, and marks the row set', async () => {
    const view = await show(
      <CloneNeedsList needs={[secretNeed({ held: true })]} machineName="studio-mac" onAdd={onAddNothing} />,
    );
    expect(text(view)).toContain('Everything the copied settings need is already on studio-mac.');
    const row = must(q(view, '[data-clone-need="secret:JEV_API_KEY"]'), 'row');
    expect(row.getAttribute('data-held')).toBe('yes');
    expect(row.textContent).toContain('set ✓');
    expect(q(view, '[data-clone-need-value]')).toBeNull();
  });

  it('names what is missing and where an added value goes', async () => {
    const view = await show(
      <CloneNeedsList
        needs={[secretNeed(), signInNeed(), secretNeed({ key: 'secret:HELD', name: 'HELD', held: true })]}
        machineName="studio-mac"
        onAdd={onAddNothing}
      />,
    );
    expect(text(view)).toContain('The copied settings need: JEV_API_KEY, Claude Code login (claude-work).');
    expect(text(view)).toContain('studio-mac’s secret store and is never shown again');
    expect(must(q(view, '[data-clone-need="secret:JEV_API_KEY"]'), 'secret row').getAttribute('data-held')).toBe('no');
    expect(must(q(view, '[data-clone-need="secret:HELD"]'), 'held row').textContent).toContain('set ✓');
  });

  it('tells a sign-in row to sign in after copying when there is no sign-in action yet', async () => {
    const view = await show(<CloneNeedsList needs={[signInNeed()]} machineName="studio-mac" onAdd={onAddNothing} />);
    expect(must(q(view, '[data-clone-need="sign-in:claude-work"]'), 'row').textContent).toContain(
      'Sign in after copying',
    );
    expect(q(view, '[data-clone-need-value]')).toBeNull();
  });

  it('renders the sign-in action when one is given, and the plain line when it returns nothing', async () => {
    const view = await show(
      <CloneNeedsList
        needs={[signInNeed(), signInNeed({ key: 'sign-in:other', credentialId: 'other', name: 'Codex login (other)' })]}
        machineName="studio-mac"
        onAdd={onAddNothing}
        signIn={need =>
          need.credentialId === 'claude-work' ? (
            <button type="button" data-sign-in={need.credentialId}>
              Sign in
            </button>
          ) : null
        }
      />,
    );
    expect(must(q(view, '[data-sign-in="claude-work"]'), 'sign-in button').textContent).toBe('Sign in');
    const other = must(q(view, '[data-clone-need="sign-in:other"]'), 'other row');
    expect(other.textContent).toContain('Sign in after copying');
    expect(other.querySelector('[data-sign-in]')).toBeNull();
  });

  it('points a speed-up need with no secret name to Settings › Speed-ups', async () => {
    const view = await show(
      <CloneNeedsList
        needs={[secretNeed({ key: 'secret:jev key', name: 'jev key', secretName: undefined })]}
        machineName="studio-mac"
        onAdd={onAddNothing}
      />,
    );
    expect(must(q(view, '[data-clone-need="secret:jev key"]'), 'row').textContent).toContain(
      'Add it in Settings › Speed-ups',
    );
    expect(q(view, 'input')).toBeNull();
  });

  it('offers a password field whose Add is off while empty and stores the typed value under the secret’s name', async () => {
    const added: [string, string][] = [];
    const view = await show(
      <CloneNeedsList
        needs={[secretNeed()]}
        machineName="studio-mac"
        onAdd={async (name, value) => {
          added.push([name, value]);
          return null;
        }}
      />,
    );
    const input = must(q(view, '[data-clone-need-value="JEV_API_KEY"]'), 'field') as HTMLInputElement;
    const add = must(q(view, '[data-clone-need-add="JEV_API_KEY"]'), 'add') as HTMLButtonElement;
    expect(input.type).toBe('password');
    expect(add.disabled).toBe(true);
    await type(input, '   ');
    expect(add.disabled).toBe(true);
    await type(input, 'test-value-not-a-key');
    expect(add.disabled).toBe(false);
    await interact(() => add.click());
    expect(added).toEqual([['JEV_API_KEY', 'test-value-not-a-key']]);
    expect(input.value).toBe('');
    expect(add.disabled).toBe(true);
    expect(q(view, '[role="alert"]')).toBeNull();
  });

  it('shows Adding… while the value is being stored', async () => {
    let finish: (failure: string | null) => void = () => undefined;
    const view = await show(
      <CloneNeedsList
        needs={[secretNeed()]}
        machineName="studio-mac"
        onAdd={() => new Promise<string | null>(resolve => (finish = resolve))}
      />,
    );
    const input = must(q(view, '[data-clone-need-value]'), 'field') as HTMLInputElement;
    await type(input, 'test-value-not-a-key');
    const add = must(q(view, '[data-clone-need-add]'), 'add') as HTMLButtonElement;
    await interact(() => add.click());
    expect(add.textContent).toBe('Adding…');
    expect(add.disabled).toBe(true);
    await interact(() => finish(null));
    expect(add.textContent).toBe('Add');
  });

  it('shows the returned sentence as an alert and keeps the value when storing fails', async () => {
    const view = await show(
      <CloneNeedsList
        needs={[secretNeed()]}
        machineName="studio-mac"
        onAdd={async () => 'This machine refused to store the value.'}
      />,
    );
    const input = must(q(view, '[data-clone-need-value]'), 'field') as HTMLInputElement;
    await type(input, 'test-value-not-a-key');
    await interact(() => (must(q(view, '[data-clone-need-add]'), 'add') as HTMLButtonElement).click());
    expect(must(q(view, '[role="alert"]'), 'alert').textContent).toBe('This machine refused to store the value.');
    expect(input.value).toBe('test-value-not-a-key');
  });

  it('never shows the typed value as text', async () => {
    const view = await show(<CloneNeedsList needs={[secretNeed()]} machineName="studio-mac" onAdd={onAddNothing} />);
    await type(must(q(view, '[data-clone-need-value]'), 'field'), 'test-value-not-a-key');
    expect(text(view)).not.toContain('test-value-not-a-key');
  });
});

describe('CloneOutcomes', () => {
  const pending = (path: string): CloneItemOutcome => ({
    kind: 'pending',
    path,
    etag: `etag-${path}`,
    changes: ['agents may now edit Ferretry settings'],
  });

  it('says how each item ended, in its own tone', async () => {
    const view = await show(
      <CloneOutcomes
        outcomes={[
          { item: item('warden'), outcome: pending('warden.yaml') },
          { item: item('learning'), outcome: { kind: 'copied' } },
          { item: item('voice'), outcome: { kind: 'refused', reason: 'voice.yaml does not check.' } },
        ]}
        onConfirm={async () => null}
      />,
    );
    expect(must(q(view, '[data-clone-outcome="warden"]'), 'warden').getAttribute('data-outcome')).toBe('pending');
    expect(must(q(view, '[data-clone-outcome="warden"]'), 'warden').textContent).toBe(
      'Warden: copied, and waiting for your confirmation because it loosens something: agents may now edit Ferretry settings.',
    );
    expect(must(q(view, '[data-clone-outcome="learning"]'), 'learning').textContent).toBe(
      'Learning defaults: copied, in effect now.',
    );
    expect(must(q(view, '[data-clone-outcome="voice"]'), 'voice').textContent).toBe(
      'Voice clean-up: not copied. voice.yaml does not check.',
    );
    expect(must(q(view, '[data-setup-note="clone-outcome-warden"]'), 'note').getAttribute('data-tone')).toBe('warn');
    expect(must(q(view, '[data-setup-note="clone-outcome-learning"]'), 'note').getAttribute('data-tone')).toBe('ok');
    expect(must(q(view, '[data-setup-note="clone-outcome-voice"]'), 'note').getAttribute('data-tone')).toBe('err');
  });

  it('offers Confirm only on the one waiting for the owner', async () => {
    const view = await show(
      <CloneOutcomes
        outcomes={[
          { item: item('warden'), outcome: pending('warden.yaml') },
          { item: item('learning'), outcome: { kind: 'copied' } },
          { item: item('voice'), outcome: { kind: 'refused', reason: 'no' } },
        ]}
        onConfirm={async () => null}
      />,
    );
    expect(view.container.querySelectorAll('[data-clone-confirm]')).toHaveLength(1);
    expect(q(view, '[data-clone-confirm="warden.yaml"]')).not.toBeNull();
    expect(text(view)).toContain('Or run fy config confirm on the machine.');
  });

  it('confirms with the path and digest, then reads as copied with no Confirm left', async () => {
    const confirmed: [string, string][] = [];
    const view = await show(
      <CloneOutcomes
        outcomes={[{ item: item('warden'), outcome: pending('warden.yaml') }]}
        onConfirm={async (path, etag) => {
          confirmed.push([path, etag]);
          return null;
        }}
      />,
    );
    await interact(() => (must(q(view, '[data-clone-confirm]'), 'confirm') as HTMLElement).click());
    expect(confirmed).toEqual([['warden.yaml', 'etag-warden.yaml']]);
    expect(q(view, '[data-clone-confirm]')).toBeNull();
    const line = must(q(view, '[data-clone-outcome="warden"]'), 'warden');
    expect(line.getAttribute('data-outcome')).toBe('copied');
    expect(line.textContent).toBe('Warden: copied, in effect now.');
    expect(must(q(view, '[data-setup-note="clone-outcome-warden"]'), 'note').getAttribute('data-tone')).toBe('ok');
  });

  it('shows the refusal sentence and keeps Confirm when confirming fails', async () => {
    const view = await show(
      <CloneOutcomes
        outcomes={[{ item: item('warden'), outcome: pending('warden.yaml') }]}
        onConfirm={async () => 'A passkey is needed to confirm.'}
      />,
    );
    await interact(() => (must(q(view, '[data-clone-confirm]'), 'confirm') as HTMLElement).click());
    expect(must(q(view, '[role="alert"]'), 'alert').textContent).toBe('A passkey is needed to confirm.');
    expect(q(view, '[data-clone-confirm="warden.yaml"]')).not.toBeNull();
    expect(must(q(view, '[data-clone-outcome="warden"]'), 'warden').getAttribute('data-outcome')).toBe('pending');
    expect(text(view)).not.toContain('Or run fy config confirm');
  });
});

describe('CloneLoginsSection', () => {
  const apiKey = (id: string, keys: Array<{ name: string; held: boolean }>): CloneLogin => ({
    kind: 'api-key',
    id,
    harness: 'claude',
    name: id,
    keys,
  });
  const row = (view: Mounted, id: string): string =>
    must(q(view, `[data-setup-row="login-${id}"]`), id).textContent ?? '';
  const section = (logins: readonly CloneLogin[], keys: readonly string[] = [], copyKeys = false) => (
    <CloneLoginsSection
      logins={logins}
      machineName="studio-mac"
      sourceName="work-mac"
      keys={keys}
      copyKeys={copyKeys}
      onCopyKeys={() => undefined}
    />
  );

  it('draws nothing when the copy brings no login and no key', async () => {
    const view = await show(section([]));
    expect(q(view, '[data-setup-row]')).toBeNull();
  });

  it('says an API-key login with no secret just copies, and one whose keys are all here has its key already', async () => {
    const view = await show(
      section([apiKey('cloud-env', []), apiKey('glm-env', [{ name: 'ZAI_API_KEY', held: true }])]),
    );
    expect(row(view, 'cloud-env')).toContain('Copies');
    expect(row(view, 'cloud-env')).toContain('Claude Code · API-key login with no secret to send');
    expect(row(view, 'glm-env')).toContain('Key already here');
    expect(row(view, 'glm-env')).toContain('Claude Code · API key ZAI_API_KEY (already on studio-mac)');
  });

  it('says whether the key travels with the copy, and that a sign-in never does', async () => {
    const logins = [
      apiKey('sealed', [{ name: 'SEALED_KEY', held: false }]),
      {
        kind: 'sign-in',
        id: 'work',
        harness: 'codex',
        name: 'me@work.example',
      } satisfies CloneLogin,
    ];
    const sending = await show(section(logins, ['SEALED_KEY'], true));
    expect(row(sending, 'sealed')).toContain('Copies with its key');
    expect(row(sending, 'work')).toContain('Sign in on studio-mac');
    const holding = await show(section(logins, ['SEALED_KEY'], false));
    expect(row(holding, 'sealed')).toContain('Copies, add its key');
  });
});
