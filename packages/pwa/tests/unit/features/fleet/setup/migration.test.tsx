import { describe, expect, it } from 'bun:test';
import type { FleetMigrationOutcome } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { MigrateMachine, migrationReachable } from '../../../../../src/features/fleet/setup/migration.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  type Call,
  machineView,
  migrationView,
  NOW,
  PASSWORD,
  permissions,
  STUDIO,
  SWITCHED_OFF,
  scriptedClient,
  UNLOCKED,
} from './setup-support.ts';

const OLD_MACHINE = machineView({ format: 'version-1' });
const MIGRATION = '/v1/fleet/migration';
const APPLY = '/v1/fleet/migration/apply';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const MIGRATED: FleetMigrationOutcome = {
  outcome: 'migrated',
  resumed: false,
  credentials: [{ id: 'claude-work', harness: 'claude', store: 'ferretry', retired: 0 }],
  runtimes: [{ name: 'claude-default' }, { name: 'claude-review', formerName: 'claude-2' }],
};

interface Spies {
  left: number;
  done: number;
  retried: number;
}

const harness = async (answers: Record<string, unknown>, calls: Call[], spies: Spies) => {
  const client = scriptedClient(answers, calls);
  return await mount(
    <MigrateMachine
      connection={STUDIO}
      machineName="studio-mac"
      machine={OLD_MACHINE}
      online
      checking={false}
      onRetry={() => {
        spies.retried += 1;
      }}
      createClient={async () => client}
      onDone={() => {
        spies.done += 1;
      }}
      onLeave={() => {
        spies.left += 1;
      }}
      now={NOW}
    />,
  );
};

const fresh = (): Spies => ({ left: 0, done: 0, retried: 0 });

describe('migrationReachable', () => {
  it('offers the entry only on an old-format machine that can migrate or is held by a named blocker', () => {
    expect(migrationReachable(migrationView({ status: 'version-2', dryRun: undefined }))).toBe(false);
    expect(migrationReachable(migrationView({ status: 'no-fleet', dryRun: undefined }))).toBe(false);
    expect(migrationReachable(migrationView())).toBe(true);
    expect(migrationReachable(migrationView({ status: 'in-progress' }))).toBe(true);

    const blocked = 'A session is running on studio-mac.';
    expect(
      migrationReachable(
        migrationView({
          dryRun: { digest: 'sha256-abc', lines: [], blockers: [blocked] },
          migrate: { available: false, reason: blocked },
        }),
      ),
    ).toBe(true);
  });

  it('hides the entry while the account-model switch is off', () => {
    expect(
      migrationReachable(
        migrationView({
          dryRun: { digest: 'sha256-abc', lines: [], blockers: ['A session is running on studio-mac.'] },
          migrate: SWITCHED_OFF,
        }),
      ),
    ).toBe(false);
    expect(migrationReachable(migrationView({ dryRun: undefined, migrate: SWITCHED_OFF }))).toBe(false);
  });
});

