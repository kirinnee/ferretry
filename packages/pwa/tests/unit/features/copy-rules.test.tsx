import { afterEach, describe, expect, it } from 'bun:test';
import type { PasteRule, PasteRuleCreate } from '@ferretry/protocol';
import { CopyRulesCard } from '../../../src/features/secure-copy/copy-rules-card.tsx';
import { CopyRulesSurface } from '../../../src/features/secure-copy/copy-rules-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';
import { click, settle, typeInto } from '../../support/dom-form.ts';
import { type Call, fakeClient } from '../../support/input-fixtures.ts';

const CONNECTION = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const OTHER = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 't2' });
const mounted: Mounted[] = [];

afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const RULE: PasteRule = {
  id: 'a'.repeat(32),
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  remaining: 1,
  used: 0,
  createdAt: '2026-08-05T09:00:00.000Z',
  createdBy: { kind: 'host' },
  plan: 'b'.repeat(32),
};

const select = async (element: Element | null, value: string): Promise<void> => {
  const node = must(element as HTMLSelectElement | null, 'a select');
  const { act } = await import('react');
  await act(async () => {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const card = async (props: Partial<Parameters<typeof CopyRulesCard>[0]> = {}) => {
  const added: PasteRuleCreate[] = [];
  const removed: string[] = [];
  const view = await mount(
    <CopyRulesCard
      onAdd={async rule => {
        added.push(rule);
        return true;
      }}
      onRemove={id => {
        removed.push(id);
        return true;
      }}
      rules={[]}
      {...props}
    />,
  );
  mounted.push(view);
  const q = (selector: string) => view.container.querySelector(selector);
  return { view, q, added, removed, text: () => view.container.textContent ?? '' };
};

describe('the pre-approval rules card', () => {
  it('says plainly when every paste asks', async () => {
    const { q } = await card();

    expect(q('[data-testid="copy-rules-empty"]')?.textContent).toContain('every paste asks you');
  });

  it('lists each route with its limits, and removes one', async () => {
    const { q, removed, text } = await card({ rules: [RULE] });

    expect(text()).toContain('what gh prints');
    expect(text()).toContain('vercel in a terminal');
    expect(q('[data-copy-rule-limits]')?.textContent).toBe(
      '1 more · any ferret · no end · used 0 · from a ferret’s plan',
    );
    await click(q(`[data-copy-rule="${RULE.id}"] button`));
    expect(removed).toEqual([RULE.id]);
  });

  it('approves a route from the form and closes it', async () => {
    const { q, added } = await card();
    await click(q('[data-copy-rule-add-open]'));
    await select(q('[data-copy-rule-from-kind]'), 'clipboard');
    await typeInto(q('[data-copy-rule-from]'), 'https://github.com');
    await select(q('[data-copy-rule-to-kind]'), 'browser');
    await typeInto(q('[data-copy-rule-to]'), 'https://vercel.com');
    await typeInto(q('[data-copy-rule-count]'), '3');
    await typeInto(q('[data-copy-rule-hours]'), '');
    await click(q('[data-copy-rule-form] button[type="submit"]'));
    await settle();

    expect(added).toEqual([
      {
        from: { kind: 'clipboard', origin: 'https://github.com' },
        to: { kind: 'browser', origin: 'https://vercel.com' },
        count: 3,
      },
    ]);
    expect(q('[data-copy-rule-form]')).toBeNull();
  });

  it('says what is wrong, keeps the form when the daemon refuses, and cancels', async () => {
    const { q, added } = await card({ onAdd: () => false, error: 'the daemon said no', busy: false });
    await click(q('[data-copy-rule-add-open]'));
    await select(q('[data-copy-rule-to-kind]'), 'secret');
    await click(q('[data-copy-rule-form] button[type="submit"]'));
    expect(q('[data-copy-rule-problem]')?.textContent).toBe('Name the program, like gh.');
    await typeInto(q('[data-copy-rule-from]'), 'gh');
    await typeInto(q('[data-copy-rule-to]'), 'GH_TOKEN');
    await click(q('[data-copy-rule-form] button[type="submit"]'));
    await settle();

    expect(added).toEqual([]);
    expect(q('[data-copy-rule-form]')).not.toBeNull();
    expect(q('[data-testid="copy-rules-error"]')?.textContent).toBe('the daemon said no');
    await click(
      must(
        Array.from(q('[data-copy-rule-form]')?.querySelectorAll('button') ?? []).find(
          b => b.textContent === 'Cancel',
        ) ?? null,
        'Cancel',
      ),
    );
    expect(q('[data-copy-rule-form]')).toBeNull();
  });

  it('marks a rule into a program from the owner profile, and says it asks while that is not allowed', async () => {
    const off = await card({ rules: [RULE], profileRules: [RULE.id], settings: { allowProfileTargets: false } });
    expect(off.q('[data-copy-rule-profile]')?.textContent).toBe(
      'your profile — a ferret could swap this program · asks you while profile programs are not allowed',
    );
    const on = await card({ rules: [RULE], profileRules: [RULE.id], settings: { allowProfileTargets: true } });
    expect(on.q('[data-copy-rule-profile]')?.textContent).toBe('your profile — a ferret could swap this program');
    const system = await card({ rules: [RULE], profileRules: [], settings: { allowProfileTargets: true } });
    expect(system.q('[data-copy-rule-profile]')).toBeNull();
  });

  it('turns profile programs on and off with the setting, which says the risk', async () => {
    const changed: unknown[] = [];
    const { q, text } = await card({
      settings: { allowProfileTargets: false },
      onSettings: settings => {
        changed.push(settings);
        return true;
      },
    });
    const box = must(q('[data-copy-profile-targets]') as HTMLInputElement | null, 'the setting');

    expect(box.checked).toBe(false);
    expect(text()).toContain('Copy rules may target programs in my own profile');
    expect(text()).toContain('could swap that program for its own');
    await click(box);
    expect(changed).toEqual([{ allowProfileTargets: true }]);
    expect((await card()).q('[data-copy-profile-targets]')).toBeNull();
  });

  it('warns on an existing rule into a shell or an interpreter, and only there', async () => {
    const shell = { ...RULE, id: 'c'.repeat(32), to: { kind: 'terminal', program: 'pwsh' } } as PasteRule;
    const { q } = await card({ rules: [RULE, shell] });

    expect(q(`[data-copy-rule="${shell.id}"] [data-copy-rule-row-runs-anything]`)?.textContent).toContain(
      'runs whatever it reads',
    );
    expect(q(`[data-copy-rule="${RULE.id}"] [data-copy-rule-row-runs-anything]`)).toBeNull();
  });

  it('warns that a shell or an interpreter runs whatever it reads', async () => {
    const { q } = await card();
    await click(q('[data-copy-rule-add-open]'));
    await typeInto(q('[data-copy-rule-to]'), 'psql');
    expect(q('[data-copy-rule-runs-anything]')).toBeNull();
    for (const program of ['bash', 'python3.12', 'node']) {
      await typeInto(q('[data-copy-rule-to]'), program);
      expect(q('[data-copy-rule-runs-anything]')?.textContent).toContain('runs whatever it reads');
    }
    await select(q('[data-copy-rule-to-kind]'), 'secret');
    expect(q('[data-copy-rule-runs-anything]')).toBeNull();
  });

  it('says it is saving while busy', async () => {
    const { q } = await card({ busy: true });
    await click(q('[data-copy-rule-add-open]'));

    expect(q('[data-copy-rule-form] button[type="submit"]')?.textContent).toContain('Saving…');
  });
});

const surface = async (
  answer: (call: Call) => unknown,
  connection = CONNECTION,
  createClient?: () => Promise<never>,
) => {
  const fake = fakeClient(answer);
  const view = await mount(
    <CopyRulesSurface connection={connection} createClient={createClient ?? (async () => fake.client)} />,
  );
  mounted.push(view);
  await settle();
  return {
    ...fake,
    view,
    q: (selector: string) => view.container.querySelector(selector),
    text: () => view.container.textContent ?? '',
  };
};

describe('the pre-approval rules surface', () => {
  it('reads the rules, adds one and reads them again', async () => {
    const rules: PasteRule[] = [];
    const { calls, q } = await surface(call => {
      if (call.method === 'POST') {
        rules.push(RULE);
        return RULE;
      }
      return { rules };
    });
    await click(q('[data-copy-rule-add-open]'));
    await typeInto(q('[data-copy-rule-from]'), 'gh');
    await typeInto(q('[data-copy-rule-to]'), 'vercel');
    await click(q('[data-copy-rule-form] button[type="submit"]'));
    await settle();

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/copy-rules',
      'GET /v1/copy-rules/settings',
      'POST /v1/copy-rules',
      'GET /v1/copy-rules',
      'GET /v1/copy-rules/settings',
    ]);
    expect(q(`[data-copy-rule="${RULE.id}"]`)).not.toBeNull();
  });

  it('removes a rule, and says why when a change fails', async () => {
    let failing = false;
    const { calls, q, text } = await surface(call => {
      if (failing) throw new Error('the daemon is gone');
      return call.method === 'DELETE' ? { removed: true } : { rules: [RULE] };
    });
    await click(q(`[data-copy-rule="${RULE.id}"] button`));
    await settle();
    failing = true;
    await click(q(`[data-copy-rule="${RULE.id}"] button`));
    await settle();

    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(2);
    expect(text()).toContain('the daemon is gone');
  });

  it('reads the setting and the badges from their own route, and changes the setting through it', async () => {
    let allowed = false;
    const { calls, q } = await surface(call => {
      if (call.method === 'PUT') {
        allowed = true;
        return { allowProfileTargets: true };
      }
      if (call.path === '/v1/copy-rules/settings')
        return { settings: { allowProfileTargets: allowed }, profileRules: [RULE.id] };
      return { rules: [RULE] };
    });
    expect(q('[data-copy-rule-profile]')).not.toBeNull();
    await click(q('[data-copy-profile-targets]'));
    await settle();

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/copy-rules',
      'GET /v1/copy-rules/settings',
      'PUT /v1/copy-rules/settings',
      'GET /v1/copy-rules',
      'GET /v1/copy-rules/settings',
    ]);
    expect((q('[data-copy-profile-targets]') as HTMLInputElement | null)?.checked).toBe(true);
  });

  it('shows no setting and no badge for a daemon too old to have them, and still lists its rules', async () => {
    const { q } = await surface(call => {
      if (call.path === '/v1/copy-rules/settings') throw new Error('404 not found');
      return { rules: [RULE] };
    });

    expect(q(`[data-copy-rule="${RULE.id}"]`)).not.toBeNull();
    expect(q('[data-copy-profile-targets]')).toBeNull();
    expect(q('[data-copy-rule-profile]')).toBeNull();
  });

  it('says a failed read is a failed read, never "no rules"', async () => {
    const { text } = await surface(() => {
      throw new Error('relay down');
    });

    expect(text()).toContain('could not read this daemon’s paste rules: relay down');
  });

  it('says it is reading until the list comes, and drops a list from another machine', async () => {
    const view = await mount(
      <CopyRulesSurface connection={CONNECTION} createClient={() => new Promise<never>(() => undefined)} />,
    );
    mounted.push(view);
    expect(view.container.textContent).toContain('Reading this daemon’s paste rules…');
    const other = await surface(() => ({ rules: [RULE] }), OTHER);
    expect(other.q(`[data-copy-rule="${RULE.id}"]`)).not.toBeNull();
  });
});
