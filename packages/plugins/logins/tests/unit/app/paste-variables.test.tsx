import { describe, expect, it } from 'bun:test';
import type { ProviderPresetView } from '../../../contract/index.ts';
import { PasteVariables } from '../../../app/features/paste-variables.tsx';
import type { Prefill } from '../../../app/lib/paste-model.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';

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

/** What the Vault answers when it holds no secret at all. */
const NONE_HELD = { v: 1, health: 'ready', secrets: [], references: [] };

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
      <PasteVariables
        client={scripted({})}
        presets={[ZAI, GATEWAY]}
        onBack={() => undefined}
        onContinue={() => undefined}
      />,
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
      <PasteVariables
        client={scripted({})}
        presets={[FIRST, SECOND]}
        onBack={() => undefined}
        onContinue={() => undefined}
      />,
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
      <PasteVariables
        client={scripted({})}
        presets={[ZAI, GATEWAY]}
        onBack={() => undefined}
        onContinue={() => undefined}
      />,
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
      <PasteVariables
        client={scripted({})}
        presets={[refused, GATEWAY]}
        onBack={() => undefined}
        onContinue={() => undefined}
      />,
    );
    await paste(view, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4');
    expect(view.container.querySelector('[data-paste-not-offered]')?.textContent).toBe(
      'That provider is not offered here, so this continues as Custom gateway.',
    );
    await view.unmount();
  });

  it('offers no Continue when nothing on offer can take the variables', async () => {
    const view = await mount(
      <PasteVariables client={scripted({})} presets={[]} onBack={() => undefined} onContinue={() => undefined} />,
    );
    await paste(view, 'GATEWAY_TOKEN=abc');
    expect(view.container.querySelector('[data-paste-not-offered]')?.textContent).toBe(
      'Nothing offered here can take these variables. Pick a provider instead.',
    );
    expect((view.container.querySelector('[data-paste-continue]') as HTMLButtonElement | null)?.disabled).toBe(true);
    await view.unmount();
  });

  it('files the pasted key in the Vault under the preset’s secret name, then continues with names only', async () => {
    const KEY = 'SENTINEL-sk-zai-very-secret';
    const calls: Call[] = [];
    const client = scripted({ 'GET /v1/secrets': NONE_HELD, 'POST /v1/secrets': { name: 'ZAI_API_KEY' } }, calls);
    const given: { value: readonly [string, Prefill] | null } = { value: null };
    const view = await mount(
      <PasteVariables
        client={client}
        presets={[ZAI, GATEWAY]}
        onBack={() => undefined}
        onContinue={(presetId, prefill) => {
          given.value = [presetId, prefill];
        }}
      />,
    );
    await paste(view, `export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4\nexport ZAI_API_KEY=${KEY}`);
    const button = must(view.container.querySelector('[data-paste-continue]') as HTMLButtonElement | null, 'Continue');
    await interact(() => button.click());

    // The value went to the secrets route, under the preset's own secret name, and nowhere else.
    expect(calls.map(call => [call.route, call.body])).toEqual([
      ['GET /v1/secrets', undefined],
      ['POST /v1/secrets', { name: 'ZAI_API_KEY', value: KEY }],
    ]);
    expect(given.value?.[0]).toBe('zai-glm');
    expect(given.value?.[1].values).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/paas/v4' });
    expect(given.value?.[1].secrets).toEqual(['ZAI_API_KEY']);
    // Nothing the panel is handed, and nothing on screen, holds the key.
    expect(JSON.stringify(given.value?.[1])).not.toContain(KEY);
    expect(view.container.innerHTML).not.toContain(KEY);
    await view.unmount();
  });

  it('files nothing when the paste carried no key', async () => {
    const calls: Call[] = [];
    const client = scripted({ 'POST /v1/secrets': { name: 'x' } }, calls);
    const view = await mount(
      <PasteVariables client={client} presets={[ZAI, GATEWAY]} onBack={() => undefined} onContinue={() => undefined} />,
    );
    await paste(view, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4');
    await interact(() =>
      must(view.container.querySelector('[data-paste-continue]') as HTMLButtonElement | null, 'Continue').click(),
    );
    expect(calls).toEqual([]);
    await view.unmount();
  });

  it('stays on the paste screen, saying why, when the Vault refuses the key — and says nothing of its value', async () => {
    const KEY = 'SENTINEL-sk-refused';
    let continued = false;
    const refusal = Object.assign(new Error('a ferret cannot set or replace a secret; the owner does.'), {
      status: 403,
      code: 'forbidden',
    });
    const view = await mount(
      <PasteVariables
        client={scripted({ 'GET /v1/secrets': NONE_HELD, 'POST /v1/secrets': refusal })}
        presets={[ZAI, GATEWAY]}
        onBack={() => undefined}
        onContinue={() => {
          continued = true;
        }}
      />,
    );
    await paste(view, `export ZAI_API_KEY=${KEY}`);
    await interact(() =>
      must(view.container.querySelector('[data-paste-continue]') as HTMLButtonElement | null, 'Continue').click(),
    );

    expect(continued).toBe(false);
    expect(view.container.querySelector('[data-paste-refused]')?.textContent).toBe(
      'a ferret cannot set or replace a secret; the owner does.',
    );
    expect(view.container.innerHTML).not.toContain(KEY);
    // The button is usable again: the person can try once more.
    expect((view.container.querySelector('[data-paste-continue]') as HTMLButtonElement | null)?.disabled).toBe(false);
    await view.unmount();
  });

  it('shows Saving… and takes no second press while the key is on its way to the Vault', async () => {
    let release: (() => void) | undefined;
    const calls: Call[] = [];
    const client = scripted(
      { 'GET /v1/secrets': NONE_HELD, 'POST /v1/secrets': () => new Promise<void>(resolve => (release = resolve)) },
      calls,
    );
    const view = await mount(
      <PasteVariables client={client} presets={[ZAI, GATEWAY]} onBack={() => undefined} onContinue={() => undefined} />,
    );
    await paste(view, 'export ZAI_API_KEY=SENTINEL-slow');
    const button = must(view.container.querySelector('[data-paste-continue]') as HTMLButtonElement | null, 'Continue');
    await interact(() => button.click());

    expect(button.textContent).toBe('Saving…');
    expect(button.disabled).toBe(true);
    await interact(() => button.click());
    expect(calls.filter(call => call.route === 'POST /v1/secrets')).toHaveLength(1);
    await interact(() => release?.());
    await view.unmount();
  });

  describe('a key the Vault already holds', () => {
    const KEY = 'SENTINEL-sk-pasted-over-a-working-key';
    const HELD = {
      v: 1,
      health: 'ready',
      secrets: [{ name: 'ZAI_API_KEY', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }],
      references: [],
    };
    const mountPaste = async (routes: Record<string, unknown>) => {
      const calls: Call[] = [];
      const given: { value: readonly [string, Prefill] | null } = { value: null };
      const view = await mount(
        <PasteVariables
          client={scripted(routes, calls)}
          presets={[ZAI, GATEWAY]}
          onBack={() => undefined}
          onContinue={(presetId, prefill) => {
            given.value = [presetId, prefill];
          }}
        />,
      );
      await paste(view, `export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4\nexport ZAI_API_KEY=${KEY}`);
      return { view, calls, given };
    };
    const posts = (calls: Call[]): Call[] => calls.filter(call => call.route === 'POST /v1/secrets');

    it('is kept: Continue makes no write to the Vault without the person’s say-so, and says so by name', async () => {
      const { view, calls, given } = await mountPaste({ 'GET /v1/secrets': HELD, 'POST /v1/secrets': { name: 'x' } });
      const c = view.container;

      expect(c.querySelector('[data-paste-held="ZAI_API_KEY"]')?.textContent).toContain(
        'ZAI_API_KEY is already in the secret store, so it stays as it is.',
      );
      expect((c.querySelector('[data-paste-replace="ZAI_API_KEY"]') as HTMLInputElement | null)?.checked).toBe(false);
      await interact(() =>
        must(c.querySelector('[data-paste-continue]') as HTMLButtonElement | null, 'Continue').click(),
      );

      expect(posts(calls)).toEqual([]);
      expect(given.value?.[0]).toBe('zai-glm');
      expect(given.value?.[1].secrets).toEqual(['ZAI_API_KEY']);
      expect(c.innerHTML).not.toContain(KEY);
      await view.unmount();
    });

    it('is replaced only after the person turns Replace on, then only that name is written', async () => {
      const { view, calls } = await mountPaste({ 'GET /v1/secrets': HELD, 'POST /v1/secrets': { name: 'x' } });
      const c = view.container;

      await interact(() =>
        must(c.querySelector('[data-paste-replace="ZAI_API_KEY"]') as HTMLInputElement | null, 'Replace').click(),
      );
      await interact(() =>
        must(c.querySelector('[data-paste-continue]') as HTMLButtonElement | null, 'Continue').click(),
      );

      expect(posts(calls).map(call => call.body)).toEqual([{ name: 'ZAI_API_KEY', value: KEY }]);
      await view.unmount();
    });

    it('is not written when Replace was turned on and then off again', async () => {
      const { view, calls } = await mountPaste({ 'GET /v1/secrets': HELD, 'POST /v1/secrets': { name: 'x' } });
      const c = view.container;
      const toggle = () =>
        interact(() =>
          must(c.querySelector('[data-paste-replace="ZAI_API_KEY"]') as HTMLInputElement | null, 'Replace').click(),
        );

      await toggle();
      await toggle();
      await interact(() =>
        must(c.querySelector('[data-paste-continue]') as HTMLButtonElement | null, 'Continue').click(),
      );

      expect(posts(calls)).toEqual([]);
      await view.unmount();
    });

    it('cannot be told apart when the Vault will not say what it holds, so nothing is written and Continue stays off', async () => {
      const refusal = Object.assign(new Error('the secret store is locked.'), { status: 403, code: 'forbidden' });
      const { view, calls } = await mountPaste({ 'GET /v1/secrets': refusal, 'POST /v1/secrets': { name: 'x' } });
      const c = view.container;

      expect(c.querySelector('[data-paste-refused]')?.textContent).toBe('the secret store is locked.');
      const button = must(c.querySelector('[data-paste-continue]') as HTMLButtonElement | null, 'Continue');
      expect(button.disabled).toBe(true);
      await interact(() => button.click());

      expect(posts(calls)).toEqual([]);
      expect(c.innerHTML).not.toContain(KEY);
      await view.unmount();
    });

    it('ignores an answer to an older paste once a newer one was read', async () => {
      const calls: Call[] = [];
      let answerFirst: ((list: unknown) => void) | undefined;
      let asked = 0;
      const view = await mount(
        <PasteVariables
          client={scripted(
            {
              'GET /v1/secrets': () => {
                asked += 1;
                return asked === 1 ? new Promise(resolve => (answerFirst = resolve)) : NONE_HELD;
              },
              'POST /v1/secrets': { name: 'x' },
            },
            calls,
          )}
          presets={[ZAI, GATEWAY]}
          onBack={() => undefined}
          onContinue={() => undefined}
        />,
      );
      await paste(view, `export ZAI_API_KEY=${KEY}`);
      await paste(view, `export ZAI_API_KEY=${KEY}-again`);
      await interact(() => answerFirst?.(HELD));

      // The late "held" answer to the first paste does not mark the second paste's key as held.
      expect(view.container.querySelector('[data-paste-held]')).toBeNull();
      await view.unmount();
    });
  });

  it('goes back without continuing', async () => {
    let back = false;
    let continued = false;
    const view = await mount(
      <PasteVariables
        client={scripted({})}
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

describe('the paste box while it holds a pasted block', () => {
  const BLOCK = 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4\nexport ZAI_API_KEY=SENTINEL-sk-typed-not-read';

  it('never puts the pasted block into the markup before Read is pressed, yet still enables Read and reads it', async () => {
    const view = await mount(
      <PasteVariables
        client={scripted({})}
        presets={[ZAI, GATEWAY]}
        onBack={() => undefined}
        onContinue={() => undefined}
      />,
    );
    const c = view.container;
    const box = must(c.querySelector('[data-paste-input]') as HTMLTextAreaElement | null, 'the box');
    expect((c.querySelector('[data-paste-read]') as HTMLButtonElement).disabled).toBe(true);
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, BLOCK);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(box.value).toBe(BLOCK);
    expect(box.textContent).toBe('');
    expect(c.innerHTML).not.toContain('SENTINEL-sk-typed-not-read');
    expect((c.querySelector('[data-paste-read]') as HTMLButtonElement).disabled).toBe(false);
    await interact(() => (c.querySelector('[data-paste-read]') as HTMLButtonElement).click());
    expect(c.querySelector('[data-paste-result="zai-glm"]')).not.toBeNull();
    expect(box.value).toBe('');
    expect(c.innerHTML).not.toContain('SENTINEL-sk-typed-not-read');
    await view.unmount();
  });

  it('keeps Read off for a box holding only spaces', async () => {
    const view = await mount(
      <PasteVariables
        client={scripted({})}
        presets={[ZAI, GATEWAY]}
        onBack={() => undefined}
        onContinue={() => undefined}
      />,
    );
    const box = must(view.container.querySelector('[data-paste-input]') as HTMLTextAreaElement | null, 'the box');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, '  \n ');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((view.container.querySelector('[data-paste-read]') as HTMLButtonElement).disabled).toBe(true);
    await view.unmount();
  });
});
