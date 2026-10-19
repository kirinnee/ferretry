/**
 * Add a login › Environment's first screen (docs/provider-presets.md): one compact tile per provider
 * this machine offers — its name and which CLIs it drives — under the heading its preset names
 * (Popular, Cloud, Self-hosted), two to a row on a phone. One tap opens the minimal form that asks only
 * for its key; nothing is picked until somebody taps. More than {@link PROVIDER_SEARCH_THRESHOLD} tiles
 * and a search box narrows them.
 *
 * A tile's one line on what the provider is shows on hover, on keyboard focus or on a long press, and
 * is always its accessible description. A provider that is not offered here stays focusable, says so,
 * and a tap shows why instead of opening anything. Last comes **Paste variables…**, which recognises
 * the provider from a block of variables a person already has.
 */

import type { FleetProviderPresetView } from '@ferretry/protocol';
import { ClipboardPaste, Search } from 'lucide-react';
import { type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import { LOCAL_TONE_CLASS, type LocalModelsRead, OLLAMA_PRESET_ID, tileWords } from '../../../lib/local-models.ts';
import { LONG_PRESS_MS } from '../../../shell/agent-sidebar-model.ts';
import { presetScope } from './environment-model.ts';
import { LoginScopeChip } from './login-scope-chip.tsx';
import { gridSections, PROVIDER_SEARCH_THRESHOLD } from './provider-model.ts';

const TILE =
  'kt-panel flex min-h-control w-full min-w-0 flex-col items-start justify-between gap-1 p-panel text-left hover:border-accent focus-visible:border-accent';

export interface ProviderGridProps {
  readonly presets: readonly FleetProviderPresetView[];
  readonly onPick: (presetId: string) => void;
  readonly onPaste: () => void;
  /** What the daemon last read from Ollama on this machine; shown on the Ollama tile's second line. */
  readonly local?: LocalModelsRead;
}

export function ProviderGrid({ presets, onPick, onPaste, local }: ProviderGridProps) {
  const [query, setQuery] = useState('');
  const [noted, setNoted] = useState<string | null>(null);
  const searchId = useId();
  const sections = gridSections(presets, query);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-provider-grid="">
      {presets.length > PROVIDER_SEARCH_THRESHOLD ? (
        <label htmlFor={searchId} className="relative block min-w-0">
          <span className="sr-only">Search providers</span>
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
            placeholder="Search providers"
            autoComplete="off"
            spellCheck={false}
            // `!pl-9`: `.kt-input`'s padding shorthand wins over a plain `pl-9` (see skills-surface.tsx).
            className="kt-input min-h-control w-full !pl-9 !pr-3"
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
                  {...(preset.id === OLLAMA_PRESET_ID && local !== undefined ? { local } : {})}
                  onNote={show => setNoted(previous => (show ? preset.id : previous === preset.id ? null : previous))}
                  onPick={onPick}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      <button type="button" className={`${TILE} border-dashed`} data-provider-tile="paste" onClick={onPaste}>
        <span className="inline-flex items-center gap-2 text-row font-semibold text-fg">
          <ClipboardPaste size={16} aria-hidden="true" className="shrink-0 text-accent" />
          Paste variables…
        </span>
        <span className="text-cell leading-base text-muted">
          Already have them? The provider is recognised right here in the browser.
        </span>
      </button>
    </div>
  );
}

interface ProviderTileProps {
  readonly preset: FleetProviderPresetView;
  readonly noted: boolean;
  readonly onNote: (show: boolean) => void;
  readonly onPick: (presetId: string) => void;
  readonly local?: LocalModelsRead;
}

function ProviderTile({ preset, noted, onNote, onPick, local }: ProviderTileProps) {
  const detected = local === undefined ? null : tileWords(local);
  const noteId = useId();
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Set when a long press showed the note, so the click that ends the press does not also open the form.
  const held = useRef(false);
  const offered = preset.offered.available;
  const release = (): void => {
    clearTimeout(press.current);
    press.current = undefined;
  };
  // A press still timing when the tile goes away (a search narrowed it out) must not fire into nothing.
  useEffect(() => () => clearTimeout(press.current), []);
  const mouse = (event: PointerEvent) => event.pointerType === 'mouse';
  return (
    <li className="relative flex min-w-0" data-provider-tile-cell={preset.id}>
      <button
        type="button"
        className={`${TILE} ${offered ? '' : 'border-dashed text-muted hover:border-border'}`}
        aria-disabled={offered ? undefined : true}
        aria-describedby={noteId}
        data-provider-tile={preset.id}
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          if (offered) onPick(preset.id);
          else onNote(true);
        }}
        onPointerEnter={event => {
          if (mouse(event)) onNote(true);
        }}
        onPointerLeave={event => {
          release();
          if (mouse(event)) onNote(false);
        }}
        onPointerDown={event => {
          held.current = false;
          if (mouse(event)) return;
          release();
          press.current = setTimeout(() => {
            held.current = true;
            onNote(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onContextMenu={event => {
          // A long press on a phone opens the system menu over the note it just showed.
          if (held.current) event.preventDefault();
        }}
        onFocus={() => onNote(true)}
        onBlur={() => onNote(false)}
        onKeyDown={event => {
          if (event.key === 'Escape') onNote(false);
        }}
      >
        <span className={`line-clamp-2 break-words text-row font-semibold ${offered ? 'text-fg' : 'text-muted'}`}>
          {preset.label}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <LoginScopeChip harnesses={presetScope(preset)} />
          {offered ? null : (
            <span className="text-meta text-warn" data-provider-tile-unoffered="">
              Not offered here
            </span>
          )}
          {detected === null ? null : (
            <span
              className={`text-meta font-semibold ${LOCAL_TONE_CLASS[detected.tone]}`}
              data-provider-tile-local={local?.snapshot?.state ?? 'pending'}
            >
              {detected.text}
            </span>
          )}
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
