import { describe, expect, it } from 'bun:test';
import { CLONE_REVIEW_STALE } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { CloneMachine } from '../../../../../src/features/fleet/setup/clone.tsx';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import { type DaemonConnection } from '../../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  FIRST_REVIEW,
  FULL_REVIEW,
  HERE_GUARD_SCRIPT,
  ITEMS,
  NOTHING_REVIEW,
  review,
  UPDATE_BUNDLE,
} from './clone-review-support.ts';
import {
  APPLY_PATH,
  bundle,
  type Call,
  credentials,
  credentialView,
  machineAnswer,
  machineView,
  STAGED,
  STUDIO,
  scriptedClient,
  WORK,
} from './setup-support.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const WORK_RECORD: DaemonConnectionRecord = { ...WORK, label: 'work-linux', pairedAt: 0, lastSelectedAt: 0 };
const EXECUTED = { outcome: 'executed', executor: 'clone', summary: 'Updated studio-mac from work-linux' };
const TARGET_MACHINE = machineView({ runtimeCount: 2 });
const STACKS = {
  format: 'version-2',
  profiles: [
    {
      name: 'default',
      layers: ['instructions/default'],
      usedBy: [],
      baseFor: [],
      wouldIncludeItself: [],
      scope: { kind: 'scoped', scope: 'generic' },
      harnesses: [],
      remove: { available: true },
    },
  ],
};
const HERE_LOGINS = credentials([
  credentialView('claude-work', { email: 'me@work.example' }),
  credentialView('codex-main', { harness: 'codex', email: undefined, label: 'Main' }),
  credentialView('codex-spare', { harness: 'codex', email: undefined, label: 'Spare' }),
]);
/** This machine's own export: its copy of the guard script differs from the other machine's. */
const HERE_BUNDLE = bundle({
  files: [{ path: 'components/hooks/guard/send.sh', content: HERE_GUARD_SCRIPT }],
  components: { hooks: { guard: { directory: 'components/hooks/guard' } } },
  profiles: {},
  runtimes: {},
  credentials: [],
});

type Answers = Record<string, unknown>;

const daemons = (target: Answers = {}) => {
  const calls: { target: Call[]; work: Call[] } = { target: [], work: [] };
  const clients: Record<string, FleetClient> = {
    studio: scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer(),
        '/v1/fleet/profiles': STACKS,
        '/v1/fleet/clone/review': FULL_REVIEW,
        '/v1/fleet/export': HERE_BUNDLE,
        '/v1/fleet/credentials': HERE_LOGINS,
        '/v1/fleet/proposals': STAGED,
        [APPLY_PATH]: EXECUTED,
        ...target,
      },
      calls.target,
    ),
    work: scriptedClient(
      { '/v1/fleet/machine': machineView({ name: 'work-linux', runtimeCount: 3 }), '/v1/fleet/export': UPDATE_BUNDLE },
      calls.work,
    ),
  };
  const createClient = async (connection: DaemonConnection): Promise<FleetClient> =>
    must(clients[String(connection.daemonId)], `client for ${connection.daemonId}`);
  return { calls, createClient };
};

// ── Driving ──────────────────────────────────────────────────────────────────────────────────────

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const render = async (
  createClient: (connection: DaemonConnection) => Promise<FleetClient>,
  onDone = () => undefined,
) => {
  const view = await mount(
    <CloneMachine
      sources={[WORK_RECORD]}
      connection={STUDIO}
      machineName="studio-mac"
      machine={TARGET_MACHINE}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={createClient}
      onDone={onDone}
      onLeave={() => undefined}
    />,
  );
  await settle();
  const q = (selector: string) => view.container.querySelector(selector);
  const all = (selector: string) => [...view.container.querySelectorAll(selector)];
  const text = (selector: string) => q(selector)?.textContent ?? '';
  const choose = async (id: string) => click(q(`[data-setup-choice="${id}"] input`), `choice ${id}`);
  const step = () => q('[data-machine-stepper]')?.getAttribute('data-step');
  const submit = () => q('[data-change-submit]') as HTMLButtonElement | null;
  return { view, q, all, text, choose, step, submit };
};
type Screen = Awaited<ReturnType<typeof render>>;

