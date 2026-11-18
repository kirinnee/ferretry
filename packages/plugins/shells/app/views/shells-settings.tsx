/** The `shells` Settings tab: nix on this machine, the shells and their build state, and adding one on the owner's yes. */

import type { PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NixFacts, ShellName, ShellPreview, ShellSummary } from '../../contract/index.ts';
import { type AddDraft, addRequestOf, BUILD_TONES, BUILD_WORDS, EMPTY_DRAFT, shellLine } from '../lib/shells-model.ts';
import { type ShellsClient, shellsClient } from '../lib/shells-client.ts';
import { Loading } from '@ferretry/app/ui';
import { Badge, Button, SettingGroup, SettingRow } from '../ui.ts';

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

  const field = 'flex min-w-0 flex-col gap-1 text-ui text-fg';
  return (
    <section data-testid="shells-settings" className="flex flex-col gap-4">
      <p className="m-0 text-ui text-muted">
        Each ferret works in its own set of tools, a nix shell, built once and cached.
      </p>

      {error !== undefined && (
        <p role="alert" data-testid="shells-error" className="m-0 text-meta text-err">
          {error}
        </p>
      )}

      {nix !== undefined && <NixLine facts={nix} />}

      <SettingGroup label="Shells">
        <>
          {list === undefined && <Loading kind="bar" label="Loading shells…" />}
          {list?.length === 0 && <SettingRow name="No shells yet." hint="Ferrets use the machine's tools." />}
          {list?.map(shell => (
            <SettingRow
              key={shell.name}
              name={shell.name}
              hint={
                <>
                  {shellLine(shell)}
                  {shell.description === undefined ? null : <span className="block">{shell.description}</span>}
                </>
              }
              dataAttributes={{ 'data-shell': shell.name }}
              wide
              control={() => (
                <span className="flex flex-wrap items-center gap-1">
                  <Badge tone={BUILD_TONES[shell.build]}>{BUILD_WORDS[shell.build]}</Badge>
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
              )}
            />
          ))}
        </>
      </SettingGroup>

      <form
        data-testid="shells-add"
        className="kt-panel flex flex-col gap-3 p-panel"
        onSubmit={event => {
          event.preventDefault();
          void looked();
        }}
      >
        <h3 className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">Add a shell</h3>
        <label className={field}>
          <span>Name</span>
          <input
            className="kt-input"
            value={draft.name}
            onChange={event => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label className={field}>
          <span>Made from</span>
          <select
            className="kt-input"
            value={draft.kind}
            onChange={event => setDraft({ ...draft, kind: event.target.value === 'flake' ? 'flake' : 'packages' })}
          >
            <option value="packages">A package list</option>
            <option value="flake">A flake reference</option>
          </select>
        </label>
        <label className={field}>
          <span>{draft.kind === 'flake' ? 'Flake reference' : 'Packages'}</span>
          <input
            className="kt-input"
            value={draft.source}
            onChange={event => setDraft({ ...draft, source: event.target.value })}
          />
        </label>
        {draft.kind === 'flake' && (
          <label className="flex items-center gap-2 text-ui text-fg">
            <input
              type="checkbox"
              checked={draft.floating}
              onChange={event => setDraft({ ...draft, floating: event.target.checked })}
            />
            <span>Floating: ask me again whenever it resolves differently</span>
          </label>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={busy !== undefined}>
            Resolve and look
          </Button>
        </div>
      </form>

      {preview !== undefined && (
        <div
          data-testid="shells-preview"
          className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-panel text-ui text-fg"
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

function NixLine({ facts }: { readonly facts: NixFacts }) {
  if (facts.present)
    return (
      <p data-testid="shells-nix" className="m-0 text-ui text-muted">
        Nix {facts.version} is on this machine.
      </p>
    );
  return (
    <p data-testid="shells-nix" role="status" className="m-0 text-ui text-warn">
      Nix is not on this machine. {facts.consequence} {facts.remedy}
    </p>
  );
}
