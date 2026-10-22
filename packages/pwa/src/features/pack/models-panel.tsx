/**
 * THE MODELS PANEL: every model the fleet knows, grouped by catalog, with the words the guide builder is told
 * about each (docs/pack-mode.md § Suggesting a guide). The builder reads these to decide what a model is
 * good for, so an owner who knows better writes their own; "Use the catalog's" gives the catalog's back.
 *
 * A save is one call to the describe route, which writes `models-guide.yaml` on the machine; nothing is
 * written as a person types. Collapsed by default, because a fleet lists dozens of models.
 */

import type { PackFleetModel } from '@ferretry/protocol';
import { MAX_GUIDE_TEXT_CHARS } from '@ferretry/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { descriptionKey, groupModels, modelRowKey } from '../../lib/pack/model-list.ts';
import { Badge, Button } from '../../shell/primitives.tsx';
import type { GuideWrite } from './use-machine-pack.ts';

export interface ModelsPanelProps {
  readonly models: readonly PackFleetModel[];
  readonly onDescribe: (request: {
    readonly provider: string;
    readonly model: string;
    readonly description: string | null;
  }) => Promise<GuideWrite>;
  /** Open when first drawn (harness, tests). */
  readonly initiallyOpen?: boolean;
}

function ModelRow({
  model,
  onDescribe,
}: {
  readonly model: PackFleetModel;
  readonly onDescribe: ModelsPanelProps['onDescribe'];
}) {
  const id = useId().replace(/:/gu, '');
  const shown = model.description ?? '';
  const [text, setText] = useState(shown);
  const [drawnFrom, setDrawnFrom] = useState(shown);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<GuideWrite | null>(null);
  // The description moved under an untouched box (another device, `fy`): show the new words.
  if (shown !== drawnFrom) {
    if (text === drawnFrom) setText(shown);
    setDrawnFrom(shown);
  }
  const owner = model.describedBy === 'owner';
  const trimmed = text.trim();
  const edited = trimmed !== shown.trim();
  const send = (description: string | null): void => {
    setBusy(true);
    setOutcome(null);
    void onDescribe({ provider: model.provider, model: model.id, description }).then(result => {
      setOutcome(result);
      setBusy(false);
    });
  };
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-t border-border-soft py-3 first:border-t-0"
      data-model-row={model.id}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words text-ui font-semibold">{model.label}</span>
        <span className="mono min-w-0 break-all text-meta text-muted">{model.id}</span>
        {model.runtimes.length > 0 ? (
          <Badge tone="ok" title={`Runs here on ${model.runtimes.join(', ')}`} data-model-runs="here">
            Runs here
          </Badge>
        ) : (
          <Badge tone="pend" data-model-runs="elsewhere">
            Not on this machine
          </Badge>
        )}
        {model.description === undefined ? null : (
          <Badge tone={owner ? 'accent' : 'pend'} data-model-described-by={owner ? 'owner' : 'catalog'}>
            {owner ? 'Your words' : 'From the catalog'}
          </Badge>
        )}
      </div>
      <label htmlFor={`${id}-d`} className="sr-only">
        What {model.label} is good for
      </label>
      <textarea
        id={`${id}-d`}
        className="kt-input min-h-[44px] w-full resize-y"
        rows={2}
        maxLength={MAX_GUIDE_TEXT_CHARS}
        placeholder="No description yet — say what it is good for"
        value={text}
        disabled={busy}
        onChange={event => setText(event.currentTarget.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="min-h-[44px]"
          disabled={busy || !edited || trimmed === ''}
          onClick={() => send(trimmed)}
          data-model-save=""
        >
          Save description
        </Button>
        {owner ? (
          <Button size="sm" className="min-h-[44px]" disabled={busy} onClick={() => send(null)} data-model-reset="">
            Use the catalog’s
          </Button>
        ) : null}
        {outcome === null ? null : (
          <span
            role="status"
            className={cn('min-w-0 text-meta leading-base', outcome.kind === 'refused' ? 'text-err' : 'text-muted')}
          >
            {outcome.message}
          </span>
        )}
      </div>
    </li>
  );
}

export function ModelsPanel({ models, onDescribe, initiallyOpen = false }: ModelsPanelProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const [filter, setFilter] = useState('');
  const headingId = useId();
  const bodyId = useId();
  const groups = useMemo(() => groupModels(models, filter), [models, filter]);
  const owned = useMemo(
    () => new Set(models.filter(m => m.describedBy === 'owner').map(descriptionKey)).size,
    [models],
  );
  return (
    <section className="kt-panel flex min-w-0 flex-col" aria-labelledby={headingId} data-models-panel="">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
        className="flex min-h-[44px] min-w-0 items-center gap-2 rounded-control p-4 text-left hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown size={16} aria-hidden="true" className="shrink-0" />
        ) : (
          <ChevronRight size={16} aria-hidden="true" className="shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span id={headingId} className="block text-ui font-semibold">
            Models
          </span>
          <span className="block text-meta leading-base text-muted">
            {models.length} {models.length === 1 ? 'model' : 'models'}
            {owned > 0 ? ` · ${owned} described in your words` : ''}. What each is good for, as the guide builder is
            told it.
          </span>
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="flex min-w-0 flex-col gap-3 border-t border-border-soft p-4">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${bodyId}-filter`} className="text-meta font-semibold text-fg-soft">
              Find a model
            </label>
            <input
              id={`${bodyId}-filter`}
              type="search"
              className="kt-input min-h-[44px] w-full"
              placeholder="Name, id, provider, words"
              value={filter}
              onChange={event => setFilter(event.currentTarget.value)}
              data-models-filter=""
            />
          </div>
          {groups.length === 0 ? (
            <p className="m-0 text-meta text-muted">No model matches “{filter.trim()}”.</p>
          ) : (
            groups.map(group => (
              <div key={group.provider} className="flex min-w-0 flex-col" data-model-group={group.provider}>
                <h4 className="m-0 text-ui font-semibold">{group.label}</h4>
                <ul className="m-0 flex list-none flex-col p-0">
                  {group.models.map(model => (
                    <ModelRow key={modelRowKey(model)} model={model} onDescribe={onDescribe} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}
