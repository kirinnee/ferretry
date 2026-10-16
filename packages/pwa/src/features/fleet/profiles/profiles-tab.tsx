/**
 * The Profiles tab (R5, docs/design/account-model.md §4.2, P6, E21): every profile with its size and
 * who uses it, and one profile's page — its contents in the drag-and-drop editor, Where it is used,
 * and **Delete profile…**. "+ New profile" opens the same editor with a name to fill in.
 *
 * Every write is one change the daemon previews and applies; while this machine refuses changes the
 * panel says why in one sentence and the pages still read.
 */

import type { FleetAccountChange, FleetLayeredProfileView } from '@ferretry/protocol';
import { useId, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { type AccountCatalog, useAccountCatalog } from '../components/account-catalog.ts';
import {
  CatalogNote,
  ComponentBadges,
  Hint,
  LinkRow,
  OpenRow,
  PageHead,
  ReadFailed,
  RowList,
  Section,
} from '../components/catalog-ui.tsx';
import { counted, listed, profileScopeBadge, profileScopeWord } from '../components/component-model.ts';
import { itemHref, useHashItem } from '../components/machine-links.ts';
import { ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { ProfileEditor } from './profile-editor.tsx';
import { includedBy, profileUseLine, runtimesReaching } from './profile-model.ts';

type Page = { readonly kind: 'list' } | { readonly kind: 'detail'; readonly name: string } | { readonly kind: 'new' };

export function ProfilesTab(props: MachineTabProps) {
  const { connection, machineName, createClient } = props;
  const { read, reload } = useAccountCatalog(connection, createClient);
  const [page, setPage] = useState<Page>({ kind: 'list' });
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const open = (next: Page) => {
    setSaved(undefined);
    setPage(next);
  };
  useHashItem('profiles', name => open({ kind: 'detail', name }));

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
  const shown = page.kind === 'new' ? 'new' : profile === undefined ? 'list' : 'detail';
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
      {page.kind === 'new' ? (
        <>
          <PageHead title="New profile" sub="Profile" onBack={() => open({ kind: 'list' })} />
          <ProfileEditor {...props} catalog={catalog} onSaved={name => afterSave(name, `Profile ${name} saved.`)}>
            <Button type="button" variant="ghost" data-profile-cancel="" onClick={() => open({ kind: 'list' })}>
              Cancel
            </Button>
          </ProfileEditor>
        </>
      ) : profile === undefined ? (
        <ListPage catalog={catalog} open={open} />
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

function ListPage({ catalog, open }: { catalog: AccountCatalog; open: (page: Page) => void }) {
  const profiles = catalog.profiles.profiles;
  const create = (
    <Button type="button" variant="primary" data-profile-new="" onClick={() => open({ kind: 'new' })}>
      + New profile
    </Button>
  );
  if (profiles.length === 0)
    return (
      <section className="kt-panel flex min-w-0 flex-col items-start gap-2 p-panel" data-profiles-empty="">
        <h3 className="m-0 text-row font-semibold text-fg">No profiles yet</h3>
        <Hint>
          A profile is a bag of components — MCP servers, skills, instructions, settings, hooks — and other profiles.
          Where two set the same thing, the later one wins.
        </Hint>
        {create}
      </section>
    );
  return (
    <>
      <PageHead title="Profiles" sub={counted(profiles.length, 'profile')} />
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
    </>
  );
}

interface DetailProps extends MachineTabProps {
  readonly catalog: AccountCatalog;
  readonly profile: FleetLayeredProfileView;
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
        connection={props.connection}
        createClient={props.createClient}
        onSaved={props.onSaved}
        onFileChanged={props.onFileChanged}
      />
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
            <span>There is no other profile to move to yet. Make one first.</span>
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
                  {other.name} · {profileScopeWord(other.scope)}
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
