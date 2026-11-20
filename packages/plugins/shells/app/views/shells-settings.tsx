/** The `shells` Settings tab: nix on this machine, the shells and their build state, and adding one on the owner's yes. */

import type { PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { NixFacts, ShellName, ShellPreview, ShellSummary } from '../../contract/index.ts';
import { type AddDraft, addRequestOf, BUILD_TONES, BUILD_WORDS, EMPTY_DRAFT, shellLine } from '../lib/shells-model.ts';
import { type ShellsClient, shellsClient } from '../lib/shells-client.ts';
import { Loading } from '@ferretry/app/ui';
import './shells-settings.css';
import { Badge, Button, SettingGroup, SettingRow, SettingSwitch } from '../ui.ts';

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createShellsSettings(client: PluginClient) {
  return function ShellsSettings(_props: SettingsProps) {
    const shells = useMemo(() => shellsClient(client), []);
    return <ShellsTab shells={shells} />;
  };
}

function ShellsTab({ shells }: { readonly shells: ShellsClient }) {
  const [nix, setNix] = useState<NixFacts | undefined>();
  const [list, setList] = useState<readonly ShellSummary[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [draft, setDraft] = useState<AddDraft>(EMPTY_DRAFT);
  const [preview, setPreview] = useState<ShellPreview | undefined>();
  const [relocking, setRelocking] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const [facts, rows] = await Promise.all([shells.nix(), shells.list()]);
      setNix(facts);
      setList(rows);
      setError(undefined);
    } catch (failure) {
      setError(said(failure));
    }
  }, [shells]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (what: string, run: () => Promise<void>): Promise<void> => {
    setBusy(what);
    setError(undefined);
    try {
      await run();
      await load();
    } catch (failure) {
      setError(said(failure));
    } finally {
      setBusy(undefined);
    }
  };

  const built = (name: ShellName) => act(`build:${name}`, async () => void (await shells.build(name)));
  const removed = (name: ShellName) => act(`remove:${name}`, () => shells.remove(name));
  const lookedAgain = (name: ShellName) =>
    act(`look:${name}`, async () => {
      const detail = await shells.detail(name);
      setPreview(await shells.preview({ name, item: detail.item }));
      setRelocking(true);
      setNote(undefined);
    });
  const relocked = () =>
    act('relock', async () => {
      if (preview === undefined) return;
      const lock = preview.lock;
      await shells.relock(
        preview.name,
        lock.source.kind === 'flake' ? lock.source.narHash : lock.source.nixpkgs.narHash,
      );
      setNote(`Re-locked ${preview.name}.`);
      setPreview(undefined);
      setRelocking(false);
    });

  const request = addRequestOf(draft);
  const looked = () =>
    act('preview', async () => {
      if (!request.ok) throw new Error(request.why);
      setPreview(await shells.preview(request.request));
      setRelocking(false);
      setNote(undefined);
    });
  const added = () =>
    act('add', async () => {
      if (!request.ok) throw new Error(request.why);
      const done = await shells.add(request.request);
      setPreview(undefined);
      setDraft(EMPTY_DRAFT);
      setNote(
        done.held === undefined
          ? `Added ${done.name}.`
          : `Added ${done.name}. It waits for your yes before it can run: ${done.held.join(' ')}`,
      );
    });

  const input = 'kt-input min-h-[44px] w-full min-w-0 max-w-[28rem]';
  return (
    <section data-testid="shells-settings" className="fy-sh flex min-w-0 flex-col">
      <p className="m-0 mb-3 text-ui text-muted">
        Each ferret works in its own set of tools, a nix shell, built once and cached.
      </p>

      {error !== undefined && (
        <p role="alert" data-testid="shells-error" className="m-0 mb-3 text-meta text-err">
          {error}
        </p>
      )}

      {nix !== undefined && <NixLine facts={nix} />}

      <SettingGroup label="Shells">
        <>
          {list === undefined && error === undefined && <Loading kind="bar" label="Loading shells…" />}
          {list?.length === 0 && <SettingRow name="No shells yet." hint="Ferrets use the machine's tools." />}
          {list?.map(shell => (
            <li key={shell.name} className="min-w-0" data-setting-row={shell.name} data-shell={shell.name}>
              <div className="fy-sh-row">
                <span className="fy-sh-text">
                  <span className="fy-sh-name">
                    <span className="text-ui font-semibold text-fg">{shell.name}</span>
                    <Badge tone={BUILD_TONES[shell.build]}>{BUILD_WORDS[shell.build]}</Badge>
                  </span>
                  {/* The whole line: it wraps, it is never cut by an ellipsis. */}
                  <span className="break-words text-meta leading-tight text-muted">{shellLine(shell)}</span>
                  {shell.description === undefined ? null : (
                    <span className="break-words text-meta leading-tight text-muted">{shell.description}</span>
                  )}
                </span>
                <span className="fy-sh-acts">
                  <Button size="sm" disabled={busy !== undefined} onClick={() => void built(shell.name)}>
                    Build
                  </Button>
                  <Button size="sm" disabled={busy !== undefined} onClick={() => void lookedAgain(shell.name)}>
                    Resolve again
                  </Button>
                  <Button size="sm" disabled={busy !== undefined} onClick={() => void removed(shell.name)}>
                    Remove
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </>
      </SettingGroup>

      <form
        data-testid="shells-add"
        className="min-w-0"
        onSubmit={event => {
          event.preventDefault();
          void looked();
        }}
      >
        <SettingGroup label="Add a shell">
          <FieldRow name="Name">
            {labelId => (
              <input
                aria-labelledby={labelId}
                className={input}
                value={draft.name}
                onChange={event => setDraft({ ...draft, name: event.target.value })}
              />
            )}
          </FieldRow>
          <FieldRow name="Made from">
            {labelId => (
              <select
                aria-labelledby={labelId}
                className={input}
                value={draft.kind}
                onChange={event => setDraft({ ...draft, kind: event.target.value === 'flake' ? 'flake' : 'packages' })}
              >
                <option value="packages">A package list</option>
                <option value="flake">A flake reference</option>
              </select>
            )}
          </FieldRow>
          <FieldRow name={draft.kind === 'flake' ? 'Flake reference' : 'Packages'}>
            {labelId => (
              <input
                aria-labelledby={labelId}
                className={input}
                value={draft.source}
                onChange={event => setDraft({ ...draft, source: event.target.value })}
              />
            )}
          </FieldRow>
          {draft.kind === 'flake' && (
            <FieldRow name="Floating" hint="Ask me again whenever it resolves differently">
              {labelId => (
                <SettingSwitch
                  checked={draft.floating}
                  labelledBy={labelId}
                  onChange={floating => setDraft({ ...draft, floating })}
                />
              )}
            </FieldRow>
          )}
          <FieldRow name="Look before adding" hint="Resolves it and shows what it locks to.">
            {() => (
              <Button type="submit" variant="primary" disabled={busy !== undefined}>
                Resolve and look
              </Button>
            )}
          </FieldRow>
        </SettingGroup>
      </form>

      {preview !== undefined && (
        <div
          data-testid="shells-preview"
          className="mb-8 flex flex-col gap-2 border-y border-border px-1 py-3 text-ui text-fg"
        >
          <p className="m-0">
            <strong>{preview.name}</strong> resolves to{' '}
            <code className="break-all">
              {preview.lock.source.kind === 'flake' ? preview.lock.source.narHash : preview.lock.source.nixpkgs.narHash}
            </code>
            .
          </p>
          {preview.changedFrom !== undefined && (
            <p className="m-0">
              That is different from the last lock ({preview.changedFrom}); it needs your yes again.
            </p>
          )}
          <div>
            <Button
              variant="primary"
              disabled={busy !== undefined}
              onClick={() => void (relocking ? relocked() : added())}
            >
              {relocking ? 'Re-lock it' : 'Add it'}
            </Button>
          </div>
        </div>
      )}

      {note !== undefined && (
        <p data-testid="shells-note" className="m-0 text-ui text-fg">
          {note}
        </p>
      )}
    </section>
  );
}

/** One label-and-control row of the add form: the label above the control on a narrow panel, beside it on a wide one. */
function FieldRow({
  name,
  hint,
  children,
}: {
  readonly name: string;
  readonly hint?: string;
  readonly children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  return (
    <li className="min-w-0" data-setting-row={name}>
      <div className="fy-sh-field">
        <span className="fy-sh-label">
          <span id={labelId} className="text-ui font-semibold text-fg">
            {name}
          </span>
          {hint === undefined ? null : <span className="text-meta leading-tight text-muted">{hint}</span>}
        </span>
        <span className="fy-sh-control">{children(labelId)}</span>
      </div>
    </li>
  );
}

function NixLine({ facts }: { readonly facts: NixFacts }) {
  if (facts.present)
    return (
      <p data-testid="shells-nix" className="m-0 mb-6 text-ui text-muted">
        Nix {facts.version} is on this machine.
      </p>
    );
  return (
    <p data-testid="shells-nix" role="status" className="m-0 mb-6 text-ui text-warn">
      Nix is not on this machine. {facts.consequence} {facts.remedy}
    </p>
  );
}