describe('MigrateMachine', () => {
  it('shows the dry run first, then migrates the plan it showed and reports the move', async () => {
    const calls: Call[] = [];
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView({
          dryRun: {
            digest: 'sha256-seen',
            lines: ['Login claude-work moves to the shared store.', 'Runtime claude-2 is renamed claude-review.'],
            blockers: [],
          },
        }),
        [APPLY]: MIGRATED,
      },
      calls,
      spies,
    );
    try {
      await settle();
      const step = must(view.container.querySelector('[data-migration-step="dry-run"]'), 'dry run');
      expect(step.textContent).toContain('studio-mac still uses the old account format');
      expect(step.textContent).toContain('Nothing moves until you approve it.');
      expect(step.textContent).toContain('Login claude-work moves to the shared store.');
      expect(step.textContent).toContain('Runtime claude-2 is renamed claude-review.');
      expect(view.container.querySelector('[data-setup-note="migration-blocked"]')).toBeNull();
      expect(calls.some(call => call.path === APPLY)).toBe(false);
      expect(view.container.querySelector('[data-change-submit]')?.textContent).toBe('Migrate');

      await click(view.container.querySelector('[data-change-submit]'), 'migrate');

      const sent = must(
        calls.find(call => call.path === APPLY),
        'apply call',
      );
      expect(sent.body).toEqual({ digest: 'sha256-seen' });
      expect(spies.retried).toBe(1);
      expect(view.container.querySelector('[data-migration-step="done"]')).not.toBeNull();
      const note = must(view.container.querySelector('[data-setup-note="migrated"]'), 'migrated note');
      expect(note.textContent).toContain('studio-mac uses the new account format');
      expect(note.textContent).toContain('2 runtimes and 1 login moved.');
      expect(note.textContent).toContain('Runtimes that were renamed still answer to their old names.');

      await click(view.container.querySelector('[data-migration-finish]'), 'go to runtimes');
      expect(spies.done).toBe(1);
      expect(spies.left).toBe(0);
    } finally {
      await view.unmount();
    }
  });

  it('says nothing about old names when no runtime was renamed', async () => {
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView(),
        [APPLY]: { ...MIGRATED, runtimes: [{ name: 'claude-default' }] },
      },
      [],
      spies,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'migrate');
      const note = must(view.container.querySelector('[data-setup-note="migrated"]'), 'migrated note');
      expect(note.textContent).toContain('1 runtime and 1 login moved.');
      expect(note.textContent).not.toContain('old names');
    } finally {
      await view.unmount();
    }
  });

  it('names every blocker and keeps Migrate off when the machine cannot migrate', async () => {
    const blocker = 'A session is running on studio-mac.';
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView({
          dryRun: {
            digest: 'sha256-abc',
            lines: ['Login claude-work moves.'],
            blockers: [blocker, 'A copy could not be read.'],
          },
          migrate: { available: false, reason: blocker },
        }),
      },
      [],
      spies,
    );
    try {
      await settle();
      const note = must(view.container.querySelector('[data-setup-note="migration-blocked"]'), 'blockers');
      expect(note.textContent).toContain('It can’t run yet');
      expect(note.textContent).toContain(blocker);
      expect(note.textContent).toContain('A copy could not be read.');
      expect(view.container.querySelector('[data-change-submit]')).toBeNull();
      expect(view.container.querySelector('[data-change-unavailable]')?.textContent).toBe(blocker);
    } finally {
      await view.unmount();
    }
  });

  it('finishes a half-done migration by its own digest, which wins over the dry run', async () => {
    const calls: Call[] = [];
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView({
          status: 'in-progress',
          inProgress: { digest: 'sha256-half', startedAt: '2026-10-13T07:00:00.000Z' },
        }),
        [APPLY]: { ...MIGRATED, resumed: true },
      },
      calls,
      spies,
    );
    try {
      await settle();
      const step = must(view.container.querySelector('[data-migration-step="dry-run"]'), 'dry run');
      expect(step.textContent).toContain('A move to the new account format started on studio-mac and did not finish.');
      expect(step.textContent).toContain('Approving it finishes that one.');
      expect(view.container.querySelector('[data-change-submit]')?.textContent).toBe('Finish migrating');

      await click(view.container.querySelector('[data-change-submit]'), 'finish migrating');
      expect(calls.find(call => call.path === APPLY)?.body).toEqual({ digest: 'sha256-half' });
      expect(view.container.querySelector('[data-setup-note="migrated"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('shows only the in-progress sentence and no dry run when none is offered', async () => {
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView({
          status: 'in-progress',
          dryRun: undefined,
          inProgress: { digest: 'sha256-half', startedAt: '2026-10-13T07:00:00.000Z' },
        }),
      },
      [],
      spies,
    );
    try {
      await settle();
      expect(view.container.querySelector('[data-setup-section="dry-run"]')).toBeNull();
      expect(view.container.querySelector('[data-setup-note="migration-blocked"]')).toBeNull();
      expect(view.container.querySelector('[data-change-submit]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('does nothing when there is no digest to send', async () => {
    const calls: Call[] = [];
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView({ dryRun: undefined }),
      },
      calls,
      spies,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'migrate');
      expect(calls.some(call => call.path === APPLY)).toBe(false);
      expect(view.container.querySelector('[data-migration-step="dry-run"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('says why nothing was migrated when the machine refuses', async () => {
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView(),
        [APPLY]: { outcome: 'refused', reasons: ['A session started while you were looking.', 'The plan changed.'] },
      },
      [],
      spies,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'migrate');
      const note = must(view.container.querySelector('[data-setup-note="migration-refused"]'), 'refusal');
      expect(note.textContent).toContain('Nothing was migrated');
      expect(note.textContent).toContain('A session started while you were looking.');
      expect(note.textContent).toContain('The plan changed.');
      expect(view.container.querySelector('[data-migration-step="done"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('says the migration was undone, and lists what could not be put back', async () => {
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView(),
        [APPLY]: { outcome: 'rolled-back', reason: 'The disk filled up.', unrestored: ['claude-work', 'codex-work'] },
      },
      [],
      spies,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'migrate');
      const note = must(view.container.querySelector('[data-setup-note="migration-rolled-back"]'), 'rolled back');
      expect(note.textContent).toContain('The migration was undone');
      expect(note.textContent).toContain('The disk filled up.');
      expect(note.textContent).toContain('These could not be put back: claude-work, codex-work.');
    } finally {
      await view.unmount();
    }

    const clean = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView(),
        [APPLY]: { outcome: 'rolled-back', reason: 'The disk filled up.', unrestored: [] },
      },
      [],
      fresh(),
    );
    try {
      await settle();
      await click(clean.container.querySelector('[data-change-submit]'), 'migrate');
      const note = must(clean.container.querySelector('[data-setup-note="migration-rolled-back"]'), 'rolled back');
      expect(note.textContent).toContain('The disk filled up.');
      expect(note.textContent).not.toContain('could not be put back');
    } finally {
      await clean.unmount();
    }
  });

  it('keeps the dry run and shows the machine’s sentence when the apply is refused outright', async () => {
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: migrationView(),
        [APPLY]: new FyHttpError('The plan on the machine is no longer this one.', 409, 'migration_stale'),
      },
      [],
      spies,
    );
    try {
      await settle();
      await click(view.container.querySelector('[data-change-submit]'), 'migrate');
      expect(view.container.querySelector('[data-change-refusal]')?.textContent).toBe(
        'The plan on the machine is no longer this one.',
      );
      expect(view.container.querySelector('[data-migration-step="dry-run"]')).not.toBeNull();
      expect(view.container.querySelector('[data-migration-step="done"]')).toBeNull();
      expect(spies.retried).toBe(0);
    } finally {
      await view.unmount();
    }
  });

  it('asks for the operator password before it even shows the dry run on a locked browser', async () => {
    const calls: Call[] = [];
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions({ mayApply: false, applyRefusal: 'locked' }),
        '/v1/grants/unlock': UNLOCKED,
        [MIGRATION]: migrationView(),
      },
      calls,
      spies,
    );
    try {
      await settle();
      expect(calls.some(call => call.path === MIGRATION)).toBe(false);
      expect(view.container.querySelector('[data-migration-step="dry-run"]')).toBeNull();
      const field = view.container.querySelector('[data-change-password]') as HTMLInputElement | null;
      expect(view.container.textContent).toContain('studio-mac operator password');
      expect(view.container.querySelector('[data-change-submit]')?.textContent).toBe('Show what changes');

      await type(must(field, 'password field'), PASSWORD);
      await click(view.container.querySelector('[data-change-submit]'), 'show what changes');

      expect(calls.some(call => call.path === '/v1/grants/unlock')).toBe(true);
      const read = must(
        calls.find(call => call.path === MIGRATION),
        'migration read',
      );
      expect(Object.values(read.headers).join(' ')).toContain('fy_unlock_');
      expect(view.container.querySelector('[data-migration-step="dry-run"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('says so when the machine’s setup cannot be read', async () => {
    const spies = fresh();
    const view = await harness(
      {
        '/v1/fleet/permissions': permissions(),
        [MIGRATION]: new FyHttpError('The old fleet files are unreadable.', 500, 'fleet_unreadable'),
      },
      [],
      spies,
    );
    try {
      await settle();
      const note = must(view.container.querySelector('[data-setup-note="migration-unreadable"]'), 'unreadable');
      expect(note.textContent).toContain('Couldn’t read studio-mac’s setup');
      expect(note.textContent).toContain('The old fleet files are unreadable.');
      expect(view.container.querySelector('[data-migration-step="dry-run"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('shows a working line until the dry run arrives, then Back from step 1 leaves', async () => {
    const spies = fresh();
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    const client = scriptedClient({
      '/v1/fleet/permissions': permissions(),
      [MIGRATION]: () => migrationView(),
    });
    const slow = {
      request: async (...args: Parameters<typeof client.request>) => {
        if (args[0] === MIGRATION) await pending;
        return await client.request(...args);
      },
    } as typeof client;
    const view = await mount(
      <MigrateMachine
        connection={STUDIO}
        machineName="studio-mac"
        machine={OLD_MACHINE}
        online
        checking={false}
        onRetry={() => undefined}
        createClient={async () => slow}
        onDone={() => undefined}
        onLeave={() => {
          spies.left += 1;
        }}
        now={NOW}
      />,
    );
    try {
      await settle();
      expect(view.container.textContent).toContain('Working out what would change…');
      release(undefined);
      await settle();
      expect(view.container.querySelector('[data-migration-step="dry-run"]')).not.toBeNull();

      await click(view.container.querySelector('[data-stepper-back]'), 'back');
      expect(spies.left).toBe(1);
    } finally {
      await view.unmount();
    }
  });
});
