/**
 * The Components tab (docs/design/account-model.md §4.2, K1–K7, E20–E22, E30): the six kinds, each
 * kind's list, one component's page, and its Edit and New forms.
 *
 * One page is one concept. The kinds page says what each kind is for; a list says who uses each one;
 * a component's page shows its badges, what it holds and who it reaches, with **Edit** and
 * **Delete…**. Every write is ONE change the daemon previews and applies.
 */

import type { FleetAccountChange, FleetComponentKind, FleetComponentView, FleetMachineView } from '@ferretry/protocol';
import { Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Markdown } from '../../../components/markdown.tsx';
import { useConnectionSnapshot } from '../../../lib/store.tsx';
import { Button } from '../../../shell/primitives.tsx';
import { daemonDisplayName } from '../../settings/daemon-settings.tsx';
import { ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
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
  COMPONENT_KINDS,
  type ComponentDraft,
  componentBadges,
  componentChange,
  counted,
  draftFromComponent,
  draftProblem,
  HARNESS_NAMES,
  KIND_ONE,
  listed,
  mcpCommandLine,
  profilesWithLayer,
  SECRET_REFERENCE,
} from './component-model.ts';
import { itemHref, useHashItem } from './machine-links.ts';
import { signsInWithOAuth } from './mcp-sign-in-model.ts';
import { McpSignInSection } from './mcp-sign-in-section.tsx';
import { ComponentMcpStatus, ComponentMcpStatusSection, type MachineMcpHost, useMachineMcp } from './mcp-status.tsx';

type Page =
  | { readonly kind: 'kinds' }
  | { readonly kind: 'list'; readonly of: FleetComponentKind }
  | { readonly kind: 'detail'; readonly reference: string }
  | { readonly kind: 'edit'; readonly reference: string }
  | { readonly kind: 'new'; readonly of: FleetComponentKind };

/** Where Back goes from each page; the kinds page has no Back, so only a list reaches the fallback. */
const parentOf = (page: Page, catalog: AccountCatalog): Page => {
  switch (page.kind) {
    case 'detail': {
      const component = allComponents(catalog).find(candidate => candidate.reference === page.reference);
      return component === undefined ? { kind: 'kinds' } : { kind: 'list', of: component.kind };
    }
    case 'edit':
      return { kind: 'detail', reference: page.reference };
    case 'new':
      return { kind: 'list', of: page.of };
    default:
      return { kind: 'kinds' };
  }
};

/** The tab as the composition root mounts it: the reader's own name for each paired machine comes from the store. */
export function ComponentsSurface(props: MachineTabProps) {
  const { connections } = useConnectionSnapshot();
  const machineNames = useMemo(
    () => new Map(connections.map(record => [String(record.daemonId), daemonDisplayName(record)])),
    [connections],
  );
  return <ComponentsTab {...props} machineNames={machineNames} />;
}

export function ComponentsTab({
  connection,
  machineName,
  machine,
  online,
  createClient,
  machineNames = new Map(),
}: MachineTabProps & { readonly machineNames?: ReadonlyMap<string, string> }) {
  const { read, reload } = useAccountCatalog(connection, createClient);
  const [page, setPage] = useState<Page>({ kind: 'kinds' });
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const open = (next: Page) => {
    setSaved(undefined);
    setPage(next);
  };

  useHashItem('components', reference => open({ kind: 'detail', reference }));

  if (read.kind === 'loading')
    return (
      <p className="m-0 text-cell text-muted" role="status">
        Reading {machineName}’s components…
      </p>
    );
  if (read.kind === 'failed') return <ReadFailed reason={read.reason} onRetry={() => void reload()} />;
  const catalog = read.catalog;
  const back = () => open(parentOf(page, catalog));
  const done = (message: string, next: Page) => {
    void reload().then(() => {
      setPage(next);
      setSaved(message);
    });
  };
  const shared = {
    catalog,
    machine,
    machineName,
    machineNames,
    online,
    connection,
    createClient,
    onBack: back,
    open,
    done,
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-components-page={page.kind}>
      {saved === undefined ? null : (
        <p className="m-0 text-cell text-ok" role="status" data-components-saved="">
          {saved}
        </p>
      )}
      {page.kind === 'kinds' ? (
        <KindsPage catalog={catalog} open={open} />
      ) : page.kind === 'list' ? (
        <ListPage {...shared} of={page.of} />
      ) : page.kind === 'new' ? (
        <FormPage {...shared} kind={page.of} />
      ) : (
        <ComponentPages {...shared} reference={page.reference} editing={page.kind === 'edit'} />
      )}
    </div>
  );
}

