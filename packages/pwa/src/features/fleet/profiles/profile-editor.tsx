/**
 * Build or edit a profile as a bag of components (R5): the library on the left, the profile's
 * contents on the right as ONE sortable list, and a Resolved view of what it all comes to.
 *
 * - **Add:** drag a library row in (dropped where the line shows), or press its Add — on a phone, the
 *   contents' Add opens the library as a picker sheet.
 * - **Remove:** ✕ on the row, or drag it back onto the library.
 * - **Order:** drag, or ↑ / ↓. Order matters only for override: a later item wins where two set the
 *   same key, and the row that wins says "overrides ‹X› · ‹key›".
 * - **Scope** is derived from the contents. Dropping a Claude-only item into a Codex-only profile —
 *   or the other way round — is refused at once, naming the items to blame.
 *
 * Every edit is a draft until **Save**, which sends the whole list as ONE change the daemon previews
 * and applies (from off the machine, after a passkey). The overrides and the Resolved view are the
 * daemon's own answer for the draft (`POST /v1/fleet/profiles/preview`), asked again on every edit.
 * A saved profile also offers **Edit as YAML**: its file, `config/profiles/<name>.yaml`.
 */

import {
  CONFIG_DIRECTORY_NAME,
  configFilePath,
  type FleetLayeredProfileView,
  type FleetProfileDraftView,
} from '@ferretry/protocol';
import { FileCode2, Plus, X } from 'lucide-react';
import { type DragEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { ConfigFileEditor } from '../../config-files/config-files-settings.tsx';
import { previewFleetProfileDraft } from '../catalog-api.ts';
import type { AccountCatalog } from '../components/account-catalog.ts';
import { CatalogNote, ComponentBadges, Hint } from '../components/catalog-ui.tsx';
import { type CatalogHarness, counted, HARNESS_NAMES } from '../components/component-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import { ContentsList, ResolvedTable } from './profile-contents.tsx';
import { AddPicker, type LibraryFilter, LibraryPanel, NO_FILTER } from './profile-library.tsx';
import {
  addRefusal,
  contentScope,
  includedBy,
  insertAt,
  itemFor,
  libraryItems,
  moveBefore,
  moveBy,
  overrideChips,
  type ProfileItem,
  profileChange,
  profileNameProblem,
  removeAt,
  resolvedHarnesses,
  sameContents,
  scopeWord,
} from './profile-model.ts';

export interface ProfileEditorProps {
  readonly catalog: AccountCatalog;
  /** The saved profile being edited; absent while a new one is built. */
  readonly profile?: FleetLayeredProfileView;
  readonly machineName: string;
  readonly online?: boolean;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** The login's tool, when a new profile is built for one (Add runtime). */
  readonly harness?: CatalogHarness;
  /** The profile was saved, under this name. */
  readonly onSaved: (name: string) => void;
  /** Its file was edited as YAML: the catalogue is read again. */
  readonly onFileChanged?: () => void;
  /** Buttons beside Save (Cancel, when building a new one). */
  readonly children?: ReactNode;
}

type Preview =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly last?: FleetProfileDraftView }
  | { readonly kind: 'ready'; readonly view: FleetProfileDraftView }
  | { readonly kind: 'failed' };

/** What the daemon says the draft resolves to: asked again on every edit and every Try again. */
function useDraftPreview(
  contents: readonly string[],
  editing: string | undefined,
  connection: DaemonConnection,
  createClient: FleetClientFactory,
) {
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  // One read per list and per Try again: both are part of what is asked for.
  const ask = `${attempt}\n${contents.join('\n')}`;
  useEffect(() => {
    const [, ...asked] = ask.split('\n');
    const layers = asked.filter(each => each !== '');
    if (layers.length === 0) {
      setPreview({ kind: 'idle' });
      return;
    }
    let live = true;
    setPreview(previous => ({
      kind: 'loading',
      ...(previous.kind === 'ready'
        ? { last: previous.view }
        : previous.kind === 'loading' && previous.last
          ? { last: previous.last }
          : {}),
    }));
    void (async () => {
      try {
        const client = await createClient(connection);
        const view = await previewFleetProfileDraft(client, {
          layers,
          ...(editing === undefined ? {} : { editing }),
        });
        if (live) setPreview({ kind: 'ready', view });
      } catch {
        if (live) setPreview({ kind: 'failed' });
      }
    })();
    return () => {
      live = false;
    };
  }, [ask, editing, connection, createClient]);
  const view = preview.kind === 'ready' ? preview.view : preview.kind === 'loading' ? preview.last : undefined;
  return { preview, view, retry: () => setAttempt(attempt + 1) };
}

