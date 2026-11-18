/**
 * Add a login: a Claude Code or Codex sign-in, or an environment login made from a provider preset (read from
 * `GET /v1/logins/presets`). Adding stages ONE change at Logins' own route and applies it; a sign-in is then signed in
 * from the login's own page. A preset's secret travels as a `${secret:NAME}` reference — the value is stored in the
 * secret store, never typed into a login file — so a variable holding a raw key is refused by the daemon. A pasted
 * block of variables (Paste variables…) is recognised in this browser and fills a preset's plain values; a pasted
 * key is named only, and pasted into the secret store itself. A tile whose preset asks for nothing but a key opens
 * the key-only quick form first (`quick-key-form.tsx`); **More fields…** there opens the full form below.
 */

import { Loading } from '@ferretry/app/ui';
import { useEffect, useState } from 'react';
import type { ProviderPresetCatalog, ProviderPresetView } from '../../contract/index.ts';
import { LoginScopeChip } from '../components/login-scope-chip.tsx';
import { type LoginsClient, refusalSentence } from '../lib/client.ts';
import { useLoginChanges } from '../lib/login-changes.ts';
import { readLogins, readPresets } from '../lib/logins-api.ts';
import { HARNESS_NAMES, HARNESSES, type HarnessKind, suggestLoginId } from '../lib/logins-view.ts';
import { type Prefill, withheldSentence } from '../lib/paste-model.ts';
import { Button, ChangeApplyPanel } from '../ui.ts';
import { PasteVariables } from './paste-variables.tsx';
import { ProviderGrid, usableHarnesses } from './provider-grid.tsx';
import { QuickKeyForm, quickKeyVariable } from './quick-key-form.tsx';

export interface AddLoginPanelProps {
  readonly client: LoginsClient;
  /** Told the new login's id once it is added, so a screen can open it. */
  readonly onAdded?: (id: string) => void;
}

const secretReference = (variable: ProviderPresetView['variables'][number]): string =>
  variable.kind === 'secret' ? `\${secret:${variable.secret ?? variable.name}}` : (variable.value ?? '');