interface SharedProps {
  readonly catalog: AccountCatalog;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  /** This browser's own label for each paired machine, by daemon id. */
  readonly machineNames: ReadonlyMap<string, string>;
  readonly online: boolean;
  readonly connection: MachineTabProps['connection'];
  readonly createClient: MachineTabProps['createClient'];
  readonly onBack: () => void;
  readonly open: (page: Page) => void;
  readonly done: (message: string, next: Page) => void;
}

function KindsPage({ catalog, open }: { catalog: AccountCatalog; open: (page: Page) => void }) {
  return (
    <>
      <PageHead title="Components" sub="Saved once, reused in any profile" />
      <Prose>
        Instructions, MCP servers and skills are adapted to each harness. Settings and hooks belong to one harness.
      </Prose>
      <RowList label="Kinds">
        {COMPONENT_KINDS.map(kind => {
          const group = catalog.components.kinds.find(candidate => candidate.kind === kind);
          return (
            <OpenRow
              key={kind}
              title={group?.label ?? KIND_ONE[kind]}
              sub={group?.description}
              aside={<span className="shrink-0 self-center text-cell text-muted">{group?.components.length ?? 0}</span>}
              onOpen={() => open({ kind: 'list', of: kind })}
              data={{ 'data-component-kind': kind }}
            />
          );
        })}
      </RowList>
    </>
  );
}

/** The MCP list's rows: each opens its page, and says where it stands with Check and Sign in under it. */
function McpRows({
  list,
  label,
  machineName,
  machineNames,
  online,
  connection,
  createClient,
  open,
}: Pick<SharedProps, 'machineName' | 'machineNames' | 'online' | 'connection' | 'createClient' | 'open'> & {
  list: readonly FleetComponentView[];
  label: string | undefined;
}) {
  const host: MachineMcpHost = { connection, createClient, machineName, online };
  const mcp = useMachineMcp(host);
  return (
    <>
      <RowList label={label}>
        {list.map(component => (
          <OpenRow
            key={component.reference}
            title={component.name}
            mono
            badges={<ComponentBadges badges={componentBadges(component, machineName, machineNames)} />}
            sub={`Used by ${counted(component.usedBy.profiles.length, 'profile')}, ${counted(component.usedBy.runtimes.length, 'runtime')}`}
            onOpen={() => open({ kind: 'detail', reference: component.reference })}
            data={{ 'data-component-row': component.reference }}
            footer={<ComponentMcpStatus component={component} mcp={mcp} host={host} />}
          />
        ))}
      </RowList>
      {mcp.actions.sheet}
    </>
  );
}

function ListPage(props: SharedProps & { of: FleetComponentKind }) {
  const { catalog, machineName, machineNames, of, onBack, open } = props;
  const group = catalog.components.kinds.find(candidate => candidate.kind === of);
  const list = group?.components ?? [];
  return (
    <>
      <PageHead title={group?.label ?? KIND_ONE[of]} {...(group ? { sub: group.description } : {})} onBack={onBack} />
      <div>
        <Button type="button" variant="primary" data-component-new={of} onClick={() => open({ kind: 'new', of })}>
          + New {KIND_ONE[of].toLowerCase()}
        </Button>
      </div>
      {list.length === 0 ? (
        <Hint>None saved yet.</Hint>
      ) : of === 'mcp' ? (
        <McpRows {...props} list={list} label={group?.label} />
      ) : (
        <RowList label={group?.label}>
          {list.map(component => (
            <OpenRow
              key={component.reference}
              title={component.name}
              mono={component.kind === 'mcp'}
              badges={<ComponentBadges badges={componentBadges(component, machineName, machineNames)} />}
              sub={`Used by ${counted(component.usedBy.profiles.length, 'profile')}, ${counted(component.usedBy.runtimes.length, 'runtime')}`}
              onOpen={() => open({ kind: 'detail', reference: component.reference })}
              data={{ 'data-component-row': component.reference }}
            />
          ))}
        </RowList>
      )}
    </>
  );
}

