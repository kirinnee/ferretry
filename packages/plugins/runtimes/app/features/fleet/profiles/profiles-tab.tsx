/**
 * The Profiles tab (R5, docs/design/account-model.md §4.2, P6, E21): every profile with its size and
 * who uses it, and one profile's page — its contents in the drag-and-drop editor, Where it is used,
 * and **Delete profile…**. "+ New profile" opens the same editor with a name to fill in.
 *
 * Below the list is **Built from** (docs/design/account-model.md §4.2): the six kinds of component a profile is made
 * of, each with its count. MCP servers, skills and model sets are drawn by the tab that owns them, so their rows link
 * there; instructions, settings and hooks have no tab of their own, so their rows open the kind's pages in place.
 *

 * Every write is one change the daemon previews and applies; while this machine refuses changes the
 * panel says why in one sentence and the pages still read.
 */

import { Loading } from '@ferretry/app/ui';
import { daemonSettingsHref } from '@ferretry/app';
import type { AccountChange, ComponentKind, LayeredProfileView } from '../../../../contract/index.ts';
import { useEffect, useId, useState } from 'react';
import { Button, SelectBox } from '../../../ui.ts';
import { type AccountCatalog, allComponents, useAccountCatalog } from '../components/account-catalog.ts';
import {
  CatalogNote,
  ComponentBadges,
  Hint,
  LinkRow,
  OpenRow,
  PageHead,
  PlainRow,
  ReadFailed,
  RowList,
  Section,
} from '../components/catalog-ui.tsx';
import { ComponentKindPages } from '../components/component-kind-pages.tsx';
import { counted, listed, profileScopeBadge, profileScopeWord } from '../components/component-model.ts';
import { isComponentReference, itemHref, useHashItem } from '../components/machine-links.ts';
import { currentDaemon, tabHref } from '../shell/machine-route.ts';
import { ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machine-tab.ts';
import { InstructionTexts } from './instruction-text.tsx';
import { ProfileEditor } from './profile-editor.tsx';
import { includedBy, profileUseLine, runtimesReaching } from './profile-model.ts';

type Page =
  | { readonly kind: 'list' }
  | { readonly kind: 'detail'; readonly name: string }
  | { readonly kind: 'new' }
  /** The pages of one kind of component that has no tab of its own (Built from). */
  | { readonly kind: 'components'; readonly of: ComponentKind };

/**
 * Where a kind is managed when it is not on this tab: the plugin tab that owns it. `undefined` means it opens here;
 * `null` means another tab owns it but this page is not under a `/d/<daemon>` route, so there is no address to name
 * (the row is shown without a link rather than as a dead one).
 */
const kindHref = (kind: ComponentKind, machineName: string): string | null | undefined => {
  if (kind !== 'modelSets' && kind !== 'mcp' && kind !== 'skills') return undefined;
  const daemon = currentDaemon();
  if (daemon === null) return null;
  if (kind === 'modelSets') return tabHref(daemon, machineName, 'model-sets');
  return daemonSettingsHref(daemon, kind, kind);
};

export function ProfilesTab(props: MachineTabProps & { readonly onAtList?: (atList: boolean) => void }) {
  const { client, machineName, onAtList } = props;
  const { read, reload, press } = useAccountCatalog(client);
  const [page, setPage] = useState<Page>({ kind: 'list' });
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const open = (next: Page) => {
    setSaved(undefined);
    setPage(next);
  };
  // A component's address on the shared Profiles tab sends this section back to its list.
  useHashItem('profiles', name => open(isComponentReference(name) ? { kind: 'list' } : { kind: 'detail', name }));
  const known = read.kind === 'loading' || read.kind === 'failed' ? undefined : read.catalog.profiles.profiles;
  const showingList =
    page.kind === 'list' ||
    (page.kind === 'detail' && known?.some(candidate => candidate.name === page.name) === false);
  useEffect(() => onAtList?.(showingList), [onAtList, showingList]);

  if (read.kind === 'loading') return <Loading kind="page" label={`Reading ${machineName}’s profiles…`} />;
  if (read.kind === 'failed') return <ReadFailed reason={read.reason} onRetry={() => void press()} />;
  const catalog = read.catalog;
  const profile =
    page.kind === 'detail' ? catalog.profiles.profiles.find(candidate => candidate.name === page.name) : undefined;
  const shown =
    page.kind === 'new' ? 'new' : page.kind === 'components' ? 'components' : profile === undefined ? 'list' : 'detail';
  const afterSave = (name: string, message: string) =>
    void reload().then(() => {
      setPage({ kind: 'detail', name });
      setSaved(message);
    });

  return (
    <div className="flex min-w-0 flex-col gap-4" data-profiles-page={shown}>
      {saved === undefined ? null : (
        <p className="m-0 text-cell text-ok" role="status" data-profiles-saved="">
          {saved}
        </p>
      )}
      {page.kind === 'components' ? (
        <ComponentKindPages
          {...props}
          kind={page.of}
          onExit={() => {
            void reload();
            open({ kind: 'list' });
          }}
        />
      ) : page.kind === 'new' ? (
        <>
          <PageHead title="New profile" sub="Profile" onBack={() => open({ kind: 'list' })} />
          <ProfileEditor {...props} catalog={catalog} onSaved={name => afterSave(name, `Profile ${name} saved.`)}>
            <Button type="button" variant="ghost" data-profile-cancel="" onClick={() => open({ kind: 'list' })}>
              Cancel
            </Button>
          </ProfileEditor>
        </>
      ) : profile === undefined ? (
        <ListPage catalog={catalog} machineName={machineName} open={open} />
      ) : (
        <DetailPage
          key={profile.name}
          {...props}
          catalog={catalog}
          profile={profile}
          onBack={() => open({ kind: 'list' })}
          onOpenProfile={name => open({ kind: 'detail', name })}
          onSaved={name => afterSave(name, 'Saved. New sessions use the new contents.')}
          onFileChanged={() => void reload()}
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

/** Built from: each kind of component with what it is and how many are saved. */
function BuiltFrom({
  catalog,
  machineName,
  open,
}: {
  catalog: AccountCatalog;
  machineName: string;
  open: (page: Page) => void;
}) {
  return (
    <Section title="Built from" spot="built-from">
      <Hint>The parts a profile is made of. Open a kind to see what is saved, or add one.</Hint>
      <RowList label="Built from">
        {catalog.components.kinds.map(group => {
          const href = kindHref(group.kind, machineName);
          const sub = `${group.description} · ${counted(group.components.length, 'item')}`;
          if (href === null) return <PlainRow key={group.kind} title={group.label} sub={sub} />;
          return href === undefined ? (
            <OpenRow
              key={group.kind}
              title={group.label}
              sub={sub}
              onOpen={() => open({ kind: 'components', of: group.kind })}
              data={{ 'data-built-from': group.kind }}
            />
          ) : (
            <LinkRow key={group.kind} title={group.label} sub={sub} href={href} />
          );
        })}
      </RowList>
    </Section>
  );
}

function ListPage({
  catalog,
  machineName,
  open,
}: {
  catalog: AccountCatalog;
  machineName: string;
  open: (page: Page) => void;
}) {
  const profiles = catalog.profiles.profiles;
  const create = (
    <Button type="button" variant="primary" data-profile-new="" onClick={() => open({ kind: 'new' })}>
      + New profile
    </Button>
  );
  if (profiles.length === 0)
    return (
      <>
        <section className="kt-panel flex min-w-0 flex-col items-start gap-2 p-panel" data-profiles-empty="">
          <h3 className="m-0 text-row font-semibold text-fg">No profiles yet</h3>
          <Hint>
            A profile is a bag of components — MCP servers, skills, instructions, settings, hooks — and other profiles.
            Where two set the same thing, the later one wins.
          </Hint>
          {create}
        </section>
        <BuiltFrom catalog={catalog} machineName={machineName} open={open} />
      </>
    );
  return (
    <>
      <PageHead root title="Profiles" sub={counted(profiles.length, 'profile')} />
      <div>{create}</div>
      <RowList label="Profiles">
        {profiles.map(profile => {
          const runtimes = runtimesReaching(profile, catalog.runtimes.runtimes).length;
          return (
            <OpenRow
              key={profile.name}
              title={profile.name}
              badges={<ComponentBadges badges={[profileScopeBadge(profile.scope)]} />}
              sub={profileUseLine(profile, runtimes)}
              onOpen={() => open({ kind: 'detail', name: profile.name })}
              data={{ 'data-profile-row': profile.name }}
            />
          );
        })}
      </RowList>
      <BuiltFrom catalog={catalog} machineName={machineName} open={open} />
    </>
  );
}

interface DetailProps extends MachineTabProps {
  readonly catalog: AccountCatalog;
  readonly profile: LayeredProfileView;
  readonly onBack: () => void;
  readonly onOpenProfile: (name: string) => void;
  readonly onSaved: (name: string) => void;
  readonly onFileChanged: () => void;
  readonly onDeleted: (message: string) => void;
}

function DetailPage(props: DetailProps) {
  const { catalog, profile, machineName, onBack, onOpenProfile } = props;
  const [deleting, setDeleting] = useState(false);
  const includers = includedBy(profile);
  const runtimes = runtimesReaching(profile, catalog.runtimes.runtimes);
  return (
    <>
      <PageHead title={profile.name} sub="Profile" onBack={onBack} />
      {profile.scope.kind === 'mixed' ? (
        <CatalogNote tone="warn" spot="mixed" title={profile.scope.sentence}>
          <span>
            It still runs, skipping the other tool’s items. Take out the Claude-only or the Codex-only items so it is
            one tool’s.
          </span>
        </CatalogNote>
      ) : null}
      <ProfileEditor
        catalog={catalog}
        profile={profile}
        machineName={machineName}
        online={props.online}
        client={props.client}
        {...(props.renderFileEditor === undefined ? {} : { renderFileEditor: props.renderFileEditor })}
        onSaved={props.onSaved}
        onFileChanged={props.onFileChanged}
      />
      <InstructionTexts profile={profile} profiles={catalog.profiles.profiles} components={allComponents(catalog)} />
      <Section title="Where it is used">
        {includers.length === 0 && runtimes.length === 0 ? (
          <Hint>Nothing uses this profile yet.</Hint>
        ) : (
          <RowList label="Where it is used">
            {includers.map(name => (
              <OpenRow
                key={name}
                title={`Profile · ${name}`}
                sub={`Contains ${profile.name}`}
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
          <Button
            type="button"
            variant="ghost"
            className="kt-btn--flush-start"
            data-profile-delete=""
            onClick={() => setDeleting(true)}
          >
            Delete profile…
          </Button>
        </div>
      )}
    </>
  );
}

/** P6, E21: blocked while another profile contains it; runtimes on it pick a replacement; its components stay saved. */
function DeletePanel(props: DetailProps & { onKeep: () => void }) {
  const { catalog, profile, machineName, online, client, onKeep, onDeleted } = props;
  const id = useId();
  const [detached, setDetached] = useState(false);
  const loops = new Set(profile.wouldIncludeItself);
  const others = catalog.profiles.profiles.filter(candidate => !loops.has(candidate.name));
  const [target, setTarget] = useState<string | undefined>(others[0]?.name);
  const changes = useAccountChanges({ client });
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
          It is inside {listed(profile.baseFor)}
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
  const change: AccountChange = {
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
            <span>There is no other profile to move to yet. Make one first.</span>
          ) : (
            <span className="contents" data-profile-switch="">
              <SelectBox
                id={id}
                label="Move to profile"
                value={target ?? ''}
                onChange={setTarget}
                options={others.map(other => ({
                  value: other.name,
                  label: `${other.name} · ${profileScopeWord(other.scope)}`,
                }))}
              />
            </span>
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