/** One preset's form: which CLI it is listed under first, its variables, its cloud credential reference, a label. */
function PresetForm({
  client,
  preset,
  prefill,
  onAdded,
  onCancel,
}: {
  readonly client: LoginsClient;
  readonly preset: ProviderPresetView;
  /** A paste's plain values, when the form was reached from Paste variables…. */
  readonly prefill?: Prefill;
  readonly onAdded: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const changes = useLoginChanges(client);
  const harnesses = usableHarnesses(preset);
  const [harness, setHarness] = useState<HarnessKind>(harnesses[0] ?? preset.harness);
  const [label, setLabel] = useState('');
  const [env, setEnv] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      preset.variables.map(variable => {
        const pasted = prefill?.values[variable.name];
        if (variable.kind === 'plain' && pasted !== undefined) return [variable.name, pasted];
        return [variable.name, secretReference(variable)];
      }),
    ),
  );
  const [cloud, setCloud] = useState(preset.cloudCredential?.suggested ?? '');
  // The secrets a paste carried, by NAME only: Continue already filed each key in the Vault, and this form
  // takes a `${secret:NAME}` reference — a key's value never reaches this screen.
  const pastedSecrets = prefill?.secrets ?? [];
  const withheld = withheldSentence(prefill?.withheld ?? []);

  const add = async (): Promise<void> => {
    let taken: ReadonlySet<string>;
    try {
      taken = new Set((await readLogins(client)).logins.map(login => login.id));
    } catch (error) {
      changes.refuse(refusalSentence(error));
      return;
    }
    const id = suggestLoginId(harness, label.trim() === '' ? preset.id : label, taken);
    // A variable the preset leaves empty on purpose is sent as its `''`; any other empty one is left out.
    const kept = new Set(preset.variables.filter(variable => variable.allowEmpty).map(variable => variable.name));
    const given = Object.fromEntries(
      Object.entries(env).filter(([name, value]) => value.trim() !== '' || kept.has(name)),
    );
    const result = await changes.apply({
      kind: 'login.add',
      id,
      harness,
      store: 'environment',
      preset: preset.id,
      env: given,
      ...(label.trim() === '' ? {} : { label: label.trim() }),
      ...(cloud.trim() === '' ? {} : { cloudCredential: cloud.trim() }),
    });
    if (result.kind === 'applied') onAdded(id);
  };

  return (
    <div className="flex flex-col gap-2" data-add-login-form={preset.id}>
      {pastedSecrets.length === 0 ? null : (
        <p role="status" className="m-0 text-cell leading-base text-muted" data-paste-secrets="">
          Your pasted {pastedSecrets.join(', ')} {pastedSecrets.length === 1 ? 'is' : 'are'} in the secret store, and
          the fields below name {pastedSecrets.length === 1 ? 'it' : 'them'} as {`\${secret:NAME}`}.
        </p>
      )}
      {withheld === null ? null : (
        <p role="status" className="m-0 text-cell leading-base text-warn" data-paste-withheld="">
          {withheld}
        </p>
      )}
      {harnesses.length > 1 ? (
        <label className="flex flex-col gap-1 text-cell text-fg">
          Listed under
          <select
            className="kt-input"
            value={harness}
            onChange={event => setHarness(event.target.value as HarnessKind)}
          >
            {harnesses.map(name => (
              <option key={name} value={name}>
                {HARNESS_NAMES[name]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {preset.variables.map(variable => (
        <label key={variable.name} className="flex flex-col gap-1 text-cell text-fg">
          <span className="font-mono">{variable.name}</span>
          <input
            className="kt-input"
            autoComplete="off"
            value={env[variable.name] ?? ''}
            onChange={event => setEnv({ ...env, [variable.name]: event.target.value })}
          />
          <span className="text-meta leading-base text-muted">
            {variable.kind === 'secret'
              ? `A secret: write the NAME it is stored under as \${secret:NAME}, never the key itself.`
              : (variable.description ?? (variable.required ? 'Needed.' : 'Optional.'))}
          </span>
        </label>
      ))}
      {preset.cloudCredential === undefined ? null : (
        <label className="flex flex-col gap-1 text-cell text-fg">
          Cloud credential ({preset.cloudCredential.kinds.join(' or ')})
          <input
            className="kt-input"
            autoComplete="off"
            value={cloud}
            onChange={event => setCloud(event.target.value)}
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-cell text-fg">
        Label (optional)
        <input className="kt-input" autoComplete="off" value={label} onChange={event => setLabel(event.target.value)} />
      </label>
      <ChangeApplyPanel
        machineName="this machine"
        authority={changes.authority}
        busy={changes.busy}
        busyLabel="Adding…"
        refusal={changes.refusal}
        submitLabel={`Add ${preset.label}`}
        onSubmit={() => void add()}
      >
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      </ChangeApplyPanel>
    </div>
  );
}

/** A Claude Code or Codex sign-in: an empty login that needs sign-in, which the login's own page then does. */
function SignInForm({ client, onAdded }: { readonly client: LoginsClient; readonly onAdded: (id: string) => void }) {
  const changes = useLoginChanges(client);
  const [harness, setHarness] = useState<HarnessKind>('claude-code');
  const [label, setLabel] = useState('');

  const add = async (): Promise<void> => {
    let taken: ReadonlySet<string>;
    try {
      taken = new Set((await readLogins(client)).logins.map(login => login.id));
    } catch (error) {
      changes.refuse(refusalSentence(error));
      return;
    }
    const id = suggestLoginId(harness, label.trim() === '' ? undefined : label, taken);
    const result = await changes.apply({
      kind: 'login.add',
      id,
      harness,
      ...(label.trim() === '' ? {} : { label: label.trim() }),
    });
    if (result.kind === 'applied') onAdded(id);
  };

  return (
    <div className="kt-panel flex flex-col gap-2 p-panel" data-add-login-sign-in="">
      <p className="m-0 text-row font-semibold text-fg">Sign in to a tool</p>
      <label className="flex flex-col gap-1 text-cell text-fg">
        Tool
        <select className="kt-input" value={harness} onChange={event => setHarness(event.target.value as HarnessKind)}>
          {HARNESSES.map(name => (
            <option key={name} value={name}>
              {HARNESS_NAMES[name]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-cell text-fg">
        Label (optional)
        <input
          className="kt-input"
          autoComplete="off"
          value={label}
          placeholder="e.g. personal or work"
          onChange={event => setLabel(event.target.value)}
        />
      </label>
      <p className="m-0 text-meta leading-base text-muted">
        It starts as an empty login that needs sign-in; you sign it in next.
      </p>
      <ChangeApplyPanel
        machineName="this machine"
        authority={changes.authority}
        busy={changes.busy}
        busyLabel="Adding…"
        refusal={changes.refusal}
        submitLabel={`Add a ${HARNESS_NAMES[harness]} login`}
        onSubmit={() => void add()}
      />
    </div>
  );
}

export function AddLoginPanel({ client, onAdded }: AddLoginPanelProps) {
  const [catalog, setCatalog] = useState<ProviderPresetCatalog | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  // A paste is held for the preset it picked and for no other: another preset's form never reads it.
  const [held, setHeld] = useState<{ readonly presetId: string; readonly prefill: Prefill } | undefined>(undefined);
  const [added, setAdded] = useState<string | null>(null);
  // The provider whose full form was asked for from its quick form (More fields…).
  const [more, setMore] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    readPresets(client).then(
      read => {
        if (alive) setCatalog(read);
      },
      (error: unknown) => {
        if (alive) setFailure(refusalSentence(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [client]);

  const done = (id: string): void => {
    setAdded(id);
    setChoosing(null);
    setHeld(undefined);
    setMore(null);
    onAdded?.(id);
  };

  // The paste screen replaces the list; its Continue opens the form it picked, prefilled.
  if (choosing === 'paste' && catalog !== null)
    return (
      <section className="flex min-w-0 flex-col gap-3" data-add-login="">
        <PasteVariables
          client={client}
          presets={catalog.presets}
          onBack={() => {
            setHeld(undefined);
            setChoosing(null);
          }}
          onContinue={(presetId, filled) => {
            setHeld({ presetId, prefill: filled });
            setChoosing(presetId);
          }}
        />
      </section>
    );

  // A tile folds the grid to its provider's own form.
  const picked = catalog?.presets.find(preset => preset.id === choosing && preset.offered.available);
  if (picked !== undefined) {
    const close = (): void => {
      setHeld(undefined);
      setChoosing(null);
      setMore(null);
    };
    // A paste's prefill, or More fields…, goes to the full form; otherwise a key-only preset asks for its key alone.
    const keyVariable =
      more === picked.id || (held !== undefined && held.presetId === picked.id) ? undefined : quickKeyVariable(picked);
    return (
      <section className="flex min-w-0 flex-col gap-3" data-add-login="">
        <div className="kt-panel flex flex-col gap-1 p-panel" data-add-login-preset={picked.id}>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-row font-semibold text-fg">{picked.label}</span>
            <LoginScopeChip harnesses={usableHarnesses(picked)} />
          </span>
          <span className="text-cell leading-base text-muted">{picked.summary}</span>
          {keyVariable !== undefined ? (
            <QuickKeyForm
              client={client}
              preset={picked}
              variable={keyVariable}
              onAdded={done}
              onCancel={close}
              onMore={() => setMore(picked.id)}
            />
          ) : (
            <PresetForm
              client={client}
              preset={picked}
              {...(held === undefined || held.presetId !== picked.id ? {} : { prefill: held.prefill })}
              onAdded={done}
              onCancel={close}
            />
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-3" data-add-login="">
      {added === null ? null : (
        <p role="status" className="m-0 text-cell leading-base text-ok" data-add-login-done="">
          Added {added}.
        </p>
      )}
      <SignInForm client={client} onAdded={done} />
      {failure === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-warn">
          {failure}
        </p>
      )}
      {catalog === null ? (
        failure === null && <Loading kind="bar" label="Reading the providers…" />
      ) : (
        <ProviderGrid presets={catalog.presets} onPick={setChoosing} onPaste={() => setChoosing('paste')} />
      )}
    </section>
  );
}
