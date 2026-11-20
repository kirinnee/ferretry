/**
 * Add a login: a Claude Code or Codex sign-in, or an environment login made from a provider preset (read from
 * `GET /v1/logins/presets`). Adding stages ONE change at Logins' own route and applies it; a sign-in is then signed in
 * from the login's own page. A preset's secret travels as a `${secret:NAME}` reference — the value is stored in the
 * secret store, never typed into a login file — so a variable holding a raw key is refused by the daemon. A pasted
 * block of variables (Paste variables…) is recognised in this browser and fills a preset's plain values; a pasted
 * key is named only, and pasted into the secret store itself. A tile whose preset asks for nothing but a key opens
 * the key-only quick form first (`quick-key-form.tsx`); **More fields…** there opens the full form below.
 *
 * A page that is already ABOUT one tool (Codex's first-run "Sign in" page) mounts the registered panel with the subject
 * `harness:codex` or `harness:claude` ({@link harnessOfSubject}): the panel is then locked to that tool — no "Tool"
 * picker — and is that tool's own one-press sign-in (`HarnessSignInEmbed`: it makes the login and starts signing it in).
 * The things the one press does not need are FOLDED, closed, not removed: **Name it (optional)** and **Other ways to
 * sign in** (that tool's providers only, read when first opened), so a Codex page never offers Claude Code (r11 O6).
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
import { isSecretReference, nonReferenceSlots, SECRET_VALUE_SENTENCE } from '../lib/secret-slot.ts';
import { Button, ChangeApplyPanel } from '../ui.ts';
import { HarnessChoice } from './harness-choice.tsx';
import { HarnessSignInEmbed } from './harness-sign-in-embed.tsx';
import { PasteVariables } from './paste-variables.tsx';
import { ProviderGrid, usableHarnesses } from './provider-grid.tsx';
import { QuickKeyForm, quickKeyVariable } from './quick-key-form.tsx';

/** The panel subjects that lock the panel to one tool: a page names the tool in the subject it mounts the panel with. */
const HARNESS_SUBJECTS: Readonly<Record<string, HarnessKind>> = {
  'harness:codex': 'codex',
  'harness:claude': 'claude-code',
};

/** The tool a panel subject locks the panel to; `undefined` for any other subject (Settings has none: the full chooser). */
export const harnessOfSubject = (subject: string | undefined): HarnessKind | undefined =>
  subject === undefined ? undefined : HARNESS_SUBJECTS[subject];

/**
 * A provider as ONE tool sees it: only that tool's half and only the variables that half reads, so a provider shared by
 * both tools (OpenRouter) shows, and a login made from it carries, the locked half alone — never the other tool's.
 */
const lockedPreset = (preset: ProviderPresetView, lock: HarnessKind): ProviderPresetView => ({
  ...preset,
  harness: lock,
  halves: preset.halves.filter(half => half.harness === lock),
  variables: preset.variables.filter(variable => variable.harnesses.includes(lock)),
});

export interface AddLoginPanelProps {
  readonly client: LoginsClient;
  /** Told the new login's id once it is added, so a screen can open it. Not used when the panel is locked to a `harness`. */
  readonly onAdded?: (id: string) => void;
  /** Lock the panel to this one tool: its one-press sign-in, with no picker; other ways are folded (see above). */
  readonly harness?: HarnessKind;
}

const secretReference = (variable: ProviderPresetView['variables'][number]): string =>
  variable.kind === 'secret' ? `\${secret:${variable.secret ?? variable.name}}` : (variable.value ?? '');

