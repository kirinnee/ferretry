/**
 * The one-click provider form (v4's): a tile that only needs a key asks for the key and nothing else. The key goes to
 * the Vault under the preset's secret name (`variable.secret ?? variable.name`, `POST /v1/secrets`, `lib/secrets-api.ts`)
 * and the login is added with the preset's own plain values and a `${secret:NAME}` reference — the key itself is typed
 * into a hidden, UNCONTROLLED field (read from a ref on submit, so React never mirrors it into a `value` attribute a DOM
 * snapshot would show), is cleared the moment it is filed, and is never put in a login file, a sentence or any other
 * field. A name the Vault ALREADY holds is asked about first (keep the one there, or replace it), as Paste variables… does,
 * so a key a working login may be using is never overwritten without the person's say-so. A preset that needs more than
 * a key (another value the person must type, or a cloud credential) gets the full form straight away, and **More fields…**
 * opens that full form for any preset. A preset that drives several CLIs asks which one the login is for, and the login is
 * made for THAT CLI alone, carrying only the variables it reads (never the other CLI's).
 */

import { useId, useRef, useState } from 'react';
import type { ProviderPresetView } from '../../contract/index.ts';
import { type LoginsClient, refusalSentence } from '../lib/client.ts';
import { useLoginChanges } from '../lib/login-changes.ts';
import { readLogins } from '../lib/logins-api.ts';
import { type HarnessKind, suggestLoginId } from '../lib/logins-view.ts';
import { heldSecretNames, saveSecret } from '../lib/secrets-api.ts';
import { Button, ChangeApplyPanel, SecretInput, useSecretField } from '../ui.ts';
import { HarnessChoice } from './harness-choice.tsx';
import { usableHarnesses } from './provider-grid.tsx';

type PresetVariable = ProviderPresetView['variables'][number];

/**
 * The one secret variable a preset asks a person for, when the key is ALL it asks for: exactly one secret, no cloud
 * credential, and every other variable either filled in by the preset or optional. `undefined` means the full form.
 */
export function quickKeyVariable(preset: ProviderPresetView): PresetVariable | undefined {
  const secrets = preset.variables.filter(variable => variable.kind === 'secret');
  const [only] = secrets;
  if (secrets.length !== 1 || only === undefined) return undefined;
  if (preset.cloudCredential !== undefined) return undefined;
  const others = preset.variables.filter(variable => variable !== only);
  const needsTyping = others.some(
    variable => variable.required && !variable.allowEmpty && (variable.value ?? '').trim() === '',
  );
  return needsTyping ? undefined : only;
}

/** The Vault name a preset files its key under. */
const secretName = (variable: PresetVariable): string => variable.secret ?? variable.name;

/**
 * The CLIs the quick form offers: the ones the preset can drive here that read the key. A preset that offers several
 * leaves the person to choose; one that offers a single CLI never asks.
 */
const quickHarnesses = (preset: ProviderPresetView, key: PresetVariable): readonly HarnessKind[] => {
  const usable = usableHarnesses(preset);
  const reading = usable.filter(harness => key.harnesses.includes(harness));
  return reading.length > 0 ? reading : usable;
};

/**
 * What the login is made with: each plain variable's own value (never a typed one) and the key's reference. A preset
 * that drives several CLIs sends only the chosen CLI's variables.
 */
function loginEnvironment(
  preset: ProviderPresetView,
  key: PresetVariable,
  harness?: HarnessKind,
): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const variable of preset.variables) {
    if (harness !== undefined && !variable.harnesses.includes(harness)) continue;
    if (variable === key) entries.push([variable.name, `\${secret:${secretName(variable)}}`]);
    else if ((variable.value ?? '').trim() !== '' || variable.allowEmpty)
      entries.push([variable.name, variable.value ?? '']);
  }
  return Object.fromEntries(entries);
}

export interface QuickKeyFormProps {
  readonly client: LoginsClient;
  readonly preset: ProviderPresetView;
  /** The preset's key variable, from {@link quickKeyVariable}. */
  readonly variable: PresetVariable;
  readonly onAdded: (id: string) => void;
  readonly onCancel: () => void;
  /** Open today's full form for this provider. */
  readonly onMore: () => void;
  /** The tool the panel is locked to: the login is made for it and the form never asks which. */
  readonly lock?: HarnessKind;
}

