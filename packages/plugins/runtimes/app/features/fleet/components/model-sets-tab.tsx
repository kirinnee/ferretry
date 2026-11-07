/**
 * The Model sets tab (docs/design/account-model.md §4.2, K1–K7, E20–E22): the model sets on this machine, one set's
 * page, and its Edit and New forms.
 *
 * Components of the other kinds (instructions, MCP servers, skills, settings, hooks) are drawn by the plugins that
 * own them; a model set belongs to Runtimes. One page is one concept: a list says who uses each set; a set's page
 * shows its badges, the models it holds and who it reaches, with **Edit** and **Delete…**. Every write is ONE change
 * the daemon previews and applies.
 */

import { useState } from 'react';
import type { AccountChange, ComponentView } from '../../../../contract/index.ts';
import { Button } from '../../../ui.ts';
import { ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machine-tab.ts';
import { type AccountCatalog, allComponents, useAccountCatalog } from './account-catalog.ts';
import {
  CatalogNote,
  ComponentBadges,
  Hint,
  LinkRow,
  OpenRow,
  PageHead,
  PlainRow,
  Prose,
  ReadFailed,
  RowList,
  Section,
} from './catalog-ui.tsx';
import { ComponentForm } from './component-form.tsx';
import {
  blankDraft,
  type ComponentDraft,
  componentBadges,
  componentChange,
  counted,
  draftFromComponent,
  draftProblem,
  KIND_ONE,
  listed,
  profilesWithLayer,
} from './component-model.ts';
import { itemHref } from './machine-links.ts';

const KIND = 'modelSets' as const;

type Page =
  | { readonly kind: 'list' }
  | { readonly kind: 'detail'; readonly name: string }
  | { readonly kind: 'edit'; readonly name: string }
  | { readonly kind: 'new' };

/** The model sets, in the order the daemon lists them. */
const modelSets = (catalog: AccountCatalog): readonly ComponentView[] =>
  catalog.components.kinds.find(group => group.kind === KIND)?.components ?? [];

export function ModelSetsTab({
  client,
  machineName,
  online,
  machineNames = new Map(),
}: MachineTabProps & { readonly machineNames?: ReadonlyMap<string, string> }) {
  const { read, reload } = useAccountCatalog(client);
  const [page, setPage] = useState<Page>({ kind: 'list' });
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const open = (next: Page) => {
    setSaved(undefined);
    setPage(next);
  };

  if (read.kind === 'loading')
    return (
      <p className="m-0 text-cell text-muted" role="status">
        Reading {machineName}’s model sets…
      </p>
    );
  if (read.kind === 'failed') return <ReadFailed reason={read.reason} onRetry={() => void reload()} />;
  const catalog = read.catalog;
  const done = (message: string, next: Page) => {
    void reload().then(() => {
      setPage(next);
      setSaved(message);
    });
  };
  const shared = { catalog, machineName, machineNames, online, client, open, done };
  const named = page.kind === 'detail' || page.kind === 'edit' ? page.name : undefined;
  const component = named === undefined ? undefined : modelSets(catalog).find(candidate => candidate.name === named);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-components-page={page.kind} data-model-sets-tab="">
      {saved === undefined ? null : (
        <p className="m-0 text-cell text-ok" role="status" data-components-saved="">
          {saved}
        </p>
      )}
      {page.kind === 'list' ? (
        <ListPage {...shared} />
      ) : page.kind === 'new' ? (
        <FormPage {...shared} onBack={() => open({ kind: 'list' })} />
      ) : component === undefined ? (
        <>
          <PageHead title="Model sets" onBack={() => open({ kind: 'list' })} />
          <Hint>This model set is not on {machineName} any more.</Hint>
        </>
      ) : page.kind === 'edit' ? (
        <FormPage {...shared} component={component} onBack={() => open({ kind: 'detail', name: component.name })} />
      ) : (
        <DetailPage {...shared} component={component} onBack={() => open({ kind: 'list' })} />
      )}
    </div>
  );
}

