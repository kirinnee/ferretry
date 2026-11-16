import { describe, expect, it } from 'bun:test';
import type { ProviderPresetView } from '../../../contract/index.ts';
import { PasteVariables } from '../../../app/features/paste-variables.tsx';
import type { Prefill } from '../../../app/lib/paste-model.ts';
import { interact, mount, must } from '../support/dom.ts';

// The paste screen (docs/provider-presets.md § Detect): what it shows is NAMES, the box empties the
// moment it is read, and a key's value never reaches the tree.

const preset = (overrides: Partial<ProviderPresetView> & { readonly id: string }): ProviderPresetView => ({
  label: overrides.id,
  harness: 'claude-code',
  summary: 'A provider.',
  docs: 'https://docs.example.test',
  origin: 'built-in',
  variables: [],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Free.' },
  quota: { source: 'none', note: 'n/a' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [{ harness: 'claude-code', offered: { available: true }, models: [] }],
  ...overrides,
});

const ZAI = preset({
  id: 'zai-glm',
  label: 'GLM / Z.ai',
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', required: true, allowEmpty: false, harnesses: ['claude-code'] },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'ZAI_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
  ],
  detect: { hosts: ['api.z.ai'], variables: ['ZAI_API_KEY'], keyPrefixes: [] },
});
const GATEWAY = preset({
  id: 'custom-gateway',
  label: 'Custom gateway',
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', required: true, allowEmpty: false, harnesses: ['claude-code'] },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'GATEWAY_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
  ],
});

const paste = async (view: { container: HTMLElement }, text: string): Promise<void> => {
  const field = must(view.container.querySelector('[data-paste-input]') as HTMLTextAreaElement | null, 'the box');
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await interact(() =>
    must(view.container.querySelector('[data-paste-read]') as HTMLButtonElement | null, 'Read').click(),
  );
};

describe('the paste screen', () => {
  it('recognises the provider in this browser, empties the box when it is read, and shows names only', async () => {
    const view = await mount(
      <PasteVariables presets={[ZAI, GATEWAY]} onBack={() => undefined} onContinue={() => undefined} />,
    );
    await paste(view, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4\nexport ZAI_API_KEY=sk-zai-very-secret');
    const c = view.container;
    expect(must(c.querySelector('[data-paste-input]') as HTMLTextAreaElement | null, 'the box').value).toBe('');
    expect(c.querySelector('[data-paste-result="zai-glm"]')).not.toBeNull();
    expect(c.querySelector('[data-paste-detected]')?.textContent).toBe(
      'Looks like GLM / Z.ai — from ANTHROPIC_BASE_URL (api.z.ai) · ZAI_API_KEY',
    );
    // The key's value is never rendered anywhere in the tree.
    expect(c.innerHTML).not.toContain('sk-zai-very-secret');
    expect(c.querySelector('[data-paste-not-offered]')).toBeNull();
    await view.unmount();
  });

  it('names the other providers a tie also matched, by name only', async () => {
    const FIRST = preset({
      id: 'first',
      label: 'First',
      detect: { hosts: [], variables: ['SHARED_KEY'], keyPrefixes: [] },
    });
    const SECOND = preset({
      id: 'second',
      label: 'Second',
      detect: { hosts: [], variables: ['SHARED_KEY'], keyPrefixes: [] },
    });
    const view = await mount(
      <PasteVariables presets={[FIRST, SECOND]} onBack={() => undefined} onContinue={() => undefined} />,
    );
    await paste(view, 'export SHARED_KEY=sk-tie-secret');
    const c = view.container;
    expect(must(c.querySelector('[data-paste-detected]') as HTMLElement | null, 'the sentence').textContent).toBe(
      'Looks like First — from SHARED_KEY',
    );
    expect(c.querySelector('[data-paste-also]')?.textContent).toBe('or: Second');
    expect(c.innerHTML).not.toContain('sk-tie-secret');
    await view.unmount();
  });

  it('says so when a paste holds no variables, and offers no Continue', async () => {
    const view = await mount(
      <PasteVariables presets={[ZAI, GATEWAY]} onBack={() => undefined} onContinue={() => undefined} />,
    );
    await paste(view, 'just a sentence, nothing to read');
    expect(view.container.querySelector('[data-paste-result="empty"]')?.textContent).toBe(
      'No variables found. Paste lines like NAME=value.',
    );
    expect(view.container.querySelector('[data-paste-continue]')).toBeNull();
    await view.unmount();
  });

  it('continues as the custom gateway, saying so, when the recognised provider is not offered here', async () => {
    const refused = preset({ ...ZAI, offered: { available: false, reason: 'not here' } });
    const view = await mount(
      <PasteVariables presets={[refused, GATEWAY]} onBack={() => undefined} onContinue={() => undefined} />,
    );
    await paste(view, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4');
    expect(view.container.querySelector('[data-paste-not-offered]')?.textContent).toBe(
      'That provider is not offered here, so this continues as Custom gateway.',
    );
    await view.unmount();
  });

  it('offers no Continue when nothing on offer can take the variables', async () => {
    const view = await mount(<PasteVariables presets={[]} onBack={() => undefined} onContinue={() => undefined} />);
    await paste(view, 'GATEWAY_TOKEN=abc');
    expect(view.container.querySelector('[data-paste-not-offered]')?.textContent).toBe(
      'Nothing offered here can take these variables. Pick a provider instead.',
    );
    expect((view.container.querySelector('[data-paste-continue]') as HTMLButtonElement | null)?.disabled).toBe(true);
    await view.unmount();
  });

  it('continues to the preset it picked with the paste as its prefill', async () => {
    const given: { value: readonly [string, Prefill] | null } = { value: null };
    const view = await mount(
      <PasteVariables
        presets={[ZAI, GATEWAY]}
        onBack={() => undefined}
        onContinue={(presetId, prefill) => {
          given.value = [presetId, prefill];
        }}
      />,
    );
    await paste(view, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4\nexport ZAI_API_KEY=sk-zai-very-secret');
    const button = must(view.container.querySelector('[data-paste-continue]') as HTMLButtonElement | null, 'Continue');
    await interact(() => button.click());
    expect(given.value?.[0]).toBe('zai-glm');
    expect(given.value?.[1].values).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/paas/v4' });
    expect(given.value?.[1].secrets).toEqual(['ZAI_API_KEY']);
    // The key's value is dropped where it is read: nothing the panel is handed holds it.
    expect(JSON.stringify(given.value?.[1])).not.toContain('sk-zai-very-secret');
    await view.unmount();
  });

  it('goes back without continuing', async () => {
    let back = false;
    let continued = false;
    const view = await mount(
      <PasteVariables
        presets={[ZAI, GATEWAY]}
        onBack={() => {
          back = true;
        }}
        onContinue={() => {
          continued = true;
        }}
      />,
    );
    await interact(() => must(view.container.querySelector('[data-paste-back]') as HTMLElement | null, 'Back').click());
    expect(back).toBe(true);
    expect(continued).toBe(false);
    await view.unmount();
  });
});
