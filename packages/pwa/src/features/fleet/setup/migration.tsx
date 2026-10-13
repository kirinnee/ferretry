/**
 * Moving a machine to the new account format (docs/design/account-model.md §10.3).
 *
 * The dry run is ALWAYS shown first: every line of what would change, and anything that stops it from
 * running now. **Migrate** then sends exactly that dry run, named by its digest, so a migration only
 * ever runs a plan somebody saw. The Settings tab offers this only on a machine that still uses the
 * old format and whose account-model switch is on; while the switch is off the entry is not shown.
 */

import type { FleetMigrationOutcome, FleetMigrationView } from '@ferretry/protocol';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { applyFleetMigration, readFleetMigration } from '../setup-api.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { MachineStepper } from '../shell/machine-stepper.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { currentFlow, type StepperState, startStepper, stepForward } from '../shell/stepper-model.ts';
import { useSetupAccess } from './setup-access.ts';
import { SetupCommand, SetupNote, SetupSection } from './setup-ui.tsx';
import { countWords } from './setup-words.ts';

export const MIGRATION_FLOW_KIND = 'migrate';

/**
 * Whether the migration entry is reachable: a version-1 machine whose migration is available, or is
 * held back only by something the dry run names (a live session). A refusal the dry run does not name
 * is the account-model switch, and then there is no entry at all.
 */
export const migrationReachable = (view: FleetMigrationView): boolean => {
  if (view.status !== 'version-1' && view.status !== 'in-progress') return false;
  if (view.migrate.available) return true;
  return view.dryRun?.blockers.includes(view.migrate.reason) === true;
};

export interface MigrateMachineProps extends MachineTabProps {
  readonly onDone: () => void;
  readonly onLeave: () => void;
  readonly now?: () => number;
}

function outcomeNote(outcome: FleetMigrationOutcome, machineName: string): ReactNode {
  if (outcome.outcome === 'migrated')
    return (
      <SetupNote live tone="ok" name="migrated" title={`${machineName} uses the new account format`}>
        <span>
          {countWords(outcome.runtimes.length, 'runtime')} and {countWords(outcome.credentials.length, 'login')} moved.
          {outcome.runtimes.some(runtime => runtime.formerName !== undefined)
            ? ' Runtimes that were renamed still answer to their old names.'
            : ''}
        </span>
      </SetupNote>
    );
  if (outcome.outcome === 'refused')
    return (
      <SetupNote live tone="warn" name="migration-refused" title="Nothing was migrated">
        {outcome.reasons.map(reason => (
          <span key={reason}>{reason}</span>
        ))}
      </SetupNote>
    );
  return (
    <SetupNote live tone="err" name="migration-rolled-back" title="The migration was undone">
      <span>{outcome.reason}</span>
      {outcome.unrestored.length === 0 ? null : (
        <span>These could not be put back: {outcome.unrestored.join(', ')}.</span>
      )}
    </SetupNote>
  );
}

export function MigrateMachine(props: MigrateMachineProps) {
  const { machineName, connection, createClient, online, checking, onRetry, onDone, onLeave, now } = props;
  const access = useSetupAccess({ connection, createClient, ...(now === undefined ? {} : { now }) });
  const { changes } = access;
  const [view, setView] = useState<FleetMigrationView | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<FleetMigrationOutcome | null>(null);
  const [stepper, setStepper] = useState<StepperState>(() =>
    startStepper({
      kind: MIGRATION_FLOW_KIND,
      title: 'Move to the new account format',
      steps: [
        { id: 'dry-run', label: 'What changes' },
        { id: 'done', label: 'Done', final: true },
      ],
      leave: { question: 'Stop migrating?', consequence: 'Nothing is changed.', stopLabel: 'Stop' },
      leaveWithoutConfirm: true,
    }),
  );

  const latest = useRef(access);
  latest.current = access;
  const read = useCallback((password?: string): void => {
    setIssue(null);
    void latest.current.read((client, unlock) => readFleetMigration(client, unlock), password).then(answer => {
      if (answer.kind === 'done') setView(answer.value);
      else if (!answer.passwordRejected) setIssue(answer.sentence);
    });
  }, []);
  const started = useRef(false);
  const authorityKnown = changes.authority !== null;
  useEffect(() => {
    if (!authorityKnown || access.locked || started.current) return;
    started.current = true;
    read();
  }, [authorityKnown, access.locked, read]);

  const migrate = (password: string | undefined): void => {
    const digest = view?.inProgress?.digest ?? view?.dryRun?.digest;
    if (digest === undefined) return;
    void access
      .act(
        async (client, authorization) =>
          await applyFleetMigration(
            client,
            {
              digest,
              ...(authorization.operatorPassword === undefined
                ? {}
                : { operatorPassword: authorization.operatorPassword }),
            },
            authorization.unlock,
          ),
        password,
      )
      .then(answer => {
        if (answer.kind === 'refused') return;
        setOutcome(answer.value);
        setStepper(current => stepForward(current));
        onRetry();
      });
  };

  const body = (): ReactNode => {
    if (currentFlow(stepper).at === 'done')
      return (
        <div className="flex min-w-0 flex-col gap-3" data-migration-step="done">
          {outcome === null ? null : outcomeNote(outcome, machineName)}
          <div>
            <Button type="button" variant="primary" data-migration-finish="" onClick={onDone}>
              Go to Runtimes
            </Button>
          </div>
        </div>
      );
    if (access.locked)
      return (
        <ChangeApplyPanel
          machineName={machineName}
          changes={null}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Show what changes"
          onSubmit={password => read(password)}
        />
      );
    if (issue !== null)
      return (
        <SetupNote live tone="warn" name="migration-unreadable" title={`Couldn’t read ${machineName}’s setup`}>
          <span>{issue}</span>
        </SetupNote>
      );
    if (view === null)
      return (
        <p role="status" className="m-0 text-cell text-muted">
          Working out what would change…
        </p>
      );
    const blockers = view.dryRun?.blockers ?? [];
    return (
      <div className="flex min-w-0 flex-col gap-4" data-migration-step="dry-run">
        <p className="m-0 text-cell leading-base text-fg">
          {view.inProgress === undefined
            ? `${machineName} still uses the old account format. This is exactly what moving it would change. Nothing moves until you approve it.`
            : `A move to the new account format started on ${machineName} and did not finish. Approving it finishes that one.`}
        </p>
        {view.dryRun === undefined ? null : (
          <SetupSection title="What changes" name="dry-run">
            <SetupCommand>{view.dryRun.lines.join('\n')}</SetupCommand>
          </SetupSection>
        )}
        {blockers.length === 0 ? null : (
          <SetupNote tone="warn" name="migration-blocked" title="It can’t run yet">
            {blockers.map(blocker => (
              <span key={blocker}>{blocker}</span>
            ))}
          </SetupNote>
        )}
        <ChangeApplyPanel
          machineName={machineName}
          changes={view.migrate}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel={view.inProgress === undefined ? 'Migrate' : 'Finish migrating'}
          busyLabel="Migrating…"
          onSubmit={migrate}
        />
      </div>
    );
  };

  return (
    <MachineStepper
      state={stepper}
      onChange={nextState => (nextState === null ? onLeave() : setStepper(nextState))}
      machineName={machineName}
      online={online}
      checking={checking}
      onRetry={onRetry}
    >
      {body()}
    </MachineStepper>
  );
}
