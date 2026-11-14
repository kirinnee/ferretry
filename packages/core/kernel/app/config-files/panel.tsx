/**
 * SETTINGS › FILES: the YAML files this machine's settings live in (docs/config-files.md; today's
 * `config-files-settings.tsx`).
 *
 * The files are the source of truth, and this panel is one of their editors — beside `fy`, a text editor on the machine,
 * and an agent holding the `config_*` tools. It reads, for ONE machine:
 *
 * - **where the files are**, as an absolute path a person can copy and open there;
 * - **what is waiting for you** — an edit that loosens what the machine may spend or what its agents may do is held,
 *   with the tighter version in effect, until the owner confirms it (a passkey, from another device, is raised by the
 *   shell around the call);
 * - **what is wrong**, each issue located (`path:line:col`) with its plain fix;
 * - **every file**, grouped by what it configures, each with its state and "Edit as YAML".
 *
 * NO SECRET IS EVER ON THIS SCREEN: a file holds `${secret:NAME}` references and the daemon never returns a value.
 */
import {
  Badge,
  type BadgeTone,
  browserClipboardWriter,
  Button,
  type ClipboardWriter,
  CopyButton,
  PanelPath,
} from '@ferretry/app/ui';
import { CircleAlert, FileCode2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { KernelClient } from '../lib/client.ts';
import {
  type ConfigFileState,
  type ConfigPending,
  type ConfigStatusView,
  confirmHeld,
  readConfigStatus,
  reasonOf,
} from './api.ts';
import { ConfigIssueList } from './config-issue-list.tsx';
import { ConfirmButton, type ConfirmState, IDLE } from './confirm-button.tsx';
import { ConfigFileEditor } from './editor.tsx';
import { useConfigChanges } from './use-config-changes.ts';

/** What each plugin's files are called as the group a person looks for them under (today's per-kind words). */
const GROUP_WORDS: Readonly<Record<string, string>> = {
  kernel: 'Machine',
  logins: 'AI logins',
  runtimes: 'Runtimes',
  accounts: 'Default accounts',
  warden: 'Warden',
  lessons: 'Learning',
  voice: 'Voice',
  packs: 'Pack mode',
  ferrets: 'Ferret limits',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  mcp: 'MCP servers',
  skills: 'Skills',
  usage: 'Usage and pricing',
  browsers: 'Browser',
  access: 'Devices and access',
};

/** A group's heading: today's word for it, else the plugin's id as words. */
export const groupWords = (kind: string): string =>
  GROUP_WORDS[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1).replace(/-/gu, ' ')}`;

const STATE_CHIPS: Readonly<Record<ConfigFileState, { readonly label: string; readonly tone: BadgeTone }>> = {
  ok: { label: 'OK', tone: 'ok' },
  invalid: { label: 'Invalid — last good in effect', tone: 'err' },
  pending: { label: 'Waiting', tone: 'warn' },
};

const CONFIG_HEADLINE = 'These settings live in files on this machine';

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

/** "N files · M with errors · K waiting for you". */
export const configSummaryWords = (view: ConfigStatusView): string => {
  const broken = new Set(view.issues.filter(issue => issue.severity === 'error').map(issue => issue.path)).size;
  return `${plural(view.files.length, 'file')} · ${String(broken)} with errors · ${String(view.pending.length)} waiting for you`;
};

/** Joins a file's path onto the config directory, for "Open file path". */
const absoluteConfigPath = (directory: string, path: string): string => `${directory.replace(/\/+$/u, '')}/${path}`;

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
  readonly file: ConfigStatusView['files'][number];
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
        {/* One line cut with an ellipsis rather than a box that scrolls: the whole path is in the title, the copy button and the DOM text, so a screen reader reads it all
         */}
        <code
          className="min-w-0 flex-1 truncate font-mono text-meta text-muted"
          title={absolute}
          data-config-file-path=""
        >
          {absolute}
        </code>
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
  const kinds = [...new Set(view.files.map(file => file.kind))].sort((a, b) =>
    groupWords(a).localeCompare(groupWords(b)),
  );
  const groups = kinds.map(kind => ({ kind, files: view.files.filter(file => file.kind === kind) }));
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
              <h4 className="m-0 text-ui font-semibold text-fg">{groupWords(group.kind)}</h4>
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

type StatusLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: ConfigStatusView }
  | { readonly status: 'failed'; readonly sentence: string };

/** Settings › Files for one daemon: the status read, kept fresh, and the editor sheet over it. */
export function ConfigFilesSurface({
  client,
  write = browserClipboardWriter(),
}: {
  readonly client: KernelClient;
  readonly write?: ClipboardWriter;
}) {
  const [load, setLoad] = useState<StatusLoad>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Readonly<Record<string, ConfirmState>>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the re-read trigger
  useEffect(() => {
    let current = true;
    readConfigStatus(client).then(
      view => {
        if (current) setLoad({ status: 'ready', view });
      },
      (cause: unknown) => {
        if (current) setLoad({ status: 'failed', sentence: reasonOf(cause) });
      },
    );
    return () => {
      current = false;
    };
  }, [client, reads]);

  const reread = useCallback(() => setReads(count => count + 1), []);
  // What is in effect, what is broken and what waits — read again whenever any file moved, from anywhere.
  useConfigChanges(client, reread);

  const confirmPending = (pending: ConfigPending): void => {
    const mark = (state: ConfirmState): void => setConfirming(previous => ({ ...previous, [pending.path]: state }));
    mark({ status: 'busy' });
    void confirmHeld(client, pending).then(sentence => {
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
          client={client}
          path={editing}
          onClose={() => setEditing(null)}
          onChanged={reread}
        />
      )}
    </>
  );
}
