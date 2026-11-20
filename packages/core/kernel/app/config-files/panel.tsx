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
import { SettingGroup, SettingRow } from '@ferretry/app';
import './files.css';
import {
  Badge,
  type BadgeTone,
  browserClipboardWriter,
  Button,
  type ClipboardWriter,
  CopyButton,
  Loading,
  PanelPath,
} from '@ferretry/app/ui';
import { CircleAlert, FileCode2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
    <SettingRow
      name={pending.path}
      wide
      dataAttributes={{ 'data-config-pending': pending.path }}
      control={() => (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <ConfirmButton state={state} onConfirm={onConfirm} name={pending.path} />
          <Button type="button" className="min-h-[44px]" data-config-review={pending.path} onClick={onReview}>
            Review
          </Button>
        </span>
      )}
    >
      <ul className="m-0 flex list-disc flex-col gap-0.5 pb-3 pl-8 pr-panel">
        {pending.changes.map(change => (
          <li key={change} className="break-words text-ui leading-base text-fg">
            {change}
          </li>
        ))}
      </ul>
    </SettingRow>
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
    <SettingRow
      name={file.path}
      wide
      dataAttributes={{ 'data-config-file': file.path }}
      // The whole path, wrapped at any character (a path has no spaces) rather than cut: it stays selectable, and it is in
      // the title and beside the copy button too.
      hint={
        <code className="block break-all font-mono" title={absolute} data-config-file-path="">
          {absolute}
        </code>
      }
      control={() => (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge className="max-w-full whitespace-normal" tone={chip.tone} data-config-file-state={file.state}>
            {chip.label}
          </Badge>
          <Button type="button" size="sm" className="min-h-[44px]" data-config-edit={file.path} onClick={onEdit}>
            Edit as YAML
          </Button>
          <CopyButton text={absolute} label={`Copy the full path of ${file.path}`} write={write} />
        </span>
      )}
    />
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
    <section className="flex min-w-0 flex-col" aria-labelledby="config-files-heading" data-config-files-panel="">
      <div className="mb-6 flex min-w-0 flex-col gap-1">
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
        <div data-config-section="pending">
          <SettingGroup label="Waiting for you">
            <li className="px-panel py-2 text-cell leading-base text-muted">
              These edits loosen what this machine allows, so the earlier version stays in effect until you confirm.
            </li>
            {view.pending.map(pending => (
              <PendingRow
                key={pending.path}
                pending={pending}
                state={confirming[pending.path] ?? IDLE}
                onConfirm={() => onConfirm(pending)}
                onReview={() => onEdit(pending.path)}
              />
            ))}
          </SettingGroup>
        </div>
      ) : null}

      {view.issues.length > 0 ? (
        <div data-config-section="issues">
          <SettingGroup label="Problems">
            <li className="min-w-0 px-panel">
              <ConfigIssueList issues={view.issues} />
            </li>
          </SettingGroup>
        </div>
      ) : null}

      <div data-config-section="files">
        {groups.length === 0 ? (
          <p className="m-0 text-cell leading-base text-muted" data-config-files-empty="">
            No configuration files yet. A file appears here once this machine is set up.
          </p>
        ) : (
          groups.map(group => (
            <div key={group.kind} data-config-group={group.kind}>
              <SettingGroup label={groupWords(group.kind)}>
                {group.files.map(file => (
                  <FileRow
                    key={file.path}
                    file={file}
                    directory={view.directory}
                    write={write}
                    onEdit={() => onEdit(file.path)}
                  />
                ))}
              </SettingGroup>
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
  // Set by the "Try again" press and spent by the read it causes: that read is the person's, so it may ask for the
  // passkey again after a Cancel; a read the page makes by itself never does.
  const pressed = useRef(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Readonly<Record<string, ConfirmState>>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the re-read trigger
  useEffect(() => {
    let current = true;
    const press = pressed.current;
    pressed.current = false;
    readConfigStatus(client, press).then(
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
  const tryAgain = useCallback(() => {
    pressed.current = true;
    reread();
  }, [reread]);
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
          <Button type="button" className="mt-2 min-h-[44px]" data-config-files-retry="" onClick={tryAgain}>
            Try again
          </Button>
        </section>
      ) : null}
      {load.status === 'loading' ? <Loading kind="bar" label="Reading this machine’s configuration files…" /> : null}
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
