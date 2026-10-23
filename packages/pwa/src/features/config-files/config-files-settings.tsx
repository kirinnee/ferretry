/**
 * SETTINGS › FILES: the YAML files this machine's settings live in (docs/config-files.md).
 *
 * The files are the source of truth, and this panel is one of their editors — beside `fy`, a text
 * editor on the machine, and an agent holding the `config.*` tools. It reads, for ONE machine:
 *
 * - **where the files are**, as an absolute path a person can copy and open there;
 * - **what is waiting for you** — an edit that loosens what the machine may spend or what its agents may
 *   do is held, with the tighter version in effect, until the owner confirms it. Confirming from another
 *   device asks for a passkey for that act alone; the app's client pool raises that prompt and sends the
 *   confirmation once more, so nothing here asks for it;
 * - **what is wrong**, each issue located (`path:line:col`) with its plain fix. An error keeps the file's
 *   last good version in effect; a warning does not, and the two read differently;
 * - **every file**, grouped by what it configures, each with its state and "Edit as YAML".
 *
 * ## NO SECRET IS EVER ON THIS SCREEN
 *
 * A file holds `${secret:NAME}` references, never a value, and the daemon never returns one. The editor
 * says so under the text, because the one way a key ends up in a file is somebody pasting it there.
 *
 * ## AN EDIT IS MADE AGAINST WHAT WAS READ
 *
 * A save carries the digest of the text it was edited from. If the file changed on the machine since,
 * the save is refused and the editor offers to reload — it never silently overwrites somebody else's
 * edit, and never silently drops this one.
 */

import {
  CONFIG_FILE_KINDS,
  type ConfigFileKind,
  type ConfigFilePutResult,
  type ConfigFileState,
  type ConfigFileSummary,
  type ConfigFileView,
  type ConfigIssue,
  type ConfigPending,
  type ConfigStatusView,
} from '@ferretry/protocol';
import { CircleAlert, FileCode2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useConfigChangeEffect } from '../../lib/store.tsx';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { PanelPath } from '../../shell/panel-typography.tsx';
import { Badge, type BadgeTone, Button } from '../../shell/primitives.tsx';
import { browserClipboardWriter, type ClipboardWriter, CopyButton } from '../onboarding/copy-button.tsx';
import {
  type ConfigFilesClient,
  configErrorCode,
  configInvalidBody,
  confirmConfigChange,
  readConfigFile,
  readConfigStatus,
  writeConfigFile,
} from './config-files-api.ts';

export type ConfigFilesClientFactory = (connection: DaemonConnection) => Promise<ConfigFilesClient>;

/** Each kind of file, as the group a person looks for it under. */
export const CONFIG_KIND_WORDS: Readonly<Record<ConfigFileKind, string>> = {
  machine: 'Machine',
  login: 'Logins',
  component: 'Components',
  profile: 'Profiles',
  runtime: 'Runtimes',
  warden: 'Warden',
  learning: 'Learning',
  voice: 'Voice',
  pack: 'Pack mode',
  modelsGuide: 'Routing prompt',
  preset: 'Provider presets',
  models: 'Model catalogs',
};

const STATE_CHIPS: Readonly<Record<ConfigFileState, { readonly label: string; readonly tone: BadgeTone }>> = {
  ok: { label: 'OK', tone: 'ok' },
  invalid: { label: 'Invalid — last good in effect', tone: 'err' },
  pending: { label: 'Waiting', tone: 'warn' },
};

export const CONFIG_HEADLINE = 'These settings live in files on this machine';

/** The command that stores a key, and the reference a file names it by — each shown as code. */
export const CONFIG_SECRET_COMMAND = 'fy secret set NAME';
// biome-ignore lint/suspicious/noTemplateCurlyInString: the reference grammar, written out for a person to type
export const CONFIG_SECRET_REFERENCE = '${secret:NAME}';

const reasonOf = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message.trim() : '';
  return message === '' ? 'This machine did not answer.' : message;
};

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

