import { describe, expect, it } from 'bun:test';
import {
  MOVE_ACCOUNT_SLOT,
  NEW_FERRET_ACCOUNT_SLOT,
  isNewFerretAccountSlotProps,
  type ChosenFerretAccount,
} from '@ferretry/core-ferrets/contract';
import type { ReactTestInstance } from 'react-test-renderer';
import { run, runAsync } from '../support/react.ts';
import { page, StubPicker, summaryAt, type Harness } from './page-support.tsx';

/** The host element with this id: a composite that takes an `id` prop (the folder combobox) would match first. */
const input = (view: Harness['view'], id: string): ReactTestInstance => {
  const found = view.root.findAll(node => typeof node.type === 'string' && node.props.id === id).at(0);
  if (found === undefined) throw new Error(`missing element ${id}`);
  return found;
};

const change = (view: Harness['view'], id: string, value: string): void => {
  run(() => input(view, id).props.onChange({ target: { value } }));
};

const button = (view: Harness['view'], label: string): ReactTestInstance => {
  const found = view.root.findAll(node => node.type === 'button' && node.children.join('') === label).at(0);
  if (found === undefined) throw new Error(`missing button ${label}`);
  return found;
};

const fill = (view: Harness['view']): void => {
  change(view, 'fy-new-ferret-runtime', 'claude-auto-loge');
  change(view, 'fy-new-ferret-folder', '/work/ferretry');
  change(view, 'fy-new-ferret-prompt', 'Port the page');
};

const post = (h: Harness): { readonly body: unknown } | undefined =>
  h.calls.find(call => call.route === 'POST /v1/ferrets');

const CLAUDE: ChosenFerretAccount = {
  wrapper: 'claude-a',
  displayName: 'Claude A',
  kind: 'claude-code',
  defaultModel: 'opus',
  models: [
    { id: 'opus', available: true },
    { id: 'haiku', available: true },
    { id: 'sonnet-old', available: false },
  ],
};
const CODEX: ChosenFerretAccount = {
  ...CLAUDE,
  wrapper: 'codex-b',
  displayName: 'Codex B',
  kind: 'codex',
  defaultModel: null,
};

