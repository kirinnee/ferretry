import { describe, expect, test } from 'bun:test';
import type React from 'react';
import { useState } from 'react';
import { type ModelChoice, ModelSelect } from '../../../src/ui/model-select.tsx';
import type { LocalModelsSnapshot } from '../../../src/ui/local-models-note.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const PULL = 'ollama pull gpt-oss:20b';

const SENTENCE = {
  found: 'Ollama has 2 models installed on this machine.',
  'not-running':
    'Ollama is not running at http://127.0.0.1:11434. Start it (open the Ollama app, or run: ollama serve), then check again.',
} as const;

const localModelsFixture = (state: keyof typeof SENTENCE): LocalModelsSnapshot => ({
  state,
  message: SENTENCE[state],
  pullCommand: PULL,
});

const MODELS: readonly ModelChoice[] = [
  { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', tier: 'fast', available: true, efforts: [] },
  { id: 'glm-5.3', label: 'GLM-5.3', tier: 'best', context: 1_000_000, available: true, efforts: ['low'] },
  { id: 'glm-old', label: 'GLM old', tier: 'balanced', available: false },
];

function Host({ customIds, initial = '', seen }: { customIds: boolean; initial?: string; seen: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <ModelSelect
      customIds={customIds}
      defaultModel="glm-5.3"
      id="model"
      models={MODELS}
      onChange={next => {
        seen.push(next);
        setValue(next);
      }}
      value={value}
    />
  );
}

/** The select box is a combobox button; its list opens in the document body, so the options are read from the document. */
const opened = async (container: HTMLElement): Promise<HTMLElement> => {
  const box = must(container.querySelector<HTMLElement>('[role="combobox"]'), 'the select box');
  await interact(() => box.click());
  return box;
};
const options = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const labelOf = (option: HTMLElement): string | null | undefined => option.querySelector('[data-label]')?.textContent;
const hintOf = (option: HTMLElement): string | null | undefined => option.querySelector('.fy-sb__hint')?.textContent;
const choose = async (container: HTMLElement, label: string): Promise<void> => {
  await opened(container);
  const option = must(
    options().find(candidate => labelOf(candidate) === label),
    `the option "${label}"`,
  );
  await interact(() => option.click());
};
const typeInto = (field: HTMLInputElement, value: string) =>
  interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('ModelSelect', () => {
  test('lists the catalog by tier, names the default first, and disables what the login cannot use', async () => {
    const screen = await mount(<Host customIds={false} seen={[]} />);
    await opened(screen.container);
    expect([...document.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label'))).toEqual([
      'Most capable',
      'Balanced',
      'Fast',
    ]);
    const listed = options();
    expect(labelOf(listed[0] as HTMLElement)).toBe('Login default (GLM-5.3)');
    expect(labelOf(listed[1] as HTMLElement)).toBe('GLM-5.3');
    expect(hintOf(listed[1] as HTMLElement)).toBe('default · 1M context');
    const old = must(
      listed.find(option => labelOf(option) === 'GLM old'),
      'the old model',
    );
    expect(old.getAttribute('aria-disabled')).toBe('true');
    expect(hintOf(old)).toBe('not on this login');
    expect(listed.some(option => labelOf(option) === 'Custom id…')).toBe(false);
    await screen.unmount();
  });

  test('offers a custom id box for a provider that takes any id, and goes back to the list', async () => {
    const seen: string[] = [];
    const screen = await mount(<Host customIds={true} seen={seen} />);
    await choose(screen.container, 'Custom id…');
    const field = must(screen.container.querySelector<HTMLInputElement>('input'), 'the custom box');
    await typeInto(field, 'bad id');
    expect(screen.container.textContent).toContain('One word');
    await typeInto(field, 'glm-next');
    await choose(screen.container, 'GLM-5.3-Flash');
    expect(screen.container.querySelector('input')).toBeNull();
    expect(seen).toEqual(['', 'bad id', 'glm-next', 'glm-5.3-flash']);
    await screen.unmount();
  });

  test('opens on the custom box for a value the list does not have, and lists an untiered one flat', async () => {
    const screen = await mount(<Host customIds={true} initial="glm-next" seen={[]} />);
    expect(must(screen.container.querySelector<HTMLInputElement>('input'), 'the custom box').value).toBe('glm-next');
    await screen.unmount();
    const flat = await mount(
      <ModelSelect
        customIds={false}
        defaultModel={null}
        id="m"
        models={[{ id: 'a', available: true }]}
        onChange={() => undefined}
        value=""
      />,
    );
    await opened(flat.container);
    expect(document.querySelectorAll('[role="group"]')).toHaveLength(0);
    expect(labelOf(options()[0] as HTMLElement)).toBe('Login default');
    await flat.unmount();
  });

  test('takes the caller’s id and name, so a visible label points at the box, and can be disabled', async () => {
    const screen = await mount(
      <ModelSelect
        customIds={false}
        defaultModel={null}
        disabled
        id="model-field"
        label="Investigation model"
        models={MODELS}
        onChange={() => undefined}
        value=""
      />,
    );
    const box = must(screen.container.querySelector<HTMLButtonElement>('#model-field'), 'the select box');
    expect(box.getAttribute('aria-label')).toBe('Investigation model');
    expect(box.disabled).toBe(true);
    await screen.unmount();
  });
});

describe('ModelSelect · models installed on this machine', () => {
  const INSTALLED: readonly ModelChoice[] = [
    { id: 'gpt-oss:20b', label: 'gpt-oss:20b', tier: 'best', available: true, efforts: [], local: true },
    { id: 'qwen3-coder:30b', label: 'qwen3-coder:30b', available: true, efforts: [], local: true },
  ];

  test('marks an installed model "installed here" and adds no note when models were found', async () => {
    const screen = await mount(
      <ModelSelect
        customIds={true}
        defaultModel="gpt-oss:20b"
        id="m"
        local={localModelsFixture('found')}
        models={INSTALLED}
        onChange={() => undefined}
        value=""
      />,
    );
    const box = await opened(screen.container);
    expect(options().map(option => [labelOf(option), hintOf(option) ?? null])).toEqual([
      ['Login default (gpt-oss:20b)', null],
      ['gpt-oss:20b', 'default · installed here'],
      ['qwen3-coder:30b', 'installed here'],
      ['Custom id…', null],
    ]);
    expect(box.getAttribute('aria-describedby')).toBeNull();
    expect(screen.container.querySelector('[data-local-models-note]')).toBeNull();
    await screen.unmount();
  });

  test('describes the select by the note when Ollama is not usable, joined to the caller’s own description', async () => {
    const screen = await mount(
      <ModelSelect
        aria-describedby="hint"
        customIds={true}
        defaultModel={null}
        id="m"
        local={localModelsFixture('not-running')}
        models={[{ id: 'gpt-oss:20b', label: 'gpt-oss:20b', available: true, efforts: [] }]}
        onChange={() => undefined}
        value=""
        write={async () => undefined}
      />,
    );
    const box = must(screen.container.querySelector('[role="combobox"]'), 'the select box');
    const note = must(screen.container.querySelector('[data-local-models-note="not-running"]'), 'the note');
    expect(box.getAttribute('aria-describedby')).toBe(`hint ${note.id}`);
    expect(note.textContent).toContain('Ollama is not running');
    expect(note.querySelector('[data-local-models-command]')?.textContent).toBe(PULL);
    await screen.unmount();
  });
});

describe('ModelSelect with a live model list', () => {
  const NOW = Date.parse('2026-11-24T12:00:00.000Z');
  const live = (over: Partial<NonNullable<React.ComponentProps<typeof ModelSelect>['live']>> = {}) => ({
    list: { fetchedAt: new Date(NOW - 3_600_000).toISOString(), complete: true, ids: ['glm-5.3', 'glm-6'] },
    now: NOW,
    providerLabel: 'Z.ai',
    ...over,
  });
  const Live = ({ liveProps }: { liveProps: ReturnType<typeof live> }) => (
    <ModelSelect
      customIds
      defaultModel="glm-5.3"
      id="model"
      live={liveProps}
      models={MODELS}
      onChange={() => undefined}
      value=""
    />
  );

  test('lists curated models, then "New from <provider>", then "Custom id…"; marks the curated model the key lacks', async () => {
    const screen = await mount(<Live liveProps={live()} />);
    await opened(screen.container);
    const labels = options().map(option => labelOf(option));
    expect(labels).toEqual(['Login default (GLM-5.3)', 'GLM-5.3', 'GLM old', 'GLM-5.3-Flash', 'glm-6', 'Custom id…']);
    expect(document.querySelector('[role="group"][aria-label="New from Z.ai"]')).not.toBeNull();
    const fresh = must(
      options().find(option => labelOf(option) === 'glm-6'),
      'the new model',
    );
    expect(hintOf(fresh)).toBe('not reviewed');
    expect(fresh.getAttribute('aria-disabled')).not.toBe('true');
    // The curated model the list lacks stays pickable (a provider may hide it from /models) and says so.
    const flash = must(
      options().find(option => labelOf(option) === 'GLM-5.3-Flash'),
      'the flash model',
    );
    expect(hintOf(flash)).toBe('not offered to this key');
    expect(flash.getAttribute('aria-disabled')).not.toBe('true');
    await screen.unmount();
  });

  test('a newer model in the list is offered and never becomes the default', async () => {
    const screen = await mount(<Live liveProps={live()} />);
    await opened(screen.container);
    expect(labelOf(options()[0] as HTMLElement)).toBe('Login default (GLM-5.3)');
    expect(
      options()
        .filter(option => hintOf(option)?.includes('default'))
        .map(option => labelOf(option)),
    ).toEqual(['GLM-5.3']);
    await screen.unmount();
  });

  test('says when the list is stale, and draws Refresh list only when the caller may press it', async () => {
    const stale = live({
      list: { fetchedAt: new Date(NOW - 3 * 86_400_000).toISOString(), complete: true, ids: ['glm-5.3'] },
    });
    const limited = await mount(<Live liveProps={stale} />);
    const line = must(limited.container.querySelector('[data-live-model-list]'), 'the list line');
    expect(line.getAttribute('data-live-model-list')).toBe('stale');
    expect(line.textContent).toContain('List out of date: read 3 days ago.');
    expect(limited.container.textContent).not.toContain('Refresh list');
    await limited.unmount();
    const runs: string[] = [];
    const allowed = await mount(
      <Live liveProps={{ ...stale, refresh: { run: () => runs.push('run'), busy: false } }} />,
    );
    const button = must(
      [...allowed.container.querySelectorAll('button')].find(b => b.textContent?.includes('Refresh list')),
      'Refresh list',
    );
    await interact(() => button.click());
    expect(runs).toEqual(['run']);
    await allowed.unmount();
  });

  test('a fresh list says so; no list and no way to ask draws nothing', async () => {
    const fresh = await mount(<Live liveProps={live()} />);
    expect(fresh.container.querySelector('[data-live-model-list]')?.getAttribute('data-live-model-list')).toBe('fresh');
    await fresh.unmount();
    const none = await mount(<Live liveProps={live({ list: undefined })} />);
    expect(none.container.querySelector('[data-live-model-list]')).toBeNull();
    await none.unmount();
  });
});
