import { describe, expect, it } from 'bun:test';
import { analyseCloneSettings, reviewCloneSettings } from '@ferretry/fleet';
import { CLONE_REVIEW_STALE, CLONE_SOURCE_SECRETS_LIMIT, CloneableSecretNameSchema, type CloneSettingsDoc } from '@ferretry/plugin-runtimes/contract';
import { FleetAccountChangeSchema, type FleetCloneReview } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/app';
import type { FleetClient } from '../../../../../../app/features/fleet/fleet-client.ts';
import { CloneMachine } from '../../../../../../app/features/fleet/setup/clone.tsx';
import { controlsText } from '../../../../../../app/features/fleet/setup/clone-settings-merge.ts';
import type { DaemonConnectionRecord } from '../../../../../../../../plugins/connections/app/lib/connections.ts';
import type { DaemonConnection } from '../../../../../../app/lib/daemon-connection.ts';
import { interact, mount, must } from '@ferretry/app/testing';
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
  type FleetCredentialView,
  machineAnswer,
  machineView,
  STAGED,
  STUDIO,
  scriptedClient,
  WORK,
} from './setup-support.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const secretName = (name: string) => CloneableSecretNameSchema.parse(name);
const WORK_RECORD: DaemonConnectionRecord = { ...WORK, label: 'work-linux', pairedAt: 0, lastSelectedAt: 0 };
const EXECUTED = { outcome: 'executed', executor: 'clone', summary: 'Updated studio-mac from work-linux' };
/** A tappable control is at least 44 x 44 CSS px at every width, not only on a coarse pointer. */
const expectTouchTarget = (control: Element | null | undefined, what: string): void => {
  expect(control, what).toBeTruthy();
  expect(control?.className, what).toContain('min-h-[44px]');
};
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
  components: {
    hooks: { guard: { directory: 'components/hooks/guard' } },
    settings: { shared: { flags: ['--verbose'] } },
  },
  profiles: { default: { layers: ['instructions/default', 'mcp/other'] } },
  runtimes: {},
  credentials: [],
});

type Answers = Record<string, unknown>;