/** One preset's form: which CLI it is listed under first, its variables, its cloud credential reference, a label. */
function PresetForm({
  client,
  preset,
  prefill,
  lock,
  onAdded,
  onCancel,
}: {
  readonly client: LoginsClient;
  readonly preset: ProviderPresetView;
  /** The tool the panel is locked to: the form is for that tool and never asks which. */
  readonly lock?: HarnessKind;
  /** A paste's plain values, when the form was reached from Paste variables…. */
  readonly prefill?: Prefill;
  readonly onAdded: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const changes = useLoginChanges(client);
  const harnesses = usableHarnesses(preset);
  const [harness, setHarness] = useState<HarnessKind>(
    lock !== undefined && harnesses.includes(lock) ? lock : (harnesses[0] ?? preset.harness),
  );
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

  const secretSlots = preset.variables.filter(variable => variable.kind === 'secret').map(variable => variable.name);

  const add = async (): Promise<void> => {
    // A secret slot holds a reference. Anything else is a key pasted by mistake: it is cleared from the form, named by
    // slot only, and no request is made — the value is not sent, kept or repeated.
    const refused = nonReferenceSlots(secretSlots, env);
    if (refused.length > 0) {
      setEnv(current => ({ ...current, ...Object.fromEntries(refused.map(name => [name, ''])) }));
      changes.refuse(`${SECRET_VALUE_SENTENCE} (${refused.join(', ')})`);
      return;
    }
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
      // Locked to one tool: the login drives that tool's half alone (absent, the daemon enables every half it offers).
      ...(lock === undefined ? {} : { halves: [harness] }),
      env: given,
      ...(label.trim() === '' ? {} : { label: label.trim() }),
      ...(cloud.trim() === '' ? {} : { cloudCredential: cloud.trim() }),
    });
    if (result.kind === 'applied') onAdded(id);
  };

  return (
    <div className="flex flex-col gap-4" data-add-login-form={preset.id}>
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
      {harnesses.length > 1 && lock === undefined ? (
        <HarnessChoice label="Listed under" harnesses={harnesses} value={harness} onChange={setHarness} />
      ) : null}
      <div className="fy-lg-fields">
        {preset.variables.map(variable => (
          <label key={variable.name} className="fy-lg-field text-cell text-fg">
            <span className="font-mono">{variable.name}</span>
            <input
              className="kt-input"
              autoComplete="off"
              spellCheck={false}
              {...(variable.kind === 'secret' && !isSecretReference(variable.name, env[variable.name] ?? '')
                ? { type: 'password', 'data-secret-masked': '' }
                : {})}
              value={env[variable.name] ?? ''}
              onChange={event => {
                changes.clear();
                setEnv({ ...env, [variable.name]: event.target.value });
              }}
            />
            <span className="fy-lg-field__hint text-meta leading-base text-muted">
              {variable.kind === 'secret'
                ? `A secret: write the NAME it is stored under as \${secret:NAME}, never the key itself.`
                : (variable.description ?? (variable.required ? 'Needed.' : 'Optional.'))}
            </span>
          </label>
        ))}
        {preset.cloudCredential === undefined ? null : (
          <label className="fy-lg-field text-cell text-fg">
            <span>Cloud credential ({preset.cloudCredential.kinds.join(' or ')})</span>
            <input
              className="kt-input"
              autoComplete="off"
              value={cloud}
              onChange={event => setCloud(event.target.value)}
            />
          </label>
        )}
        <label className="fy-lg-field text-cell text-fg">
          <span>Label (optional)</span>
          <input
            className="kt-input"
            autoComplete="off"
            value={label}
            onChange={event => setLabel(event.target.value)}
          />
        </label>
      </div>
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
    <div className="fy-lg-group" data-add-login-sign-in="">
      <p className="m-0 text-row font-semibold text-fg">Sign in to a tool</p>
      <HarnessChoice label="Tool" harnesses={HARNESSES} value={harness} onChange={setHarness} />
      <div className="fy-lg-fields">
        <label className="fy-lg-field text-cell text-fg">
          <span>Label (optional)</span>
          <input
            className="kt-input"
            autoComplete="off"
            value={label}
            placeholder="e.g. personal or work"
            onChange={event => setLabel(event.target.value)}
          />
          <span className="fy-lg-field__hint text-meta leading-base text-muted">
            It starts as an empty login that needs sign-in; you sign it in next.
          </span>
        </label>
      </div>
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

export function AddLoginPanel({ client, onAdded, harness }: AddLoginPanelProps) {
  if (harness !== undefined) return <LockedAddLogin client={client} harness={harness} />;
  return <AddAnyLogin client={client} {...(onAdded === undefined ? {} : { onAdded })} />;
}

/**
 * One tool's own sign-in: the one press, with the optional name and the other providers folded away (closed). The name
 * goes on the login the press makes; the other providers are read the first time that fold is opened.
 */
function LockedAddLogin({ client, harness }: { readonly client: LoginsClient; readonly harness: HarnessKind }) {
  const [label, setLabel] = useState('');
  const [opened, setOpened] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-add-login-locked={harness}>
      <HarnessSignInEmbed
        client={client}
        harness={harness}
        {...(label.trim() === '' ? {} : { label: label.trim() })}
        beforeMake={
          <details className="min-w-0" data-add-login-name="">
            <summary className="cursor-pointer text-cell font-semibold text-fg">Name it (optional)</summary>
            <label className="fy-lg-field mt-2 text-cell text-fg">
              <span className="sr-only">Name</span>
              <input
                className="kt-input"
                autoComplete="off"
                value={label}
                placeholder="e.g. personal or work"
                onChange={event => setLabel(event.target.value)}
              />
            </label>
          </details>
        }
      />
      <details
        className="min-w-0"
        data-add-login-other-ways=""
        onToggle={event => {
          if (event.currentTarget.open) setOpened(true);
        }}
      >
        <summary className="cursor-pointer text-cell font-semibold text-fg">Other ways to sign in</summary>
        <div className="mt-3">{opened ? <AddAnyLogin client={client} lock={harness} /> : null}</div>
      </details>
    </div>
  );
}

function AddAnyLogin({
  client,
  onAdded,
  lock,
}: Omit<AddLoginPanelProps, 'harness'> & {
  /** Offer only this tool's providers, and make every login for it. */
  readonly lock?: HarnessKind;
}) {
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
        if (alive)
          setCatalog(
            lock === undefined
              ? read
              : {
                  ...read,
                  presets: read.presets
                    .filter(preset => usableHarnesses(preset).includes(lock))
                    .map(preset => lockedPreset(preset, lock)),
                },
          );
      },
      (error: unknown) => {
        if (alive) setFailure(refusalSentence(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [client, lock]);

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
        <div className="fy-lg-group" data-add-login-preset={picked.id}>
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
              {...(lock === undefined ? {} : { lock })}
            />
          ) : (
            <PresetForm
              client={client}
              preset={picked}
              {...(held === undefined || held.presetId !== picked.id ? {} : { prefill: held.prefill })}
              {...(lock === undefined ? {} : { lock })}
              onAdded={done}
              onCancel={close}
            />
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="fy-lg-groups min-w-0" data-add-login="">
      {added === null ? null : (
        <p role="status" className="m-0 text-cell leading-base text-ok" data-add-login-done="">
          Added {added}.
        </p>
      )}
      {lock === undefined ? <SignInForm client={client} onAdded={done} /> : null}
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
