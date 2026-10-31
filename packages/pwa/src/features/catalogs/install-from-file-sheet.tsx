/**
 * "Install from a file…": open a signed catalog file, pick one item and a place, read the review the
 * machine wrote, choose what every secret becomes, and confirm with a passkey.
 *
 * The signature is checked here before anything is shown, and this machine's daemon checks it again
 * before it writes. Nothing is installed by this screen on its own: Install needs an explicit choice for
 * every secret and a fresh passkey.
 */

import { type CatalogInstallPreview, type CatalogInstalled, revealHidden, type SecretList } from '@ferretry/protocol';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import type { RelayCrypto } from '@ferretry/relay';
import { CircleCheck, FileUp } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useKnownProjects } from '../../hooks/use-projects.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useAppStore, useDaemonClient } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import { readFleetRuntimes } from '../fleet/catalog-api.ts';
import { listSecrets } from '../secrets/secrets-api.ts';
import { fingerprintStart, shortDigest } from './catalog-review-model.ts';
import { MarkedText, ReviewBody, WarningList } from './catalog-review-view.tsx';
import { CatalogSheet, FailureLine } from './catalog-parts.tsx';
import { applyCatalogInstall, previewCatalogInstall } from './catalog-installs-api.ts';
import {
  type BindingPicks,
  bindableSecretNames,
  bindingNote,
  CHOOSE_PLACEHOLDER,
  EXPIRY_NOTE,
  FILE_LIMIT_NOTE,
  FIRST_INSTALL_NOTE,
  fileItemRows,
  fileSizeProblem,
  fileSummary,
  heldHint,
  INSTALL_BUTTON,
  type InstallRefusal,
  installRefusal,
  installRequest,
  installState,
  LEAVE_UNBOUND,
  NO_AUTO_UPDATE,
  type OpenedCatalogFile,
  openCatalogFile,
  pickBinding,
  previewDisagreement,
  previewRequest,
  type TargetDraft,
  type TargetOptions,
  targetProblem,
  toTarget,
  unpickBinding,
  withdrawnNote,
} from './catalog-install-model.ts';
import type { CatalogClient, CatalogClientFactory } from './catalogs-api.ts';

/** What a test or a harness can replace. The app uses the daemon-bound client, the browser's crypto and the known projects. */
export interface InstallHost {
  readonly createClient?: CatalogClientFactory;
  readonly crypto?: RelayCrypto;
  /** The projects to offer, instead of the ones this browser knows. */
  readonly projects?: readonly { readonly name: string; readonly path: string }[];
}

export interface InstallFromFileSheetProps {
  readonly connection: DaemonConnection;
  readonly onClose: () => void;
  readonly host?: InstallHost;
}

type Project = { readonly name: string; readonly path: string };

/** The projects this browser already knows for the machine, unless the host names some. */
export function InstallFromFileSheet(props: InstallFromFileSheetProps) {
  const given = props.host?.projects;
  return given === undefined ? <KnownProjectsSheet {...props} /> : <InstallSheetBody {...props} projects={given} />;
}

function KnownProjectsSheet(props: InstallFromFileSheetProps) {
  const store = useAppStore();
  const projects = useKnownProjects(store.projects, props.connection.daemonId);
  return <InstallSheetBody {...props} projects={projects} />;
}

type Landed = CatalogInstalled;