/** Pick work-linux, read its setup and review, and take the default Update on to the Changes step. */
const toChanges = async (screen: Screen) => {
  await screen.choose('work');
  await click(screen.q('[data-step-next]'), 'Next');
  expect(screen.step()).toBe('existing');
  await click(screen.q('[data-step-next]'), 'Next');
  expect(screen.step()).toBe('preview');
};

const changeBodies = (calls: readonly Call[]) =>
  calls
    .filter(call => call.path === '/v1/fleet/proposals')
    .map(call => call.body as { change: Record<string, unknown> });

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────

describe('CloneMachine · Update · Existing setup', () => {
  it('offers Update (the default), Add alongside and Start over (Replace) for a machine copied from this source before', async () => {
    const { createClient, calls } = daemons();
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      expect(screen.step()).toBe('existing');
      // The review was asked of THIS machine, with the source's export and the names the person uses.
      const asked = calls.target.find(call => call.path === '/v1/fleet/clone/review');
      expect(asked?.body).toMatchObject({
        source: { daemonId: 'work' },
        names: { source: 'work-linux', target: 'studio-mac' },
      });

      const labels = screen
        .all('[data-setup-choices="clone-mode"] [data-setup-choice]')
        .map(choice => choice.getAttribute('data-setup-choice'));
      expect(labels).toEqual(['update', 'alongside', 'replace']);
      expect(screen.text('[data-setup-choice="update"]')).toContain('Update');
      expect(screen.text('[data-setup-choice="alongside"]')).toContain('Add alongside');
      expect(screen.text('[data-setup-choice="replace"]')).toContain('Start over (Replace)');
      expect((screen.q('[data-setup-choice="update"] input') as HTMLInputElement).checked).toBe(true);
      expect(screen.text('[data-clone-step="existing"]')).toContain('studio-mac was copied from work-linux before.');
      expect(screen.text('[data-clone-step="existing"]')).toContain('Last copied');

      // Source → Existing setup → Changes → Done.
      expect(screen.all('[data-stepper-steps] li').map(li => li.textContent)).toEqual(
        expect.arrayContaining([expect.stringContaining('Changes')]),
      );
    } finally {
      await screen.view.unmount();
    }
  });

  it('keeps Add alongside after an earlier copy: it shows the full preview and copies everything, as before', async () => {
    const { createClient, calls } = daemons({ '/v1/fleet/clone/review': FULL_REVIEW });
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      await screen.choose('alongside');
      await click(screen.q('[data-step-next]'), 'Next');
      expect(screen.step()).toBe('preview');
      expect(screen.q('[data-clone-review]')).toBeNull();
      expect(screen.text('[data-clone-step="preview"]')).toContain('Profiles and runtimes copy');

      await click(screen.q('[data-change-submit]'), 'Copy alongside');
      expect(changeBodies(calls.target)[0]?.change).toMatchObject({ kind: 'clone.import', mode: 'alongside' });
      expect(changeBodies(calls.target)[0]?.change).not.toHaveProperty('reviewed');
    } finally {
      await screen.view.unmount();
    }
  });

  it('asks nothing new of a first copy: the first-copy preview, in its own order, with no review', async () => {
    const { createClient } = daemons({ '/v1/fleet/clone/review': FIRST_REVIEW });
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      expect(screen.step()).toBe('preview');
      expect(screen.q('[data-clone-review]')).toBeNull();
      expect(screen.text('[data-stepper-position]')).toBe('Step 2 of 3 · Preview');
    } finally {
      await screen.view.unmount();
    }
  });

  it('falls back to the first-copy preview when this machine cannot review (an older Ferretry)', async () => {
    const { createClient } = daemons({ '/v1/fleet/clone/review': new FyHttpError('not found', 404, undefined) });
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      expect(screen.step()).toBe('preview');
      expect(screen.q('[data-clone-review]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });
});

describe('CloneMachine · Update · Changes', () => {
  it('lists only what differs, in groups that say what will happen, and the things already the same collapsed', async () => {
    const { createClient } = daemons();
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const titles = screen.all('[data-clone-review] [data-setup-section] h4').map(heading => heading.textContent);
      expect(titles).toEqual([
        'New on work-linux · 2',
        'Changed on work-linux · 1',
        'Both changed — pick one · 1',
        'Changed here (kept) · 1',
        'Gone from work-linux · 1',
        'You removed these here · 1',
        'Logins and keys',
      ]);
      expect(screen.text('[data-setup-disclosure="review-same"] summary')).toContain(
        '6 things already the same (2 matched by name)',
      );
      // Names only, behind the fold.
      expect(screen.text('[data-review-same-names]')).toContain('runtime/claude-default');
      expect(screen.text('[data-review-same-names]')).not.toContain('Be kind');

      expect(screen.text('[data-review-item="instructions/main"]')).toContain('Yours stays. Nothing is written');
      expect(screen.text('[data-review-item="runtime/old-codex"]')).toContain(`Stays on studio-mac`);
      expect(screen.text('[data-review-item="mcp/notes"]')).toContain('Added to studio-mac');
    } finally {
      await screen.view.unmount();
    }
  });

  it('lists everything an item would run, in full, and a changed document as a line diff against this machine', async () => {
    const { createClient } = daemons();
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const notes = screen.text('[data-review-item="mcp/notes"]');
      expect(notes).toContain('Runs on studio-mac');
      expect(notes).toContain('Starts');
      expect(notes).toContain('npx -y notes');

      const guard = must(screen.q('[data-review-item="hooks/guard"]'), 'guard');
      expect(guard.textContent).toContain('components/hooks/guard/send.sh');
      expect(guard.textContent).toContain('+3 −1 lines');
      expect(guard.textContent).toContain('See the change');
      const diff = must(guard.querySelector('[data-review-diff]'), 'diff');
      expect(diff.querySelectorAll('[data-diff="add"]').length).toBeGreaterThan(0);
      expect(diff.querySelectorAll('[data-diff="del"]').length).toBeGreaterThan(0);
      // The whole script is there to read, and so is the whole file.
      expect(guard.textContent).toContain('Script components/hooks/guard/send.sh');
      expect(guard.textContent).toContain('mkfs) echo "blocked');
      await click(guard.querySelector('[data-review-whole]'), 'Show the whole file');
      expect(guard.querySelector('[data-review-diff]')).toBeNull();
      expect(guard.textContent).toContain('Stop a risky command before an agent runs it.');
    } finally {
      await screen.view.unmount();
    }
  });

  it('says where a relocated item lands, and why', async () => {
    const { createClient } = daemons({
      '/v1/fleet/clone/review': review({ items: [ITEMS.relocated], same: { count: 10, probable: 0 } }),
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const row = must(screen.q('[data-review-item="hooks/lint-2"]'), 'relocated');
      expect(row.textContent).toContain('components/hooks/lint-2/run.sh');
      expect(row.textContent).toContain(
        'is also used by hooks/format here, so taking this writes it to components/hooks/lint-2',
      );
    } finally {
      await screen.view.unmount();
    }
  });

  it('pre-selects NOTHING for an item both sides changed, and keeps Apply off until each is chosen, saying so', async () => {
    const { createClient, calls } = daemons();
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const row = must(screen.q('[data-review-item="settings/shared"]'), 'both');
      const radios = [...row.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
      expect(radios.map(radio => radio.getAttribute('data-review-pick'))).toEqual([
        'settings/shared:keep',
        'settings/shared:take',
      ]);
      expect(radios.map(radio => radio.checked)).toEqual([false, false]);
      expect(row.textContent).toContain('Keep mine');
      expect(row.textContent).toContain('Use work-linux’s');
      expect(row.textContent).toContain('Not chosen yet');

      expect(screen.submit()?.disabled).toBe(true);
      expect(screen.text('[data-review-hold]')).toContain('Choose one more under “Both changed” first');
      // Nothing was sent.
      expect(changeBodies(calls.target)).toEqual([]);

      await click(radios[0] ?? null, 'Keep mine');
      expect(radios.map(radio => radio.checked)).toEqual([true, false]);
      expect(screen.submit()?.disabled).toBe(false);
      expect(screen.q('[data-review-hold]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });

  it('counts what will be written on the button, and says Nothing to copy when the choices write nothing', async () => {
    const { createClient } = daemons({
      '/v1/fleet/clone/review': review({
        items: [ITEMS.newMcp, ITEMS.theirsHooks, ITEMS.bothSettings],
        same: { count: 8, probable: 0 },
      }),
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.q('[data-review-pick="settings/shared:take"]'), 'Use theirs');
      expect(screen.submit()?.textContent).toBe('Update 3 things');

      await click(screen.q('[data-review-pick="mcp/notes"]'), 'untick notes');
      expect(screen.submit()?.textContent).toBe('Update 2 things');
      expect(screen.text('[data-review-item="mcp/notes"]')).toContain('Left out: not copied');

      await click(screen.q('[data-review-pick="hooks/guard"]'), 'untick guard');
      await click(screen.q('[data-review-pick="settings/shared:keep"]'), 'Keep mine');
      expect(screen.submit()?.textContent).toBe('Nothing to copy');
    } finally {
      await screen.view.unmount();
    }
  });

  it('ticks what a profile needs and unticks what needs a component that was left out', async () => {
    const { createClient } = daemons();
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const tick = (ref: string) => (screen.q(`[data-review-pick="${ref}"]`) as HTMLInputElement).checked;
      expect(tick('mcp/notes')).toBe(true);
      expect(tick('profile/review')).toBe(true);
      expect(screen.text('[data-review-item="profile/review"]')).toContain('Needs mcp/notes');

      await click(screen.q('[data-review-pick="mcp/notes"]'), 'untick notes');
      expect(tick('mcp/notes')).toBe(false);
      expect(tick('profile/review')).toBe(false);

      await click(screen.q('[data-review-pick="profile/review"]'), 'tick the profile');
      expect(tick('profile/review')).toBe(true);
      expect(tick('mcp/notes')).toBe(true);
    } finally {
      await screen.view.unmount();
    }
  });

  it('applies with the fingerprint it reviewed and one decision per item, the both-changed one included', async () => {
    const { createClient, calls } = daemons();
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.q('[data-review-pick="settings/shared:take"]'), 'Use theirs');
      await click(screen.q('[data-review-pick="runtime/old-codex"]'), 'remove old-codex');
      await click(screen.q('[data-review-login-pick="codex-work:codex-main"]'), 'use codex-main');
      expect(screen.submit()?.textContent).toBe('Update 5 things');
      await click(screen.submit(), 'Update');

      const [body] = changeBodies(calls.target);
      expect(body?.change).toMatchObject({
        kind: 'clone.import',
        mode: 'update',
        reviewed: 'fingerprint-1',
        source: { daemonId: 'work' },
        decisions: {
          'mcp/notes': 'add',
          'profile/review': 'add',
          'hooks/guard': 'take',
          'settings/shared': 'take',
          'instructions/main': 'keep',
          'runtime/old-codex': 'remove',
          'profile/legacy': 'keep',
        },
        logins: { 'codex-work': 'codex-main' },
      });
      expect(body?.change).not.toHaveProperty('skip');

      // Done lists the outcomes per group.
      expect(screen.step()).toBe('done');
      const outcomes = screen.text('[data-setup-section="update-outcomes"]');
      expect(outcomes).toContain('What changed');
      expect(outcomes).toContain('Added · 2 items');
      expect(outcomes).toContain('mcp/notes, profile/review');
      expect(outcomes).toContain('hooks/guard, settings/shared');
      expect(outcomes).toContain('runtime/old-codex');
      expect(outcomes).toContain('instructions/main, profile/legacy');
    } finally {
      await screen.view.unmount();
    }
  });

  it('shows one note and a Done button when nothing differs, with no empty section and nothing to apply', async () => {
    const { createClient, calls } = daemons({ '/v1/fleet/clone/review': NOTHING_REVIEW });
    let done = 0;
    const screen = await render(createClient, () => {
      done += 1;
    });
    try {
      await toChanges(screen);
      const note = must(screen.q('[data-setup-note="nothing-to-copy"]'), 'note');
      expect(note.getAttribute('data-tone')).toBe('ok');
      expect(note.textContent).toBe('Everything from work-linux is already here. Nothing to copy.');
      expect(screen.q('[data-setup-section]')).toBeNull();
      expect(screen.q('[data-change-submit]')).toBeNull();
      await click(screen.q('[data-clone-finish]'), 'Done');
      expect(done).toBe(1);
      expect(changeBodies(calls.target)).toEqual([]);
    } finally {
      await screen.view.unmount();
    }
  });

  it('refuses a stale review in words, changes nothing, and offers Review again', async () => {
    let reviews = 0;
    const { createClient, calls } = daemons({
      '/v1/fleet/clone/review': () => {
        reviews += 1;
        return review({ ...FULL_REVIEW, fingerprint: `fingerprint-${String(reviews)}` });
      },
      '/v1/fleet/proposals': new FyHttpError(CLONE_REVIEW_STALE, 409, 'fleet_change_refused'),
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.q('[data-review-pick="settings/shared:keep"]'), 'Keep mine');
      await click(screen.submit(), 'Update');

      expect(screen.step()).toBe('preview');
      const note = must(screen.q('[data-setup-note="stale-review"]'), 'stale note');
      expect(note.textContent).toContain('Something changed since you reviewed. Review again.');
      expect(screen.q('[data-change-refusal]')).toBeNull();
      expect(reviews).toBe(1);

      await click(screen.q('[data-review-again]'), 'Review again');
      expect(reviews).toBe(2);
      expect(calls.target.filter(call => call.path === '/v1/fleet/clone/review')).toHaveLength(2);
      // A fresh review is a fresh start: the stale note is gone and nothing is chosen for the both-changed item.
      expect(screen.q('[data-setup-note="stale-review"]')).toBeNull();
      expect(screen.submit()?.disabled).toBe(true);
    } finally {
      await screen.view.unmount();
    }
  });

  it('words any other refusal as the daemon did, with no Review again', async () => {
    const { createClient } = daemons({
      '/v1/fleet/proposals': new FyHttpError(
        'settings/shared is still used by profile/review.',
        409,
        'fleet_change_refused',
      ),
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.q('[data-review-pick="settings/shared:keep"]'), 'Keep mine');
      await click(screen.submit(), 'Update');
      expect(screen.text('[data-change-refusal]')).toBe('settings/shared is still used by profile/review.');
      expect(screen.q('[data-review-again]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });
});

describe('CloneMachine · Update · Logins', () => {
  it('says a matched login is already here with no new sign-in, and asks which login to use when several fit', async () => {
    const { createClient } = daemons();
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const matched = screen.text('[data-setup-row="login-claude-work"]');
      expect(matched).toContain('me@work.example');
      expect(matched).toContain('Already here, no new sign-in');

      const ask = must(screen.q('[data-review-login-ask="codex-work"]'), 'ask');
      expect(ask.textContent).toContain('Work: use which login on studio-mac?');
      const options = [...ask.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
      expect(options.map(option => option.getAttribute('data-review-login-pick'))).toEqual([
        'codex-work:codex-main',
        'codex-work:codex-spare',
        'codex-work:slot',
      ]);
      expect(ask.textContent).toContain('Use Main');
      expect(ask.textContent).toContain('Use Spare');
      expect(ask.textContent).toContain('Add an empty slot');
      expect(options.map(option => option.checked)).toEqual([false, false, true]);
    } finally {
      await screen.view.unmount();
    }
  });

  it('never offers to remove a login or touch its credentials: logins carry no checkbox, and Gone lists only items', async () => {
    const { createClient } = daemons();
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const logins = must(screen.q('[data-setup-section="review-logins"]'), 'logins');
      expect(logins.querySelector('input[type="checkbox"]:not([data-clone-keys-copy])')).toBeNull();
      expect(logins.textContent?.toLowerCase()).not.toContain('remove');
      expect(logins.textContent?.toLowerCase()).not.toContain('sign out');
      // Every control on a Gone row is about an item of the setup, never a login.
      const gone = screen
        .all('[data-setup-section="review-gone"] [data-review-item]')
        .map(row => row.getAttribute('data-review-item'));
      expect(gone).toEqual(['runtime/old-codex']);
    } finally {
      await screen.view.unmount();
    }
  });
});
