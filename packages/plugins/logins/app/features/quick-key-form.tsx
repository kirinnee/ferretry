/**
 * The one-click provider form (v4's): a tile that only needs a key asks for the key and nothing else. The key goes to
 * the Vault under the preset's secret name (`variable.secret ?? variable.name`, `POST /v1/secrets`, `lib/secrets-api.ts`)
 * and the login is added with the preset's own plain values and a `${secret:NAME}` reference — the key itself is typed
 * into a hidden field, is cleared the moment it is filed, and is never put in a login file, a sentence or any other
 * field. A name the Vault ALREADY holds is asked about first (keep the one there, or replace it), as Paste variables… does,
 * so a key a working login may be using is never overwritten without the person's say-so. A preset that needs more than
 * a key (another value the person must type, or a cloud credential) gets the full form straight away, and **More fields…**
 * opens that full form for any preset.
 */

import { useState } from 'react';
import type { ProviderPresetView } from '../../contract/index.ts';
import { type LoginsClient, refusalSentence } from '../lib/client.ts';
import { useLoginChanges } from '../lib/login-changes.ts';
import { readLogins } from '../lib/logins-api.ts';
import { type HarnessKind, suggestLoginId } from '../lib/logins-view.ts';
import { heldSecretNames, saveSecret } from '../lib/secrets-api.ts';
import { Button, ChangeApplyPanel } from '../ui.ts';
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

/** What the login is made with: each plain variable's own value (never a typed one) and the key's reference. */
function loginEnvironment(preset: ProviderPresetView, key: PresetVariable): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const variable of preset.variables) {
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
}

export function QuickKeyForm({ client, preset, variable, onAdded, onCancel, onMore }: QuickKeyFormProps) {
  const changes = useLoginChanges(client);
  const name = secretName(variable);
  const harnesses = usableHarnesses(preset);
  const harness: HarnessKind = harnesses[0] ?? preset.harness;
  const [key, setKey] = useState('');
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
      env: loginEnvironment(preset, variable),
    });
    if (result.kind === 'applied') onAdded(id);
  };

  /** Files the key (when asked to), empties the field, then adds the login. */
  const fileAndAdd = async (write: boolean): Promise<void> => {
    setAsking(false);
    if (write) {
      setSaving(true);
      changes.clear();
      try {
        await saveSecret(client, name, key);
      } catch (error) {
        changes.refuse(refusalSentence(error));
        return;
      } finally {
        setSaving(false);
      }
    }
    setKey('');
    setFiled(true);
    await addLogin();
  };

  const submit = async (): Promise<void> => {
    if (filed) {
      await addLogin();
      return;
    }
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
    <div className="flex flex-col gap-2" data-quick-key-form={preset.id}>
      {filed ? (
        <p role="status" className="m-0 text-cell leading-base text-muted" data-quick-key-filed="">
          Your key is in the secret store as <span className="font-mono">{name}</span>; the login names it as{' '}
          {`\${secret:${name}}`}.
        </p>
      ) : (
        <label className="flex flex-col gap-1 text-cell text-fg">
          <span>{variable.description ?? `${preset.label} key`}</span>
          <input
            className="kt-input font-mono"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={key}
            disabled={asking || saving}
            data-quick-key-input=""
            onChange={event => setKey(event.target.value)}
          />
          <span className="text-meta leading-base text-muted">
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
            <Button type="button" variant="primary" data-quick-key-keep="" onClick={() => void fileAndAdd(false)}>
              Use the one already there
            </Button>
            <Button type="button" data-quick-key-replace="" onClick={() => void fileAndAdd(true)}>
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
          disabled={!filed && key === ''}
          submitLabel={`Add ${preset.label}`}
          onSubmit={() => void submit()}
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
