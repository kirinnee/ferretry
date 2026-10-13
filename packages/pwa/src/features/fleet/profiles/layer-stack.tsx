/**
 * A profile's layers, newest on top, and its conflicts (the prototype's `stackHtml` and
 * `conflictsHtml`; E18). The numbers count from the oldest, so "1" is always the bottom layer and the
 * highest number wins.
 */

import type { FleetComponentView, FleetLayerConflict, FleetLayeredProfileView } from '@ferretry/protocol';
import { ComponentBadges, Hint } from '../components/catalog-ui.tsx';
import { componentBadges, counted, KIND_ONE } from '../components/component-model.ts';
import { parseLayer, partCount } from './profile-model.ts';

export interface LayerStackProps {
  /** Oldest first, as written. */
  readonly layers: readonly string[];
  readonly components: readonly FleetComponentView[];
  readonly profiles: readonly FleetLayeredProfileView[];
  readonly machineName: string;
}

export function LayerStack({ layers, components, profiles, machineName }: LayerStackProps) {
  if (layers.length === 0) return <Hint>No layers yet.</Hint>;
  const rows = layers.map((text, index) => ({ text, number: index + 1 })).reverse();
  return (
    <div className="flex min-w-0 flex-col gap-1" data-layer-stack="">
      <span className="text-meta text-muted">Newest on top · newer layer wins</span>
      <ol className="kt-panel m-0 flex min-w-0 list-none flex-col divide-y divide-border p-0">
        {rows.map(({ text, number }) => {
          const layer = parseLayer(text);
          const base = layer?.kind === 'profile' ? profiles.find(profile => profile.name === layer.name) : undefined;
          const component =
            layer?.kind === 'component' ? components.find(candidate => candidate.reference === text) : undefined;
          return (
            <li key={text} className="flex min-w-0 items-start gap-3 px-panel py-2" data-layer={text}>
              <span className="w-5 shrink-0 text-right font-mono text-cell text-muted">{number}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {layer?.kind === 'profile' ? (
                  <>
                    <span className="break-words text-row font-semibold text-fg">Profile · {layer.name}</span>
                    <span className="text-cell text-muted">
                      {counted(base === undefined ? 0 : partCount(base), 'part')}, used as a base
                    </span>
                  </>
                ) : layer?.kind === 'component' ? (
                  <>
                    <span className="break-words text-row font-semibold text-fg">
                      {KIND_ONE[layer.componentKind]} · {layer.name}
                    </span>
                    {component === undefined ? null : (
                      <ComponentBadges badges={componentBadges(component, machineName)} />
                    )}
                  </>
                ) : (
                  <span className="break-words font-mono text-row text-fg">{text}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The daemon's sentence marks the key with backticks; it is drawn as code, never as two stray ticks. */
function ConflictSentence({ sentence }: { sentence: string }) {
  const marked = /^`([^`]+)`(.*)$/su.exec(sentence);
  if (marked === null) return <>{sentence}</>;
  return (
    <>
      <span className="font-mono font-semibold">{marked[1]}</span>
      {marked[2]}
    </>
  );
}

/** E18: "`key` · Claude Code: new (from layer) overrides old (from layer)". Information, never an error. */
export function ConflictList({ conflicts }: { conflicts: readonly FleetLayerConflict[] }) {
  if (conflicts.length === 0) return <Hint>No conflicts. Nothing in a newer layer replaces an older one.</Hint>;
  return (
    <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-cell leading-base text-fg" data-conflicts="">
      {conflicts.map(conflict => (
        <li key={conflict.sentence} className="break-words">
          <ConflictSentence sentence={conflict.sentence} />
        </li>
      ))}
    </ul>
  );
}
