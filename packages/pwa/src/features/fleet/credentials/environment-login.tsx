/**
 * Add a login › **Environment** (docs/provider-presets.md): pick a provider preset, check the variables
 * it fills in, store each secret it needs, and add the login — then Test it.
 *
 * A SECRET IS STORED, NEVER KEPT. A pasted value goes straight to `POST /v1/secrets` under the name the
 * preset suggests, the field clears, and from then on the screen says "set ✓". The login itself holds
 * only `${secret:NAME}`, and the reviewed change that adds it carries no value either.
 *
 * The Test runs on the SAVED login: the daemon tests a login it has, never a draft, so a Test can only
 * send a key to where that login itself sends it.
 */

import type { FleetProviderPresetView } from '@ferretry/protocol';
import { Check, ExternalLink } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { listSecrets, putSecret } from '../../secrets/secrets-api.ts';
import { readFleetPresets } from '../credentials-api.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import type { MachineData } from '../runtimes/machine-data.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import type { HarnessKind } from './credentials-model.ts';
import {
  type EnvironmentDraft,
  environmentChange,
  environmentDraftProblem,
  firstOffered,
  PRESET_GROUPS,
  presetDraft,
  presetOptionLabel,
  presetsOf,
} from './environment-model.ts';
import { LoginScopeChip } from './login-scope-chip.tsx';
import { LoginTest } from './login-test.tsx';
import { SecretPill } from './secret-pill.tsx';

export interface EnvironmentLoginProps {
  /** Set when the flow was opened for one harness: only its presets are offered. */
  readonly harness?: HarnessKind;
  readonly machineName: string;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly data: MachineData | null;
  readonly reload: () => Promise<MachineData | null>;
  readonly changes: AccountChanges;
  /** The login is added and the person pressed Done. */
  readonly onAdded: (credentialId: string) => void;
  /** The login is saved and its Test is on screen: the flow moves to its Test step. */
  readonly onSaved?: (credentialId: string) => void;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly sentence: string }
  | { readonly kind: 'ready'; readonly presets: readonly FleetProviderPresetView[] };

