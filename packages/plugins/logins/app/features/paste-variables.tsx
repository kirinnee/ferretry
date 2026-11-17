/**
 * **Paste variables…** (docs/provider-presets.md § Detect): a person pastes the block they already use —
 * `export A=B`, `A=B`, `A: B`, or a Codex `[model_providers.x]` table — and the provider is recognised
 * in this browser from the presets' own clues.
 *
 * WHAT IS SHOWN IS NAMES. The result names the variables that gave the provider away and the host the
 * preset declares, never a value. The box is emptied the moment it is read; the values stay in memory
 * only, to fill in the provider's form — where a secret stays a `${secret:NAME}` reference. A pasted
 * key is filed in the Vault under the preset's secret name when Continue is pressed (`POST /v1/secrets`,
 * `lib/secrets-api.ts`) and goes nowhere else: not into a field, a login file or a sentence. A name the Vault ALREADY
 * holds (`GET /v1/secrets`, asked when the paste is read) is kept as it is, said by name with a Replace choice that is
 * off until the person turns it on: pressing Continue never overwrites a key a working login may be using.
 */

import { ChevronLeft } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { ProviderPresetView } from '../../contract/index.ts';
import type { LoginsClient } from '../lib/client.ts';
import { refusalSentence } from '../lib/client.ts';
import {
  alsoMatchedSentence,
  detectionSentence,
  type PasteReading,
  type Prefill,
  pasteTarget,
  pastedSecrets,
  prefillFrom,
  readPaste,
} from '../lib/paste-model.ts';
import { heldSecretNames, saveSecret } from '../lib/secrets-api.ts';
import { Button, SecretTextarea, useSecretTextarea } from '../ui.ts';

export interface PasteVariablesProps {
  readonly client: LoginsClient;
  /** The presets on offer, in the daemon's order. */
  readonly presets: readonly ProviderPresetView[];
  readonly onBack: () => void;
  /** Continue to this preset's form, filled in from the paste; its pasted keys are already in the Vault. */
  readonly onContinue: (presetId: string, prefill: Prefill) => void;
}

