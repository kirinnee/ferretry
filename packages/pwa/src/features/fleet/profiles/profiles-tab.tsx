/**
 * The Profiles tab (docs/design/account-model.md §4.2, P1–P6, E18, E19, E21): every profile with its
 * layer count and who uses it, and one profile's page — its Layers newest on top, its Conflicts, and
 * Where it is used — with **Edit layers** and **Delete profile…**.
 *
 * "+ Build a new profile" and "Edit layers" open the Build a profile stepper in place of the page.
 * Every write is one change the daemon previews and applies; while this machine refuses changes the
 * panel says why in one sentence and the pages still read.
 */

import type { FleetAccountChange, FleetLayeredProfileView } from '@ferretry/protocol';
import { useId, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { type AccountCatalog, allComponents, useAccountCatalog } from '../components/account-catalog.ts';
import {
  CatalogNote,
  Hint,
  LinkRow,
  OpenRow,
  PageHead,
  ReadFailed,
  RowList,
  Section,
} from '../components/catalog-ui.tsx';
import { counted, listed } from '../components/component-model.ts';
import { itemHref, useHashItem } from '../components/machine-links.ts';
import { ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import { MachineStepper } from '../shell/machine-stepper.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { type StepperState, startStepper } from '../shell/stepper-model.ts';
import { BuildProfileStep } from './build-profile-step.tsx';
import { ConflictList, LayerStack } from './layer-stack.tsx';
import { buildProfileFlowInput, includedBy, runtimesReaching, stackConflicts } from './profile-model.ts';

type Page = { readonly kind: 'list' } | { readonly kind: 'detail'; readonly name: string };

export function ProfilesTab(props: MachineTabProps) {
  const { connection, machineName, createClient, online, checking, onRetry, machine } = props;
  const { read, reload } = useAccountCatalog(connection, createClient);
  const [page, setPage] = useState<Page>({ kind: 'list' });
  const [stepper, setStepper] = useState<{ state: StepperState; editing?: string } | null>(null);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const open = (next: Page) => {
    setSaved(undefined);
    setPage(next);
  };
  useHashItem('profiles', name => {
    setStepper(null);
    open({ kind: 'detail', name });
  });
  const build = (editing?: string) => {
    setSaved(undefined);
    setStepper({
      state: startStepper(buildProfileFlowInput(editing === undefined ? {} : { editing })),
      ...(editing === undefined ? {} : { editing }),
    });
  };

  if (stepper !== null)
    return (
      <MachineStepper
        state={stepper.state}
        onChange={next => setStepper(next === null ? null : { ...stepper, state: next })}
        machineName={machineName}
        online={online}
        checking={checking}
        onRetry={onRetry}
      >
        <BuildProfileStep
          state={stepper.state}
          onChange={next => setStepper({ ...stepper, state: next })}
          onBuilt={name => {
            setStepper(null);
            void reload().then(() => {
              setPage({ kind: 'detail', name });
              setSaved(
                stepper.editing === undefined ? `Profile ${name} saved.` : 'Saved. New sessions use the new layers.',
              );
            });
          }}
          machineName={machineName}
          machine={machine}
          connection={connection}
          createClient={createClient}
          {...(stepper.editing === undefined ? {} : { editing: stepper.editing })}
        />
      </MachineStepper>
    );

  if (read.kind === 'loading')
    return (
      <p className="m-0 text-cell text-muted" role="status">
        Reading {machineName}’s profiles…
      </p>
    );
  if (read.kind === 'failed') return <ReadFailed reason={read.reason} onRetry={() => void reload()} />;
  const catalog = read.catalog;
  const profile =
    page.kind === 'detail' ? catalog.profiles.profiles.find(candidate => candidate.name === page.name) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-profiles-page={profile === undefined ? 'list' : 'detail'}>
      {saved === undefined ? null : (
        <p className="m-0 text-cell text-ok" role="status" data-profiles-saved="">
          {saved}
        </p>
      )}
      {profile === undefined ? (
        <ListPage catalog={catalog} open={open} build={() => build()} />
      ) : (
        <DetailPage
          {...props}
          catalog={catalog}
          profile={profile}
          onBack={() => open({ kind: 'list' })}
          onEdit={() => build(profile.name)}
          onOpenProfile={name => open({ kind: 'detail', name })}
          onDeleted={message =>
            void reload().then(() => {
              setPage({ kind: 'list' });
              setSaved(message);
            })
          }
        />
      )}
    </div>
  );
}

function ListPage({
  catalog,
  open,
  build,
}: {
  catalog: AccountCatalog;
  open: (page: Page) => void;
  build: () => void;
}) {
  const profiles = catalog.profiles.profiles;
  if (profiles.length === 0)
    return (
      <section className="kt-panel flex min-w-0 flex-col items-start gap-2 p-panel" data-profiles-empty="">
        <h3 className="m-0 text-row font-semibold text-fg">No profiles yet</h3>
        <Hint>A profile is a stack of layers: other profiles and components. The newer layer wins.</Hint>
        <Button type="button" variant="primary" data-profile-build="" onClick={build}>
          Build a profile
        </Button>
      </section>
    );
  return (
    <>
      <PageHead title="Profiles" sub={counted(profiles.length, 'profile')} />
      <div>
        <Button type="button" variant="primary" data-profile-build="" onClick={build}>
          + Build a new profile
        </Button>
      </div>
      <RowList label="Profiles">
        {profiles.map(profile => {
          const runtimes = runtimesReaching(profile, catalog.runtimes.runtimes).length;
          const bases = includedBy(profile).length;
          return (
            <OpenRow
              key={profile.name}
              title={profile.name}
              sub={`${counted(profile.layers.length, 'layer')} · used by ${counted(runtimes, 'runtime')}${bases > 0 ? ` · base for ${counted(bases, 'profile')}` : ''}`}
              onOpen={() => open({ kind: 'detail', name: profile.name })}
              data={{ 'data-profile-row': profile.name }}
            />
          );
        })}
      </RowList>
    </>
  );
}

interface DetailProps extends MachineTabProps {
  readonly catalog: AccountCatalog;
  readonly profile: FleetLayeredProfileView;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onOpenProfile: (name: string) => void;
  readonly onDeleted: (message: string) => void;
}

function DetailPage(props: DetailProps) {
  const { catalog, profile, machineName, onBack, onEdit, onOpenProfile } = props;
  const [deleting, setDeleting] = useState(false);
  const includers = includedBy(profile);
  const runtimes = runtimesReaching(profile, catalog.runtimes.runtimes);
  return (
    <>
      <PageHead title={profile.name} sub={`Profile · ${counted(profile.layers.length, 'layer')}`} onBack={onBack} />
      <Section title="Layers">
        <LayerStack
          layers={profile.layers}
          components={allComponents(catalog)}
          profiles={catalog.profiles.profiles}
          machineName={machineName}
        />
        {profile.harnesses.flatMap(stack =>
          stack.skipped.length === 0
            ? []
            : [<Hint key={stack.harness}>{stack.skipped.map(skip => skip.sentence).join(' ')}</Hint>],
        )}
      </Section>
      <Section title="Conflicts" spot="conflicts">
        <ConflictList conflicts={stackConflicts(profile.harnesses)} />
      </Section>
      <Section title="Where it is used">
        {includers.length === 0 && runtimes.length === 0 ? (
          <Hint>Nothing uses this profile yet.</Hint>
        ) : (
          <RowList label="Where it is used">
            {includers.map(name => (
              <OpenRow
                key={name}
                title={`Profile · ${name}`}
                sub={`Builds on ${profile.name}`}
                onOpen={() => onOpenProfile(name)}
                data={{ 'data-profile-includer': name }}
              />
            ))}
            {runtimes.map(use => (
              <LinkRow
                key={use.runtime}
                mono
                title={use.runtime}
                href={itemHref(machineName, 'runtimes', use.runtime)}
                sub={use.through === undefined ? 'Runtime' : `Runtime · through ${use.through}`}
              />
            ))}
          </RowList>
        )}
      </Section>
      {deleting ? (
        <DeletePanel {...props} onKeep={() => setDeleting(false)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" data-profile-edit="" onClick={onEdit}>
            Edit layers
          </Button>
          <Button type="button" variant="ghost" data-profile-delete="" onClick={() => setDeleting(true)}>
            Delete profile…
          </Button>
        </div>
      )}
    </>
  );
}

/** P6, E21: blocked while it is a base; runtimes on it pick a replacement; its components stay saved. */
function DeletePanel(props: DetailProps & { onKeep: () => void }) {
  const { catalog, profile, machineName, online, connection, createClient, onKeep, onDeleted } = props;
  const id = useId();
  const [detached, setDetached] = useState(false);
  const loops = new Set(profile.wouldIncludeItself);
  const others = catalog.profiles.profiles.filter(candidate => !loops.has(candidate.name));
  const [target, setTarget] = useState<string | undefined>(others[0]?.name);
  const changes = useAccountChanges({ connection, createClient });
  const keep = (
    <Button type="button" size="sm" data-profile-keep="" onClick={onKeep}>
      Keep it
    </Button>
  );

  if (profile.baseFor.length > 0 && !detached)
    return (
      <CatalogNote
        tone="danger"
        spot="delete"
        role="alert"
        title={`${profile.name} is in use, so it can’t be deleted`}
        actions={
          <>
            <Button type="button" size="sm" data-profile-detach="" onClick={() => setDetached(true)}>
              Remove from those first
            </Button>
            {keep}
          </>
        }
      >
        <span>
          It is the base of {listed(profile.baseFor)}
          {profile.usedBy.length === 0 ? (
            ''
          ) : (
            <>
              , and these runtimes use it: <span className="font-mono">{profile.usedBy.join(', ')}</span>
            </>
          )}
          .
        </span>
      </CatalogNote>
    );

  const moving = profile.usedBy.length > 0;
  const change: FleetAccountChange = {
    kind: 'profile.remove',
    name: profile.name,
    ...(detached ? { removeFromProfiles: true } : {}),
    ...(moving && target !== undefined ? { switchRuntimesTo: target } : {}),
  };
  const removedFrom = detached ? `It is taken out of ${listed(profile.baseFor)} first. ` : '';
  return (
    <CatalogNote
      tone="danger"
      spot="delete"
      role="alert"
      title={
        moving
          ? `Pick another profile for ${profile.usedBy.length === 1 ? 'this runtime' : 'these runtimes'} first`
          : `Delete ${profile.name}?`
      }
    >
      {moving ? (
        <>
          <span>
            A runtime always needs a profile. {removedFrom}
            <span className="font-mono">{profile.usedBy.join(', ')}</span>{' '}
            {profile.usedBy.length === 1 ? 'moves' : 'move'} to:
          </span>
          {others.length === 0 ? (
            <span>There is no other profile to move to yet. Build one first.</span>
          ) : (
            <select
              id={id}
              aria-label="Move to profile"
              className="kt-input"
              value={target}
              data-profile-switch=""
              onChange={event => setTarget(event.currentTarget.value)}
            >
              {others.map(other => (
                <option key={other.name} value={other.name}>
                  {other.name}
                </option>
              ))}
            </select>
          )}
        </>
      ) : (
        <span>{removedFrom}Nothing uses it now. Its components stay saved. This can’t be undone.</span>
      )}
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        refusal={changes.refusal}
        submitLabel={
          moving
            ? `Switch ${counted(profile.usedBy.length, 'runtime')} and delete ${profile.name}`
            : `Delete ${profile.name}`
        }
        busyLabel="Deleting…"
        variant="danger"
        disabled={!online || (moving && target === undefined)}
        onSubmit={() =>
          void changes.apply(change).then(result => {
            if (result.kind === 'applied') onDeleted(`Deleted profile ${profile.name}.`);
          })
        }
      >
        {keep}
      </ChangeApplyPanel>
    </CatalogNote>
  );
}
