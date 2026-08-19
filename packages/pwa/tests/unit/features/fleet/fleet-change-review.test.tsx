import { describe, expect, it } from 'bun:test';
import { FLEET_APPROVAL_MAX_ATTEMPTS, FLEET_APPROVAL_TTL_SECONDS } from '@ferretry/protocol';
import type {
  FleetApplyOutcome,
  FleetManifestAccountView,
  FleetProposalView,
} from '../../../../src/features/fleet/fleet-api.ts';
import {
  FleetApplyReport,
  FleetChangeReview,
  FleetLiveRoster,
  FleetRefusalAlert,
} from '../../../../src/features/fleet/fleet-change-review.tsx';
import { type GrantRefusalNotice, grantRefusalNotice } from '../../../../src/lib/grants.ts';
import { absoluteTime } from '../../../../src/lib/session-screens.ts';
import { mount } from '../../../support/dom.ts';
import {
  account,
  accountId,
  button,
  click,
  field,
  manifest,
  pick,
  plan,
  proposal,
  scaffoldProposal,
  type,
} from './fleet-support.ts';

const noop = (): void => undefined;
/** `account()` already returns the shared shape, so this is a name rather than a conversion. */
const accounts = (list: readonly FleetManifestAccountView[]): readonly FleetManifestAccountView[] => list;

describe('the live roster', () => {
  it('renders a published manifest and offers each account its own layer', async () => {
    let edited = '';
    const mounted = await mount(
      <FleetLiveRoster
        accounts={accounts([
          account(),
          account({
            id: accountId(2),
            wrapper: 'claude-blocked',
            available: false,
            unavailableReason: 'no wrapper on PATH',
          }),
        ])}
        generatedAt="2026-08-05T06:00:00.000Z"
        onEdit={target => {
          edited = target.wrapper;
        }}
        editable={true}
      />,
    );
    expect(mounted.container.textContent).toContain('claude-studio');
    expect(mounted.container.textContent).toContain('no wrapper on PATH');
    expect(mounted.container.textContent).toContain('2 published');

    const buttons = [...mounted.container.querySelectorAll('button')];
    await click(buttons[1] as HTMLElement);
    expect(edited).toBe('claude-blocked');
    await mounted.unmount();
  });

  it('says an empty manifest is an OBSERVED empty fleet, not a failed read', async () => {
    const mounted = await mount(
      <FleetLiveRoster accounts={[]} generatedAt="2026-08-05T06:00:00.000Z" onEdit={noop} editable={false} />,
    );
    expect(pick(mounted.container, '[data-fleet-live-empty]').textContent).toContain('observed empty fleet');
    await mounted.unmount();
  });

  it('offers no layer edit while a change is already staged', async () => {
    const mounted = await mount(
      <FleetLiveRoster accounts={accounts([account()])} generatedAt="now" onEdit={noop} editable={false} />,
    );
    expect(button(mounted.container, 'Edit layer').hasAttribute('disabled')).toBe(true);
    await mounted.unmount();
  });
});

