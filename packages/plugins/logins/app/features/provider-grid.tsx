/**
 * Add a login's provider choice (docs/provider-presets.md): one compact tile per provider this machine offers — its name
 * and which CLIs it drives — under the heading its preset names, two to a row on a phone. One tap opens that provider's
 * form; nothing is picked until somebody taps. More than {@link PROVIDER_SEARCH_THRESHOLD} tiles and a search box narrows
 * them. A tile's one line on what the provider is is its accessible description and shows on hover or keyboard focus.
 * A provider that is not offered here stays focusable, says so, and a tap shows why instead of opening anything. Last
 * comes **Paste variables…**.
 */

import { useId, useState } from 'react';
import type { ProviderPresetView } from '../../contract/index.ts';
import { LoginScopeChip } from '../components/login-scope-chip.tsx';
import type { HarnessKind } from '../lib/logins-view.ts';
import { gridSections, PROVIDER_SEARCH_THRESHOLD } from '../lib/provider-grid-model.ts';

const TILE =
  'kt-panel flex min-h-control w-full min-w-0 flex-col items-start justify-between gap-1 p-panel text-left hover:border-accent focus-visible:border-accent';

/** The CLIs a preset can drive on this machine. */
export const usableHarnesses = (preset: ProviderPresetView): readonly HarnessKind[] =>
  preset.halves.filter(half => half.offered.available).map(half => half.harness);

export interface ProviderGridProps {
  readonly presets: readonly ProviderPresetView[];
  readonly onPick: (presetId: string) => void;
  readonly onPaste: () => void;
}

export function ProviderGrid({ presets, onPick, onPaste }: ProviderGridProps) {
  const [query, setQuery] = useState('');
  const [noted, setNoted] = useState<string | null>(null);
  const searchId = useId();
  const sections = gridSections(presets, query);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-provider-grid="">
      {presets.length > PROVIDER_SEARCH_THRESHOLD ? (
        <label htmlFor={searchId} className="block min-w-0">
          <span className="sr-only">Search providers</span>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
            placeholder="Search providers"
            autoComplete="off"
            spellCheck={false}
            className="kt-input min-h-control w-full"
            data-provider-search=""
          />
        </label>
      ) : null}
      {sections.length === 0 ? (
        <p role="status" className="m-0 text-cell leading-base text-muted" data-provider-no-match="">
          No provider matches “{query.trim()}”. Try another name, or paste your variables below.
        </p>
      ) : (
        sections.map(section => (
          <section key={section.key} className="flex min-w-0 flex-col gap-1" data-provider-section={section.key}>
            <h4 className="m-0 text-meta font-semibold uppercase text-muted">{section.heading}</h4>
            <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-4">
              {section.presets.map(preset => (
                <ProviderTile
                  key={preset.id}
                  preset={preset}
                  noted={noted === preset.id}
                  onNote={show => setNoted(previous => (show ? preset.id : previous === preset.id ? null : previous))}
                  onPick={onPick}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      <button type="button" className={`${TILE} border-dashed`} data-provider-tile="paste" onClick={onPaste}>
        <span className="text-row font-semibold text-fg">Paste variables…</span>
        <span className="text-cell leading-base text-muted">
          Already have them? The provider is recognised right here in the browser.
        </span>
      </button>
    </div>
  );
}

interface ProviderTileProps {
  readonly preset: ProviderPresetView;
  readonly noted: boolean;
  readonly onNote: (show: boolean) => void;
  readonly onPick: (presetId: string) => void;
}

function ProviderTile({ preset, noted, onNote, onPick }: ProviderTileProps) {
  const noteId = useId();
  const offered = preset.offered.available;
  return (
    <li className="relative flex min-w-0" data-provider-tile-cell={preset.id}>
      <button
        type="button"
        className={`${TILE} ${offered ? '' : 'border-dashed text-muted hover:border-border'}`}
        aria-disabled={offered ? undefined : true}
        aria-describedby={noteId}
        data-provider-tile={preset.id}
        onClick={() => (offered ? onPick(preset.id) : onNote(true))}
        onPointerEnter={() => onNote(true)}
        onPointerLeave={() => onNote(false)}
        onFocus={() => onNote(true)}
        onBlur={() => onNote(false)}
      >
        <span className={`line-clamp-2 break-words text-row font-semibold ${offered ? 'text-fg' : 'text-muted'}`}>
          {preset.label}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <LoginScopeChip harnesses={usableHarnesses(preset)} />
          {offered ? null : <span className="text-meta text-warn">Not offered here</span>}
        </span>
      </button>
      <span
        id={noteId}
        role="tooltip"
        className={`kt-panel absolute inset-x-0 top-full z-20 mt-1 p-panel text-cell leading-base text-fg shadow-panel ${noted ? '' : 'hidden'}`}
        data-provider-tile-note={preset.id}
      >
        {preset.summary}
        {offered ? null : (
          <span className="mt-1 block text-warn" data-provider-tile-reason="">
            Not offered here: {preset.offered.reason}
          </span>
        )}
      </span>
    </li>
  );
}
