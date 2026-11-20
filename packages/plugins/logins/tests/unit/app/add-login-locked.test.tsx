/**
 * r11 O6, owner item 6 ("why in codex' segment, it ask you to use claude code?"): an add-login panel mounted with a
 * `harness` is that tool's own sign-in. It draws no Tool picker and no provider grid, never reads the preset catalog,
 * and its one press makes a login of THAT tool only.
 */
import { describe, expect, it } from 'bun:test';
import { AddLoginPanel } from '../../../app/features/add-login-panel.tsx';
import logins from '../../../app/index.ts';
import { login, loginList } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';

const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };

const settle = async (): Promise<void> => {
  for (let elapsed = 0; elapsed < 300; elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
};

describe('the add-login panel locked to one tool', () => {
  for (const [harness, name, other] of [
    ['codex', 'Codex', 'Claude Code'],
    ['claude-code', 'Claude Code', 'Codex'],
  ] as const) {
    it(`${name}: no picker, no providers, no mention of ${other}, and an add of ${name} only`, async () => {
      const calls: Call[] = [];
      const client = scripted(
        {
          'GET /v1/logins': loginList(),
          'GET /v1/grants': OPEN,
          'POST /v1/logins/changes': (call: Call) => ({
            id: 'chg1',
            change: call.body,
            summary: 'Add a login',
            consequences: [],
            expiresAt: '2026-11-01T10:15:00.000Z',
            state: 'pending',
          }),
        },
        calls,
      );
      const view = await mount(<AddLoginPanel client={client} harness={harness} />);
      await settle();
      expect(view.container.querySelector('[role="radiogroup"]')).toBeNull();
      expect(view.container.querySelector('[data-add-login]')).toBeNull();
      expect(view.container.textContent).not.toContain(other);
      expect(view.container.textContent).toContain(`Sign in to ${name}`);
      // The catalog of other providers is never even read.
      expect(calls.some(call => call.route === 'GET /v1/logins/presets')).toBe(false);
      const staged = calls.filter(call => call.route === 'POST /v1/logins/changes');
      expect(staged).toEqual([]);
      await interact(() => must(view.container.querySelector<HTMLElement>('[data-change-submit]'), 'the add').click());
      await settle();
      const sent = calls.find(call => call.route === 'POST /v1/logins/changes');
      expect(sent?.body).toMatchObject({ kind: 'login.add', harness });
      await view.unmount();
    });
  }

  it('is still the full panel (picker and providers) with no harness named', async () => {
    const client = scripted({
      'GET /v1/logins/presets': { presets: [] },
      'GET /v1/logins': loginList(login()),
      'GET /v1/grants': OPEN,
    });
    const view = await mount(<AddLoginPanel client={client} />);
    await settle();
    expect(view.container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    await view.unmount();
  });

  it('the add-login slot panel reads `harness` from its props and ignores anything else', () => {
    const built = logins.build?.({ client: scripted({}) } as never) as unknown as {
      panels: Record<string, (props: Record<string, unknown>) => { props: { harness?: string } }>;
    };
    const panel = built.panels['add-login'] as (props: Record<string, unknown>) => { props: { harness?: string } };
    expect(panel({ harness: 'codex' }).props.harness).toBe('codex');
    expect(panel({ harness: 'gemini' }).props.harness).toBeUndefined();
    expect(panel({}).props.harness).toBeUndefined();
  });
});