describe('a daemon refusal', () => {
  it('keeps every line, and names the code when there is one', async () => {
    const detail = 'the resulting fleet configuration would be invalid:\nagents.0.routes.default.home: duplicate home';
    const mounted = await mount(
      <FleetRefusalAlert refusal={{ kind: 'refused', detail, code: 'fleet_proposal_refused' }} />,
    );
    const block = pick(mounted.container, 'pre');
    expect(block.textContent).toBe(detail);
    expect(block.textContent?.split('\n')).toHaveLength(2);
    expect(mounted.container.textContent).toContain('fleet_proposal_refused');
    await mounted.unmount();
  });

  it('says a forbidden refusal was a refusal of the CHANGE, with no code to show', async () => {
    const mounted = await mount(
      <FleetRefusalAlert refusal={{ kind: 'forbidden', detail: 'a paired device may not apply' }} />,
    );
    expect(mounted.container.textContent).toContain('This daemon refused the change');
    expect(mounted.container.querySelector('code')).toBeNull();
    await mounted.unmount();
  });

  /**
   * A 403 is three different situations a person acts on differently — the operator switched the
   * capability off, the operator password is needed, or the daemon has lost its own decision. Showing
   * only "the daemon refused" collapses them into the greyed-control dead end this feature removes.
   */
  it('names WHICH operator refusal a 403 was, above the daemon’s own sentence', async () => {
    const mounted = await mount(
      <FleetRefusalAlert
        refusal={{
          kind: 'forbidden',
          detail: 'grant it on the host with `fy daemon config set fleet --configure`.',
          code: 'grant_not_granted',
          grant: grantRefusalNotice(
            Object.assign(new Error('grant it on the host with `fy daemon config set fleet --configure`.'), {
              status: 403,
              code: 'grant_not_granted',
            }),
          ) as GrantRefusalNotice,
        }}
      />,
    );
    expect(pick(mounted.container, '[data-fleet-refusal-grant]').getAttribute('data-fleet-refusal-grant')).toBe(
      'not-granted',
    );
    // No capability is named: a 403 says WHICH refusal it is, not which capability was demanded, and
    // inventing one from the route would be a guess. The daemon's sentence supplies that.
    expect(mounted.container.textContent).toContain('switched this off');
    // And the daemon's own words survive, because they name the command a human runs.
    expect(mounted.container.textContent).toContain('fy daemon config set fleet --configure');
    await mounted.unmount();
  });
});