/** "N files · M with errors · K waiting for you". */
export const configSummaryWords = (view: ConfigStatusView): string => {
  const broken = new Set(view.issues.filter(issue => issue.severity === 'error').map(issue => issue.path)).size;
  return `${plural(view.files.length, 'file')} · ${String(broken)} with errors · ${String(view.pending.length)} waiting for you`;
};

/** Where an issue is: `path:line:col`, as far as the daemon could place it. */
export const issueLocation = (issue: ConfigIssue): string =>
  [issue.path, issue.line, issue.line === undefined ? undefined : issue.column]
    .filter(part => part !== undefined)
    .join(':');

/** Joins a file's path onto the config directory, for "Open file path". */
export const absoluteConfigPath = (directory: string, path: string): string =>
  `${directory.replace(/\/+$/u, '')}/${path}`;

export function ConfigIssueList({ issues }: { readonly issues: readonly ConfigIssue[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-config-issues="">
      {issues.map((issue, index) => (
        <li
          // Issues have no id; a list is replaced whole on every read, so position is stable.
          key={`${issueLocation(issue)}-${String(index)}`}
          data-config-issue={issue.severity}
          className={
            issue.severity === 'error'
              ? 'flex min-w-0 items-start gap-2 rounded-control border border-err-border bg-err-bg px-3 py-2'
              : 'flex min-w-0 items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2'
          }
        >
          {issue.severity === 'error' ? (
            <CircleAlert size={14} aria-hidden="true" className="mt-1 shrink-0 text-err" />
          ) : (
            <TriangleAlert size={14} aria-hidden="true" className="mt-1 shrink-0 text-warn" />
          )}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="sr-only">{issue.severity === 'error' ? 'Error' : 'Warning'}: </span>
            <PanelPath value={issueLocation(issue)} className="text-meta text-fg" />
            <span className="min-w-0 break-words text-ui leading-base text-fg">{issue.message}</span>
            <span className="min-w-0 break-words text-meta leading-base text-muted">{issue.fix}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What pressing Confirm on one held edit came to. */
type ConfirmState =
  | { readonly status: 'idle' }
  | { readonly status: 'busy' }
  | { readonly status: 'failed'; readonly sentence: string };

const IDLE: ConfirmState = { status: 'idle' };

const STALE_CONFIRM =
  'That edit is no longer the one waiting — the file changed since. Review it again before confirming.';

/** Confirm one held edit and say what happened, never throwing. `null` is "confirmed". */
async function confirmHeld(
  createClient: ConfigFilesClientFactory,
  connection: DaemonConnection,
  pending: Pick<ConfigPending, 'path' | 'etag'>,
): Promise<string | null> {
  try {
    const result = await confirmConfigChange(await createClient(connection), pending.path, pending.etag);
    return result.confirmed ? null : STALE_CONFIRM;
  } catch (cause) {
    return reasonOf(cause);
  }
}

function ConfirmButton({
  state,
  onConfirm,
  name,
}: {
  readonly state: ConfirmState;
  readonly onConfirm: () => void;
  readonly name: string;
}) {
  return (
    <>
      <Button
        type="button"
        variant="primary"
        className="min-h-[44px]"
        data-config-confirm={name}
        disabled={state.status === 'busy'}
        onClick={onConfirm}
      >
        {state.status === 'busy' ? 'Confirming…' : 'Confirm'}
      </Button>
      {state.status === 'failed' ? (
        <span
          role="alert"
          className="min-w-0 break-words text-cell leading-base text-err"
          data-config-confirm-failed=""
        >
          {state.sentence}
        </span>
      ) : null}
    </>
  );
}

function PendingRow({
  pending,
  state,
  onConfirm,
  onReview,
}: {
  readonly pending: ConfigPending;
  readonly state: ConfirmState;
  readonly onConfirm: () => void;
  readonly onReview: () => void;
}) {
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0"
      data-config-pending={pending.path}
    >
      <PanelPath value={pending.path} className="text-ui font-semibold text-fg" />
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
        {pending.changes.map(change => (
          <li key={change} className="break-words text-ui leading-base text-fg">
            {change}
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ConfirmButton state={state} onConfirm={onConfirm} name={pending.path} />
        <Button type="button" className="min-h-[44px]" data-config-review={pending.path} onClick={onReview}>
          Review
        </Button>
      </div>
    </li>
  );
}

function FileRow({
  file,
  directory,
  write,
  onEdit,
}: {
  readonly file: ConfigFileSummary;
  readonly directory: string;
  readonly write: ClipboardWriter;
  readonly onEdit: () => void;
}) {
  const chip = STATE_CHIPS[file.state];
  const absolute = absoluteConfigPath(directory, file.path);
  return (
    <li
      className="flex min-w-0 flex-col gap-1 border-t border-border py-2 first:border-t-0 first:pt-0 last:pb-0"
      data-config-file={file.path}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <PanelPath value={file.path} className="min-w-0 text-ui font-semibold text-fg" />
        <Badge tone={chip.tone} data-config-file-state={file.state}>
          {chip.label}
        </Badge>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <PanelPath value={absolute} className="min-w-0 text-meta text-muted" label="Full path" />
        <CopyButton text={absolute} label={`Copy the full path of ${file.path}`} write={write} />
      </div>
      <div>
        <Button type="button" size="sm" data-config-edit={file.path} onClick={onEdit}>
          Edit as YAML
        </Button>
      </div>
    </li>
  );
}

/** The loaded panel, apart from the reads, so every state it shows can be rendered from plain values. */
export function ConfigFilesPanel({
  view,
  write,
  confirming,
  onConfirm,
  onEdit,
}: {
  readonly view: ConfigStatusView;
  readonly write: ClipboardWriter;
  /** Each held edit's confirmation, by path. */
  readonly confirming: Readonly<Record<string, ConfirmState>>;
  readonly onConfirm: (pending: ConfigPending) => void;
  readonly onEdit: (path: string) => void;
}) {
  const groups = CONFIG_FILE_KINDS.map(kind => ({
    kind,
    files: view.files.filter(file => file.kind === kind),
  })).filter(group => group.files.length > 0);
  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-3 p-panel"
      aria-labelledby="config-files-heading"
      data-config-files-panel=""
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id="config-files-heading" className="m-0 flex items-center gap-2 text-row font-semibold text-fg">
          <FileCode2 size={16} aria-hidden="true" className="shrink-0 text-accent" />
          {CONFIG_HEADLINE}
        </h3>
        <div className="flex min-w-0 items-center gap-1">
          <PanelPath value={view.directory} className="min-w-0 text-cell text-fg" label="Configuration directory" />
          <CopyButton text={view.directory} label="Copy the configuration directory" write={write} />
        </div>
        <p className="m-0 text-cell leading-base text-muted" data-config-summary="">
          {configSummaryWords(view)}
        </p>
      </div>

      {view.pending.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2" data-config-section="pending">
          <h4 className="m-0 text-ui font-semibold text-fg">Waiting for you</h4>
          <p className="m-0 text-cell leading-base text-muted">
            These edits loosen what this machine allows, so the earlier version stays in effect until you confirm.
          </p>
          <ul className="m-0 list-none p-0">
            {view.pending.map(pending => (
              <PendingRow
                key={pending.path}
                pending={pending}
                state={confirming[pending.path] ?? IDLE}
                onConfirm={() => onConfirm(pending)}
                onReview={() => onEdit(pending.path)}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {view.issues.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2" data-config-section="issues">
          <h4 className="m-0 text-ui font-semibold text-fg">Problems</h4>
          <ConfigIssueList issues={view.issues} />
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col gap-3" data-config-section="files">
        {groups.length === 0 ? (
          <p className="m-0 text-cell leading-base text-muted" data-config-files-empty="">
            No configuration files yet. A file appears here once this machine is set up.
          </p>
        ) : (
          groups.map(group => (
            <div key={group.kind} className="flex min-w-0 flex-col gap-1" data-config-group={group.kind}>
              <h4 className="m-0 text-ui font-semibold text-fg">{CONFIG_KIND_WORDS[group.kind]}</h4>
              <ul className="m-0 list-none p-0">
                {group.files.map(file => (
                  <FileRow
                    key={file.path}
                    file={file}
                    directory={view.directory}
                    write={write}
                    onEdit={() => onEdit(file.path)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/** Where the editor's file read stands. */
type EditorLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly file: ConfigFileView }
  | { readonly status: 'failed'; readonly sentence: string };

/** What the last save came to. */
type SaveState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'applied' }
  | { readonly status: 'pending'; readonly pending: Pick<ConfigPending, 'path' | 'etag' | 'changes'> }
  | { readonly status: 'invalid'; readonly issues: readonly ConfigIssue[]; readonly sentence: string }
  | { readonly status: 'conflict' }
  | { readonly status: 'failed'; readonly sentence: string };

export const CONFLICT_SENTENCE =
  'This file changed on the machine since you opened it, so nothing was saved. Reload to edit the newer version.';

/** A save's result as the editor's next state. */
const savedState = (result: ConfigFilePutResult): SaveState =>
  result.outcome === 'pending'
    ? {
        status: 'pending',
        pending: result.pending ?? {
          path: result.path,
          etag: result.etag,
          changes: ['it loosens what this machine allows'],
        },
      }
    : { status: 'applied' };

/** A refused save as the editor's next state. */
const refusedState = (cause: unknown): SaveState => {
  const invalid = configInvalidBody(cause);
  if (invalid !== undefined) return { status: 'invalid', issues: invalid.issues, sentence: invalid.error };
  const code = configErrorCode(cause);
  if (code === 'config_invalid') return { status: 'invalid', issues: [], sentence: reasonOf(cause) };
  if (code === 'config_conflict') return { status: 'conflict' };
  return { status: 'failed', sentence: reasonOf(cause) };
};

export function ConfigFileEditor({
  connection,
  createClient,
  path,
  onClose,
  onChanged,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: ConfigFilesClientFactory;
  readonly path: string;
  readonly onClose: () => void;
  /** The machine's files changed: the panel reads its status again. */
  readonly onChanged: () => void;
}) {
  const headingId = useId();
  const editorId = useId();
  const noteId = useId();
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' });
  const [draft, setDraft] = useState('');
  const [etag, setEtag] = useState('');
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  const [confirm, setConfirm] = useState<ConfirmState>(IDLE);
  const [reads, setReads] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the Reload trigger
  useEffect(() => {
    let current = true;
    setLoad({ status: 'loading' });
    void createClient(connection)
      .then(async client => await readConfigFile(client, path))
      .then(file => {
        if (!current) return;
        setLoad({ status: 'ready', file });
        setDraft(file.text);
        setEtag(file.etag);
        setSave({ status: 'idle' });
      })
      .catch((cause: unknown) => {
        if (current) setLoad({ status: 'failed', sentence: reasonOf(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, path, reads]);

  // Changed on the machine — a hand edit, `fy`, another device — and read again in place, unless the
  // person has started editing: their draft stays, and saving it says the file moved under them.
  useConfigChangeEffect(connection.daemonId, ['files'], () => {
    if (load.status !== 'ready' || draft !== load.file.text) return;
    void createClient(connection)
      .then(async client => await readConfigFile(client, path))
      .then(file => {
        setLoad({ status: 'ready', file });
        setDraft(file.text);
        setEtag(file.etag);
      })
      .catch(() => undefined);
  });

  const submit = (): void => {
    setSave({ status: 'saving' });
    setConfirm(IDLE);
    void createClient(connection)
      .then(async client => await writeConfigFile(client, path, draft, etag))
      .then(result => {
        setEtag(result.etag);
        setSave(savedState(result));
        onChanged();
      })
      .catch((cause: unknown) => setSave(refusedState(cause)));
  };

  const confirmSaved = (pending: Pick<ConfigPending, 'path' | 'etag'>): void => {
    setConfirm({ status: 'busy' });
    void confirmHeld(createClient, connection, pending).then(sentence => {
      if (sentence !== null) {
        setConfirm({ status: 'failed', sentence });
        return;
      }
      setConfirm(IDLE);
      setSave({ status: 'applied' });
      onChanged();
    });
  };

  const fileIssues = load.status === 'ready' ? load.file.issues : [];
  const shownIssues = save.status === 'invalid' ? save.issues : save.status === 'idle' ? fileIssues : [];
  const saving = save.status === 'saving';

  return (
    <BottomSheet
      id="config-file-editor"
      open
      onClose={onClose}
      labelledBy={headingId}
      closeLabel="Close the editor"
      panelClassName="kt-details bg-surface"
      maxHeight="min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border px-panel pb-row-y" data-config-editor={path}>
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-1">
          <h2 id={headingId} className="m-0 flex items-center gap-2 font-display text-title font-semibold text-fg">
            <FileCode2 size={16} aria-hidden="true" className="shrink-0 text-accent" />
            Edit as YAML
          </h2>
          <PanelPath
            value={load.status === 'ready' ? load.file.absolutePath : path}
            className="text-cell text-muted"
            label="File"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-4">
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-3 py-3">
          {load.status === 'loading' ? (
            <p role="status" className="m-0 text-cell text-muted">
              Reading {path}…
            </p>
          ) : null}
          {load.status === 'failed' ? (
            <p role="alert" className="m-0 text-cell leading-base text-err" data-config-editor-failed="">
              {path} could not be read. {load.sentence}
            </p>
          ) : null}
          {load.status === 'ready' ? (
            <>
              <label htmlFor={editorId} className="sr-only">
                {path}
              </label>
              <textarea
                id={editorId}
                aria-describedby={noteId}
                // `!` because `.kt-input` sets its own min-height, which left the editor two lines tall on a phone.
                className="kt-input !min-h-[16rem] w-full shrink-0 resize-y whitespace-pre font-mono text-cell leading-base"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                disabled={saving}
                value={draft}
                data-config-editor-text=""
                onChange={event => {
                  setDraft(event.target.value);
                  // An edit makes the last answer stale; the box is disabled while a save is in flight.
                  setSave({ status: 'idle' });
                }}
              />
              <p id={noteId} className="m-0 text-meta leading-base text-muted" data-config-secret-note="">
                Never paste a key here: store it with <code className="font-mono text-fg">{CONFIG_SECRET_COMMAND}</code>{' '}
                and write <code className="font-mono text-fg">{CONFIG_SECRET_REFERENCE}</code>.
              </p>
              {save.status === 'invalid' ? (
                <p role="alert" className="m-0 text-ui leading-base text-err" data-config-save="invalid">
                  {save.sentence}
                </p>
              ) : null}
              {shownIssues.length > 0 ? <ConfigIssueList issues={shownIssues} /> : null}
              {save.status === 'conflict' ? (
                <div
                  role="alert"
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2"
                  data-config-save="conflict"
                >
                  <span className="min-w-0 flex-1 text-ui leading-base text-warn">{CONFLICT_SENTENCE}</span>
                  <Button
                    type="button"
                    className="min-h-[44px]"
                    data-config-reload=""
                    onClick={() => setReads(reads + 1)}
                  >
                    Reload
                  </Button>
                </div>
              ) : null}
              {save.status === 'failed' ? (
                <p role="alert" className="m-0 text-ui leading-base text-err" data-config-save="failed">
                  Nothing was saved. {save.sentence}
                </p>
              ) : null}
              {save.status === 'applied' ? (
                <p role="status" className="m-0 text-ui font-semibold leading-base text-ok" data-config-save="applied">
                  In effect
                </p>
              ) : null}
              {save.status === 'pending' ? (
                <div
                  role="status"
                  className="flex min-w-0 flex-col gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2"
                  data-config-save="pending"
                >
                  <span className="text-ui leading-base text-fg">
                    Saved — waiting for your confirmation: {save.pending.changes.join('; ')}
                  </span>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <ConfirmButton state={confirm} name={path} onConfirm={() => confirmSaved(save.pending)} />
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
          <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
            <Button type="button" className="min-h-[44px]" data-config-cancel="" onClick={onClose}>
              {save.status === 'applied' || save.status === 'pending' ? 'Close' : 'Cancel'}
            </Button>
            <Button
              type="button"
              variant="primary"
              className="min-h-[44px]"
              data-config-submit=""
              disabled={load.status !== 'ready' || saving}
              onClick={submit}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </BottomSheet>
  );
}

type StatusLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: ConfigStatusView }
  | { readonly status: 'failed'; readonly sentence: string };

export function ConfigFilesSurface({
  connection,
  createClient,
  write = browserClipboardWriter(),
}: {
  readonly connection: DaemonConnection;
  readonly createClient: ConfigFilesClientFactory;
  readonly write?: ClipboardWriter;
}) {
  const [load, setLoad] = useState<StatusLoad>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Readonly<Record<string, ConfirmState>>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the re-read trigger
  useEffect(() => {
    let current = true;
    void createClient(connection)
      .then(async client => await readConfigStatus(client))
      .then(view => {
        if (current) setLoad({ status: 'ready', view });
      })
      .catch((cause: unknown) => {
        if (current) setLoad({ status: 'failed', sentence: reasonOf(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, reads]);

  const reread = useCallback(() => setReads(count => count + 1), []);
  // What is in effect, what is broken and what waits — read again whenever any file moved, from anywhere.
  useConfigChangeEffect(connection.daemonId, ['files'], reread);

  const confirmPending = (pending: ConfigPending): void => {
    const mark = (state: ConfirmState): void => setConfirming(previous => ({ ...previous, [pending.path]: state }));
    mark({ status: 'busy' });
    void confirmHeld(createClient, connection, pending).then(sentence => {
      mark(sentence === null ? IDLE : { status: 'failed', sentence });
      if (sentence === null) reread();
    });
  };

  return (
    <>
      {load.status === 'ready' ? (
        <ConfigFilesPanel
          view={load.view}
          write={write}
          confirming={confirming}
          onConfirm={confirmPending}
          onEdit={setEditing}
        />
      ) : null}
      {load.status === 'failed' ? (
        <section className="kt-panel p-panel" role="alert" data-config-files-failed="">
          <h3 className="m-0 flex items-center gap-2 text-row font-semibold text-fg">
            <CircleAlert size={16} aria-hidden="true" className="text-err" />
            This machine’s configuration files could not be read
          </h3>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">{load.sentence}</p>
          <Button type="button" className="mt-2 min-h-[44px]" data-config-files-retry="" onClick={reread}>
            Try again
          </Button>
        </section>
      ) : null}
      {load.status === 'loading' ? (
        <section className="kt-panel p-panel" role="status" aria-label="Reading the configuration files">
          <p className="m-0 text-cell leading-base text-muted">Reading this machine’s configuration files…</p>
        </section>
      ) : null}
      {editing === null ? null : (
        <ConfigFileEditor
          key={editing}
          connection={connection}
          createClient={createClient}
          path={editing}
          onClose={() => setEditing(null)}
          onChanged={reread}
        />
      )}
    </>
  );
}

/** The Settings panel, for the composition root's `daemonSettingsTabs`, bound to the app's client pool. */
export const configFilesSettingsTab = (createClient: ConfigFilesClientFactory) =>
  ({
    id: 'files',
    label: 'Files',
    description: 'The YAML files this machine’s settings live in.',
    // Keyed by machine, so switching machines starts the panel over rather than showing one machine's
    // files, or an editor open on them, under another's name.
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <ConfigFilesSurface key={connection.daemonId} connection={connection} createClient={createClient} />
    ),
  }) as const;