export function PasteVariables({ client, presets, onBack, onContinue }: PasteVariablesProps) {
  const ids = useId();
  /** The pasted block lives only in the textarea's own value: read when Read is pressed, never held in state or markup. */
  const paste = useSecretTextarea(typed => typed.trim().length);
  const [reading, setReading] = useState<PasteReading | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The pasted keys' names the Vault already holds; `null` until the Vault has been asked (Continue waits for it). */
  const [held, setHeld] = useState<readonly string[] | null>(null);
  /** The held names the person chose to replace. Empty unless they said so: a held key is never replaced by default. */
  const [replacing, setReplacing] = useState<readonly string[]>([]);
  const latest = useRef(0);

  /** Files each pasted key the Vault does not hold (or the person chose to replace), then continues. A refusal stays here. */
  const save = async (preset: ProviderPresetView, pasted: PasteReading): Promise<void> => {
    setSaving(true);
    setRefusal(null);
    try {
      for (const [name, value] of Object.entries(pastedSecrets(preset, pasted.values))) {
        if ((held ?? []).includes(name) && !replacing.includes(name)) continue;
        await saveSecret(client, name, value);
      }
    } catch (error) {
      setRefusal(refusalSentence(error));
      setSaving(false);
      return;
    }
    onContinue(preset.id, prefillFrom(preset, pasted.values));
  };

  /** Reads the paste, empties the box, and asks the Vault which pasted keys it already holds (names only). */
  const read = (): void => {
    const next = readPaste(presets, paste.read());
    const to = pasteTarget(presets, next.detection);
    const names = to === undefined ? [] : Object.keys(pastedSecrets(to, next.values));
    latest.current += 1;
    const turn = latest.current;
    setReading(next);
    paste.clear();
    setReplacing([]);
    setRefusal(null);
    if (names.length === 0) {
      setHeld([]);
      return;
    }
    setHeld(null);
    void heldSecretNames(client).then(
      inVault => {
        if (latest.current === turn) setHeld(names.filter(name => inVault.has(name)));
      },
      error => {
        // Unable to tell what the Vault holds: Continue stays off, so nothing is written without knowing.
        if (latest.current === turn) setRefusal(refusalSentence(error));
      },
    );
  };

  const found = reading === null ? 0 : Object.keys(reading.values).length;
  const target = reading === null ? undefined : pasteTarget(presets, reading.detection);
  const detected = reading?.detection.preset;
  const also = reading === null ? null : alsoMatchedSentence(presets, reading.detection);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-paste-variables="">
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="kt-btn--flush-start"
          data-paste-back=""
          onClick={onBack}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Add a login
        </Button>
      </div>
      <div className="flex min-w-0 max-w-[42rem] flex-col gap-1">
        <label htmlFor={`${ids}-paste`} className="text-ui font-semibold text-fg">
          Paste your variables
        </label>
        <SecretTextarea
          field={paste}
          id={`${ids}-paste`}
          className="kt-input min-h-32 min-w-0 font-mono"
          placeholder={'export ANTHROPIC_BASE_URL=https://…\nexport ANTHROPIC_AUTH_TOKEN=…'}
          data-paste-input=""
        />
        <span className="text-meta leading-base text-muted">
          NAME=value lines, YAML, or a Codex [model_providers] table. Read here and cleared; a new key goes straight to
          the secret store when you Continue (one already there stays unless you choose to replace it), and the form
          keeps only its name.
        </span>
      </div>
      <div>
        <Button type="button" data-paste-read="" disabled={!paste.filled} onClick={read}>
          Read
        </Button>
      </div>
      {reading === null ? null : found === 0 ? (
        <p role="status" className="m-0 text-cell leading-base text-warn" data-paste-result="empty">
          No variables found. Paste lines like NAME=value.
        </p>
      ) : (
        <div
          role="status"
          className="kt-panel flex min-w-0 flex-col gap-1 p-panel"
          data-paste-result={detected ?? 'custom'}
        >
          <p className="m-0 break-words text-row font-semibold text-fg" data-paste-detected="">
            {detectionSentence(presets, reading.detection)}
          </p>
          {also === null ? null : (
            <p className="m-0 text-cell leading-base text-muted" data-paste-also="">
              {also}
            </p>
          )}
          {target === undefined ? (
            <p className="m-0 text-cell leading-base text-warn" data-paste-not-offered="">
              Nothing offered here can take these variables. Pick a provider instead.
            </p>
          ) : detected !== undefined && target.id !== detected ? (
            <p className="m-0 text-cell leading-base text-warn" data-paste-not-offered="">
              That provider is not offered here, so this continues as {target.label}.
            </p>
          ) : null}
          {(held ?? []).map(name => (
            <div key={name} className="flex min-w-0 flex-col gap-1" data-paste-held={name}>
              <p className="m-0 break-words text-cell leading-base text-muted">
                <span className="mono">{name}</span> is already in the secret store, so it stays as it is.
              </p>
              <label className="flex min-h-control items-center gap-sm text-ui text-fg">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-accent"
                  checked={replacing.includes(name)}
                  disabled={saving}
                  data-paste-replace={name}
                  onChange={event =>
                    setReplacing(event.target.checked ? [...replacing, name] : replacing.filter(item => item !== name))
                  }
                />
                Replace it with the pasted key
              </label>
            </div>
          ))}
        </div>
      )}
      {reading === null || found === 0 ? null : (
        <div>
          <Button
            type="button"
            variant="primary"
            data-paste-continue=""
            disabled={target === undefined || saving || held === null}
            onClick={() => {
              if (target !== undefined) void save(target, reading);
            }}
          >
            {saving ? 'Saving…' : 'Continue'}
          </Button>
          {refusal === null ? null : (
            <p role="alert" className="m-0 mt-2 text-cell leading-base text-warn" data-paste-refused="">
              {refusal}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