const daemons = (target: Answers = {}, work: Answers = {}) => {
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
      {
        '/v1/fleet/machine': machineView({ name: 'work-linux', runtimeCount: 3 }),
        '/v1/fleet/export': UPDATE_BUNDLE,
        ...work,
      },
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
      expectTouchTarget(screen.q('[data-setup-disclosure="review-same"] summary'), 'the already-the-same disclosure');
      expectTouchTarget(
        screen.q('[data-review-pick="settings/shared:keep"]')?.closest('label'),
        'a both-changed choice',
      );
      expectTouchTarget(screen.q('[data-review-pick="mcp/notes"]')?.closest('label'), 'a tick row');
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
      expectTouchTarget(screen.submit(), 'Update N things');

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
    const { createClient, calls } = daemons({
      '/v1/fleet/clone/review': review({ same: { count: 12, probable: 0 } }),
    });
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
      expectTouchTarget(screen.q('[data-clone-finish]'), 'Done');
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
      // A read asks twice: once with the settings a first copy would send, then for the Update itself (none ticked).
      expect(reviews).toBe(2);
      expectTouchTarget(screen.q('[data-review-again]'), 'Review again');
      expectTouchTarget(screen.submit(), 'Update beside Review again');

      await click(screen.q('[data-review-again]'), 'Review again');
      expect(reviews).toBe(4);
      expect(calls.target.filter(call => call.path === '/v1/fleet/clone/review')).toHaveLength(4);
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
      for (const option of options) expectTouchTarget(option.closest('label'), 'a login choice');
      expect(options.map(option => option.checked)).toEqual([false, false, true]);
      // Nothing is picked for the person, and the help says so; picking one says what happens instead.
      expect(ask.querySelector('[data-review-login-help]')?.textContent).toContain('none is picked for you');
      await click(screen.q('[data-review-login-pick="codex-work:codex-spare"]'), 'use Spare');
      const help = must(screen.q('[data-review-login-ask="codex-work"] [data-review-login-help]'), 'help').textContent;
      expect(help).toContain('Uses Spare as it is: no new sign-in, and no login is changed.');
      expect(help).not.toContain('none is picked for you');
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

describe('CloneMachine · Update · An identical copy made before origin links existed', () => {
  it('finishes by linking the names it matched, writes nothing else, and says so', async () => {
    const { createClient, calls } = daemons({ '/v1/fleet/clone/review': NOTHING_REVIEW });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      expect(screen.text('[data-setup-note="nothing-to-copy"]')).toBe(
        'Everything from work-linux is already here. Nothing to copy.',
      );
      expect(screen.text('[data-setup-note="link-by-name"]')).toContain('3 items matched by name');
      expect(screen.text('[data-setup-note="link-by-name"]')).toContain('Nothing else is written.');
      // Not a bare Done: leaving here would save no link, and the next edit on the source would read as a conflict.
      expect(screen.q('[data-clone-finish]')).toBeNull();
      expect(screen.submit()?.textContent).toBe('Finish and link 3 items');
      expect(screen.submit()?.disabled).toBe(false);

      await click(screen.submit(), 'Finish and link');

      const bodies = changeBodies(calls.target);
      expect(bodies).toHaveLength(1);
      // The same apply as any Update: the reviewed fingerprint, and no decision because no item differs.
      expect(bodies[0]?.change).toMatchObject({
        kind: 'clone.import',
        mode: 'update',
        reviewed: 'fingerprint-1',
        source: { daemonId: 'work' },
        decisions: {},
      });
      expect(bodies[0]?.change).not.toHaveProperty('skip');
      expect(bodies[0]?.change).not.toHaveProperty('logins');
      expect(bodies[0]?.change).not.toHaveProperty('defaultRuntime');
      // Nothing was written but that one reviewed change: no settings file, no key, no login.
      const allowed = new Set(['/v1/fleet/clone/review', '/v1/fleet/proposals', APPLY_PATH]);
      const sent = calls.target.filter(call => call.body !== undefined).map(call => call.path);
      expect(sent.filter(path => !allowed.has(path))).toEqual([]);
      expect(screen.step()).toBe('done');
      expect(screen.q('[data-setup-section="update-outcomes"]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });

  it('seals no key for a link-only finish, even when the source holds one the copied setup names', async () => {
    const named = {
      ...UPDATE_BUNDLE,
      components: {
        ...UPDATE_BUNDLE.components,
        mcp: { notes: { command: 'npx', args: ['-y', 'notes'], env: { TOKEN: `\${secret:NOTES_TOKEN}` } } },
      },
    };
    const { createClient, calls } = daemons(
      { '/v1/fleet/clone/review': NOTHING_REVIEW, '/v1/secrets': secretNames([]) },
      { '/v1/fleet/export': named, '/v1/secrets': secretNames(['NOTES_TOKEN']) },
    );
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.submit(), 'Finish and link');
      expect(screen.step()).toBe('done');
      // The source was only read, and this machine was sent the one reviewed change.
      expect(calls.work.filter(call => call.body !== undefined)).toEqual([]);
      expect(calls.target.filter(call => call.path.startsWith('/v1/secrets') && call.body !== undefined)).toEqual([]);
      expect(screen.q('[data-clone-outcome="keys"]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });

  it('refuses a stale link in words with Review again, and words any other refusal as the daemon did', async () => {
    let reviews = 0;
    const stale = daemons({
      '/v1/fleet/clone/review': () => {
        reviews += 1;
        return review({ ...NOTHING_REVIEW, fingerprint: `fingerprint-${String(reviews)}` });
      },
      '/v1/fleet/proposals': new FyHttpError(CLONE_REVIEW_STALE, 409, 'fleet_change_refused'),
    });
    const screen = await render(stale.createClient);
    try {
      await toChanges(screen);
      await click(screen.submit(), 'Finish and link');
      expect(screen.step()).toBe('preview');
      expect(screen.text('[data-setup-note="stale-review"]')).toContain(CLONE_REVIEW_STALE);
      expect(screen.q('[data-change-refusal]')).toBeNull();
      await click(screen.q('[data-review-again]'), 'Review again');
      expect(reviews).toBe(4);
      expect(screen.q('[data-setup-note="stale-review"]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }

    const other = daemons({
      '/v1/fleet/clone/review': NOTHING_REVIEW,
      '/v1/fleet/proposals': new FyHttpError('The names changed.', 409, 'fleet_change_refused'),
    });
    const again = await render(other.createClient);
    try {
      await toChanges(again);
      await click(again.submit(), 'Finish and link');
      expect(again.text('[data-change-refusal]')).toBe('The names changed.');
      expect(again.q('[data-review-again]')).toBeNull();
    } finally {
      await again.view.unmount();
    }
  });
});

// ── What the button counts ───────────────────────────────────────────────────────────────────────

const KEPT_ONLY = review({ items: [ITEMS.mineInstructions, ITEMS.goneRuntime], same: { count: 8, probable: 0 } });
const sourceFile = (path: string, text: string) => ({
  path,
  absolutePath: `/home/me/.fy/config/${path}`,
  kind: path.replace('.yaml', ''),
  schema: path.replace('.yaml', ''),
  exists: true,
  text,
  etag: `etag-${path}`,
  state: 'ok',
  issues: [],
});
const fileRoute = (path: string): string => `/v1/config/file?path=${encodeURIComponent(path)}`;
const secretNames = (names: readonly string[]) => ({
  v: 1,
  health: 'ready',
  secrets: names.map(name => ({
    name,
    createdAt: '2026-10-13T07:00:00.000Z',
    updatedAt: '2026-10-13T07:00:00.000Z',
  })),
  references: [],
});
const WARDEN = `enabled: true\nlabel: \${secret:JEV_API_KEY}\n`;
const settingsAnswers = (): { target: Answers; work: Answers } => ({
  target: {
    '/v1/fleet/clone/review': KEPT_ONLY,
    '/v1/secrets': secretNames([]),
    '/v1/speedups': { vault: 'ok', providers: [] },
    [fileRoute('warden.yaml')]: sourceFile('warden.yaml', '# here\n'),
    '/v1/config/file': (call: Call) => ({
      path: (call.body as { path: string }).path,
      etag: 'etag-written',
      outcome: 'applied',
    }),
  },
  work: {
    '/v1/secrets': secretNames(['JEV_API_KEY']),
    [fileRoute('warden.yaml')]: sourceFile('warden.yaml', WARDEN),
  },
});
const tickItem = (screen: Screen, id: string) =>
  screen.q(`[data-setup-choices="clone-items"] [data-setup-choice="${id}"] input`);

describe('CloneMachine · Update · The button counts every write the apply makes', () => {
  it('never says Nothing to copy while a ticked settings file, the agent controls or a key will be written', async () => {
    const { target, work } = settingsAnswers();
    const { createClient } = daemons(target, work);
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      // Only kept items: nothing is written, and the button says so.
      expect(screen.submit()?.textContent).toBe('Nothing to copy');

      // A settings file is written whole by the same handler, so it counts.
      await click(tickItem(screen, 'warden'), 'tick warden');
      expect(screen.q('[data-clone-keys-copy]')).not.toBeNull();
      // The file and the key it names.
      expect(screen.submit()?.textContent).toBe('Update 2 things');

      await click(screen.q('[data-clone-keys-copy]'), 'leave the key');
      expect(screen.submit()?.textContent).toBe('Update 1 thing');

      await click(tickItem(screen, 'controls'), 'tick controls');
      expect(screen.submit()?.textContent).toBe('Update 2 things');

      await click(tickItem(screen, 'warden'), 'untick warden');
      await click(tickItem(screen, 'controls'), 'untick controls');
      expect(screen.submit()?.textContent).toBe('Nothing to copy');
    } finally {
      await screen.view.unmount();
    }
  });

  it('writes the ticked settings file when it is applied, under the label that said so', async () => {
    const { target, work } = settingsAnswers();
    const { createClient, calls } = daemons(target, work);
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(tickItem(screen, 'warden'), 'tick warden');
      await click(screen.q('[data-clone-keys-copy]'), 'leave the key');
      expect(screen.submit()?.textContent).toBe('Update 1 thing');
      await click(screen.submit(), 'Update');
      const written = calls.target.filter(call => call.path === '/v1/config/file' && call.body !== undefined);
      expect(written.map(call => (call.body as { path: string }).path)).toEqual(['warden.yaml']);
    } finally {
      await screen.view.unmount();
    }
  });
});

// ── One mode's choices never reach another ──────────────────────────────────────────────────────

/** Source → Existing setup, then the copy mode, then on to its preview. */
const throughMode = async (screen: Screen, mode: 'update' | 'alongside' | 'replace') => {
  await screen.choose(mode);
  await click(screen.q('[data-step-next]'), 'Next');
  expect(screen.step()).toBe('preview');
};
const back = async (screen: Screen) => click(screen.q('[data-stepper-back]'), 'Back');
const configWrites = (calls: readonly Call[]) =>
  calls.filter(call => call.path === '/v1/config/file' && call.body !== undefined);
const writesOf = (calls: readonly Call[]) => calls.filter(call => call.body !== undefined);

describe('CloneMachine · Update · A mode submits only what its own screen shows', () => {
  const identical = () => {
    const { target, work } = settingsAnswers();
    return daemons({ ...target, '/v1/fleet/clone/review': NOTHING_REVIEW }, work);
  };

  it('starts Add alongside with everything it can copy ticked, and an Update with the fleet alone', async () => {
    const { createClient } = identical();
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      await throughMode(screen, 'alongside');
      expect((tickItem(screen, 'fleet') as HTMLInputElement).checked).toBe(true);
      expect((tickItem(screen, 'warden') as HTMLInputElement).checked).toBe(true);
      await back(screen);
      await throughMode(screen, 'update');
      expect(screen.text('[data-setup-note="nothing-to-copy"]')).toContain('Nothing to copy');
    } finally {
      await screen.view.unmount();
    }
  });

  it('finishes a link with no settings write after Add alongside ticked Warden (reviewer N1)', async () => {
    const { createClient, calls } = identical();
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      await throughMode(screen, 'alongside');
      expect((tickItem(screen, 'warden') as HTMLInputElement).checked).toBe(true);
      await back(screen);
      await throughMode(screen, 'update');
      // The screen promises it: this is all it says it writes.
      expect(screen.text('[data-setup-note="link-by-name"]')).toContain('Nothing else is written.');
      expect(screen.q('[data-setup-choices="clone-items"]')).toBeNull();

      await click(screen.submit(), 'Finish and link');

      expect(configWrites(calls.target)).toEqual([]);
      expect(writesOf(calls.work)).toEqual([]);
      expect(writesOf(calls.target).filter(call => call.path.startsWith('/v1/secrets'))).toEqual([]);
      expect(changeBodies(calls.target)).toHaveLength(1);
      expect(screen.step()).toBe('done');
    } finally {
      await screen.view.unmount();
    }
  });

  it('still links after Add alongside left the fleet out (reviewer N2)', async () => {
    const { createClient, calls } = identical();
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      await throughMode(screen, 'alongside');
      await click(tickItem(screen, 'fleet'), 'untick the fleet');
      expect((tickItem(screen, 'fleet') as HTMLInputElement).checked).toBe(false);
      await back(screen);
      await throughMode(screen, 'update');

      await click(screen.submit(), 'Finish and link');

      // One reviewed link, so the next edit on the source reads as theirs and not as a conflict.
      const bodies = changeBodies(calls.target);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.change).toMatchObject({ kind: 'clone.import', mode: 'update', reviewed: 'fingerprint-1' });
      expect(configWrites(calls.target)).toEqual([]);
      expect(screen.step()).toBe('done');
    } finally {
      await screen.view.unmount();
    }
  });

  it('applies the reviewed Update after Add alongside left the fleet out, and writes no file it does not show', async () => {
    const { target, work } = settingsAnswers();
    const { createClient, calls } = daemons({ ...target, '/v1/fleet/clone/review': FULL_REVIEW }, work);
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      await throughMode(screen, 'alongside');
      await click(tickItem(screen, 'fleet'), 'untick the fleet');
      await back(screen);
      await throughMode(screen, 'update');
      // The Update screen offers settings files unticked, and the fleet is its own review: neither is inherited.
      expect((tickItem(screen, 'warden') as HTMLInputElement).checked).toBe(false);
      await click(screen.q('[data-review-pick="settings/shared:keep"]'), 'Keep mine');

      await click(screen.submit(), 'Update');

      const bodies = changeBodies(calls.target);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.change).toMatchObject({ kind: 'clone.import', mode: 'update', reviewed: 'fingerprint-1' });
      expect(configWrites(calls.target)).toEqual([]);
    } finally {
      await screen.view.unmount();
    }
  });

  it('keeps what Add alongside left out when the person moves to Start over, which shows the same screen', async () => {
    const { createClient } = identical();
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      await throughMode(screen, 'alongside');
      await click(tickItem(screen, 'warden'), 'untick warden');
      expect((tickItem(screen, 'warden') as HTMLInputElement).checked).toBe(false);
      await back(screen);
      await throughMode(screen, 'replace');
      expect((tickItem(screen, 'warden') as HTMLInputElement).checked).toBe(false);
    } finally {
      await screen.view.unmount();
    }
  });
});

// ── The writes an Update makes, in the order it makes them ───────────────────────────────────────

const IMPORT_ID = `fy_secret_import_${'a'.repeat(22)}`;
const OFFER = {
  v: 1,
  importId: IMPORT_ID,
  daemonId: `fy_daemon_${'T'.repeat(43)}`,
  identityKey: 'aWQ',
  publicKey: 'cHVi',
  expiresAt: '2026-10-20T10:00:00.000Z',
  signature: 'c2ln',
};
const SEALED = {
  v: 1,
  importId: IMPORT_ID,
  sourceDaemonId: `fy_daemon_${'S'.repeat(43)}`,
  targetDaemonId: OFFER.daemonId,
  expiresAt: OFFER.expiresAt,
  names: ['JEV_API_KEY'],
  ephemeralKey: 'ZXBo',
  nonce: 'bm9uY2U',
  ciphertext: 'Y2lwaGVy',
};
const NAMES_TWO_KEYS = `enabled: true\nlabel: \${secret:JEV_API_KEY}\nother: \${secret:HELD_ONE}\n`;

describe('CloneMachine · Update · The writes it makes, in order', () => {
  it('writes the reviewed change, the ticked file, the controls and the one key this machine lacks, and nothing else', async () => {
    const { target, work } = settingsAnswers();
    const { createClient, calls } = daemons(
      {
        ...target,
        '/v1/fleet/clone/review': FULL_REVIEW,
        '/v1/secrets': secretNames(['HELD_ONE']),
        '/v1/secrets/imports': OFFER,
        [`/v1/secrets/imports/${IMPORT_ID}`]: {
          importId: IMPORT_ID,
          sourceDaemonId: SEALED.sourceDaemonId,
          imported: ['JEV_API_KEY'],
          replaced: [],
        },
      },
      {
        ...work,
        '/v1/secrets': secretNames(['JEV_API_KEY', 'HELD_ONE']),
        [fileRoute('warden.yaml')]: sourceFile('warden.yaml', NAMES_TWO_KEYS),
        [`/v1/secrets/exports/${IMPORT_ID}`]: { bundle: SEALED, names: ['JEV_API_KEY'] },
      },
    );
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.q('[data-review-pick="settings/shared:keep"]'), 'Keep mine');
      await click(tickItem(screen, 'warden'), 'tick warden');
      await click(tickItem(screen, 'controls'), 'tick controls');
      // The key this machine already holds is not offered; the one it lacks is.
      expect(screen.text('[data-clone-keys-names]')).toBe('JEV_API_KEY');

      await click(screen.submit(), 'Update');

      expect(screen.step()).toBe('done');
      const describeWrite = (call: Call): string => {
        const body = call.body as { change?: { kind?: string } } | undefined;
        return call.path === '/v1/fleet/proposals' ? `propose ${body?.change?.kind ?? '?'}` : call.path;
      };
      // The review is a question, not a write: it carries a body but changes nothing.
      const writes = writesOf(calls.target).filter(call => call.path !== '/v1/fleet/clone/review');
      expect(writes.map(describeWrite)).toEqual([
        'propose clone.import',
        APPLY_PATH,
        '/v1/config/file',
        'propose machine.settings',
        APPLY_PATH,
        '/v1/secrets/imports',
        `/v1/secrets/imports/${IMPORT_ID}`,
      ]);
      expect(configWrites(calls.target).map(call => (call.body as { path: string }).path)).toEqual(['warden.yaml']);
      // The source is asked for the one missing key by name, and for nothing else.
      expect(writesOf(calls.work).map(call => ({ path: call.path, body: call.body }))).toEqual([
        { path: `/v1/secrets/exports/${IMPORT_ID}`, body: { offer: OFFER, names: ['JEV_API_KEY'] } },
      ]);
    } finally {
      await screen.view.unmount();
    }
  });
});