function ComponentPages(props: SharedProps & { reference: string; editing: boolean }) {
  const component = allComponents(props.catalog).find(candidate => candidate.reference === props.reference);
  if (component === undefined)
    return (
      <>
        <PageHead title="Components" onBack={() => props.open({ kind: 'kinds' })} />
        <Hint>This component is not on {props.machineName} any more.</Hint>
      </>
    );
  return props.editing ? (
    <FormPage {...props} kind={component.kind} component={component} />
  ) : (
    <DetailPage {...props} component={component} />
  );
}

/** An environment, each value shown only when it may travel (K4, E7). */
function EnvList({ env }: { env: Extract<FleetComponentView['detail'], { kind: 'mcp' | 'settings' }>['env'] }) {
  if (env.length === 0) return null;
  return (
    <RowList label="Environment">
      {env.map(entry => (
        <PlainRow
          key={entry.name}
          mono
          title={`env.${entry.name}`}
          sub={
            'hidden' in entry || SECRET_REFERENCE.test(entry.value) ? (
              <span className="inline-flex items-center gap-1">
                <Lock size={12} aria-hidden="true" /> In Ferretry’s secret store · never shown
              </span>
            ) : (
              <span className="font-mono">{entry.value}</span>
            )
          }
        />
      ))}
    </RowList>
  );
}

function Content({ component }: { component: FleetComponentView }) {
  const detail = component.detail;
  const content = component.content;
  switch (detail.kind) {
    case 'skills':
      return (
        <RowList label="Skills">
          {detail.items.map(item => (
            <PlainRow key={item} mono title={item} />
          ))}
        </RowList>
      );
    case 'modelSets':
      return (
        <RowList label="Models">
          {detail.models.map(model => (
            <PlainRow key={model} mono title={model} {...(model === detail.default ? { sub: 'Default' } : {})} />
          ))}
        </RowList>
      );
    case 'mcp':
      return (
        <>
          <pre className="kt-panel m-0 whitespace-pre-wrap break-words p-panel font-mono text-cell text-fg">
            {mcpCommandLine(detail)}
          </pre>
          <EnvList env={detail.env} />
        </>
      );
    case 'settings':
      return (
        <>
          {content?.form === 'entries' && content.entries.length > 0 ? (
            <RowList label="Settings">
              {content.entries.map(entry => (
                <PlainRow
                  key={entry.key}
                  mono
                  title={entry.key}
                  sub={
                    'hidden' in entry ? (
                      <span className="inline-flex items-center gap-1">
                        <Lock size={12} aria-hidden="true" /> Hidden · never shown
                      </span>
                    ) : (
                      <span className="font-mono">{entry.value}</span>
                    )
                  }
                />
              ))}
            </RowList>
          ) : (
            <Hint>No settings in this file yet.</Hint>
          )}
          {detail.flags === undefined || detail.flags.length === 0 ? null : (
            <RowList label="Flags">
              {detail.flags.map(flag => (
                <PlainRow key={flag} mono title={flag} />
              ))}
            </RowList>
          )}
          <EnvList env={detail.env} />
        </>
      );
    default:
      if (detail.kind === 'hooks' && detail.directory !== undefined)
        return <Hint>These hooks come from a folder on this machine, so they are edited there.</Hint>;
      if (content?.form !== 'text') return <Hint>The text could not be read on this machine.</Hint>;
      return detail.kind === 'instructions' ? <MarkdownText text={content.text} /> : <SourceText text={content.text} />;
  }
}

/** A file's text exactly as written, escaped by React. */
function SourceText({ text }: { text: string }) {
  return (
    <pre
      className="kt-panel m-0 max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-panel font-mono text-cell text-fg"
      data-component-source=""
    >
      {text}
    </pre>
  );
}

/**
 * Instructions are Markdown (`CLAUDE.md`, `AGENTS.md`), so they read as Markdown: headings, lists and
 * code blocks, through the app's one renderer — the transcripts' — which never lets raw HTML from the
 * file through and highlights fences under the app's Trusted Types policy. "View source" shows the
 * text exactly as written.
 */