describe('NewFerretPage', () => {
  it('renders the typed fallback where no panel is contributed and keeps Create disabled until runtime, folder and prompt are present', () => {
    const { view } = page();

    expect(view.root.findByProps({ id: 'new-ferret-heading' }).children.join('')).toBe('New ferret');
    expect(input(view, 'fy-new-ferret-runtime').props.placeholder).toBe('e.g. claude-default');
    expect(input(view, 'fy-new-ferret-prompt').props.placeholder).toBe('Describe what you want the agent to do…');
    expect(button(view, 'Create ferret').props.disabled).toBeTrue();

    change(view, 'fy-new-ferret-runtime', 'claude-auto-loge');
    change(view, 'fy-new-ferret-prompt', 'Port the page');
    expect(button(view, 'Create ferret').props.disabled).toBeTrue();

    change(view, 'fy-new-ferret-folder', '/work/ferretry');
    expect(button(view, 'Create ferret').props.disabled).toBeFalse();
  });

  it('starts in fast mode only when the switch was pressed, and says what it costs on the form', async () => {
    const harness = page();
    const { view } = harness;
    expect(JSON.stringify(view.toJSON())).toContain('Fast mode can cost more.');
    fill(view);

    run(() => view.root.findByProps({ 'data-fast-switch': 'off' }).props.onClick());
    expect(view.root.findByProps({ 'data-fast-switch': 'on' }).props['aria-pressed']).toBeTrue();
    await runAsync(async () => button(view, 'Create ferret').props.onClick());
    expect(post(harness)?.body).toMatchObject({ fast: true });

    const untouched = page();
    fill(untouched.view);
    await runAsync(async () => button(untouched.view, 'Create ferret').props.onClick());
    expect(post(untouched)?.body).not.toHaveProperty('fast');
  });

  it('turns Fast off for a model with no fast mode, says why, and never sends fast for it', async () => {
    const account: ChosenFerretAccount = {
      ...CLAUDE,
      models: [
        { id: 'opus', label: 'Opus', available: true, fast: true },
        { id: 'haiku', label: 'Haiku', available: true, fast: false },
      ],
    };
    const harness = page({ panel: slot => <StubPicker account={account} slot={slot} /> });
    run(() => harness.view.root.findByProps({ 'data-stub-runtime': 'claude-a' }).props.onClick());
    // The runtime's own default (opus) has a fast mode: the switch works and fast is sent.
    expect(harness.view.root.findByProps({ 'data-fast-switch': 'off' }).props.disabled).toBeFalsy();
    run(() => harness.view.root.findByProps({ 'data-fast-switch': 'off' }).props.onClick());
    change(harness.view, 'fy-new-ferret-folder', '/work/x');
    change(harness.view, 'fy-new-ferret-prompt', 'Go');
    await runAsync(async () => button(harness.view, 'Create ferret').props.onClick());
    expect(post(harness)?.body).toMatchObject({ fast: true });

    // Typing a model that has none turns the switch off with the reason, and the request drops fast.
    const none = page({ panel: slot => <StubPicker account={account} slot={slot} /> });
    run(() => none.view.root.findByProps({ 'data-stub-runtime': 'claude-a' }).props.onClick());
    run(() => none.view.root.findByProps({ 'data-fast-switch': 'off' }).props.onClick());
    change(none.view, 'fy-new-ferret-model', 'haiku');
    expect(JSON.stringify(none.view.toJSON())).toContain('Haiku has no fast mode.');
    expect(none.view.root.findByProps({ 'data-fast-switch': 'off' }).props.disabled).toBeTrue();
    change(none.view, 'fy-new-ferret-folder', '/work/x');
    change(none.view, 'fy-new-ferret-prompt', 'Go');
    await runAsync(async () => button(none.view, 'Create ferret').props.onClick());
    expect(post(none)?.body).not.toHaveProperty('fast');
    expect(post(none)?.body).toMatchObject({ model: 'haiku' });
  });

  it('keeps Fast available for a model the panel could not say anything about', () => {
    const harness = page({ panel: slot => <StubPicker account={CLAUDE} slot={slot} /> });
    run(() => harness.view.root.findByProps({ 'data-stub-runtime': 'claude-a' }).props.onClick());
    expect(harness.view.root.findByProps({ 'data-fast-switch': 'off' }).props.disabled).toBeFalsy();
  });

  it('starts with Remote Control off, and sends it only when the Advanced options box was ticked', async () => {
    const harness = page();
    const box = (): ReactTestInstance => input(harness.view, 'fy-new-ferret-remote-control');
    expect(box().props.checked).toBeFalse();
    expect(box().props.disabled).toBeFalse();
    fill(harness.view);
    await runAsync(async () => button(harness.view, 'Create ferret').props.onClick());
    expect(post(harness)?.body).not.toHaveProperty('remoteControl');

    const ticked = page();
    fill(ticked.view);
    run(() => ticked.view.root.findByProps({ id: 'fy-new-ferret-remote-control' }).props.onChange());
    expect(ticked.view.root.findByProps({ id: 'fy-new-ferret-remote-control' }).props.checked).toBeTrue();
    await runAsync(async () => button(ticked.view, 'Create ferret').props.onClick());
    expect(post(ticked)?.body).toMatchObject({ remoteControl: true });
  });

  it('speaks the product, not the tool it replaced, and says what each mode means', () => {
    const { view } = page();
    const text = JSON.stringify(view.toJSON());

    expect(text).not.toMatch(/kteam|teammate|TUI|session/iu);
    expect(input(view, 'fy-new-ferret-label').props.placeholder).toBe('e.g. website-redesign');
    expect(text).toContain('what you want the agent to do');
    expect(view.root.findByProps({ 'data-new-ferret-mode-meaning': '' }).findAllByType('dt')).toHaveLength(2);
    expect(text).toContain('the agent works through your request on its own');
    expect(text).toContain('opens a live terminal you type into, like a chat');
  });

  it('names no model in the override box when no runtime has been chosen', () => {
    const { view } = page();
    expect(input(view, 'fy-new-ferret-model').props.placeholder).toBe('');
  });

  it('says why Create is unavailable, and wears the outline look until it is not', () => {
    const { view } = page();
    const reason = (): string => view.root.findByProps({ id: 'fy-new-ferret-create-blocker' }).children.join('');

    expect(reason()).toBe('Choose a runtime first.');
    expect(button(view, 'Create ferret').props['data-variant']).toBeUndefined();
    expect(button(view, 'Create ferret').props['aria-describedby']).toBe('fy-new-ferret-create-blocker');

    change(view, 'fy-new-ferret-runtime', 'claude-auto-default');
    expect(reason()).toBe('Choose the folder the agent works in first.');

    change(view, 'fy-new-ferret-folder', '/work/ferretry');
    expect(reason()).toBe('Say what you want the agent to do first.');

    change(view, 'fy-new-ferret-prompt', 'Tidy the README');
    expect(view.root.findAllByProps({ id: 'fy-new-ferret-create-blocker' })).toHaveLength(0);
    expect(button(view, 'Create ferret').props['data-variant']).toBe('primary');
    expect(button(view, 'Create ferret').props['aria-describedby']).toBeUndefined();
  });

  it('allows an interactive ferret without an opening message and changes the prompt copy with the mode', () => {
    const { view } = page();
    change(view, 'fy-new-ferret-runtime', 'codex-auto-loge');
    change(view, 'fy-new-ferret-folder', '/work/ferretry');

    run(() => button(view, 'interactive').props.onClick());

    expect(input(view, 'fy-new-ferret-prompt').props.placeholder).toBe('(optional) first message…');
    expect(JSON.stringify(view.toJSON())).toContain('Opening message (optional)');
    expect(button(view, 'Create ferret').props.disabled).toBeFalse();
  });

  it('starts through the route key with trimmed text and navigates to the ferret’s chat on this daemon', async () => {
    const harness = page();
    change(harness.view, 'fy-new-ferret-runtime', ' claude-auto-loge ');
    change(harness.view, 'fy-new-ferret-folder', ' /work/ferretry ');
    change(harness.view, 'fy-new-ferret-prompt', ' Port the page ');

    await runAsync(async () => {
      button(harness.view, 'Create ferret').props.onClick();
      await Promise.resolve();
    });

    expect(harness.calls.filter(call => call.route === 'POST /v1/ferrets')).toEqual([
      {
        route: 'POST /v1/ferrets',
        params: undefined,
        query: undefined,
        body: { runtime: 'claude-auto-loge', folder: '/work/ferretry', mode: 'auto', prompt: 'Port the page' },
        headers: { 'x-fy-request-id': expect.any(String) },
      },
    ]);
    expect(harness.navigated).toEqual(['/d/daemon%2Fa/ferrets/new-ferret/chat']);
  });

  it('shows a daemon failure and makes the form actionable again', async () => {
    const harness = page({ start: Object.assign(new Error('daemon refused start'), { status: 409 }) });
    fill(harness.view);

    await runAsync(async () => {
      button(harness.view, 'Create ferret').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.view.root.findByProps({ role: 'alert' }).children.join('')).toBe('daemon refused start');
    expect(button(harness.view, 'Create ferret').props.disabled).toBeFalse();
    expect(harness.navigated).toEqual([]);
  });

  it('resubmits the SAME draft after a lost answer with the same request id, and a changed draft with a new one', async () => {
    const harness = page({ start: new TypeError('fetch failed') });
    fill(harness.view);
    const submit = () =>
      runAsync(async () => {
        button(harness.view, 'Create ferret').props.onClick();
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
      });
    const requestIds = () =>
      harness.calls
        .filter(call => call.route === 'POST /v1/ferrets')
        .map(call => call.headers?.['x-fy-request-id'] ?? '');

    await submit();
    const firstAttempt = new Set(requestIds());
    // The answer was lost: the form is actionable again, and the unchanged draft is sent again as the same request.
    expect(button(harness.view, 'Create ferret').props.disabled).toBeFalse();
    await submit();
    expect(new Set(requestIds())).toEqual(firstAttempt);
    expect(firstAttempt.size).toBe(1);

    // A genuinely new draft is a new start.
    change(harness.view, 'fy-new-ferret-prompt', 'Port another page');
    await submit();
    expect(new Set(requestIds()).size).toBe(2);
  });

  it('refuses a runtime the daemon could not name before sending anything', async () => {
    const harness = page();
    change(harness.view, 'fy-new-ferret-runtime', 'Not A Runtime!');
    change(harness.view, 'fy-new-ferret-folder', '/work/ferretry');
    change(harness.view, 'fy-new-ferret-prompt', 'Go');

    await runAsync(async () => {
      button(harness.view, 'Create ferret').props.onClick();
      await Promise.resolve();
    });

    expect(post(harness)).toBeUndefined();
    expect(harness.view.root.findByProps({ role: 'alert' })).toBeDefined();
  });

  it('returns to the current daemon home for cancel, and sends back through onBack', () => {
    const { navigated, backed, view } = page();

    run(() => button(view, '← Home').props.onClick());
    run(() => button(view, 'Cancel').props.onClick());

    expect(backed).toEqual(['/d/daemon%2Fa']);
    expect(navigated).toEqual(['/d/daemon%2Fa']);
  });

  it('offers the folders ferrets were started in, newest first, with typing a path as the way out', async () => {
    const harness = page({
      list: [summaryAt('/work/old/', '2026-01-01T00:00:00Z'), summaryAt('/work/new', '2026-02-01T00:00:00Z')],
    });
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.calls.some(call => call.route === 'GET /v1/ferrets')).toBeTrue();
    expect(input(harness.view, 'fy-new-ferret-folder').props.placeholder).toBe(
      'Choose a folder, or type its full path',
    );
    // The typed text is what is sent, whatever was or was not offered.
    change(harness.view, 'fy-new-ferret-folder', '/somewhere/else');
    change(harness.view, 'fy-new-ferret-runtime', 'claude-a');
    change(harness.view, 'fy-new-ferret-prompt', 'Go');
    await runAsync(async () =>
      harness.view.root
        .findAll(n => n.type === 'button' && n.children.join('') === 'Create ferret')[0]
        ?.props.onClick(),
    );
    expect(post(harness)?.body).toMatchObject({ folder: '/somewhere/else' });
  });

  it('still starts when the ferret list cannot be read', async () => {
    const harness = page({ list: new Error('daemon unreachable') });
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input(harness.view, 'fy-new-ferret-folder').props.placeholder).toBe('Full path, e.g. /home/you/my-project');
    fill(harness.view);
    await runAsync(async () => button(harness.view, 'Create ferret').props.onClick());
    expect(harness.navigated).toEqual(['/d/daemon%2Fa/ferrets/new-ferret/chat']);
  });
});

