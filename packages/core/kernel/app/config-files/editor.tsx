/**
 * EDIT AS YAML: one configuration file in a sheet (today's `ConfigFileEditor`, Settings › Files).
 *
 * ## NO SECRET IS EVER ON THIS SCREEN
 *
 * A file holds `${secret:NAME}` references, never a value, and the daemon never returns one. The editor says so under
 * the text, because the one way a key ends up in a file is somebody pasting it there; the kernel refuses it anyway.
 *
 * ## AN EDIT IS MADE AGAINST WHAT WAS READ
 *
 * A save carries the etag of the text it was edited from. If the file changed on the machine since, the save is
 * refused and the editor offers to reload — it never silently overwrites somebody else's edit, and never silently drops
 * this one. An edit that loosens what the machine allows is saved and HELD for the owner; Confirm asks the kernel to put
 * it into effect.
 */
import { BottomSheet, Button, PanelPath } from '@ferretry/app/ui';
import { FileCode2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { KernelClient } from '../lib/client.ts';
import {
  type ConfigFilePutResult,
  type ConfigFileView,
  type ConfigIssue,
  type ConfigPending,
  configErrorCode,
  configInvalidBody,
  confirmHeld,
  readConfigFile,
  reasonOf,
  writeConfigFile,
} from './api.ts';
import { ConfigIssueList } from './config-issue-list.tsx';
import { ConfirmButton, type ConfirmState, IDLE } from './confirm-button.tsx';
import { useConfigChanges } from './use-config-changes.ts';

/** The command that stores a key, and the reference a file names it by — each shown as code. */
const CONFIG_SECRET_COMMAND = 'fy secret set NAME';
// biome-ignore lint/suspicious/noTemplateCurlyInString: the reference grammar, written out for a person to type
const CONFIG_SECRET_REFERENCE = '${secret:NAME}';

const CONFLICT_SENTENCE =
  'This file changed on the machine since you opened it, so nothing was saved. Reload to edit the newer version.';

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
  client,
  path,
  onClose,
  onChanged,
}: {
  readonly client: KernelClient;
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
    readConfigFile(client, path).then(
      file => {
        if (!current) return;
        setLoad({ status: 'ready', file });
        setDraft(file.text);
        setEtag(file.etag);
        setSave({ status: 'idle' });
      },
      (cause: unknown) => {
        if (current) setLoad({ status: 'failed', sentence: reasonOf(cause) });
      },
    );
    return () => {
      current = false;
    };
  }, [client, path, reads]);

  // Changed on the machine — a hand edit, `fy`, another device — and read again in place, unless the person has started
  // editing: their draft stays, and saving it says the file moved under them.
  useConfigChanges(
    client,
    () => {
      if (load.status !== 'ready' || draft !== load.file.text) return;
      readConfigFile(client, path).then(
        file => {
          setLoad({ status: 'ready', file });
          setDraft(file.text);
          setEtag(file.etag);
        },
        () => undefined,
      );
    },
    path,
  );

  const submit = (): void => {
    setSave({ status: 'saving' });
    setConfirm(IDLE);
    writeConfigFile(client, path, draft, etag).then(
      result => {
        setEtag(result.etag);
        setSave(savedState(result));
        onChanged();
      },
      (cause: unknown) => setSave(refusedState(cause)),
    );
  };

  const confirmSaved = (pending: Pick<ConfigPending, 'path' | 'etag'>): void => {
    setConfirm({ status: 'busy' });
    void confirmHeld(client, pending).then(sentence => {
      if (sentence !== null) {
        setConfirm({ status: 'failed', sentence });
        return;
      }
      setConfirm(IDLE);
      setSave({ status: 'applied' });
      onChanged();
    });
  };

  const fileIssues = load.status === 'ready' ? (load.file.issues ?? []) : [];
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
            value={load.status === 'ready' ? (load.file.absolutePath ?? path) : path}
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
        </div>
      </div>
      {/* Pinned under the scroller, never inside it: a tall issue list or a short window scrolls the text, and Cancel
          and Save stay in view. */}
      <div className="shrink-0 border-t border-border bg-surface px-panel py-3" data-config-editor-actions="">
        <div className="mx-auto w-full max-w-3xl min-w-0">
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