interface SharedProps {
  readonly catalog: AccountCatalog;
  readonly client: MachineTabProps['client'];
  readonly machineName: string;
  /** This browser's own label for each paired machine, by daemon id. */
  readonly machineNames: ReadonlyMap<string, string>;
  readonly online: boolean;
  readonly open: (page: Page) => void;
  readonly done: (message: string, next: Page) => void;
}

function ListPage({ catalog, machineName, machineNames, open }: SharedProps) {
  const list = modelSets(catalog);
  const group = catalog.components.kinds.find(candidate => candidate.kind === KIND);
  return (
    <>
      <PageHead title={group?.label ?? 'Model sets'} {...(group ? { sub: group.description } : {})} />
      <div>
        <Button type="button" variant="primary" data-component-new={KIND} onClick={() => open({ kind: 'new' })}>
          + New {KIND_ONE[KIND].toLowerCase()}
        </Button>
      </div>
      {list.length === 0 ? (
        <Hint>None saved yet.</Hint>
      ) : (
        <RowList label={group?.label ?? 'Model sets'}>
          {list.map(component => (
            <OpenRow
              key={component.reference}
              title={component.name}
              badges={<ComponentBadges badges={componentBadges(component, machineName, machineNames)} />}
              sub={`Used by ${counted(component.usedBy.profiles.length, 'profile')}, ${counted(component.usedBy.runtimes.length, 'runtime')}`}
              onOpen={() => open({ kind: 'detail', name: component.name })}
              data={{ 'data-component-row': component.reference }}
            />
          ))}
        </RowList>
      )}
    </>
  );
}

/** The models a set holds, the default marked. */
function Content({ component }: { component: ComponentView }) {
  const detail = component.detail;
  if (detail.kind !== KIND) return <Hint>This is not a model set.</Hint>;
  return (
    <RowList label="Models">
      {detail.models.map(model => (
        <PlainRow key={model} mono title={model} {...(model === detail.default ? { sub: 'Default' } : {})} />
      ))}
    </RowList>
  );
}