// ── Logins the person chose ──────────────────────────────────────────────────────────────────────

const ready = (id: string, overrides: Partial<FleetCredentialView> = {}): FleetCredentialView =>
  credentialView(id, {
    ...overrides,
    status: { ...credentialView('x').status, word: 'ready', label: 'Ready' },
  });
const CODEX = { harness: 'codex', email: undefined } as const;
const SIGNED_IN = credentials([
  ready('claude-work', { email: 'me@work.example' }),
  ready('codex-main', { ...CODEX, label: 'Main' }),
  ready('codex-spare', { ...CODEX, label: 'Spare' }),
]);
const SPARE_NOT_SIGNED_IN = credentials([
  ready('claude-work', { email: 'me@work.example' }),
  ready('codex-main', { ...CODEX, label: 'Main' }),
  credentialView('codex-spare', { ...CODEX, label: 'Spare' }),
]);
const signInNeeds = (screen: Screen) =>
  screen.all('[data-clone-need^="sign-in:"]').map(need => need.getAttribute('data-clone-need'));

describe('CloneMachine · Update · The login the person chose', () => {
  it('asks for no sign-in the review already settled, before the update and on Done', async () => {
    const { createClient, calls } = daemons({ '/v1/fleet/credentials': SIGNED_IN });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.q('[data-review-login-pick="codex-work:codex-main"]'), 'use Main');
      await click(screen.q('[data-review-pick="settings/shared:keep"]'), 'Keep mine');
      // claude-work is matched and signed in here, and codex-work is the signed-in login picked: neither is
      // missing, so the preview does not say a sign-in is still to do.
      expect(signInNeeds(screen)).toEqual([]);
      await click(screen.submit(), 'Update');

      expect(changeBodies(calls.target)[0]?.change).toMatchObject({ logins: { 'codex-work': 'codex-main' } });
      expect(screen.step()).toBe('done');
      // Done neither asks to sign in again nor links to a slot the copy never made.
      expect(signInNeeds(screen)).toEqual([]);
      expect(screen.q('[data-clone-need-sign-in]')).toBeNull();
      expect(screen.q('[data-clone-slot]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });

  it('keeps the sign-in of a login that is not signed in, and links it to the login the person picked', async () => {
    const { createClient } = daemons({ '/v1/fleet/credentials': SPARE_NOT_SIGNED_IN });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.q('[data-review-login-pick="codex-work:codex-spare"]'), 'use Spare');
      await click(screen.q('[data-review-pick="settings/shared:keep"]'), 'Keep mine');
      expect(signInNeeds(screen)).toEqual(['sign-in:codex-work']);
      await click(screen.submit(), 'Update');
      expect(screen.step()).toBe('done');
      expect(signInNeeds(screen)).toEqual(['sign-in:codex-work']);
      // The chosen login, not the slot the generic rule would have made.
      expect(
        screen
          .q('[data-clone-need="sign-in:codex-work"] [data-clone-need-sign-in]')
          ?.getAttribute('data-clone-need-sign-in'),
      ).toBe('codex-spare');
    } finally {
      await screen.view.unmount();
    }
  });

  it('still names a new empty slot when none was picked', async () => {
    let applied = false;
    const slot = credentialView('codex-work', { ...CODEX, label: 'Work', clonedFrom: 'work-linux' });
    const { createClient } = daemons({
      [APPLY_PATH]: () => {
        applied = true;
        return EXECUTED;
      },
      '/v1/fleet/credentials': () => (applied ? credentials([...SIGNED_IN.credentials, slot]) : SIGNED_IN),
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.q('[data-review-pick="settings/shared:keep"]'), 'Keep mine');
      expect(signInNeeds(screen)).toEqual(['sign-in:codex-work']);
      await click(screen.submit(), 'Update');
      expect(
        screen
          .q('[data-clone-need="sign-in:codex-work"] [data-clone-need-sign-in]')
          ?.getAttribute('data-clone-need-sign-in'),
      ).toBe('codex-work');
      expect(screen.all('[data-clone-slot]').map(link => link.getAttribute('data-clone-slot'))).toEqual(['codex-work']);
    } finally {
      await screen.view.unmount();
    }
  });
});

describe('CloneMachine · Update · A login and its keys are never touched', () => {
  it('sends only the reviewed change: no sign-out, no secret write and no credential route, whatever was chosen', async () => {
    const { createClient, calls } = daemons({ '/v1/fleet/credentials': SIGNED_IN });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(screen.q('[data-review-login-pick="codex-work:codex-main"]'), 'use Main');
      await click(screen.q('[data-review-pick="settings/shared:take"]'), 'Use theirs');
      await click(screen.q('[data-review-pick="runtime/old-codex"]'), 'remove old-codex');
      await click(screen.submit(), 'Update');
      expect(screen.step()).toBe('done');

      // Every request that carried a body, on either machine.
      const sent = [...calls.target, ...calls.work].filter(call => call.body !== undefined).map(call => call.path);
      // The review is asked twice per read (see the stale test): once with a first copy's settings, once for the Update.
      expect(sent.toSorted()).toEqual(
        ['/v1/fleet/clone/review', '/v1/fleet/clone/review', '/v1/fleet/proposals', APPLY_PATH].toSorted(),
      );
      // The one change names the existing login to use; it carries no login to remove and no secret.
      const [body] = changeBodies(calls.target);
      const change = JSON.stringify(body?.change);
      expect(change).not.toContain('signOut');
      expect(change).not.toContain('secrets');
      expect(body?.change).toMatchObject({ logins: { 'codex-work': 'codex-main' } });
    } finally {
      await screen.view.unmount();
    }
  });
});