/** The facts under the preset select: scope, quota, docs, when it was checked, what was not. */
function PresetFacts({ preset }: { readonly preset: FleetProviderPresetView }) {
  return (
    <div className="flex flex-col gap-1 text-meta leading-base text-muted" data-env-preset-facts={preset.id}>
      <p className="m-0">{preset.summary}</p>
      <p className="m-0 flex min-w-0 flex-wrap items-center gap-1">
        <LoginScopeChip harness={preset.harness} />
        <span>Quota: {preset.quota.note}</span>
      </p>
      <p className="m-0 min-w-0">
        Docs: <span className="break-all font-mono">{preset.docs}</span>{' '}
        <a href={preset.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
          open
          <ExternalLink size={12} aria-hidden="true" />
        </a>{' '}
        · checked against them {preset.verified}
      </p>
      {preset.unverified.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-warn" data-env-preset-unverified="">
          {preset.unverified.map(sentence => (
            <li key={sentence}>Not confirmed: {sentence}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EnvironmentLogin({
  harness,
  machineName,
  connection,
  createClient,
  data,
  reload,
  changes,
  onAdded,
  onSaved,
}: EnvironmentLoginProps) {
  const ids = useId();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [stored, setStored] = useState<ReadonlySet<string>>(new Set());
  const [presetId, setPresetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EnvironmentDraft | null>(null);
  const [pasted, setPasted] = useState<Readonly<Record<string, string>>>({});
  const [storing, setStoring] = useState<string | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const client = await createClient(connection);
        const catalog = await readFleetPresets(client);
        // Names only: whether a secret is already stored, never what it is. A store that cannot be listed
        // simply shows every secret as one to store.
        const names = await listSecrets(client).then(
          list => list.secrets.map(secret => secret.name),
          () => [] as string[],
        );
        if (!live) return;
        setStored(new Set(names));
        setLoaded({ kind: 'ready', presets: catalog.presets });
      } catch (error) {
        if (live) setLoaded({ kind: 'failed', sentence: changeRefusalSentence(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  if (loaded.kind === 'loading')
    return (
      <p role="status" className="m-0 text-cell text-muted" data-env-login="loading">
        Reading the provider presets on {machineName}…
      </p>
    );
  if (loaded.kind === 'failed')
    return (
      <p role="alert" className="m-0 text-cell leading-base text-warn" data-env-login="failed">
        {loaded.sentence}
      </p>
    );

  const offered = loaded.presets.filter(preset => harness === undefined || preset.harness === harness);
  const preset =
    offered.find(candidate => candidate.id === presetId) ??
    (presetId === null ? firstOffered(offered, harness) : undefined);
  if (preset === undefined)
    return (
      <p role="status" className="m-0 text-cell text-muted" data-env-login="none">
        {machineName} offers no provider preset for this tool.
      </p>
    );
  const current = draft ?? presetDraft(preset, data?.credentials ?? null);
  const setCurrent = (next: Partial<EnvironmentDraft>): void => setDraft({ ...current, ...next });

  if (added !== null) {
    const row = data?.credentials.credentials.find(candidate => candidate.id === added);
    return (
      <div className="flex flex-col gap-3" data-env-login="added">
        <p role="status" className="m-0 inline-flex items-center gap-2 text-row font-semibold text-ok">
          <Check size={16} aria-hidden="true" />
          Added {added} from {preset.label}
        </p>
        <p className="m-0 text-cell leading-base text-muted">
          Test it now: the daemon tests the login it saved, sending the key only where the login sends it.
        </p>
        <LoginTest
          credentialId={added}
          act={row?.environment?.test ?? preset.test}
          connection={connection}
          createClient={createClient}
        />
        <div>
          <Button type="button" variant="primary" data-step-next="" onClick={() => onAdded(added)}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const store = async (variable: string, name: string): Promise<void> => {
    const value = pasted[variable] ?? '';
    if (value.trim() === '') return;
    setStoring(variable);
    setStoreError(null);
    try {
      const client = await createClient(connection);
      await putSecret(client, name, value);
      setStored(new Set([...stored, name]));
    } catch (error) {
      setStoreError(changeRefusalSentence(error));
    } finally {
      // The pasted value is gone either way: it is never kept, only stored.
      setPasted({ ...pasted, [variable]: '' });
      setStoring(null);
    }
  };

  const add = async (): Promise<void> => {
    const made = await changes.apply(environmentChange(preset, current, stored));
    if (made.kind === 'refused') return;
    await reload();
    setAdded(current.name);
    onSaved?.(current.name);
  };

  const problem = environmentDraftProblem(preset, current, stored);
  const selectId = `${ids}-preset`;
  return (
    <div className="flex flex-col gap-3" data-env-login="form">
      <div className="flex flex-col gap-1">
        <label htmlFor={selectId} className="text-ui font-semibold text-fg">
          Provider preset
        </label>
        <select
          id={selectId}
          className="kt-input"
          value={preset.id}
          data-env-preset=""
          onChange={event => {
            setPresetId(event.target.value);
            setDraft(null);
            setPasted({});
            changes.clear();
          }}
        >
          {PRESET_GROUPS.map(group => {
            const members = presetsOf(offered, group.harness);
            if (members.length === 0) return null;
            return (
              <optgroup key={group.harness} label={group.label}>
                {members.map(candidate => (
                  <option key={candidate.id} value={candidate.id} disabled={!candidate.offered.available}>
                    {presetOptionLabel(candidate)}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </div>
      <PresetFacts preset={preset} />

      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-name`} className="text-ui font-semibold text-fg">
          Name
        </label>
        <input
          id={`${ids}-name`}
          className="kt-input font-mono"
          autoComplete="off"
          value={current.name}
          data-env-name=""
          onChange={event => setCurrent({ name: event.target.value })}
        />
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-env-variables="">
        <legend className="mb-1 text-ui font-semibold text-fg">Variables injected into the CLI at launch</legend>
        {preset.variables.map(variable => {
          const field = `${ids}-${variable.name}`;
          if (variable.kind === 'plain')
            return (
              <div key={variable.name} className="flex min-w-0 flex-col gap-1" data-env-variable={variable.name}>
                <label htmlFor={field} className="break-all font-mono text-cell font-semibold text-fg">
                  {variable.name}
                  {variable.required ? '' : ' (optional)'}
                </label>
                <input
                  id={field}
                  className="kt-input font-mono"
                  autoComplete="off"
                  value={current.values[variable.name] ?? ''}
                  placeholder={variable.description ?? 'fill in'}
                  onChange={event => setCurrent({ values: { ...current.values, [variable.name]: event.target.value } })}
                />
              </div>
            );
          const name = current.secrets[variable.name] ?? variable.name;
          const set = stored.has(name);
          return (
            <div key={variable.name} className="flex min-w-0 flex-col gap-1" data-env-variable={variable.name}>
              <span className="break-all font-mono text-cell font-semibold text-fg">
                {variable.name}
                {variable.required ? '' : ' (optional)'}
              </span>
              {set ? (
                <SecretPill name={name} set data-env-secret-set={name} />
              ) : (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <label htmlFor={field} className="sr-only">
                    {name}
                  </label>
                  <input
                    id={field}
                    type="password"
                    className="kt-input min-w-0 flex-1 basis-40"
                    autoComplete="off"
                    placeholder={`paste ${name}`}
                    value={pasted[variable.name] ?? ''}
                    data-env-secret-input={name}
                    onChange={event => setPasted({ ...pasted, [variable.name]: event.target.value })}
                  />
                  <Button
                    type="button"
                    size="sm"
                    data-env-secret-store={name}
                    disabled={storing !== null || (pasted[variable.name] ?? '').trim() === ''}
                    onClick={() => void store(variable.name, name)}
                  >
                    {storing === variable.name ? 'Storing…' : 'Store'}
                  </Button>
                </div>
              )}
              <span className="text-meta leading-base text-muted">
                Stored in {machineName}’s secret store as {name}; never shown again.
              </span>
            </div>
          );
        })}
        {preset.cloudCredential === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-1" data-env-cloud="">
            <label htmlFor={`${ids}-cloud`} className="text-cell font-semibold text-fg">
              Cloud credential ({preset.cloudCredential.kinds.join(' or ')})
            </label>
            <input
              id={`${ids}-cloud`}
              className="kt-input font-mono"
              autoComplete="off"
              value={current.cloudCredential}
              onChange={event => setCurrent({ cloudCredential: event.target.value })}
            />
            <Badge className="self-start">Reference, never copied</Badge>
          </div>
        )}
      </fieldset>
      {storeError === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-env-store-error="">
          {storeError}
        </p>
      )}
      {problem === null ? null : (
        <p className="m-0 text-cell leading-base text-muted" data-env-problem="">
          {problem}
        </p>
      )}
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        busyLabel="Adding…"
        refusal={changes.refusal}
        submitLabel="Add login"
        disabled={problem !== null || !preset.offered.available}
        onSubmit={() => void add()}
      />
    </div>
  );
}
