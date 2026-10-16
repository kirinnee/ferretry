/**
 * Add runtime's "+ Build a new profile" (docs/design/account-model.md §4.5, E17): the drag-and-drop
 * editor as ONE step of a sub-flow, rendered inside Add runtime's stepper, which owns Back, Cancel
 * and the offline pause. There is no stepper of its own any more: the profile is built exactly as it
 * is on the Profiles tab, and is for the login's tool, so the other tool's items are refused.
 *
 * Saved, it hands Add runtime the new profile's name with its own flow ended, so the parent step
 * shows it picked — and lists it as saved for reuse, should Add runtime then be cancelled.
 */

import type { FleetMachineView } from '@ferretry/protocol';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { useAccountCatalog } from '../components/account-catalog.ts';
import { Hint, ReadFailed } from '../components/catalog-ui.tsx';
import type { CatalogHarness } from '../components/component-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { returnToParent, type StepperState, saveForReuse } from '../shell/stepper-model.ts';
import { ProfileEditor } from './profile-editor.tsx';

export interface BuildProfileStepProps {
  /** The whole stack; the top flow is Build a profile. */
  readonly state: StepperState;
  readonly onChange: (next: StepperState) => void;
  /** Saved: this flow has ended, and `next` has the parent flow on top (or is `null`). */
  readonly onBuilt: (profileName: string, next: StepperState | null) => void;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** The login's tool. */
  readonly harness?: CatalogHarness;
  readonly openedFromAddRuntime?: boolean;
}

export function BuildProfileStep(props: BuildProfileStepProps) {
  const { state, onBuilt, machineName, connection, createClient, harness } = props;
  const { read, reload } = useAccountCatalog(connection, createClient);
  if (read.kind === 'failed') return <ReadFailed reason={read.reason} onRetry={() => void reload()} />;
  if (read.kind === 'loading')
    return (
      <p className="m-0 text-cell text-muted" role="status">
        Reading {machineName}’s profiles and components…
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3" data-build-step="build">
      <ProfileEditor
        catalog={read.catalog}
        machineName={machineName}
        connection={connection}
        createClient={createClient}
        {...(harness === undefined ? {} : { harness })}
        onSaved={name => onBuilt(name, returnToParent(saveForReuse(state, `Profile ${name}`)))}
      />
      {props.openedFromAddRuntime ? <Hint>Saved, you go back to choosing a profile, with this one picked.</Hint> : null}
    </div>
  );
}