/** What is being dragged: a library item, or a contents row by its position. */
type Drag =
  | { readonly from: 'library'; readonly item: ProfileItem }
  | { readonly from: 'contents'; readonly index: number };

/** Some browsers refuse a drag that carries no data; the payload itself is kept in state. */
function markDrag(event: DragEvent<HTMLElement>, text: string): void {
  try {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', text);
  } catch {
    // A synthetic drag has no data transfer to fill.
  }
}

export function ProfileEditor(props: ProfileEditorProps) {
  const { catalog, profile, machineName, online = true, connection, createClient, harness, onSaved } = props;
  const nameId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const saved = profile?.layers ?? [];
  const [contents, setContents] = useState<readonly string[]>(saved);
  const [name, setName] = useState('');
  const [view, setView] = useState<'list' | 'resolved'>('list');
  const [filter, setFilter] = useState<LibraryFilter>(NO_FILTER);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [picking, setPicking] = useState(false);
  const [yaml, setYaml] = useState(false);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [dropBefore, setDropBefore] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ readonly reference: string; readonly move: 'up' | 'down' } | null>(null);
  const [shownHarness, setShownHarness] = useState<CatalogHarness | null>(null);
  const changes = useAccountChanges({ connection, createClient });
  const { preview, view: answer, retry } = useDraftPreview(contents, profile?.name, connection, createClient);

  const library = libraryItems(catalog, profile?.name);
  const items = contents.map(reference => itemFor(reference, library));
  const scope = contentScope(items);
  const label = profile?.name ?? (name.trim() === '' ? 'this profile' : name.trim());
  const resolved = answer?.resolved;
  const chips = overrideChips(resolved ?? []);
  const harnesses = resolvedHarnesses(scope.scope, resolved ?? []);
  const harnessShown =
    shownHarness !== null && harnesses.includes(shownHarness) ? shownHarness : (harnesses[0] as CatalogHarness);
  const dirty = !sameContents(contents, saved);
  const nameProblem = profile === undefined ? profileNameProblem(name, catalog.profiles.profiles) : undefined;
  const daemonRefusal = preview.kind === 'ready' ? preview.view.refusal : undefined;

  // The saved contents changed under the editor (its file was edited, or a save landed): an
  // untouched draft follows them, an edited one is kept for its Save or Discard.
  const savedBefore = useRef(saved);
  const savedKey = saved.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `savedKey` stands for `saved`, a new array each render
  useEffect(() => {
    const before = savedBefore.current;
    savedBefore.current = saved;
    setContents(current => (sameContents(current, before) ? saved : current));
  }, [savedKey]);

  // ↑ / ↓ keep focus on the row that moved; at an end, on the button that still works.
  useEffect(() => {
    if (focus === null) return;
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-profile-item]') ?? [])].find(
      each => each.dataset.profileItem === focus.reference,
    );
    const wanted = row?.querySelector<HTMLButtonElement>(`[data-item-move="${focus.move}"]`);
    const other = row?.querySelector<HTMLButtonElement>(`[data-item-move="${focus.move === 'up' ? 'down' : 'up'}"]`);
    (wanted?.disabled === false ? wanted : other)?.focus();
    setFocus(null);
  }, [focus]);

  const add = (item: ProfileItem, at = contents.length): void => {
    const refused = addRefusal({
      profile: profile?.name ?? name.trim(),
      contents: items,
      item,
      loops: profile === undefined ? [] : includedBy(profile),
      ...(harness === undefined ? {} : { harness }),
    });
    if (refused !== undefined) {
      setRefusal(refused);
      setSaid(refused);
      return;
    }
    const next = insertAt(contents, item.reference, at);
    setContents(next);
    setRefusal(null);
    setSaid(`Added ${item.name} at position ${next.indexOf(item.reference) + 1} of ${next.length}.`);
  };

  const remove = (index: number): void => {
    const item = items[index];
    if (item === undefined) return;
    setContents(removeAt(contents, index));
    setRefusal(null);
    setSaid(`Removed ${item.name}.`);
  };

  const move = (index: number, by: -1 | 1): void => {
    const item = items[index] as ProfileItem;
    setContents(moveBy(contents, index, by));
    setFocus({ reference: item.reference, move: by === -1 ? 'up' : 'down' });
    setSaid(`Moved ${item.name} to position ${index + by + 1} of ${contents.length}.`);
  };

  const endDrag = (): void => {
    setDragging(null);
    setDropBefore(null);
  };

  const dropOnContents = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    const at = dropBefore ?? contents.length;
    if (dragging?.from === 'library') add(dragging.item, at);
    if (dragging?.from === 'contents') {
      const item = items[dragging.index] as ProfileItem;
      const next = moveBefore(contents, dragging.index, at);
      setContents(next);
      setSaid(`Moved ${item.name} to position ${next.indexOf(item.reference) + 1} of ${next.length}.`);
    }
    endDrag();
  };

  const save = (): void => {
    const target = profile?.name ?? name.trim();
    void changes.apply(profileChange(target, contents, profile === undefined)).then(result => {
      if (result.kind === 'applied') onSaved(target);
    });
  };

  const filePath = profile === undefined ? undefined : configFilePath({ kind: 'profile', name: profile.name });

  return (
    <div className="flex min-w-0 flex-col gap-3" data-profile-editor={profile?.name ?? ''}>
      <p className="sr-only" role="status" aria-live="polite" data-profile-said="">
        {said}
      </p>
      {profile === undefined ? (
        <label className="flex min-w-0 flex-col gap-1" htmlFor={nameId}>
          <span className="text-cell font-medium text-fg">Profile name</span>
          <input
            id={nameId}
            className="kt-input"
            value={name}
            autoComplete="off"
            aria-invalid={nameProblem !== undefined && name !== ''}
            data-profile-name=""
            onChange={event => setName(event.currentTarget.value)}
          />
          {nameProblem !== undefined && name !== '' ? (
            <span className="text-cell text-err">{nameProblem}</span>
          ) : (
            <span className="text-cell text-muted">For example Review, Agent or Docs.</span>
          )}
        </label>
      ) : null}
      <p className="m-0 flex flex-wrap items-center gap-2 text-cell text-fg" data-profile-scope={scope.scope}>
        Scope:
        <ComponentBadges
          badges={[
            {
              text: scopeWord(scope.scope),
              tone: scope.scope === 'generic' ? 'pend' : scope.scope === 'mixed' ? 'warn' : 'accent',
              ...(scope.scope === 'mixed' ? { warn: true } : {}),
            },
          ]}
        />
        <span className="text-muted">
          derived from the contents
          {harness === undefined ? '' : ` · for a ${HARNESS_NAMES[harness]} login`}
        </span>
      </p>
      {refusal === null ? null : (
        <CatalogNote
          tone="warn"
          role="alert"
          spot="refused"
          title={refusal}
          actions={
            <Button type="button" size="sm" variant="ghost" data-refusal-dismiss="" onClick={() => setRefusal(null)}>
              <X size={14} aria-hidden="true" /> Dismiss
            </Button>
          }
        />
      )}
      {daemonRefusal === undefined ? null : (
        <CatalogNote tone="warn" spot="draft-refused" title={daemonRefusal}>
          <span>Change the contents so it can be saved.</span>
        </CatalogNote>
      )}
      <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <LibraryPanel
          items={library}
          contents={contents}
          profileLabel={label}
          filter={filter}
          onFilter={setFilter}
          onAdd={item => add(item)}
          onDragStart={(event, item) => {
            markDrag(event, item.reference);
            setDragging({ from: 'library', item });
          }}
          onDragEnd={endDrag}
          removing={dragging?.from === 'contents'}
          onRemoveDrop={() => {
            if (dragging?.from === 'contents') remove(dragging.index);
            endDrag();
          }}
        />
        <section className="kt-panel flex min-w-0 flex-col" aria-label={`Contents of ${label}`} data-profile-box="">
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-panel py-2">
            <p className="m-0 w-full min-w-0 text-cell text-fg md:w-auto md:flex-1">
              <span className="font-semibold">{label}</span>{' '}
              <span className="text-muted">
                {counted(contents.length, 'item')} · later overrides earlier
                {preview.kind === 'loading' ? ' · checking…' : ''}
              </span>
            </p>
            <fieldset className="m-0 flex border-0 p-0" aria-label="View">
              {(['list', 'resolved'] as const).map(each => (
                <button
                  key={each}
                  type="button"
                  aria-pressed={view === each}
                  className={`kt-btn kt-btn--sm ${view === each ? 'text-accent' : 'text-muted'}`}
                  data-variant={view === each ? undefined : 'ghost'}
                  data-profile-view={each}
                  onClick={() => setView(each)}
                >
                  {each === 'list' ? 'List' : 'Resolved'}
                </button>
              ))}
            </fieldset>
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="md:hidden"
              data-profile-pick=""
              onClick={() => {
                setRefusal(null);
                setPicking(true);
              }}
            >
              <Plus size={14} aria-hidden="true" /> Add
            </Button>
          </div>
          {preview.kind === 'failed' ? (
            <div className="flex flex-wrap items-center gap-2 px-panel pt-2" data-profile-preview-failed="">
              <Hint>{machineName} did not answer, so overrides can’t be shown yet.</Hint>
              <Button type="button" size="sm" data-profile-preview-retry="" onClick={retry}>
                Try again
              </Button>
            </div>
          ) : null}
          <div ref={listRef} className="min-w-0">
            {view === 'list' ? (
              <ContentsList
                items={items}
                chips={chips}
                dropBefore={dropBefore}
                onMove={move}
                onRemove={remove}
                onDragStart={(event, index) => {
                  markDrag(event, contents[index] as string);
                  setDragging({ from: 'contents', index });
                }}
                onDragEnd={endDrag}
                onDragOver={(event, index) => {
                  if (dragging === null) return;
                  event.preventDefault();
                  setDropBefore(index);
                }}
                onDrop={dropOnContents}
              />
            ) : (
              <ResolvedTable
                entries={contents.length === 0 ? [] : resolved}
                harnesses={harnesses}
                harness={harnessShown}
                onHarness={setShownHarness}
              />
            )}
          </div>
        </section>
      </div>
      <AddPicker
        open={picking}
        onClose={() => setPicking(false)}
        refusal={refusal}
        items={library}
        contents={contents}
        profileLabel={label}
        filter={filter}
        onFilter={setFilter}
        onAdd={item => add(item)}
      />
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        refusal={changes.refusal}
        submitLabel={profile === undefined ? 'Save profile' : 'Save changes'}
        busyLabel="Saving…"
        disabled={
          !online ||
          contents.length === 0 ||
          nameProblem !== undefined ||
          daemonRefusal !== undefined ||
          scope.scope === 'mixed' ||
          (profile !== undefined && !dirty)
        }
        onSubmit={save}
      >
        {profile !== undefined && dirty ? (
          <Button
            type="button"
            variant="ghost"
            data-profile-discard=""
            onClick={() => {
              setContents(saved);
              setRefusal(null);
              setSaid('Changes discarded.');
            }}
          >
            Discard changes
          </Button>
        ) : null}
        {props.children}
      </ChangeApplyPanel>
      {profile !== undefined && dirty ? (
        <Hint>Unsaved: new sessions keep the saved contents until you save.</Hint>
      ) : null}
      {filePath === undefined ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-profile-file="">
          <Button type="button" size="sm" data-profile-yaml="" onClick={() => setYaml(true)}>
            <FileCode2 size={14} aria-hidden="true" /> Edit as YAML
          </Button>
          <span className="min-w-0 break-all font-mono text-meta text-muted">
            {CONFIG_DIRECTORY_NAME}/{filePath}
          </span>
        </div>
      )}
      {yaml && filePath !== undefined
        ? // Portalled, like the picker: the sheet belongs to the screen, not to this tab's column.
          createPortal(
            <ConfigFileEditor
              connection={connection}
              createClient={createClient}
              path={filePath}
              onClose={() => setYaml(false)}
              onChanged={() => props.onFileChanged?.()}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