export function QuickKeyForm({ client, preset, variable, onAdded, onCancel, onMore, lock }: QuickKeyFormProps) {
  const changes = useLoginChanges(client);
  const name = secretName(variable);
  const harnesses = quickHarnesses(preset, variable);
  const [chosen, setChosen] = useState<HarnessKind | undefined>(undefined);
  const several = harnesses.length > 1;
  const harness: HarnessKind =
    lock !== undefined && harnesses.includes(lock)
      ? lock
      : chosen !== undefined && harnesses.includes(chosen)
        ? chosen
        : (harnesses[0] ?? preset.harness);
  /** The key lives only in the field's own value: read from here on submit, never held in React state. */
  const field = useSecretField();
  const inputId = useId();
  /** Set synchronously the moment a submit starts: a second click in the same tick finds it taken. */
  const inFlight = useRef(false);
  /** The Vault already holds the name: asked about before anything is written. */
  const [asking, setAsking] = useState(false);
  /** The key is in the Vault: a retry after a refused add needs no key. */
  const [filed, setFiled] = useState(false);
  const [saving, setSaving] = useState(false);

  /** Adds the login that names the key; the Vault holds the key by now. */
  const addLogin = async (): Promise<void> => {
    let taken: ReadonlySet<string>;
    try {
      taken = new Set((await readLogins(client)).logins.map(login => login.id));
    } catch (error) {
      changes.refuse(refusalSentence(error));
      return;
    }
    const id = suggestLoginId(harness, preset.id, taken);
    const result = await changes.apply({
      kind: 'login.add',
      id,
      harness,
      store: 'environment',
      preset: preset.id,
      env: loginEnvironment(preset, variable, several ? harness : undefined),
      ...(several || lock !== undefined ? { halves: [harness] } : {}),
    });
    if (result.kind === 'applied') onAdded(id);
  };

  /**
   * Runs one submit at a time. The guard is a ref, so it holds against a second click in the same tick, before any
   * render has disabled the button; `saving` then shows it. Every path that reads the Vault or writes to it goes
   * through here — Add, the filed retry, and both answers to the held question.
   */
  const exclusive = async (work: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await work();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  /** Files the key (when asked to), empties the field, then adds the login. */
  const fileAndAdd = async (write: boolean): Promise<void> => {
    setAsking(false);
    if (write) {
      changes.clear();
      try {
        await saveSecret(client, name, field.read());
      } catch (error) {
        changes.refuse(refusalSentence(error));
        return;
      }
    }
    field.clear();
    setFiled(true);
    await addLogin();
  };

  const submit = async (): Promise<void> => {
    if (filed) {
      await addLogin();
      return;
    }
    if (field.read() === '') return;
    changes.clear();
    let held: ReadonlySet<string>;
    try {
      held = await heldSecretNames(client);
    } catch (error) {
      // Unable to tell what the Vault holds: nothing is written without knowing.
      changes.refuse(refusalSentence(error));
      return;
    }
    if (held.has(name)) {
      setAsking(true);
      return;
    }
    await fileAndAdd(true);
  };

  return (
    <div className="flex flex-col gap-4" data-quick-key-form={preset.id}>
      {several && lock === undefined ? (
        <div data-quick-key-harness="">
          <HarnessChoice
            label="Use it with"
            harnesses={harnesses}
            value={harness}
            disabled={filed || asking || saving}
            onChange={setChosen}
          />
        </div>
      ) : null}
      {filed ? (
        <p role="status" className="m-0 text-cell leading-base text-muted" data-quick-key-filed="">
          Your key is in the secret store as <span className="font-mono">{name}</span>; the login names it as{' '}
          {`\${secret:${name}}`}.
        </p>
      ) : (
        <label htmlFor={inputId} className="fy-lg-field text-cell text-fg">
          <span>{variable.description ?? `${preset.label} key`}</span>
          <SecretInput
            field={field}
            id={inputId}
            className="kt-input font-mono"
            disabled={asking || saving}
            data-quick-key-input=""
          />
          <span className="fy-lg-field__hint text-meta leading-base text-muted">
            Goes straight to the secret store as <span className="font-mono">{name}</span>; the login only holds its
            name.
          </span>
        </label>
      )}
      {asking ? (
        <div className="flex flex-col gap-2" data-quick-key-held={name}>
          <p role="status" className="m-0 break-words text-cell leading-base text-warn">
            <span className="font-mono">{name}</span> is already in the secret store. Keep the key that is there, or
            replace it with the one you typed?
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="primary"
              data-quick-key-keep=""
              onClick={() => void exclusive(() => fileAndAdd(false))}
            >
              Use the one already there
            </Button>
            <Button type="button" data-quick-key-replace="" onClick={() => void exclusive(() => fileAndAdd(true))}>
              Replace it with mine
            </Button>
            <Button type="button" data-quick-key-back="" onClick={() => setAsking(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <ChangeApplyPanel
          machineName="this machine"
          authority={changes.authority}
          busy={changes.busy || saving}
          busyLabel="Adding…"
          refusal={changes.refusal}
          disabled={!filed && !field.filled}
          submitLabel={`Add ${preset.label}`}
          onSubmit={() => void exclusive(submit)}
        >
          <Button type="button" data-quick-key-more="" onClick={onMore}>
            More fields…
          </Button>
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        </ChangeApplyPanel>
      )}
    </div>
  );
}
