import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { AddLoginPanel } from '../../../app/features/add-login-panel.tsx';
import { HarnessChoice } from '../../../app/features/harness-choice.tsx';
import type { HarnessKind } from '../../../app/lib/logins-view.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';

// The CLI choice only STAGES: ChoiceCards fires onChange on an arrow key, so nothing may be written when the choice
// moves. The login is made by the form's own button, with the staged choice.

function Probe({ onChoose }: { readonly onChoose: (next: HarnessKind) => void }) {
  const [value, setValue] = useState<HarnessKind>('claude-code');
  return (
    <HarnessChoice
      label="Tool"
      harnesses={['claude-code', 'codex']}
      value={value}
      onChange={next => {
        setValue(next);
        onChoose(next);
      }}
    />
  );
}

describe('the CLI choice', () => {
  it('is one radio group of two cards that reports the choice and nothing else', async () => {
    const chosen: HarnessKind[] = [];
    const view = await mount(<Probe onChoose={next => chosen.push(next)} />);
    const group = must(view.container.querySelector('[role="radiogroup"]'), 'the group');
    expect(group.getAttribute('aria-label')).toBe('Tool');
    const radios = Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map(radio => radio.value)).toEqual(['claude-code', 'codex']);
    expect(radios.map(radio => radio.checked)).toEqual([true, false]);
    await interact(() => must(radios[1] ?? null, 'Codex').click());
    expect(chosen).toEqual(['codex']);
    await view.unmount();
  });

  it('writes nothing on the machine while the choice moves: only the Add button does', async () => {
    const calls: Call[] = [];
    const client = scripted(
      {
        'GET /v1/logins/presets': { presets: [] },
        'GET /v1/logins': { format: 1, machine: 'box', logins: [] },
        'GET /v1/grants': {
          capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }],
        },
      },
      calls,
    );
    const view = await mount(<AddLoginPanel client={client} />);
    const form = must(view.container.querySelector('[data-add-login-sign-in]'), 'the sign-in form');
    const radios = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    await interact(() => must(radios[1] ?? null, 'Codex').click());
    expect(form.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe('codex');
    expect(form.textContent).toContain('Add a Codex login');
    expect(calls.map(call => call.route).filter(route => route.startsWith('POST'))).toEqual([]);
    await view.unmount();
  });
});