describe('NewFerretPage › the offered runtime slot', () => {
  it('hands the contract’s props to whatever draws the slot, and no typed box beside a picker', () => {
    const harness = page({ panel: slot => <StubPicker account={CLAUDE} slot={slot} /> });
    const slot = harness.slot();
    expect(NEW_FERRET_ACCOUNT_SLOT).toBe('ferrets.new-ferret-account');
    expect(MOVE_ACCOUNT_SLOT).not.toBe(NEW_FERRET_ACCOUNT_SLOT);
    expect(isNewFerretAccountSlotProps(slot)).toBeTrue();
    expect(slot).toMatchObject({
      value: '',
      fallbackId: 'fy-new-ferret-runtime',
      labelId: 'fy-new-ferret-runtime-label',
      fallbackPlaceholder: 'e.g. claude-default',
    });
    expect(harness.view.root.findAllByProps({ id: 'fy-new-ferret-runtime' })).toHaveLength(0);
  });

  it('writes the proposed wrapper into the draft and starts on it', async () => {
    const harness = page({ panel: slot => <StubPicker account={CLAUDE} slot={slot} /> });
    run(() => harness.view.root.findByProps({ 'data-stub-runtime': 'claude-a' }).props.onClick());
    change(harness.view, 'fy-new-ferret-folder', '/work/x');
    change(harness.view, 'fy-new-ferret-prompt', 'Go');
    await runAsync(async () => button(harness.view, 'Create ferret').props.onClick());
    expect(post(harness)?.body).toMatchObject({ runtime: 'claude-a', folder: '/work/x' });
  });

  it('reads a chosen runtime’s models as SUGGESTIONS and leaves the model unset', async () => {
    const harness = page({ panel: slot => <StubPicker account={CLAUDE} slot={slot} /> });
    run(() => harness.view.root.findByProps({ 'data-stub-runtime': 'claude-a' }).props.onClick());
    const model = input(harness.view, 'fy-new-ferret-model');
    expect(model.props.placeholder).toBe('default: opus');
    const options = harness.view.root.findAllByType('option').map(option => option.props.value);
    expect(options).toEqual(['opus', 'haiku']);
    change(harness.view, 'fy-new-ferret-folder', '/work/x');
    change(harness.view, 'fy-new-ferret-prompt', 'Go');
    await runAsync(async () => button(harness.view, 'Create ferret').props.onClick());
    expect(post(harness)?.body).not.toHaveProperty('model');
  });

  it('drops the suggestions when the reader types another runtime over the chosen one', () => {
    const harness = page({ panel: slot => <StubPicker account={CLAUDE} slot={slot} /> });
    run(() => harness.view.root.findByProps({ 'data-stub-runtime': 'claude-a' }).props.onClick());
    expect(input(harness.view, 'fy-new-ferret-model').props.placeholder).toBe('default: opus');
    run(() => harness.slot()?.onValueChange('something-else'));
    expect(input(harness.view, 'fy-new-ferret-model').props.placeholder).toBe('');
  });

  it("lists a catalog login's models in a select, and starts on the one chosen", async () => {
    const catalog: ChosenFerretAccount = { ...CLAUDE, modelCatalog: { id: 'zai', label: 'Z.ai', customIds: false } };
    const harness = page({ panel: slot => <StubPicker account={catalog} slot={slot} /> });
    run(() => harness.view.root.findByProps({ 'data-stub-runtime': 'claude-a' }).props.onClick());
    const select = harness.view.root.findByType('select');
    expect(select.findAllByType('option').map(option => option.props.value)).toEqual([
      '',
      'opus',
      'haiku',
      'sonnet-old',
    ]);
    run(() => select.props.onChange({ target: { value: 'haiku' } }));
    change(harness.view, 'fy-new-ferret-folder', '/work/x');
    change(harness.view, 'fy-new-ferret-prompt', 'Go');
    await runAsync(async () => button(harness.view, 'Create ferret').props.onClick());
    expect(post(harness)?.body).toMatchObject({ runtime: 'claude-a', model: 'haiku' });
  });

  it('takes the Remote Control box away from a Codex runtime, says why, and never sends it', async () => {
    const harness = page({ panel: slot => <StubPicker account={CODEX} slot={slot} /> });
    run(() => harness.view.root.findByProps({ 'data-stub-runtime': 'codex-b' }).props.onClick());
    const box = harness.view.root.findByProps({ id: 'fy-new-ferret-remote-control' });
    expect(box.props.disabled).toBeTrue();
    expect(JSON.stringify(harness.view.toJSON())).toContain('Codex has no Remote Control.');
    run(() => box.props.onChange());
    change(harness.view, 'fy-new-ferret-folder', '/work/x');
    change(harness.view, 'fy-new-ferret-prompt', 'Go');
    await runAsync(async () => button(harness.view, 'Create ferret').props.onClick());
    expect(post(harness)?.body).not.toHaveProperty('remoteControl');
  });

  it('passes the Launch button’s runtime as a hint only, and starts nothing from it', () => {
    const harness = page({
      props: { initialAgent: 'codex-b' },
      panel: slot => <StubPicker account={CODEX} slot={slot} />,
    });
    expect(harness.slot()).toMatchObject({ preferred: 'codex-b', value: '' });
    expect(post(harness)).toBeUndefined();
    const plain = page({ panel: slot => <StubPicker account={CODEX} slot={slot} /> });
    expect(plain.slot()).not.toHaveProperty('preferred');
  });

  it('says in one sentence that no runtime can run a ferret, and why Create is unavailable', () => {
    const harness = page({ panel: slot => <StubPicker account={CODEX} noAccounts slot={slot} /> });
    const text = JSON.stringify(harness.view.toJSON());
    expect(text).toContain('No runtime on this machine can run ferrets yet.');
    expect(harness.view.root.findByProps({ id: 'fy-new-ferret-create-blocker' }).children.join('')).toBe(
      'No runtime can run a ferret yet — add one first.',
    );
  });

  it('opens the daemon’s Runtimes settings from the no-runtime notice', () => {
    const harness = page({ panel: slot => <StubPicker account={CODEX} noAccounts slot={slot} /> });
    run(() => button(harness.view, 'Create a runtime').props.onClick());
    expect(harness.navigated).toEqual(['/d/daemon%2Fa/settings/runtimes/runtimes']);
  });
});
