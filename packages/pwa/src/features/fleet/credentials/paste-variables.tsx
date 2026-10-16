/**
 * **Paste variables…** (docs/provider-presets.md § Detect): a person pastes the block they already use —
 * `export A=B`, `A=B`, `A: B`, or a Codex `[model_providers.x]` table — and the provider is recognised
 * in this browser from the presets' own clues.
 *
 * WHAT IS SHOWN IS NAMES. The result names the variables that gave the provider away and the host the
 * preset declares, never a value. The box is emptied the moment it is read; the values stay in memory
 * only, to fill in the provider's form, where a secret is stored on Add and never shown.
 */

import type { FleetProviderPresetView } from '@ferretry/protocol';
import { ChevronLeft } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import {
  alsoMatchedSentence,
  detectionSentence,
  type PasteReading,
  type Prefill,
  pasteTarget,
  prefillFrom,
  readPaste,
} from './provider-model.ts';

export interface PasteVariablesProps {
  /** The presets on offer, in the daemon's order. */
  readonly presets: readonly FleetProviderPresetView[];
  readonly onBack: () => void;
  /** Continue to this preset's form, filled in from the paste. */
  readonly onContinue: (presetId: string, prefill: Prefill) => void;
}

export function PasteVariables({ presets, onBack, onContinue }: PasteVariablesProps) {
  const ids = useId();
  const [text, setText] = useState('');
  const [reading, setReading] = useState<PasteReading | null>(null);

  const read = (): void => {
    setReading(readPaste(presets, text));
    setText('');
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
          All providers
        </Button>
      </div>
      <div className="flex min-w-0 max-w-[42rem] flex-col gap-1">
        <label htmlFor={`${ids}-paste`} className="text-ui font-semibold text-fg">
          Paste your variables
        </label>
        <textarea
          id={`${ids}-paste`}
          className="kt-input min-h-32 min-w-0 font-mono"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={'export ANTHROPIC_BASE_URL=https://…\nexport ANTHROPIC_AUTH_TOKEN=…'}
          value={text}
          data-paste-input=""
          onChange={event => setText(event.target.value)}
        />
        <span className="text-meta leading-base text-muted">
          NAME=value lines, YAML, or a Codex [model_providers] table. Read here and cleared; a key is stored only when
          you Add.
        </span>
      </div>
      <div>
        <Button type="button" data-paste-read="" disabled={text.trim() === ''} onClick={read}>
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
        </div>
      )}
      {reading === null || found === 0 ? null : (
        <div>
          <Button
            type="button"
            variant="primary"
            data-paste-continue=""
            disabled={target === undefined}
            onClick={() => {
              if (target !== undefined) onContinue(target.id, prefillFrom(target, reading.values));
            }}
          >
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}