function InstallSheetBody({
  connection,
  onClose,
  host,
  projects,
}: InstallFromFileSheetProps & { readonly projects: readonly Project[] }) {
  const routed = useDaemonClient();
  const createClient: CatalogClientFactory = host?.createClient ?? routed;
  const crypto = useMemo<RelayCrypto>(() => host?.crypto ?? new WebCryptoRelayCrypto(), [host?.crypto]);
  const fileId = useId();
  const input = useRef<HTMLInputElement>(null);

  const [opened, setOpened] = useState<OpenedCatalogFile | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TargetDraft>({});
  const [runtimes, setRuntimes] = useState<TargetOptions['runtimes']>([]);
  const [allowOlder, setAllowOlder] = useState(false);
  const [preview, setPreview] = useState<CatalogInstallPreview | null>(null);
  const [picks, setPicks] = useState<BindingPicks>({});
  const [secrets, setSecrets] = useState<SecretList | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<InstallRefusal | null>(null);
  const [landed, setLanded] = useState<Landed | null>(null);
  // Counts the previews asked for. An answer is kept only if nothing it was asked about has changed since.
  const asked = useRef(0);

  const options = useMemo<TargetOptions>(
    () => ({
      projects: projects.map(project => ({ root: project.path, label: project.name })),
      runtimes,
    }),
    [projects, runtimes],
  );

  useEffect(() => {
    if (opened === null) return;
    let live = true;
    void createClient(connection)
      .then(async client => await readFleetRuntimes(client))
      .then(catalog => {
        if (live) setRuntimes(catalog.runtimes.map(runtime => ({ runtime: runtime.id, profiles: [runtime.profile] })));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [opened, connection, createClient]);

  const startOver = (): void => {
    setItemId(null);
    setPreview(null);
    setPicks({});
    setFailure(null);
    setAllowOlder(false);
  };

  const openFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    asked.current += 1;
    setOpened(null);
    startOver();
    const tooBig = fileSizeProblem(file.size);
    if (tooBig !== null) {
      setFileProblem(tooBig);
      return;
    }
    setBusy(true);
    try {
      const result = await openCatalogFile(await file.text(), crypto);
      if (result.ok) {
        setFileProblem(null);
        setOpened(result.opened);
      } else setFileProblem(result.sentence);
    } catch {
      setFileProblem('This file could not be read. Nothing was installed.');
    } finally {
      setBusy(false);
    }
  };

  const problem = itemId === null ? 'Pick an item.' : targetProblem(draft, options);

  const runPreview = useCallback(
    async (older: boolean): Promise<void> => {
      const target = toTarget(draft);
      if (opened === null || itemId === null || target === null) return;
      const request = previewRequest(opened, itemId, target, older);
      if (request === null) return;
      asked.current += 1;
      const mine = asked.current;
      setBusy(true);
      setFailure(null);
      setPicks({});
      try {
        const client: CatalogClient = await createClient(connection);
        const read = await previewCatalogInstall(client, target.scope, request);
        if (mine !== asked.current) return;
        const disagreement = previewDisagreement(opened, itemId, read);
        if (disagreement !== null) {
          setPreview(null);
          setFailure({ sentence: disagreement, previewAgain: false, olderOffered: false });
          return;
        }
        setPreview(read);
        setSecrets(undefined);
        if (read.secrets.length > 0)
          void listSecrets(client)
            .then(list => {
              if (mine === asked.current) setSecrets(list);
            })
            .catch(() => {
              if (mine === asked.current) setSecrets(null);
            });
      } catch (error) {
        if (mine !== asked.current) return;
        setPreview(null);
        setFailure(installRefusal(error));
      } finally {
        if (mine === asked.current) setBusy(false);
      }
    },
    [opened, itemId, draft, createClient, connection],
  );

  const install = async (): Promise<void> => {
    if (preview === null) return;
    const request = installRequest(preview, picks);
    if (request === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const client = await createClient(connection);
      setLanded(await applyCatalogInstall(client, preview.target.scope, request));
    } catch (error) {
      setFailure(installRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  const state = installState(preview, picks, busy);

  if (landed !== null)
    return (
      <CatalogSheet name="install" title="Installed" closeLabel="Close Installed" onClose={onClose}>
        <section className="flex min-w-0 flex-col gap-xs" role="status" data-catalog-installed="">
          <p className="m-0 flex items-start gap-2 break-words text-cell font-semibold text-ok">
            <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            {landed.install.provenance.name} · version {landed.install.provenance.version}
          </p>
          <p className="m-0 break-all text-cell text-fg" data-catalog-destination="">
            Put into {landed.install.destination}
          </p>
          {landed.notes.map(note => (
            <p key={note} className="m-0 break-words text-cell text-muted" data-catalog-note="">
              <MarkedText text={note} />
            </p>
          ))}
          <p className="m-0 text-cell text-muted">{NO_AUTO_UPDATE}</p>
          <Button type="button" onClick={onClose} data-catalog-done="">
            Done
          </Button>
        </section>
      </CatalogSheet>
    );

  return (
    <CatalogSheet name="install" title="Install from a file" closeLabel="Close Install from a file" onClose={onClose}>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={fileId} className="text-meta font-semibold text-muted">
          Catalog file
        </label>
        <input
          ref={input}
          id={fileId}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          disabled={busy}
          onChange={event => void openFile(event.target.files?.[0])}
          data-catalog-file-input=""
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
          data-catalog-pick-file=""
        >
          <FileUp size={16} aria-hidden="true" />
          {opened === null ? 'Choose a .catalog.json file' : 'Choose another file'}
        </Button>
        <p className="m-0 text-meta text-faint">{FILE_LIMIT_NOTE}</p>
      </div>
      {fileProblem === null ? null : <FailureLine sentence={fileProblem} />}
      {opened === null ? null : (
        <OpenedFile
          opened={opened}
          itemId={itemId}
          onItem={next => {
            asked.current += 1;
            setItemId(next);
            setPreview(null);
            setFailure(null);
          }}
          draft={draft}
          onDraft={next => {
            asked.current += 1;
            setDraft(next);
            setPreview(null);
            setFailure(null);
          }}
          options={options}
          problem={problem}
          busy={busy}
          onPreview={() => void runPreview(false)}
        />
      )}
      {failure === null ? null : (
        <div className="flex min-w-0 flex-col items-start gap-xs">
          <FailureLine
            sentence={failure.sentence}
            {...(failure.previewAgain ? { again: true, onAgain: () => void runPreview(allowOlder) } : {})}
          />
          {failure.olderOffered ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setAllowOlder(true);
                void runPreview(true);
              }}
              data-catalog-allow-older=""
            >
              Show me the older version anyway
            </Button>
          ) : null}
        </div>
      )}
      {preview === null ? null : (
        <Confirm
          preview={preview}
          picks={picks}
          secrets={secrets}
          onPick={(placeholder, choice) =>
            setPicks(current =>
              choice === undefined ? unpickBinding(current, placeholder) : pickBinding(current, placeholder, choice),
            )
          }
          state={state}
          busy={busy}
          onInstall={() => void install()}
        />
      )}
    </CatalogSheet>
  );
}

function OpenedFile({
  opened,
  itemId,
  onItem,
  draft,
  onDraft,
  options,
  problem,
  busy,
  onPreview,
}: {
  readonly opened: OpenedCatalogFile;
  readonly itemId: string | null;
  readonly onItem: (itemId: string) => void;
  readonly draft: TargetDraft;
  readonly onDraft: (draft: TargetDraft) => void;
  readonly options: TargetOptions;
  readonly problem: string | null;
  readonly busy: boolean;
  readonly onPreview: () => void;
}) {
  const rows = fileItemRows(opened);
  const withdrawn = withdrawnNote(opened);
  const legend = useId();
  return (
    <section className="flex min-w-0 flex-col gap-sm" aria-label="This file" data-catalog-file="">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 break-words text-cell font-semibold text-fg" data-catalog-file-summary="">
          {revealHidden(fileSummary(opened))}
        </p>
        <p className="m-0 break-words text-meta text-muted">
          From {revealHidden(opened.manifest.publisherName)} ·{' '}
          <TapToExpand
            label="Publisher fingerprint"
            short={fingerprintStart(opened.manifest.publisher)}
            full={opened.manifest.publisher}
          />
        </p>
      </div>
      <fieldset className="m-0 flex min-w-0 flex-col gap-xs border-0 p-0" aria-labelledby={legend}>
        <legend id={legend} className="p-0 text-meta font-semibold text-muted">
          Item
        </legend>
        {rows.length === 0 ? <p className="m-0 text-cell text-muted">This file has no items.</p> : null}
        {rows.map(row => (
          <label
            key={row.entry.itemId}
            className="kt-panel flex min-h-[44px] min-w-0 cursor-pointer items-start gap-2 px-control-x py-2"
            data-catalog-file-item={row.entry.itemId}
          >
            <input
              type="radio"
              name="catalog-file-item"
              className="mt-1"
              checked={itemId === row.entry.itemId}
              disabled={row.unavailable !== null || busy}
              onChange={() => onItem(row.entry.itemId)}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="break-words text-cell text-fg">
                {revealHidden(row.entry.name)} · {row.entry.kind === 'skill' ? 'Skill' : 'MCP server'} · version{' '}
                {row.entry.version}
              </span>
              <span className="break-words text-meta text-muted">{revealHidden(row.entry.summary)}</span>
              {row.unavailable === null ? null : <span className="text-meta text-err">{row.unavailable}</span>}
            </span>
          </label>
        ))}
        {withdrawn === null ? null : <p className="m-0 text-meta text-muted">{withdrawn}</p>}
      </fieldset>
      <TargetPicker draft={draft} onDraft={onDraft} options={options} busy={busy} />
      {problem === null ? null : (
        <p className="m-0 text-meta text-muted" data-catalog-choice-problem="">
          {problem}
        </p>
      )}
      <Button
        type="button"
        variant="primary"
        disabled={busy || problem !== null}
        onClick={onPreview}
        data-catalog-preview=""
      >
        {busy ? 'Reading…' : 'Review before installing'}
      </Button>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-meta font-semibold text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function TargetPicker({
  draft,
  onDraft,
  options,
  busy,
}: {
  readonly draft: TargetDraft;
  readonly onDraft: (draft: TargetDraft) => void;
  readonly options: TargetOptions;
  readonly busy: boolean;
}) {
  const where = useId();
  const project = useId();
  const harness = useId();
  const runtime = useId();
  return (
    <div className="flex min-w-0 flex-col gap-sm" data-catalog-target="">
      <Field label="Install into" htmlFor={where}>
        <select
          id={where}
          className="kt-input"
          value={draft.scope ?? ''}
          onChange={event => {
            const scope = event.target.value;
            onDraft(scope === 'project' || scope === 'runtime' ? { scope } : {});
          }}
          disabled={busy}
          data-catalog-scope=""
        >
          <option value="">{CHOOSE_PLACEHOLDER}</option>
          <option value="project">A project</option>
          <option value="runtime">A runtime</option>
        </select>
      </Field>
      {draft.scope === 'project' ? (
        <>
          <Field label="Project" htmlFor={project}>
            <select
              id={project}
              className="kt-input"
              value={draft.projectRoot ?? ''}
              onChange={event => {
                const { harness: kept } = draft;
                onDraft({
                  scope: 'project',
                  ...(kept === undefined ? {} : { harness: kept }),
                  ...(event.target.value === '' ? {} : { projectRoot: event.target.value }),
                });
              }}
              disabled={busy}
              data-catalog-project=""
            >
              <option value="">{CHOOSE_PLACEHOLDER}</option>
              {options.projects.map(item => (
                <option key={item.root} value={item.root}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="For which agent" htmlFor={harness}>
            <select
              id={harness}
              className="kt-input"
              value={draft.harness ?? ''}
              onChange={event => {
                const next = event.target.value;
                const { projectRoot: kept } = draft;
                onDraft({
                  scope: 'project',
                  ...(kept === undefined ? {} : { projectRoot: kept }),
                  ...(next === 'claude' || next === 'codex' ? { harness: next } : {}),
                });
              }}
              disabled={busy}
              data-catalog-harness=""
            >
              <option value="">{CHOOSE_PLACEHOLDER}</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </Field>
        </>
      ) : null}
      {draft.scope === 'runtime' ? (
        <Field label="Runtime" htmlFor={runtime}>
          <select
            id={runtime}
            className="kt-input"
            value={draft.runtime ?? ''}
            onChange={event => {
              const picked = options.runtimes.find(item => item.runtime === event.target.value);
              onDraft(
                picked === undefined
                  ? { scope: 'runtime' }
                  : {
                      scope: 'runtime',
                      runtime: picked.runtime,
                      ...(picked.profiles[0] === undefined ? {} : { profile: picked.profiles[0] }),
                    },
              );
            }}
            disabled={busy}
            data-catalog-runtime=""
          >
            <option value="">{CHOOSE_PLACEHOLDER}</option>
            {options.runtimes.map(item => (
              <option key={item.runtime} value={item.runtime}>
                {item.runtime} · {item.profiles.join(', ')}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
    </div>
  );
}

/** A short value that shows in full when tapped. */
function TapToExpand({
  short,
  full,
  label,
}: {
  readonly short: string;
  readonly full: string;
  readonly label: string;
}) {
  const [open, setOpen] = useState(false);
  const hint = useId();
  return (
    <>
      <button
        type="button"
        className="min-h-[44px] max-w-full break-all bg-transparent p-0 text-left font-mono text-cell text-fg underline decoration-dotted"
        aria-expanded={open}
        aria-label={`${label}: ${full}`}
        aria-describedby={hint}
        onClick={() => setOpen(value => !value)}
      >
        {open ? full : short}
      </button>
      <span id={hint} className="sr-only">
        {open ? 'Showing in full. Tap to shorten.' : 'Tap to show in full.'}
      </span>
    </>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-b border-border-soft py-xs">
      <span className="text-meta font-semibold text-muted">{label}</span>
      <span className="min-w-0 break-words text-cell text-fg">{children}</span>
    </div>
  );
}

function Confirm({
  preview,
  picks,
  secrets,
  onPick,
  state,
  busy,
  onInstall,
}: {
  readonly preview: CatalogInstallPreview;
  readonly picks: BindingPicks;
  readonly secrets: SecretList | null | undefined;
  readonly onPick: (placeholder: string, choice: string | null | undefined) => void;
  readonly state: ReturnType<typeof installState>;
  readonly busy: boolean;
  readonly onInstall: () => void;
}) {
  const names = bindableSecretNames(secrets ?? null);
  return (
    <section className="flex min-w-0 flex-col gap-sm" aria-label="Confirm" data-catalog-confirm="">
      <WarningList warnings={preview.warnings.filter(warning => warning.code !== 'first-publisher')} />
      <div className="flex min-w-0 flex-col">
        <Fact label="From">
          {revealHidden(preview.provenance.catalogName)} · {revealHidden(preview.publisher.name)} ·{' '}
          <TapToExpand
            label="Publisher fingerprint"
            short={fingerprintStart(preview.publisher.daemonId)}
            full={preview.publisher.daemonId}
          />
        </Fact>
        {preview.publisher.firstSeen ? (
          <p className="m-0 py-xs text-cell font-semibold text-warn" data-catalog-first-seen="">
            {FIRST_INSTALL_NOTE}
          </p>
        ) : null}
        <Fact label="Into">{preview.destination}</Fact>
        <Fact label="Version">
          {preview.provenance.name} · version {preview.provenance.version}
          {preview.replaces === undefined ? null : ` · replaces version ${preview.replaces.version}`}
        </Fact>
        <Fact label="Digest">
          <TapToExpand label="Digest" short={shortDigest(preview.provenance.digest)} full={preview.provenance.digest} />
        </Fact>
      </div>
      <ReviewBody entries={preview.review} warnings={preview.warnings} audience="installer" />
      {preview.secrets.length === 0 ? null : (
        <section className="flex min-w-0 flex-col gap-sm" aria-label="Secrets" data-catalog-secrets="">
          <h4 className="m-0 text-meta font-semibold uppercase text-muted">Secrets it asks for</h4>
          {secrets === null ? (
            <p className="m-0 text-meta text-muted">
              Your secrets could not be read, so you can only leave these unbound.
            </p>
          ) : null}
          {preview.secrets.map(secret => (
            <SecretPicker
              key={secret.placeholder}
              placeholder={secret.placeholder}
              held={secret.held}
              choice={picks[secret.placeholder]}
              names={names}
              onChoice={choice => onPick(secret.placeholder, choice)}
            />
          ))}
        </section>
      )}
      <p className="m-0 text-cell text-muted">{NO_AUTO_UPDATE}</p>
      <p className="m-0 text-meta text-faint">{EXPIRY_NOTE}</p>
      {state.reason === null ? null : (
        <p className="m-0 text-cell text-muted" data-catalog-install-reason="">
          {state.reason}
        </p>
      )}
      <Button type="button" variant="primary" disabled={!state.enabled} onClick={onInstall} data-catalog-install="">
        {busy ? 'Installing…' : INSTALL_BUTTON}
      </Button>
    </section>
  );
}

const UNCHOSEN = '';
const UNBOUND = '\u0000unbound';

function SecretPicker({
  placeholder,
  held,
  choice,
  names,
  onChoice,
}: {
  readonly placeholder: string;
  readonly held: boolean | undefined;
  readonly choice: string | null | undefined;
  readonly names: readonly string[];
  readonly onChoice: (choice: string | null | undefined) => void;
}) {
  const id = useId();
  const note = bindingNote(choice);
  const hint = heldHint(held);
  const value = choice === undefined ? UNCHOSEN : choice === null ? UNBOUND : choice;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-catalog-secret={placeholder}>
      <label htmlFor={id} className="break-all font-mono text-meta font-semibold text-fg">
        {placeholder}
      </label>
      <select
        id={id}
        className="kt-input"
        value={value}
        onChange={event => {
          const next = event.target.value;
          onChoice(next === UNCHOSEN ? undefined : next === UNBOUND ? null : next);
        }}
        data-catalog-secret-picker=""
      >
        <option value={UNCHOSEN}>{CHOOSE_PLACEHOLDER}</option>
        <option value={UNBOUND}>{LEAVE_UNBOUND}</option>
        {names.map(name => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {hint === null ? null : <p className="m-0 text-meta text-muted">{hint}</p>}
      {note === null ? null : (
        <p className="m-0 break-words text-cell text-fg" data-catalog-secret-note="">
          {note}
        </p>
      )}
    </div>
  );
}