function DetailPage(props: SharedProps & { component: ComponentView; onBack: () => void }) {
  const { component, catalog, machineName, machineNames, open, onBack } = props;
  const [deleting, setDeleting] = useState(false);
  const layerIn = profilesWithLayer(component.reference, catalog.profiles.profiles);
  return (
    <>
      <PageHead title={component.name} sub={KIND_ONE[component.kind]} onBack={onBack} />
      <ComponentBadges badges={componentBadges(component, machineName, machineNames)} />
      {component.warnings.map(warning => (
        <CatalogNote key={warning} tone="warn" spot="warning" title={warning}>
          It was saved anyway.
        </CatalogNote>
      ))}
      <Section title="Content">
        <Content component={component} />
      </Section>
      <Section title="Used by">
        <Prose>
          Used by {counted(component.usedBy.profiles.length, 'profile')} and{' '}
          {counted(component.usedBy.runtimes.length, 'runtime')}.
        </Prose>
        {component.usedBy.profiles.length === 0 ? null : (
          <RowList label="Profiles">
            {component.usedBy.profiles.map(profile => (
              <LinkRow
                key={profile}
                title={profile}
                href={itemHref(machineName, 'profiles', profile)}
                sub={layerIn.includes(profile) ? 'Has it as a layer' : 'Gets it through a base profile'}
              />
            ))}
          </RowList>
        )}
      </Section>
      {deleting ? (
        <DeletePanel {...props} layerIn={layerIn} onKeep={() => setDeleting(false)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            data-component-edit=""
            onClick={() => open({ kind: 'edit', name: component.name })}
          >
            Edit
          </Button>
          <Button type="button" variant="ghost" data-component-delete="" onClick={() => setDeleting(true)}>
            Delete…
          </Button>
        </div>
      )}
    </>
  );
}

/** E21: blocked while a profile has it as a layer, then confirmed. */
function DeletePanel(
  props: SharedProps & { component: ComponentView; layerIn: readonly string[]; onKeep: () => void },
) {
  const { component, layerIn, machineName, online, client, done, onKeep } = props;
  const [detached, setDetached] = useState(false);
  const changes = useAccountChanges({ client });
  const keep = (
    <Button type="button" size="sm" data-component-keep="" onClick={onKeep}>
      Keep it
    </Button>
  );
  if (layerIn.length > 0 && !detached)
    return (
      <CatalogNote
        tone="danger"
        spot="delete"
        role="alert"
        title={`${component.name} is in use, so it can’t be deleted`}
        actions={
          <>
            <Button type="button" size="sm" data-component-detach="" onClick={() => setDetached(true)}>
              Remove from those first
            </Button>
            {keep}
          </>
        }
      >
        <span>It is a layer in:</span>
        <RowList label="Profiles">
          {layerIn.map(profile => (
            <PlainRow key={profile} title={`Profile · ${profile}`} />
          ))}
        </RowList>
        {component.usedBy.runtimes.length === 0 ? null : (
          <span>
            Through those, {counted(component.usedBy.runtimes.length, 'runtime')}{' '}
            {component.usedBy.runtimes.length === 1 ? 'uses' : 'use'} it:{' '}
            <span className="font-mono">{component.usedBy.runtimes.join(', ')}</span>.
          </span>
        )}
      </CatalogNote>
    );
  const change: AccountChange = {
    kind: 'component.remove',
    componentKind: component.kind,
    name: component.name,
    ...(detached ? { removeFromProfiles: true } : {}),
  };
  return (
    <CatalogNote tone="danger" spot="delete" role="alert" title={`Delete ${component.name}?`}>
      <span>
        {detached ? `It is taken out of ${listed(layerIn)} first. ` : 'Nothing uses it now. '}This can’t be undone.
      </span>
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        refusal={changes.refusal}
        submitLabel={`Delete ${component.name}`}
        busyLabel="Deleting…"
        variant="danger"
        disabled={!online}
        onSubmit={() =>
          void changes.apply(change).then(result => {
            if (result.kind === 'applied') done(`Deleted ${component.name}.`, { kind: 'list' });
          })
        }
      >
        {keep}
      </ChangeApplyPanel>
    </CatalogNote>
  );
}

/** Edit (with `component`) or New. */
function FormPage(props: SharedProps & { component?: ComponentView; onBack: () => void }) {
  const { catalog, component, machineName, online, client, onBack, done } = props;
  const editing = component !== undefined;
  const [draft, setDraft] = useState<ComponentDraft>(() =>
    component === undefined ? blankDraft(KIND) : draftFromComponent(component),
  );
  const changes = useAccountChanges({ client });
  const problem = draftProblem(draft, allComponents(catalog), editing ? component.name : undefined);
  const wide =
    component !== undefined && (component.usedBy.profiles.length > 1 || component.usedBy.runtimes.length > 1);
  const submit = () =>
    void changes.apply(componentChange(draft, !editing)).then(result => {
      if (result.kind !== 'applied') return;
      done(editing ? 'Saved. New sessions use the new version.' : 'Saved. Add it to a profile to use it.', {
        kind: 'detail',
        name: draft.name.trim(),
      });
    });
  return (
    <>
      <PageHead
        title={editing ? `Edit ${component.name}` : `New ${KIND_ONE[KIND].toLowerCase()}`}
        {...(editing ? { sub: KIND_ONE[KIND] } : {})}
        onBack={onBack}
      />
      {wide ? (
        <CatalogNote
          tone="warn"
          spot="used"
          title={`Used by ${counted(component.usedBy.profiles.length, 'profile')} and ${counted(component.usedBy.runtimes.length, 'runtime')}`}
        >
          Saving changes it everywhere. Running sessions keep the old version until restarted.
        </CatalogNote>
      ) : null}
      <ComponentForm draft={draft} onChange={setDraft} editing={editing} {...(problem ? { problem } : {})} />
      {problem !== undefined && draft.name !== '' && !/name|called/u.test(problem) ? (
        <p className="m-0 text-cell text-err" data-component-problem="">
          {problem}
        </p>
      ) : null}
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        refusal={changes.refusal}
        submitLabel={wide ? 'Save for all' : 'Save'}
        busyLabel="Saving…"
        disabled={!online || problem !== undefined}
        onSubmit={submit}
      >
        <Button type="button" variant="ghost" data-component-cancel="" onClick={onBack}>
          Cancel
        </Button>
      </ChangeApplyPanel>
    </>
  );
}
