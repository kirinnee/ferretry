import { afterEach, describe, expect, it } from 'bun:test';
import {
  type PasteRule,
  type PasteRuleCreate,
  type PasteRuleStaged,
  RUNS_WHAT_IT_READS_WARNING,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { CopyRulesCard } from '../../../src/features/secure-copy/copy-rules-card.tsx';
import { CopyRulesSurface } from '../../../src/features/secure-copy/copy-rules-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { PASTE_RULE_NO_PASSKEY_WORDS } from '../../../src/lib/secure-copy.ts';
import type { StepUpWords } from '../../../src/lib/step-up-gate.ts';
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
    expect(text()).toContain('Paste rules may target programs in my own profile');
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

  it('shows no setting and no badge for a daemon too old to have them (a 404), and still lists its rules', async () => {
    const { q } = await surface(call => {
      if (call.path === '/v1/copy-rules/settings') throw new FyHttpError('not found', 404, 'not_found');
      return { rules: [RULE] };
    });

    expect(q(`[data-copy-rule="${RULE.id}"]`)).not.toBeNull();
    expect(q('[data-copy-profile-targets]')).toBeNull();
    expect(q('[data-copy-rule-profile]')).toBeNull();
    expect(q('[data-copy-settings-error]')).toBeNull();
  });

  it('says so when the setting cannot be read for any other reason, never hiding it quietly', async () => {
    for (const failure of [new FyHttpError('the daemon fell over', 500, 'internal'), new Error('relay down')]) {
      const { q } = await surface(call => {
        if (call.path === '/v1/copy-rules/settings') throw failure;
        return { rules: [RULE] };
      });

      expect(q(`[data-copy-rule="${RULE.id}"]`)).not.toBeNull();
      expect(q('[data-copy-settings-error]')?.textContent).toContain(
        `could not check which rules a program in your own profile could satisfy, so no rule is marked: ${failure.message}`,
      );
    }
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

describe('making a paste rule with a passkey bound to it (!A244)', () => {
  const STAGE = `prs_${'1'.repeat(24)}`;
  const STAGED: PasteRuleStaged = {
    stage: STAGE as PasteRuleStaged['stage'],
    kind: 'rule',
    does: 'Ferretry pastes what gh prints into bash in a terminal, for any ferret on this machine, without asking.',
    rows: [
      { label: 'From', value: 'what gh prints' },
      { label: 'To', value: 'bash in a terminal' },
      { label: 'Who', value: 'Any ferret on this machine' },
      { label: 'Pastes', value: 'Any number' },
      { label: 'Until', value: 'No end: until you remove it' },
    ],
    runsAnything: true,
    expiresAt: '2026-11-02T09:02:00.000Z',
  };

  /** The surface on a machine that stages paste rules, with a passkey prompt that answers `given`. */
  const PROFILE: PasteRuleStaged = {
    stage: `prs_${'2'.repeat(24)}` as PasteRuleStaged['stage'],
    kind: 'profile-targets',
    does: 'Paste rules may then paste into programs from your own profile (~/.nix-profile), which any ferret can swap; it widens one paste rule now.',
    rows: [
      { label: 'Widens', value: 'what gh prints → vercel in a terminal' },
      { label: 'Staged', value: 'On Kirin’s phone, 2026-11-02 09:00 UTC' },
    ],
    runsAnything: false,
    expiresAt: '2026-11-02T09:02:00.000Z',
  };

  const staging = async (given: boolean | undefined, waiting: readonly PasteRuleStaged[] = []) => {
    const asked: [string, StepUpWords, string][] = [];
    const rules: PasteRule[] = [];
    let allowed = false;
    const fake = fakeClient(call => {
      if (call.method === 'POST' && call.path === '/v1/copy-rules/stages') return STAGED;
      if (call.method === 'POST' && call.path === `/v1/copy-rules/stages/${STAGE}/bind`) return STAGED;
      if (call.method === 'POST' && call.path === '/v1/copy-rules/settings/stages') return PROFILE;
      if (call.method === 'POST' && call.path === `/v1/copy-rules/settings/stages/${PROFILE.stage}/commit`) {
        allowed = true;
        return { allowProfileTargets: true };
      }
      if (call.method === 'POST' && call.path === `/v1/copy-rules/stages/${STAGE}/commit`) {
        rules.push(RULE);
        return RULE;
      }
      if (call.method === 'DELETE') return { stage: STAGE, dropped: true };
      if (call.path === '/v1/copy-rules/stages') return { stages: waiting };
      if (call.path === '/v1/copy-rules/settings')
        return { settings: { allowProfileTargets: allowed }, profileRules: [] };
      return { rules };
    });
    const view = await mount(
      <CopyRulesSurface
        connection={CONNECTION}
        createClient={async () => fake.client}
        staging
        {...(given === undefined
          ? {}
          : {
              askPasskey: async (stage: string, words: StepUpWords, act: string) => {
                asked.push([stage, words, act]);
                return given;
              },
            })}
      />,
    );
    mounted.push(view);
    await settle();
    const q = (selector: string) => view.container.querySelector(selector);
    const addOne = async () => {
      await click(q('[data-copy-rule-add-open]'));
      await typeInto(q('[data-copy-rule-from]'), 'gh');
      await typeInto(q('[data-copy-rule-to]'), 'bash');
      await click(q('[data-copy-rule-form] button[type="submit"]'));
      await settle();
    };
    const routes = () => fake.calls.map(call => `${call.method} ${call.path}`);
    return { q, asked, addOne, routes, text: () => view.container.textContent ?? '' };
  };

  it("stages the rule, asks for the passkey bound to it with the daemon's rows, then commits", async () => {
    const { asked, addOne, routes, q } = await staging(true);

    await addOne();

    expect(asked).toEqual([
      [
        STAGE,
        { does: STAGED.does, rows: [...STAGED.rows], warnings: [RUNS_WHAT_IT_READS_WARNING] },
        'approve-paste-rule',
      ],
    ]);
    expect(routes()).not.toContain(`POST /v1/copy-rules/stages/${STAGE}/bind`);
    expect(routes()).toContain('POST /v1/copy-rules/stages');
    expect(routes()).toContain(`POST /v1/copy-rules/stages/${STAGE}/commit`);
    expect(routes()).not.toContain('POST /v1/copy-rules');
    expect(q(`[data-copy-rule="${RULE.id}"]`)).not.toBeNull();
  });

  it('drops the stage and commits nothing when the passkey prompt is dismissed', async () => {
    const { addOne, routes, q } = await staging(false);

    await addOne();

    expect(routes()).toContain(`DELETE /v1/copy-rules/stages/${STAGE}`);
    expect(routes()).not.toContain(`POST /v1/copy-rules/stages/${STAGE}/commit`);
    expect(q('[data-testid="copy-rules-error"]')).toBeNull();
    expect(q('[data-copy-rule-form]')).not.toBeNull();
  });

  it('drops the stage and says so on a device that cannot confirm with a passkey', async () => {
    const { addOne, routes, text } = await staging(undefined);

    await addOne();

    expect(routes()).toContain(`DELETE /v1/copy-rules/stages/${STAGE}`);
    expect(routes()).not.toContain(`POST /v1/copy-rules/stages/${STAGE}/commit`);
    expect(text()).toContain(PASTE_RULE_NO_PASSKEY_WORDS);
  });

  it('shows a rule staged at the machine with its rows, approves it with the passkey, or denies it', async () => {
    const approving = await staging(true, [STAGED]);

    expect(approving.text()).toContain('Waiting for your passkey');
    expect(approving.text()).toContain(STAGED.does);
    expect(approving.q('[data-copy-rule-waiting-runs-anything]')?.textContent).toBe(RUNS_WHAT_IT_READS_WARNING);
    await click(approving.q('[data-copy-rule-waiting-approve]'));
    await settle();
    expect(approving.asked.map(([stage]) => stage)).toEqual([STAGE]);
    // A machine's stage is taken by this device first, so only it gets the challenge.
    const order = approving.routes().filter(route => route.includes(STAGE));
    expect(order).toEqual([`POST /v1/copy-rules/stages/${STAGE}/bind`, `POST /v1/copy-rules/stages/${STAGE}/commit`]);

    const dismissing = await staging(false, [STAGED]);
    await click(dismissing.q('[data-copy-rule-waiting-approve]'));
    await settle();
    expect(dismissing.routes()).not.toContain(`DELETE /v1/copy-rules/stages/${STAGE}`);

    const denying = await staging(true, [STAGED]);
    await click(denying.q('[data-copy-rule-waiting-deny]'));
    await settle();
    expect(denying.asked).toEqual([]);
    expect(denying.routes()).toContain(`DELETE /v1/copy-rules/stages/${STAGE}`);
    expect(denying.routes()).not.toContain(`POST /v1/copy-rules/stages/${STAGE}/commit`);
  });

  it('keeps the one-step add on a machine that does not stage paste rules', async () => {
    const { calls, q } = await surface(call => (call.method === 'POST' ? RULE : { rules: [] }));
    await click(q('[data-copy-rule-add-open]'));
    await typeInto(q('[data-copy-rule-from]'), 'gh');
    await typeInto(q('[data-copy-rule-to]'), 'vercel');
    await click(q('[data-copy-rule-form] button[type="submit"]'));
    await settle();

    expect(calls.map(call => `${call.method} ${call.path}`)).toContain('POST /v1/copy-rules');
    expect(calls.some(call => call.path.startsWith('/v1/copy-rules/stages'))).toBe(false);
  });

  it('stages turning on programs in your own profile, asks the passkey for that act with its rows, then commits', async () => {
    const { q, asked, routes } = await staging(true);
    const toggle = q('[data-copy-profile-targets] input, input[data-copy-profile-targets]');
    expect(toggle).not.toBeNull();

    await click(toggle);
    await settle();

    expect(asked).toEqual([
      [PROFILE.stage, { does: PROFILE.does, rows: [...PROFILE.rows], warnings: [] }, 'allow-profile-targets'],
    ]);
    expect(routes()).toContain('POST /v1/copy-rules/settings/stages');
    expect(routes()).toContain(`POST /v1/copy-rules/settings/stages/${PROFILE.stage}/commit`);
    expect(routes()).not.toContain('PUT /v1/copy-rules/settings');
  });
});