// ── Here beside the source ───────────────────────────────────────────────────────────────────────

const BOTH_FLAGS_ONLY = review({ items: [ITEMS.bothSettings, ITEMS.bothProfile], same: { count: 4, probable: 0 } });

describe('CloneMachine · Update · A change both machines made shows both values', () => {
  it('shows this machine’s launch flags beside the source’s, and which line differs', async () => {
    const { createClient } = daemons({ '/v1/fleet/clone/review': BOTH_FLAGS_ONLY });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const row = must(screen.q('[data-review-item="settings/shared"]'), 'settings conflict');
      const rows = [...row.querySelectorAll('[data-review-compare-row]')];
      expect(rows.map(line => line.getAttribute('data-differs'))).toEqual(['no', 'yes']);
      expect(rows[0]?.textContent).toContain('Here (mine)');
      expect(rows[0]?.textContent).toContain('work-linux');
      // The line both machines hold, and the one only the source has.
      expect(rows[0]?.querySelector('[data-review-compare-side="here"]')?.textContent).toContain('--verbose');
      expect(rows[1]?.querySelector('[data-review-compare-side="here"]')?.textContent).toContain('Not set');
      expect(rows[1]?.querySelector('[data-review-compare-side="source"]')?.textContent).toContain(
        '--dangerously-skip-permissions',
      );
      expect(rows[1]?.textContent).toContain('differs');
      // The full list of what it would run stays.
      expect(row.querySelector('[data-review-runs]')?.textContent).toContain('--dangerously-skip-permissions');
    } finally {
      await screen.view.unmount();
    }
  });

  it('compares the fields of an item with nothing to run, and a side the item does not have as not set', async () => {
    const { createClient } = daemons({ '/v1/fleet/clone/review': BOTH_FLAGS_ONLY });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const row = must(screen.q('[data-review-item="profile/default"]'), 'profile conflict');
      const line = must(row.querySelector('[data-review-compare-row="layers"]'), 'layers');
      expect(line.getAttribute('data-differs')).toBe('yes');
      expect(line.querySelector('[data-review-compare-side="here"]')?.textContent).toContain('mcp/other');
      expect(line.querySelector('[data-review-compare-side="source"]')?.textContent).toContain('instructions/default');
      expect(line.querySelector('[data-review-compare-side="source"]')?.textContent).not.toContain('mcp/other');
    } finally {
      await screen.view.unmount();
    }
  });

  it('says so when this machine’s own setup could not be read, and still shows the source’s side', async () => {
    const { createClient } = daemons({
      '/v1/fleet/clone/review': BOTH_FLAGS_ONLY,
      '/v1/fleet/export': new FyHttpError('unreadable', 500, undefined),
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const row = must(screen.q('[data-review-item="settings/shared"]'), 'settings conflict');
      expect(row.querySelector('[data-review-compare="unreadable"]')?.textContent).toContain(
        'What is on studio-mac now couldn’t be read, so only work-linux’s version is shown.',
      );
      expect(row.querySelector('[data-review-runs]')?.textContent).toContain('--dangerously-skip-permissions');
      expect(row.querySelector('[data-review-compare-row]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });

  it('shows no comparison for an item that is not both-changed, or one whose only change is a document', async () => {
    const { createClient } = daemons({
      '/v1/fleet/clone/review': review({ items: [ITEMS.newMcp, ITEMS.bothHooks], same: { count: 4, probable: 0 } }),
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      expect(screen.q('[data-review-compare]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });
});

// ── The rest of the sheet ────────────────────────────────────────────────────────────────────────

describe('CloneMachine · Update · Logins and keys, in every state', () => {
  const KEYS_REVIEW = review({
    items: [ITEMS.theirsHooks],
    logins: [
      { sourceId: 'claude-work', outcome: 'matched', target: 'codex-main' },
      { sourceId: 'codex-work', outcome: 'slot' },
      {
        sourceId: 'api-env',
        outcome: 'slot',
        runnable: {
          entries: [
            { label: 'Harness', text: 'claude', document: false },
            { label: 'Environment ANTHROPIC_API_KEY', text: '${secret:ANTHROPIC_API_KEY}', document: false },
          ],
        },
      },
    ],
    keys: [
      { name: secretName('NOTES_TOKEN'), outcome: 'missing' },
      { name: secretName('JEV_API_KEY'), outcome: 'newer' },
      { name: secretName('GROQ_API_KEY'), outcome: 'both' },
      { name: secretName('SAME_KEY'), outcome: 'same' },
    ],
    settings: [
      {
        path: 'warden.yaml',
        keys: [
          { key: 'caps.daily', outcome: 'both', mine: '20', theirs: '40', loosens: true },
          { key: 'triage', outcome: 'theirs', mine: 'off', theirs: 'jev' },
        ],
      },
      { path: 'voice.yaml', keys: [] },
    ],
    same: { count: 4, probable: 0 },
  });

  it('says a login matched under another name is already here as that login, an API-key login copies as new, and a sign-in is an empty slot', async () => {
    const { createClient } = daemons({ '/v1/fleet/clone/review': KEYS_REVIEW });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      expect(screen.text('[data-setup-row="login-claude-work"]')).toContain('Already here as Main, no new sign-in');
      expect(screen.text('[data-setup-row="login-codex-work"]')).toContain('Adds an empty slot: sign in on studio-mac');
      const api = screen.text('[data-setup-row="login-api-env"]');
      expect(api).toContain('Copies as a new API-key login on studio-mac');
      expect(api).toContain('Environment ANTHROPIC_API_KEY');
      // A name, never a value.
      expect(api).toContain('${secret:ANTHROPIC_API_KEY}');
    } finally {
      await screen.view.unmount();
    }
  });

  it('names each key that differs by what happens to it, hides the ones that are the same, and lists the settings keys that differ', async () => {
    const { createClient } = daemons({ '/v1/fleet/clone/review': KEYS_REVIEW });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      expect(screen.text('[data-setup-row="key-NOTES_TOKEN"]')).toContain('Missing here: copied with its login');
      // A newer or both-changed key is a REPORT with the command to take it by hand, never a row to tick.
      const newer = screen.text('[data-clone-newer-key="JEV_API_KEY"]');
      expect(newer).toContain('A newer JEV_API_KEY exists on work-linux');
      expect(newer).toContain('fy secret set JEV_API_KEY');
      expect(newer).not.toContain('You changed it');
      const both = screen.text('[data-clone-newer-key="GROQ_API_KEY"]');
      expect(both).toContain('A newer GROQ_API_KEY exists on work-linux');
      expect(both).toContain('You changed it on studio-mac too');
      expect(both).toContain('fy secret set GROQ_API_KEY');
      expect(screen.q('[data-clone-newer-key] input')).toBeNull();
      expect(screen.q('[data-clone-newer-key="SAME_KEY"]')).toBeNull();
      expect(screen.q('[data-setup-row="key-SAME_KEY"]')).toBeNull();
      expect(screen.text('[data-setup-row="settings-warden.yaml"]')).toContain('2 settings differ: caps.daily, triage');
      expect(screen.q('[data-setup-row="settings-voice.yaml"]')).toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });

  describe('the keys the source holds (a newer key is reported, never copied)', () => {
    const SOURCE_AT = '2026-11-02T09:30:00.000Z';
    const HERE_AT = '2026-10-13T07:00:00.000Z';
    const stampedSecrets = (names: readonly string[], updatedAt: string) => ({
      v: 1,
      health: 'ready',
      secrets: names.map(name => ({ name, createdAt: HERE_AT, updatedAt })),
      references: [],
    });
    const keyed = (outcome: 'newer' | 'both' | 'same') =>
      review({
        items: [ITEMS.newMcp],
        keys: [{ name: secretName('DEMO_API_KEY'), outcome }],
        same: { count: 3, probable: 0 },
      });
    const keysSetup = (outcome: 'newer' | 'both' | 'same') =>
      daemons(
        { '/v1/fleet/clone/review': keyed(outcome), '/v1/secrets': stampedSecrets(['DEMO_API_KEY'], HERE_AT) },
        { '/v1/secrets': stampedSecrets(['DEMO_API_KEY', 'DEMO_SERVICE_TOKEN'], SOURCE_AT) },
      );

    it('asks the Update’s own review with the source’s key names and instants, and asks nothing else about the keys', async () => {
      const { createClient, calls } = keysSetup('newer');
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        const reviews = calls.target.filter(call => call.path === '/v1/fleet/clone/review');
        expect(reviews.length).toBeGreaterThan(0);
        // Every review the Update stands on carries the keys (names and instants), so it can report a newer one.
        for (const asked of reviews) {
          expect(asked.body).toMatchObject({
            sourceSecrets: [
              { name: 'DEMO_API_KEY', updatedAt: SOURCE_AT },
              { name: 'DEMO_SERVICE_TOKEN', updatedAt: SOURCE_AT },
            ],
          });
        }
        // No value, and no digest of one, is in anything sent to this machine.
        expect(JSON.stringify(reviews.map(call => call.body))).not.toMatch(/value|digest|sk-/u);
      } finally {
        await screen.view.unmount();
      }
    });

    it('sends no key list a review cannot take (more than the route allows) and still makes the review', async () => {
      const many = Array.from({ length: CLONE_SOURCE_SECRETS_LIMIT + 1 }, (_, index) => `MANY_KEY_${String(index)}`);
      const { createClient, calls } = daemons(
        { '/v1/fleet/clone/review': keyed('same'), '/v1/secrets': stampedSecrets([], HERE_AT) },
        { '/v1/secrets': stampedSecrets(many, SOURCE_AT) },
      );
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        const reviews = calls.target.filter(call => call.path === '/v1/fleet/clone/review');
        expect(reviews.length).toBeGreaterThan(0);
        for (const asked of reviews) expect(asked.body).not.toHaveProperty('sourceSecrets');
        expect(screen.submit()?.textContent).toContain('Update 1 thing');
      } finally {
        await screen.view.unmount();
      }
    });

    for (const outcome of ['newer', 'both'] as const) {
      it(`reports a ${outcome} key on the Update screen with the command to take it by hand, and writes nothing for it`, async () => {
        const { createClient, calls } = keysSetup(outcome);
        const screen = await render(createClient);
        try {
          await toChanges(screen);
          const row = screen.text('[data-clone-newer-key="DEMO_API_KEY"]');
          expect(row).toContain('A newer DEMO_API_KEY exists on work-linux');
          expect(row).toContain('Clone does not replace a key studio-mac already has');
          expect(row).toContain('fy secret set DEMO_API_KEY');
          expect(row.includes('You changed it on studio-mac too')).toBe(outcome === 'both');
          // A report: nothing to tick, no passkey to ask for, and the button counts only the one item.
          expect(screen.q('[data-clone-newer-key] input')).toBeNull();
          expect(row).not.toContain('passkey');
          expect(screen.submit()?.textContent).toContain('Update 1 thing');

          await click(screen.submit(), 'Update');
          expect(screen.step()).toBe('done');
          expect(calls.work.some(call => call.path.startsWith('/v1/secrets/exports/'))).toBe(false);
          expect(calls.target.some(call => call.path.startsWith('/v1/secrets/imports'))).toBe(false);
          expect(calls.target.some(call => call.path === '/v1/fleet/clone/keys')).toBe(false);
          expect(calls.target.filter(call => call.path === '/v1/secrets' && call.body !== undefined)).toEqual([]);
        } finally {
          await screen.view.unmount();
        }
      });
    }

    it('says nothing about a key that is the same', async () => {
      const { createClient } = keysSetup('same');
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        expect(screen.q('[data-clone-newer-key]')).toBeNull();
      } finally {
        await screen.view.unmount();
      }
    });

    it('shows the secret copy panel on the Update with the held key kept: locked, not ticked, not counted', async () => {
      const { createClient } = keysSetup('both');
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        await click(screen.q('[data-secret-copy-launch]'), 'Copy secrets');
        const kept = screen.q('[data-secret-copy-kept][data-secret-copy-row="DEMO_API_KEY"]');
        expect(kept?.textContent).toContain('already on');
        expect(kept?.textContent).toContain('kept');
        expect(kept?.textContent).toContain('fy secret set DEMO_API_KEY');
        expect(kept?.querySelector('input')).toBeNull();
        // The key this machine lacks is the one to pick, unticked; the held one adds nothing to the button.
        expect(screen.q('[data-secret-copy-row="DEMO_SERVICE_TOKEN"] input')).not.toBeNull();
        expect(screen.submit()?.textContent).toContain('Update 1 thing');
      } finally {
        await screen.view.unmount();
      }
    });
  });
});

describe('CloneMachine · Update · Other states of the sheet', () => {
  it('words the Existing setup step without a date when the copy has no record of when it was made', async () => {
    const { createClient } = daemons({
      '/v1/fleet/clone/review': review({ ...FULL_REVIEW, source: { name: 'work-linux', verified: 'browser' } }),
    });
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      expect(screen.text('[data-clone-step="existing"]')).toContain(
        'studio-mac already has some of work-linux’s setup. What should happen this time?',
      );
    } finally {
      await screen.view.unmount();
    }
  });

  it('lists no Logins and keys group when the review has no login, key or settings key to say anything about', async () => {
    const { createClient } = daemons({
      '/v1/fleet/clone/review': review({ items: [ITEMS.newMcp], logins: [], same: { count: 3, probable: 0 } }),
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      expect(screen.q('[data-review-group="logins"]')).toBeNull();
      expect(screen.q('[data-review-item="mcp/notes"]')).not.toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });

  it('offers no Update for a setup this machine would refuse, and says why', async () => {
    const orphan = { ...UPDATE_BUNDLE, files: [...UPDATE_BUNDLE.files, { path: 'components/lost.md', content: 'x' }] };
    const { createClient, calls } = daemons({}, { '/v1/fleet/export': orphan });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      const note = must(screen.q('[data-setup-note="bundle-refused"]'), 'refusal');
      expect(note.textContent).toContain('work-linux’s setup can’t be copied');
      expect(note.textContent).toContain('components/lost.md');
      expect(screen.q('[data-change-submit]')).toBeNull();
      expect(changeBodies(calls.target)).toEqual([]);
    } finally {
      await screen.view.unmount();
    }
  });

  it('starts over only when asked, with no reviewed fingerprint and no login named, and keeps every login', async () => {
    const { createClient, calls } = daemons({ '/v1/fleet/credentials': SIGNED_IN });
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      await screen.choose('replace');
      await click(screen.q('[data-step-next]'), 'Next');
      expect(screen.step()).toBe('preview');
      expect(screen.submit()?.textContent).toBe('Replace and copy');
      await click(screen.submit(), 'Replace and copy');

      const [body] = changeBodies(calls.target);
      expect(body?.change).toMatchObject({ kind: 'clone.import', mode: 'replace' });
      expect(body?.change).not.toHaveProperty('reviewed');
      expect(body?.change).not.toHaveProperty('logins');
      expect(body?.change).not.toHaveProperty('decisions');
      const sent = [...calls.target, ...calls.work].filter(call => call.body !== undefined).map(call => call.path);
      expect(sent.filter(path => path.startsWith('/v1/secrets') || path.includes('credentials'))).toEqual([]);
    } finally {
      await screen.view.unmount();
    }
  });
});

// ── Settings an Update compares key by key ───────────────────────────────────────────────────────

describe('CloneMachine · Update · Settings compared key by key', () => {
  type Rows = FleetCloneReview['settings'][number]['keys'];
  const WARDEN_ROWS: Rows = [
    { key: 'intervalMinutes', outcome: 'both', mine: '5', theirs: '10' },
    { key: 'caps.jevUsdPerDay', outcome: 'theirs', choice: 'take', mine: '1', theirs: '5', loosens: true },
  ];
  const DEFAULT_ROW: Rows[number] = {
    key: 'defaultRuntime',
    outcome: 'new',
    choice: 'take',
    theirs: '"claude-default"',
  };
  const HELD = { path: 'warden.yaml', etag: 'etag-held', changes: ['the Warden may spend more'] };
  const configStatus = (pending: (typeof HELD)[] = []) => ({
    directory: '/home/me/.fy/config',
    files: [],
    issues: [],
    pending,
    checkedAt: '2026-11-05T10:00:00.000Z',
  });

  /** The answer for what was sent: no settings, no rows; a document, its keys. The fingerprint says which. */
  const answering =
    (rows: Partial<Record<CloneSettingsDoc, Rows>> = { 'warden.yaml': WARDEN_ROWS }) =>
    (call: Call): unknown => {
      const sent = (call.body as { settings?: { path: CloneSettingsDoc }[] }).settings;
      return review({
        items: [ITEMS.newMcp],
        settings: (sent ?? []).map(document => ({ path: document.path, keys: rows[document.path] ?? [] })),
        fingerprint: sent === undefined ? 'fp-plain' : `fp-${sent.map(document => document.path).join('+')}`,
      });
    };
  const keyRadios = (screen: Screen, name: string) =>
    screen.all(`[data-clone-key="${name}"] input[type="radio"]`) as HTMLInputElement[];
  /** Every review this machine was asked for: each one also carries the source's keys (`sourceSecrets`). */
  const reviewBodies = (calls: readonly Call[]) =>
    calls.filter(call => call.path === '/v1/fleet/clone/review').map(call => call.body as { settings?: unknown[] });

  const setup = (target: Answers = {}) => {
    const { target: here, work } = settingsAnswers();
    return daemons(
      { ...here, '/v1/config/status': configStatus([HELD]), '/v1/fleet/clone/review': answering(), ...target },
      work,
    );
  };

  it('starts with no settings ticked and none listed, then lists a ticked file’s keys and waits for a pick on a key both machines changed', async () => {
    const { createClient, calls } = setup();
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      // The Update is the fleet alone: the review it applies was made with no settings.
      expect((tickItem(screen, 'warden') as HTMLInputElement).checked).toBe(false);
      expect(screen.q('[data-clone-key]')).toBeNull();
      expect(screen.submit()?.disabled).toBe(false);
      expect(screen.text('[data-clone-items-intro], [data-setup-section="clone-items"]')).not.toContain('Copied whole');
      expect(reviewBodies(calls.target).map(body => body.settings === undefined)).toEqual([false, true]);

      await click(tickItem(screen, 'warden'), 'tick warden');
      // Ticking asks again, for exactly this document.
      expect(reviewBodies(calls.target).at(-1)?.settings).toEqual([
        { path: 'warden.yaml', text: expect.stringContaining('JEV_API_KEY') },
      ]);
      expect(screen.q('[data-clone-key="warden.yaml:caps.jevUsdPerDay"] [data-clone-key-loosens]')).not.toBeNull();
      expect(keyRadios(screen, 'warden.yaml:intervalMinutes').map(radio => radio.checked)).toEqual([false, false]);
      expect(screen.submit()?.disabled).toBe(true);
      expect(screen.text('[data-setup-note="settings-undecided"]')).toContain('warden.yaml: intervalMinutes');
      expect(screen.step()).toBe('preview');
      expect(screen.q('[data-clone-review-state="changes"]')).not.toBeNull();
    } finally {
      await screen.view.unmount();
    }
  });

  it('decides the items and the settings in ONE apply that names the review it was shown, and writes no file whole', async () => {
    const { createClient, calls } = setup();
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(tickItem(screen, 'warden'), 'tick warden');
      // The item and the key it needs are two writes; the file is a third only while some key of it is taken.
      await click(keyRadios(screen, 'warden.yaml:intervalMinutes')[0] ?? null, 'keep mine');
      expect(screen.submit()?.textContent).toBe('Update 3 things');
      const cap = '[data-clone-key="warden.yaml:caps.jevUsdPerDay"] input[type="checkbox"]';
      await click(screen.q(cap), 'keep the cap');
      expect(screen.submit()?.textContent).toBe('Update 2 things');
      await click(screen.q(cap), 'take the cap');
      expect(screen.submit()?.textContent).toBe('Update 3 things');

      await click(screen.submit(), 'Update');

      expect(screen.step()).toBe('done');
      const bodies = changeBodies(calls.target);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.change).toMatchObject({
        kind: 'clone.import',
        mode: 'update',
        reviewed: 'fp-warden.yaml',
        settings: [{ path: 'warden.yaml' }],
        settingsDecisions: { 'warden.yaml': { intervalMinutes: 'keep', 'caps.jevUsdPerDay': 'take' } },
      });
      expect(configWrites(calls.target)).toEqual([]);
      // A file that loosens is held: Done says it is waiting, beside the fleet it came with.
      expect(screen.q('[data-clone-outcome="warden"]')?.getAttribute('data-outcome')).toBe('pending');
      expect(screen.text('[data-clone-outcome="warden"]')).toContain('waiting for your confirmation');
      expect(screen.q('[data-clone-outcome="fleet"]')?.getAttribute('data-outcome')).toBe('copied');
    } finally {
      await screen.view.unmount();
    }
  });

  it('shows the default runtime as a row of its own, since an Update has no picker for it', async () => {
    const { createClient, calls } = setup({
      '/v1/fleet/clone/review': answering({ controls: [DEFAULT_ROW] }),
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(tickItem(screen, 'controls'), 'tick controls');
      expect(screen.q('[data-clone-key="controls:defaultRuntime"]')).not.toBeNull();
      expect(screen.submit()?.disabled).toBe(false);
      await click(screen.submit(), 'Update');
      expect(changeBodies(calls.target)[0]?.change).toMatchObject({
        mode: 'update',
        settingsDecisions: { controls: { defaultRuntime: 'take' } },
      });
    } finally {
      await screen.view.unmount();
    }
  });

  it('stays on the Update when the settings cannot be reviewed, says why, and applies the review it has once they are unticked', async () => {
    let asked = 0;
    const plain = answering();
    const { createClient, calls } = setup({
      '/v1/fleet/clone/review': (call: Call) => {
        // The third review: the one the tick asks for (the Update's own review already carries the keys).
        asked += 1;
        return asked === 3 ? new Error('network down') : plain(call);
      },
    });
    const screen = await render(createClient);
    try {
      await toChanges(screen);
      await click(tickItem(screen, 'warden'), 'tick warden');

      // The Update is still the screen: its review stands, and the settings wait for a review of their own.
      expect(screen.q('[data-clone-review-state="changes"]')).not.toBeNull();
      expect(screen.text('[data-setup-note="settings-undecided"]')).toContain('none of them is copied yet');
      expect(screen.submit()?.disabled).toBe(true);
      expect(screen.q('[data-clone-review-retry]')?.className).toContain('min-h-[44px]');

      await click(tickItem(screen, 'warden'), 'untick warden');
      expect(screen.q('[data-setup-note="settings-undecided"]')).toBeNull();
      expect(screen.submit()?.disabled).toBe(false);
      await click(screen.submit(), 'Update');
      const change = changeBodies(calls.target)[0]?.change;
      expect(change).toMatchObject({ mode: 'update', reviewed: 'fp-plain' });
      expect(change).not.toHaveProperty('settings');
      expect(change).not.toHaveProperty('settingsDecisions');
    } finally {
      await screen.view.unmount();
    }
  });

  it('reviews again for the settings a mode ticks when the person moves from Update to Add alongside', async () => {
    const { createClient, calls } = setup();
    const screen = await render(createClient);
    try {
      await screen.choose('work');
      await click(screen.q('[data-step-next]'), 'Next');
      expect(screen.step()).toBe('existing');
      await screen.choose('alongside');
      // Add alongside starts with every file the source shared ticked, so the review is made again for those.
      expect(
        ((reviewBodies(calls.target).at(-1)?.settings ?? []) as { path: string }[]).map(document => document.path),
      ).toEqual(['warden.yaml', 'controls']);
      await click(screen.q('[data-step-next]'), 'Next');
      expect(screen.step()).toBe('preview');
      await click(keyRadios(screen, 'warden.yaml:intervalMinutes')[1] ?? null, 'use theirs');
      await click(screen.submit(), 'Copy alongside');

      // The settings are decided first, against the review that asked for them, and the fleet is added after.
      const [settings, fleet] = changeBodies(calls.target).map(body => body.change);
      expect(settings).toMatchObject({
        mode: 'update',
        reviewed: 'fp-warden.yaml+controls',
        settingsDecisions: { 'warden.yaml': { intervalMinutes: 'take', 'caps.jevUsdPerDay': 'take' } },
      });
      expect(fleet).toMatchObject({ mode: 'alongside' });
      expect(fleet).not.toHaveProperty('reviewed');
    } finally {
      await screen.view.unmount();
    }
  });

  describe('when only a settings file differs (reviewer M1)', () => {
    /** The fleet, the logins and the keys are all the same as the earlier copy: only the documents sent can differ. */
    const settingsOnly =
      (rows: Partial<Record<CloneSettingsDoc, Rows>> = { 'warden.yaml': WARDEN_ROWS }, probable = 0) =>
      (call: Call): unknown => {
        const sent = (call.body as { settings?: { path: CloneSettingsDoc }[] }).settings;
        return review({
          same: { count: 12, probable },
          settings: (sent ?? []).map(document => ({ path: document.path, keys: rows[document.path] ?? [] })),
          fingerprint: sent === undefined ? 'fp-plain' : `fp-${sent.map(document => document.path).join('+')}`,
        });
      };
    const only = (rows?: Partial<Record<CloneSettingsDoc, Rows>>, probable = 0) =>
      setup({ '/v1/fleet/clone/review': settingsOnly(rows, probable) });

    it('keeps the settings files on screen and says nothing to copy only until one is ticked', async () => {
      const { createClient, calls } = only();
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        // Not the "already here" note: a settings file differs, and the Update is where it is chosen.
        expect(screen.q('[data-setup-note="nothing-to-copy"]')).toBeNull();
        expect(screen.q('[data-clone-review-state="changes"]')).not.toBeNull();
        expect((tickItem(screen, 'warden') as HTMLInputElement).checked).toBe(false);
        expect(tickItem(screen, 'controls')).not.toBeNull();
        expect(screen.q('[data-clone-key]')).toBeNull();
        // Nothing is ticked, so nothing is written and nothing is linked: the button waits.
        expect(screen.submit()?.textContent).toBe('Nothing to copy');
        expect(screen.submit()?.disabled).toBe(true);
        expect(changeBodies(calls.target)).toEqual([]);

        await click(tickItem(screen, 'warden'), 'tick warden');
        expect(screen.q('[data-clone-key="warden.yaml:caps.jevUsdPerDay"] [data-clone-key-loosens]')).not.toBeNull();
        // A key both machines changed is the person's to choose.
        expect(keyRadios(screen, 'warden.yaml:intervalMinutes').map(radio => radio.checked)).toEqual([false, false]);
        expect(screen.submit()?.disabled).toBe(true);
        expect(screen.text('[data-setup-note="settings-undecided"]')).toContain('warden.yaml: intervalMinutes');
      } finally {
        await screen.view.unmount();
      }
    });

    it('applies the ticked settings in one update that names the review it was shown, and writes no file whole', async () => {
      const { createClient, calls } = only();
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        await click(tickItem(screen, 'warden'), 'tick warden');
        await click(keyRadios(screen, 'warden.yaml:intervalMinutes')[0] ?? null, 'keep mine');
        expect(screen.submit()?.textContent).toBe('Update 2 things');
        // The file, and the key the Warden needs that this machine lacks.
        expect(screen.submit()?.disabled).toBe(false);

        await click(screen.submit(), 'Update');

        expect(screen.step()).toBe('done');
        const bodies = changeBodies(calls.target);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]?.change).toMatchObject({
          kind: 'clone.import',
          mode: 'update',
          reviewed: 'fp-warden.yaml',
          decisions: {},
          settings: [{ path: 'warden.yaml' }],
          settingsDecisions: { 'warden.yaml': { intervalMinutes: 'keep', 'caps.jevUsdPerDay': 'take' } },
        });
        expect(configWrites(calls.target)).toEqual([]);
      } finally {
        await screen.view.unmount();
      }
    });

    it('offers the default runtime and the controls too, each reviewed key by key', async () => {
      const { createClient, calls } = only({ controls: [DEFAULT_ROW] });
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        await click(tickItem(screen, 'controls'), 'tick controls');
        expect(screen.q('[data-clone-key="controls:defaultRuntime"]')).not.toBeNull();
        expect(screen.submit()?.textContent).toBe('Update 1 thing');
        await click(screen.submit(), 'Update');
        expect(changeBodies(calls.target)[0]?.change).toMatchObject({
          mode: 'update',
          settingsDecisions: { controls: { defaultRuntime: 'take' } },
        });
      } finally {
        await screen.view.unmount();
      }
    });

    it('still links an earlier copy by name without writing a setting, until the person ticks one', async () => {
      const { createClient, calls } = only(undefined, 3);
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        expect(screen.q('[data-setup-note="nothing-to-copy"]')).toBeNull();
        expect(screen.submit()?.textContent).toBe('Finish and link 3 items');
        expect(screen.submit()?.disabled).toBe(false);
        await click(tickItem(screen, 'warden'), 'tick warden');
        await click(tickItem(screen, 'warden'), 'untick warden');
        expect(screen.submit()?.textContent).toBe('Finish and link 3 items');

        await click(screen.submit(), 'Finish and link');

        const bodies = changeBodies(calls.target);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]?.change).toMatchObject({ kind: 'clone.import', mode: 'update', reviewed: 'fp-plain' });
        expect(bodies[0]?.change).not.toHaveProperty('settings');
        expect(bodies[0]?.change).not.toHaveProperty('settingsDecisions');
        expect(configWrites(calls.target)).toEqual([]);
      } finally {
        await screen.view.unmount();
      }
    });

    it('still says Nothing to copy when the source shares settings files and none of them differs', async () => {
      const { createClient, calls } = only({});
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        expect(screen.text('[data-setup-note="nothing-to-copy"]')).toBe(
          'Everything from work-linux is already here. Nothing to copy.',
        );
        expect(screen.q('[data-setup-choices="clone-items"]')).toBeNull();
        expect(screen.q('[data-change-submit]')).toBeNull();
        expect(changeBodies(calls.target)).toEqual([]);
      } finally {
        await screen.view.unmount();
      }
    });
  });

  describe('when Finish and link is the primary action (reviewer M2)', () => {
    // A daemon that does what `clone.import` does with a review: the fingerprint it recomputes is bound to the
    // fleet AND the documents the request carries (`#reviewFingerprint`), using the real settings analysis and
    // the real request schema. A request whose fingerprint names a different set of documents is refused as stale.
    const THEIRS_CONTROLS = controlsText(machineView({ name: 'work-linux', runtimeCount: 3 }));
    /** This machine's own documents: the Warden differs from the source's, the controls are identical. */
    const HERE: Readonly<Record<string, string>> = { 'warden.yaml': '# here\n', controls: THEIRS_CONTROLS };
    const analysed = (sent: readonly { path: CloneSettingsDoc; text: string }[]) =>
      analyseCloneSettings(
        sent.map(document => ({
          path: document.path,
          theirs: document.text,
          mine: HERE[document.path] ?? '',
          mineExists: true,
        })),
        undefined,
      );
    const bound = (sent: readonly { path: CloneSettingsDoc; text: string }[] | undefined): string =>
      sent === undefined || sent.length === 0 ? 'fleet' : `fleet+${analysed(sent).fingerprint}`;
    const daemon = (items: FleetCloneReview['items'] = []) =>
      setup({
        '/v1/fleet/clone/review': (call: Call): unknown => {
          const sent = (call.body as { settings?: { path: CloneSettingsDoc; text: string }[] }).settings;
          return review({
            items,
            same: { count: 12, probable: 3 },
            settings: sent === undefined ? [] : reviewCloneSettings(analysed(sent)),
            fingerprint: bound(sent),
          });
        },
        '/v1/fleet/proposals': (call: Call): unknown => {
          const change = FleetAccountChangeSchema.parse((call.body as { change: unknown }).change);
          if (change.kind === 'clone.import' && change.reviewed !== bound(change.settings)) {
            return new FyHttpError(CLONE_REVIEW_STALE, 409, 'fleet_change_refused');
          }
          return STAGED;
        },
      });
    /** Take every undecided key (the differing Warden has keys both machines hold), so Update can be pressed. */
    const decideAll = async (screen: Screen): Promise<void> => {
      for (const group of screen.all('[data-clone-key]')) {
        const radios = [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
        if (radios.length > 0 && !radios.some(radio => radio.checked)) await click(radios[1] ?? null, 'take theirs');
      }
    };
    const warden = (screen: Screen) => click(tickItem(screen, 'warden'), 'toggle warden');
    const controls = (screen: Screen) => click(tickItem(screen, 'controls'), 'toggle controls');
    const paths = (change: Record<string, unknown> | undefined) =>
      ((change?.settings as { path: string }[] | undefined) ?? []).map(document => document.path);

    /** Each way of ticking, what the screen then offers, and the documents the request must carry. */
    const MATRIX: readonly {
      readonly name: string;
      readonly tick: (screen: Screen) => Promise<void>;
      readonly button: string;
      readonly carries: readonly string[];
    }[] = [
      { name: 'ticks nothing', tick: async () => undefined, button: 'Finish and link 3 items', carries: [] },
      {
        name: 'ticks only the document that differs',
        tick: warden,
        button: 'Update 2 things',
        carries: ['warden.yaml'],
      },
      {
        name: 'ticks only a document that is identical here',
        tick: controls,
        button: 'Finish and link 3 items',
        carries: [],
      },
      {
        name: 'ticks both',
        tick: async screen => {
          await warden(screen);
          await controls(screen);
        },
        button: 'Update 2 things',
        carries: ['warden.yaml', 'controls'],
      },
      {
        name: 'ticks then unticks the document that differs',
        tick: async screen => {
          await warden(screen);
          await warden(screen);
        },
        button: 'Finish and link 3 items',
        carries: [],
      },
      {
        name: 'ticks the identical one, then the one that differs',
        tick: async screen => {
          await controls(screen);
          await warden(screen);
        },
        button: 'Update 2 things',
        carries: ['warden.yaml', 'controls'],
      },
      {
        name: 'ticks both, then unticks the one that differs',
        tick: async screen => {
          await controls(screen);
          await warden(screen);
          await warden(screen);
        },
        button: 'Finish and link 3 items',
        carries: [],
      },
      {
        name: 'ticks both, then unticks the identical one',
        tick: async screen => {
          await warden(screen);
          await controls(screen);
          await controls(screen);
        },
        button: 'Update 2 things',
        carries: ['warden.yaml'],
      },
    ];

    it('binds an Update that also changes the fleet to the identical document it ticked, and sends it', async () => {
      const { createClient, calls } = daemon([ITEMS.newMcp]);
      const screen = await render(createClient);
      try {
        await toChanges(screen);
        await controls(screen);
        expect(screen.submit()?.disabled).toBe(false);
        await click(screen.submit(), 'Update');

        expect(screen.step()).toBe('done');
        const change = changeBodies(calls.target)[0]?.change;
        expect(paths(change)).toEqual(['controls']);
        expect(change).toMatchObject({ mode: 'update', reviewed: bound(change?.settings as never) });
        expect(change?.reviewed).not.toBe('fleet');
      } finally {
        await screen.view.unmount();
      }
    });

    for (const row of MATRIX) {
      it(`sends a request this machine accepts when the person ${row.name}`, async () => {
        const { createClient, calls } = daemon();
        const screen = await render(createClient);
        try {
          await toChanges(screen);
          await row.tick(screen);
          await decideAll(screen);
          expect(screen.submit()?.textContent).toBe(row.button);
          expect(screen.submit()?.disabled).toBe(false);

          await click(screen.submit(), row.button);

          // The daemon took it: a refusal as stale would have left the person on this step.
          expect(screen.step()).toBe('done');
          const bodies = changeBodies(calls.target);
          expect(bodies).toHaveLength(1);
          const change = bodies[0]?.change;
          expect(change).toMatchObject({
            kind: 'clone.import',
            mode: 'update',
            reviewed: bound(change?.settings as never),
          });
          // The documents the request carries are exactly the ones whose review the person was shown.
          expect(paths(change)).toEqual([...row.carries]);
          if (row.carries.length === 0) {
            // Metadata only: the link names the plain review and writes no setting and no file.
            expect(change).toMatchObject({ reviewed: 'fleet' });
            expect(change).not.toHaveProperty('settings');
            expect(change).not.toHaveProperty('settingsDecisions');
          }
          expect(configWrites(calls.target)).toEqual([]);
        } finally {
          await screen.view.unmount();
        }
      });
    }
  });
});