function MarkdownText({ text }: { text: string }) {
  const [source, setSource] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Button
        type="button"
        variant="ghost"
        className="kt-btn--flush-start self-start"
        data-component-view-source=""
        onClick={() => setSource(!source)}
      >
        {source ? 'View formatted' : 'View source'}
      </Button>
      {source ? (
        <SourceText text={text} />
      ) : (
        <div className="kt-panel max-h-[360px] min-w-0 overflow-auto p-panel" data-component-rendered="">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}

function DetailPage(props: SharedProps & { component: FleetComponentView }) {
  const { component, catalog, machineName, machineNames, open, onBack, online, connection, createClient } = props;
  const [deleting, setDeleting] = useState(false);
  const layerIn = profilesWithLayer(component.reference, catalog.profiles.profiles);
  return (
    <>
      <PageHead title={component.name} sub={KIND_ONE[component.kind]} mono={component.kind === 'mcp'} onBack={onBack} />
      <ComponentBadges badges={componentBadges(component, machineName, machineNames)} />
      {component.harness === undefined && component.kind !== 'modelSets' ? (
        <Prose>Ferretry adapts this for each harness, so it works in Claude Code and Codex.</Prose>
      ) : null}
      {component.partial.map(partial => (
        <CatalogNote
          key={partial.harness}
          tone="warn"
          spot="partial"
          title={`Partly supported on ${HARNESS_NAMES[partial.harness]}`}
        >
          {partial.reason}
        </CatalogNote>
      ))}
      {component.warnings.map(warning => (
        <CatalogNote key={warning} tone="warn" spot="warning" title={warning}>
          It was saved anyway. Install the missing command on {machineName} and it starts working.
        </CatalogNote>
      ))}
      {component.checkPath === undefined ? null : (
        <CatalogNote
          tone="warn"
          spot="path"
          title={`Check this path on ${machineName}`}
          actions={
            <Button
              type="button"
              size="sm"
              data-component-edit-path=""
              onClick={() => open({ kind: 'edit', reference: component.reference })}
            >
              Edit path
            </Button>
          }
        >
          <span>
            It names <span className="font-mono">{component.checkPath}</span>, a folder from another machine. Edit it if
            the folder lives somewhere else on {machineName}.
          </span>
        </CatalogNote>
      )}
      <Section
        title={
          component.kind !== 'mcp'
            ? 'Content'
            : component.detail.kind === 'mcp' && component.detail.url !== undefined
              ? 'Address'
              : 'Command'
        }
      >
        <Content component={component} />
      </Section>
      {component.kind === 'mcp' ? (
        <ComponentMcpStatusSection component={component} host={{ connection, createClient, machineName, online }} />
      ) : null}
      {signsInWithOAuth(component) ? (
        <McpSignInSection
          component={component}
          machineName={machineName}
          online={online}
          connection={connection}
          createClient={createClient}
        />
      ) : null}
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
            onClick={() => open({ kind: 'edit', reference: component.reference })}
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
  props: SharedProps & { component: FleetComponentView; layerIn: readonly string[]; onKeep: () => void },
) {
  const { component, layerIn, machineName, online, connection, createClient, done, onKeep } = props;
  const [detached, setDetached] = useState(false);
  const changes = useAccountChanges({ connection, createClient });
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
  const change: FleetAccountChange = {
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
            if (result.kind === 'applied') done(`Deleted ${component.name}.`, { kind: 'list', of: component.kind });
          })
        }
      >
        {keep}
      </ChangeApplyPanel>
    </CatalogNote>
  );
}

/** Edit (with `component`) or New. */
function FormPage(props: SharedProps & { kind: FleetComponentKind; component?: FleetComponentView }) {
  const { catalog, kind, component, machineName, online, connection, createClient, onBack, done } = props;
  const editing = component !== undefined;
  const [draft, setDraft] = useState<ComponentDraft>(() =>
    component === undefined ? blankDraft(kind) : draftFromComponent(component),
  );
  const changes = useAccountChanges({ connection, createClient });
  const problem = draftProblem(draft, allComponents(catalog), editing ? component.name : undefined);
  const wide =
    component !== undefined && (component.usedBy.profiles.length > 1 || component.usedBy.runtimes.length > 1);
  const submit = () =>
    void changes.apply(componentChange(draft, !editing)).then(result => {
      if (result.kind !== 'applied') return;
      const reference = `${kind}/${draft.name.trim()}`;
      done(editing ? 'Saved. New sessions use the new version.' : 'Saved. Add it to a profile to use it.', {
        kind: 'detail',
        reference,
      });
    });
  return (
    <>
      <PageHead
        title={editing ? `Edit ${component.name}` : `New ${KIND_ONE[kind].toLowerCase()}`}
        {...(editing ? { sub: KIND_ONE[kind] } : {})}
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
