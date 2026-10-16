/**
 * A provider's MINIMAL form (docs/provider-presets.md): only what the preset cannot fill in itself —
 * each secret it needs (one field per secret NAME, so one key drives both halves), a required value it
 * has no default for (an Azure resource, a gateway's address), and the cloud credential reference it
 * suggests. Everything else is the preset's, and **More options** shows it to change.
 *
 * A SECRET IS STORED, NEVER KEPT. On **Add** each pasted secret goes to `POST /v1/secrets` first and its
 * field is emptied whatever the answer; only then is the login added as a reviewed change holding
 * `${secret:NAME}`. A value is never rendered, logged, or kept once stored.
 */

import type { FleetCredentialList, FleetProviderPresetView } from '@ferretry/protocol';
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useId, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { putSecret } from '../../secrets/secrets-api.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { type EnvironmentDraft, environmentChange, environmentDraftProblem, presetScope } from './environment-model.ts';
import { LoginScopeChip } from './login-scope-chip.tsx';
import { blankRequiredValues, oneClickDraft, type Prefill, type SecretField, secretFields } from './provider-model.ts';
import { SecretPill } from './secret-pill.tsx';

/** The facts under a provider's name: scope, quota, docs, when it was checked, and what was not. */
export function PresetFacts({ preset }: { readonly preset: FleetProviderPresetView }) {
  return (
    <div className="flex flex-col gap-1 text-meta leading-base text-muted" data-env-preset-facts={preset.id}>
      <p className="m-0">{preset.summary}</p>
      <p className="m-0 flex min-w-0 flex-wrap items-center gap-1">
        <LoginScopeChip harnesses={presetScope(preset)} />
        <span>Quota: {preset.quota.note}</span>
      </p>
      <p className="m-0 min-w-0">
        <a
          href={preset.docs}
          title={preset.docs}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1"
          data-env-preset-docs=""
        >
          {preset.label} docs
          <ExternalLink size={12} aria-hidden="true" />
        </a>{' '}
        · facts checked against them <span className="whitespace-nowrap">{preset.verified}</span>
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

export interface OneClickLoginProps {
  readonly preset: FleetProviderPresetView;
  /** The secret NAMES the store holds. */
  readonly stored: ReadonlySet<string>;
  /** A secret was stored: its NAME. */
  readonly onStored: (name: string) => void;
  /** What a paste filled in, when the form was opened from one. */
  readonly prefill?: Prefill;
  readonly list: FleetCredentialList | null;
  readonly machineName: string;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly changes: AccountChanges;
  readonly reload: () => Promise<unknown>;
  /** Back to the providers. */
  readonly onBack: () => void;
  /** The login is added: its id. */
  readonly onSaved: (credentialId: string) => void;
}

export function OneClickLogin({
  preset,
  stored,
  onStored,
  prefill,
  list,
  machineName,
  connection,
  createClient,
  changes,
  reload,
  onBack,
  onSaved,
}: OneClickLoginProps) {
  const ids = useId();
  const [draft, setDraft] = useState<EnvironmentDraft>(() => oneClickDraft(preset, list, prefill));
  // Secret NAME → a value to store on Add. Emptied the moment it is stored, or fails to be.
  const [pending, setPending] = useState<Readonly<Record<string, string>>>(prefill?.secrets ?? {});
  const [pasted, setPasted] = useState<ReadonlySet<string>>(new Set(Object.keys(prefill?.secrets ?? {})));
  const [more, setMore] = useState(false);
  const [storing, setStoring] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);

  const secrets = secretFields(preset);
  const asked = new Set(blankRequiredValues(preset));
  const filled = Object.entries(pending).filter(([, value]) => value.trim() !== '');
  const ready = new Set([...stored, ...filled.map(([name]) => name)]);
  const problem = environmentDraftProblem(preset, draft, ready);
  const setValue = (name: string, value: string): void =>
    setDraft({ ...draft, values: { ...draft.values, [name]: value } });

  const add = async (): Promise<void> => {
    setStoreError(null);
    if (filled.length > 0) {
      setStoring(true);
      try {
        const client = await createClient(connection);
        for (const [name, value] of filled) {
          await putSecret(client, name, value);
          onStored(name);
        }
      } catch (error) {
        setStoreError(changeRefusalSentence(error));
        return;
      } finally {
        // Stored or not, the value is gone: it is never kept, only stored.
        setPending({});
        setPasted(new Set());
        setStoring(false);
      }
    }
    const made = await changes.apply(environmentChange(preset, draft, ready));
    if (made.kind === 'refused') return;
    await reload();
    onSaved(draft.name);
  };

  const secretRow = (field: SecretField) => {
    const input = `${ids}-secret-${field.secret}`;
    return (
      <div key={field.secret} className="flex min-w-0 flex-col gap-1" data-one-click-secret={field.secret}>
        <label htmlFor={input} className="break-all font-mono text-cell font-semibold text-fg">
          {field.secret}
          {field.required ? '' : ' (optional)'}
        </label>
        {stored.has(field.secret) ? (
          <SecretPill name={field.secret} set data-env-secret-set={field.secret} />
        ) : pasted.has(field.secret) ? (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge tone="accent" data-one-click-pasted={field.secret}>
              pasted — stored when you Add
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-one-click-replace={field.secret}
              onClick={() => {
                setPasted(new Set([...pasted].filter(name => name !== field.secret)));
                setPending({ ...pending, [field.secret]: '' });
              }}
            >
              Paste another
            </Button>
          </span>
        ) : (
          <input
            id={input}
            type="password"
            className="kt-input min-w-0 font-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder={`paste ${field.secret}`}
            value={pending[field.secret] ?? ''}
            data-env-secret-input={field.secret}
            onChange={event => setPending({ ...pending, [field.secret]: event.target.value })}
          />
        )}
        <span className="text-meta leading-base text-muted">
          {stored.has(field.secret)
            ? `Already in ${machineName}’s secret store.`
            : `Kept in ${machineName}’s secret store as ${field.secret}; never shown again.`}
          {field.variables.length > 1 ? ` Used as ${field.variables.join(' and ')}.` : ''}
        </span>
      </div>
    );
  };

  const valueRow = (name: string) => {
    const variable = preset.variables.find(candidate => candidate.name === name);
    const input = `${ids}-value-${name}`;
    return (
      <div key={name} className="flex min-w-0 flex-col gap-1" data-env-variable={name}>
        <label htmlFor={input} className="break-all font-mono text-cell font-semibold text-fg">
          {name}
          {variable?.required === false ? ' (optional)' : ''}
        </label>
        <input
          id={input}
          className="kt-input font-mono"
          autoComplete="off"
          spellCheck={false}
          value={draft.values[name] ?? ''}
          placeholder={variable?.description ?? 'fill in'}
          onChange={event => setValue(name, event.target.value)}
        />
      </div>
    );
  };

  const others = preset.variables.filter(variable => variable.kind === 'plain' && !asked.has(variable.name));
  return (
    <div className="flex min-w-0 flex-col gap-3" data-env-login="form" data-one-click={preset.id}>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="kt-btn--flush-start"
          data-one-click-back=""
          onClick={onBack}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          All providers
        </Button>
        <h4 className="m-0 mt-1 text-title font-semibold text-fg">{preset.label}</h4>
      </div>
      <PresetFacts preset={preset} />
      {prefill === undefined ? null : (
        <p className="m-0 text-cell leading-base text-fg" data-one-click-prefilled="">
          Filled in from what you pasted. Check it, then Add.
        </p>
      )}

      <div className="flex min-w-0 max-w-[42rem] flex-col gap-3" data-one-click-fields="">
        {secrets.filter(field => field.required).map(secretRow)}
        {[...asked].map(valueRow)}
        {preset.cloudCredential === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-1" data-env-cloud="">
            <label htmlFor={`${ids}-cloud`} className="text-cell font-semibold text-fg">
              Cloud credential ({preset.cloudCredential.kinds.join(' or ')})
            </label>
            <input
              id={`${ids}-cloud`}
              className="kt-input font-mono"
              autoComplete="off"
              spellCheck={false}
              value={draft.cloudCredential}
              onChange={event => setDraft({ ...draft, cloudCredential: event.target.value })}
            />
            <Badge className="self-start">Reference, never copied</Badge>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="kt-btn--flush-start"
            aria-expanded={more}
            data-one-click-more=""
            onClick={() => setMore(!more)}
          >
            {more ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            More options
          </Button>
        </div>
        {more ? (
          <fieldset className="m-0 flex min-w-0 max-w-[42rem] flex-col gap-3 border-0 p-0" data-env-variables="">
            <legend className="sr-only">More options</legend>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={`${ids}-name`} className="text-ui font-semibold text-fg">
                Name
              </label>
              <input
                id={`${ids}-name`}
                className="kt-input font-mono"
                autoComplete="off"
                spellCheck={false}
                value={draft.name}
                data-env-name=""
                onChange={event => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <p className="m-0 text-cell font-semibold text-fg">Variables injected into the CLI at launch</p>
            {others.map(variable => valueRow(variable.name))}
            {secrets.filter(field => !field.required).map(secretRow)}
          </fieldset>
        ) : null}
      </div>

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
        busy={changes.busy || storing}
        busyLabel={storing ? 'Storing the key…' : 'Adding…'}
        refusal={changes.refusal}
        submitLabel="Add"
        disabled={problem !== null || !preset.offered.available}
        onSubmit={() => void add()}
      />
    </div>
  );
}