describe('the staged change', () => {
  const reviewHarness = async (
    overrides: {
      readonly proposal?: FleetProposalView;
      readonly authority?: 'direct' | 'approval' | 'read-only';
      readonly code?: string;
      readonly busy?: boolean;
    } = {},
  ) => {
    const calls = { applied: 0, rechecked: 0, discarded: 0, code: '' };
    const view = overrides.proposal ?? proposal();
    const mounted = await mount(
      <FleetChangeReview
        proposal={view}
        live={accounts([account()])}
        authority={overrides.authority ?? 'approval'}
        command="fy fleet authorize fy_fprop_AAAAAAAAAAAAAAAAAAAAAA"
        code={overrides.code ?? ''}
        onCodeChange={next => {
          calls.code = next;
        }}
        onApply={() => {
          calls.applied += 1;
        }}
        onRecheck={() => {
          calls.rechecked += 1;
        }}
        onDiscard={() => {
          calls.discarded += 1;
        }}
        busy={overrides.busy ?? false}
        refusal={null}
      />,
    );
    return { ...mounted, calls };
  };

  it('never tears a path apart mid-token, and keeps the whole value reachable', async () => {
    // Arrange — the ugliest thing on this screen was a wrapper path rendered as
    //     /Users/ern  g/.ferretr  y/fleet/bi  n/claude-pe  rsonal
    // by `break-all` inside a narrow column: unreadable, and indistinguishable from corruption.
    const harness = await reviewHarness();

    // Assert — not one break-anywhere rule anywhere in the panel.
    expect([...harness.container.querySelectorAll('[class*="break-all"]')]).toHaveLength(0);

    // Every path scrolls in its own box instead, which is what keeps the PAGE from scrolling sideways.
    const paths = [...harness.container.querySelectorAll<HTMLElement>('[data-panel-path]')];
    expect(paths.length).toBeGreaterThan(3);
    for (const path of paths) {
      expect(path.className).toContain('whitespace-nowrap');
      expect(path.className).toContain('overflow-x-auto');
      expect(path.className).toContain('max-w-full');
      // Clipping must never LOSE the value: the whole thing on hover, and the whole thing in the DOM for
      // a screen reader and for a copy.
      expect(path.getAttribute('title')).toBe(path.textContent);
    }

    // The proposal id is one of them: it is what the host mints an approval AGAINST, so a reader has to
    // be able to compare it character for character.
    expect(paths.some(path => path.textContent === 'fy_fprop_AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    await harness.unmount();
  });

  it('keeps uppercase for the eyebrow and the state chip, and nothing else', async () => {
    // Arrange — uppercase on every label removes the hierarchy it exists to create. The eyebrow role
    // (`kt-label`) and the shared state chip (`kt-badge`) keep it; no third thing shouts.
    const harness = await reviewHarness();

    // Assert
    const shouting = [...harness.container.querySelectorAll<HTMLElement>('[class*="uppercase"]')];
    for (const node of shouting) {
      // The approval-code INPUT is a value transform, not a label: a code is typed and shown in caps.
      expect(node.className).toContain('kt-input');
    }
    // The verdict chip is the shared badge rather than a fifth hand-rolled chip design.
    const verdict = pick(harness.container, '[data-fleet-roster-change="unchanged"] .kt-badge');
    expect(verdict.getAttribute('data-tone')).toBe('muted');
    expect(verdict.textContent).toBe('unchanged');
    expect(harness.container.querySelectorAll('.kt-label').length).toBeGreaterThan(0);
    await harness.unmount();
  });

  it('numbers every operation, names its action and shows where a copy comes from', async () => {
    const harness = await reviewHarness();
    const rows = [...harness.container.querySelectorAll('[data-fleet-operation]')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('01');
    expect(rows[0]?.textContent).toContain('create directory');
    expect(rows[2]?.textContent).toContain('from /assets/instructions/studio.md');
    expect(harness.container.textContent).toContain('3 operations');
    await harness.unmount();
  });

  it('binds the review to one proposal id, its expiry and the revision it was derived from', async () => {
    const harness = await reviewHarness();
    expect(pick(harness.container, '[data-fleet-proposal-id]').getAttribute('data-fleet-proposal-id')).toBe(
      'fy_fprop_AAAAAAAAAAAAAAAAAAAAAA',
    );
    // Formatted, not raw: the repo owns instants and the rest of the PWA formats them.
    expect(harness.container.textContent).toContain(absoluteTime('2026-08-05T06:15:00.000Z'));
    expect(harness.container.textContent).not.toContain('2026-08-05T06:15:00.000Z');
    expect(harness.container.textContent).toContain('a1b2c3');
    await harness.unmount();
  });

  it('marks the proposed roster against the live one and warns that history is not rolled back', async () => {
    const changed = proposal({
      preview: {
        kind: 'apply',
        plan: plan([account({ displayName: 'Renamed' }), account({ id: accountId(4), wrapper: 'claude-new' })]),
        documents: [{ path: '/fleet/config.yaml', bytes: 512 }],
      },
    });
    const harness = await reviewHarness({ proposal: changed });
    const marks = [...harness.container.querySelectorAll('[data-fleet-roster-change]')].map(row =>
      row.getAttribute('data-fleet-roster-change'),
    );
    expect(marks).toEqual(['changed', 'added']);
    expect(harness.container.textContent).toContain('not rolled back with it');
    expect(pick(harness.container, '[data-fleet-asset-edits]').getAttribute('data-fleet-asset-edits')).toBe('1');
    await harness.unmount();
  });

  it('names the configuration and asset writes the plan does not contain', async () => {
    const harness = await reviewHarness();
    expect(pick(harness.container, '[data-fleet-documents]').getAttribute('data-fleet-documents')).toBe('2');
    expect(harness.container.textContent).toContain('/home/pilot/.ferretry/fleet/config.yaml');
    expect(harness.container.textContent).toContain('512 B');
    await harness.unmount();
  });

  it('shows the first-run scaffold instead of a plan when there is nothing to plan from', async () => {
    const harness = await reviewHarness({ proposal: scaffoldProposal() });
    expect(harness.container.textContent).toContain('First run');
    expect(harness.container.textContent).toContain('/home/pilot/.ferretry/fleet/bin');
    expect(harness.container.textContent).toContain('config.yaml');
    expect(harness.container.textContent).toContain('export PATH=');
    expect(harness.container.querySelector('[data-fleet-operation]')).toBeNull();
    await harness.unmount();
  });

  it('under approval authority shows the exact host command and will not apply without a code', async () => {
    const harness = await reviewHarness({ authority: 'approval' });
    expect(pick(harness.container, '[data-fleet-authority="approval"]')).toBeDefined();
    expect(pick(harness.container, 'pre').textContent).toBe('fy fleet authorize fy_fprop_AAAAAAAAAAAAAAAAAAAAAA');
    expect(pick(harness.container, '[data-fleet-apply]').hasAttribute('disabled')).toBe(true);
    // L8: the actual budget, from the shared constants, not 'a small number of tries'.
    expect(harness.container.textContent).toContain(`A code lasts ${FLEET_APPROVAL_TTL_SECONDS} seconds`);
    expect(harness.container.textContent).toContain(`${FLEET_APPROVAL_MAX_ATTEMPTS} wrong ones`);

    await type(field(harness.container, '-approval-code'), '7f3k m9qw');
    expect(harness.calls.code).toBe('7f3k m9qw');
    await click(button(harness.container, 'Check for approval'));
    expect(harness.calls.rechecked).toBe(1);
    await harness.unmount();
  });

  it('applies once a code is typed, and reports an outstanding approval', async () => {
    const outstanding = proposal({
      approval: { outstanding: true, expiresAt: '2026-08-05T06:02:00.000Z' },
    });
    const harness = await reviewHarness({ proposal: outstanding, code: '7F3K-M9QW' });
    expect(harness.container.textContent).toContain(
      `An approval is outstanding until ${absoluteTime('2026-08-05T06:02:00.000Z')}.`,
    );
    await click(pick(harness.container, '[data-fleet-apply]'));
    expect(harness.calls.applied).toBe(1);
    await click(button(harness.container, 'Discard'));
    expect(harness.calls.discarded).toBe(1);
    await harness.unmount();
  });

  it('lets a host credential apply directly, and lets a read-only one apply nothing', async () => {
    const direct = await reviewHarness({ authority: 'direct' });
    expect(pick(direct.container, '[data-fleet-authority="direct"]')).toBeDefined();
    expect(pick(direct.container, '[data-fleet-apply]').hasAttribute('disabled')).toBe(false);
    expect(direct.container.querySelector('[id$="-approval-code"]')).toBeNull();
    await direct.unmount();

    const readOnly = await reviewHarness({ authority: 'read-only' });
    expect(pick(readOnly.container, '[data-fleet-authority="read-only"]').textContent).toContain('Run the change');
    expect(pick(readOnly.container, '[data-fleet-apply]').hasAttribute('disabled')).toBe(true);
    await readOnly.unmount();
  });

  it('says it is applying while it applies, and shows a consumed proposal as consumed', async () => {
    const harness = await reviewHarness({ authority: 'direct', busy: true });
    expect(pick(harness.container, '[data-fleet-apply]').textContent).toContain('Applying');
    expect(pick(harness.container, '[data-fleet-side="proposed"]').getAttribute('aria-busy')).toBe('true');
    await harness.unmount();

    const consumed = await reviewHarness({ proposal: proposal({ state: 'consumed' }) });
    expect(consumed.container.textContent).toContain('consumed');
    await consumed.unmount();
  });

  it('renders a refusal inside the review it belongs to', async () => {
    const mounted = await mount(
      <FleetChangeReview
        proposal={proposal()}
        live={[]}
        authority="direct"
        command="fy fleet authorize x"
        code=""
        onCodeChange={noop}
        onApply={noop}
        onRecheck={noop}
        onDiscard={noop}
        busy={false}
        refusal={{ kind: 'proposal-stale', detail: 'the fleet configuration changed on this host' }}
      />,
    );
    expect(pick(mounted.container, '[data-fleet-refusal="proposal-stale"]').textContent).toContain(
      'changed on this host',
    );
    await mounted.unmount();
  });

  it('renders a plan with no shared history and no asset edits without inventing either', async () => {
    const bare = proposal({
      assetEdits: [],
      preview: { kind: 'apply', plan: { ...plan(), sharedHistory: [] }, documents: [] },
    });
    const harness = await reviewHarness({ proposal: bare });
    expect(harness.container.querySelector('[data-fleet-asset-edits]')).toBeNull();
    expect(harness.container.querySelector('[data-fleet-documents]')).toBeNull();
    expect(harness.container.textContent).not.toContain('not rolled back with it');
    await harness.unmount();
  });
});

describe('the apply report', () => {
  const report = async (outcome: FleetApplyOutcome) => await mount(<FleetApplyReport outcome={outcome} />);

  it('reports a plain success, what it pruned and what it left moved aside', async () => {
    const mounted = await report({
      outcome: 'committed',
      result: {
        accountCount: 2,
        operationCount: 7,
        manifestPath: '/m',
        prunedWrappers: ['claude-old'],
        sharedHistory: [],
        backupResidue: ['/homes/x/CLAUDE.md.fy-backup'],
      },
    });
    expect(pick(mounted.container, '[data-fleet-outcome]').getAttribute('data-fleet-outcome')).toBe('committed');
    expect(mounted.container.textContent).toContain('published 2 account(s) from 7 operation(s)');
    expect(mounted.container.textContent).toContain('claude-old');
    expect(mounted.container.textContent).toContain('/homes/x/CLAUDE.md.fy-backup');
    await mounted.unmount();
  });

  it('says the fleet landed when only the history step failed, and not to re-apply', async () => {
    const mounted = await report({
      outcome: 'committed-with-history-failure',
      failedHarness: 'claude',
      reason: 'pool /pool/claude is not writable',
      committed: {
        accountCount: 2,
        operationCount: 9,
        manifestPath: '/home/pilot/.ferretry/fleet/manifest.json',
        manifest: manifest(),
        prunedWrappers: [],
        sharedHistory: [],
      },
    });
    expect(mounted.container.textContent).toContain('The fleet DID land');
    expect(mounted.container.textContent).toContain('Do not re-apply');
    expect(mounted.container.textContent).toContain('pool /pool/claude is not writable');
    await mounted.unmount();
  });

  it('says the host is unchanged after a verified rollback', async () => {
    const mounted = await report({
      outcome: 'rolled-back',
      failedOperation: 'file /bin/claude-studio',
      reason: 'permission denied',
    });
    expect(mounted.container.textContent).toContain('Not applied — host unchanged');
    expect(mounted.container.textContent).toContain('permission denied');
    await mounted.unmount();
  });

  it('names every path a rollback could not verify, and where the only copy still is', async () => {
    const mounted = await report({
      outcome: 'rollback-incomplete',
      failedOperation: 'settings /homes/x/settings.json',
      reason: 'no space left on device',
      unrestored: [
        { path: '/homes/x/settings.json', reason: 'rename failed', backup: '/tmp/settings.fy-backup' },
        { path: '/homes/x/CLAUDE.md', reason: 'still present after removal' },
      ],
    });
    expect(mounted.container.textContent).toContain('host state unverified');
    expect(mounted.container.textContent).toContain('2 path(s) could not be verified');
    expect(mounted.container.textContent).toContain('/tmp/settings.fy-backup');
    expect(mounted.container.textContent).toContain('Do not delete it');
    expect(mounted.container.textContent).toContain('still present after removal');
    await mounted.unmount();
  });

  it('names an exclusive claim it could not clear, because it blocks the NEXT apply', async () => {
    const committed = await report({
      outcome: 'committed',
      result: {
        accountCount: 1,
        operationCount: 3,
        manifestPath: '/m',
        prunedWrappers: [],
        sharedHistory: [],
        lockResidue: '/home/pilot/.ferretry/fleet/apply.lock',
      },
    });
    expect(committed.container.textContent).toContain('/home/pilot/.ferretry/fleet/apply.lock');
    expect(committed.container.textContent).toContain('blocked until this claim is removed');
    await committed.unmount();

    const back = await report({
      outcome: 'rolled-back',
      failedOperation: 'file /bin/x',
      reason: 'denied',
      lockResidue: '/lock',
    });
    expect(back.container.textContent).toContain('/lock');
    await back.unmount();
  });

  it('names content the rollback moved aside because it was not this apply to delete', async () => {
    const mounted = await report({
      outcome: 'rollback-incomplete',
      failedOperation: 'settings /x',
      reason: 'disk full',
      unrestored: [{ path: '/x', reason: 'rename failed' }],
      displaced: [{ path: '/homes/studio/CLAUDE.md', movedTo: '/homes/studio/CLAUDE.md.fy-displaced' }],
    });
    expect(mounted.container.textContent).toContain('/homes/studio/CLAUDE.md.fy-displaced');
    expect(mounted.container.textContent).toContain('was not this apply');
    await mounted.unmount();
  });

  it('reports a prepared host as prepared, with the shell line and what it created and kept', async () => {
    const mounted = await report({
      outcome: 'initialized',
      created: ['/fleet/config.yaml', '/fleet/bin/.keep'],
      kept: ['/fleet/assets/instructions/shared.md'],
      directories: ['/fleet', '/fleet/bin'],
      pathEntry: 'export PATH="$HOME/.ferretry/fleet/bin:$PATH"',
    });
    expect(pick(mounted.container, '[data-fleet-outcome]').getAttribute('data-fleet-outcome')).toBe('initialized');
    expect(mounted.container.textContent).toContain('Host prepared');
    expect(mounted.container.textContent).toContain('NO fleet manifest has been published yet');
    // The shell line is the whole point: without it not one generated wrapper is runnable, and the
    // scaffold preview that also carried it is gone the moment the change is applied.
    expect(mounted.container.textContent).toContain('export PATH="$HOME/.ferretry/fleet/bin:$PATH"');
    expect(mounted.container.textContent).toContain('/fleet/assets/instructions/shared.md');
    expect(mounted.container.textContent).toContain('Directories (2)');
    await mounted.unmount();
  });

  it('says WHY preparation stopped and where, not only that it stopped', async () => {
    const mounted = await report({
      outcome: 'initialization-partial',
      reason: 'permission denied writing the bin directory',
      failedPath: '/fleet/bin/.keep',
      created: ['/fleet/config.yaml'],
      kept: [],
      directories: ['/fleet'],
      lockResidue: '/fleet/apply.lock',
    });
    expect(mounted.container.textContent).toContain('Host partly prepared');
    expect(mounted.container.textContent).toContain('permission denied writing the bin directory');
    expect(mounted.container.textContent).toContain('/fleet/bin/.keep');
    expect(mounted.container.textContent).toContain('running it again is safe');
    expect(mounted.container.textContent).toContain('/fleet/apply.lock');
    // Nothing claims a manifest: preparing a host publishes none.
    expect(mounted.container.textContent).not.toContain('Manifest published');
    await mounted.unmount();
  });

  it('reports the published manifest path and the shared-history counts a commit produced', async () => {
    const mounted = await report({
      outcome: 'committed',
      result: {
        accountCount: 2,
        operationCount: 8,
        manifestPath: '/home/pilot/.ferretry/fleet/manifest.json',
        prunedWrappers: [],
        sharedHistory: [{ kind: 'claude', pool: '/pool/claude', migrated: 214, conflicts: 2, links: 4 }],
      },
    });
    expect(mounted.container.textContent).toContain('/home/pilot/.ferretry/fleet/manifest.json');
    expect(mounted.container.textContent).toContain('214 moved, 4 linked, 2 kept as-is');
    await mounted.unmount();
  });

  it('mentions no residue when a successful apply left none', async () => {
    const mounted = await report({
      outcome: 'committed',
      result: { accountCount: 1, operationCount: 3, manifestPath: '/m', prunedWrappers: [], sharedHistory: [] },
    });
    expect(mounted.container.textContent).not.toContain('Removed wrappers');
    await mounted.unmount();
  });
});
