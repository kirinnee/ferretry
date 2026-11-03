/**
 * WHAT CHANGED BETWEEN TWO VERSIONS, drawn in the item head's version slot (docs/agenda.md § The item view, "Changes").
 * A button in the slot opens a panel under the head: it compares "since you last looked" by default (this device's
 * last-seen mark against the newest version) and lets the owner pick ANY two. Each changed section shows its words with
 * the additions underlined and the removals struck through, plus a count — never a colour alone. Sections that did not
 * change fold away under one line. The comparison itself is `agenda-diff.ts`'s; this only reads and draws.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { GitCompareArrows } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  BASIS_WORDS,
  changedSections,
  defaultComparison,
  diffItems,
  diffSummary,
  orderedPair,
  type SectionDiff,
  type VersionPair,
  versionLabel,
} from '../../lib/agenda-diff.ts';
import type { AgendaVersionsView } from './use-item-lifecycle.ts';

/** The button in the version slot: it opens and closes the comparison. */
export function DiffToggle({
  open,
  controls,
  onToggle,
}: {
  readonly open: boolean;
  readonly controls: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      aria-controls={controls}
      aria-expanded={open}
      className="fy-diff__toggle"
      data-agenda-diff-toggle=""
      onClick={onToggle}
      type="button"
    >
      <GitCompareArrows aria-hidden="true" size={14} />
      Changes
    </button>
  );
}

type Loaded =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly from: AgendaItem; readonly to: AgendaItem };

/** The two versions of the pair, read from the machine once each; shown loading until both are in. */
function usePair(versions: AgendaVersionsView, pair: VersionPair): Loaded {
  const [loaded, setLoaded] = useState<{ readonly pair: string; readonly value: Loaded } | null>(null);
  const key = `${String(pair.from)}:${String(pair.to)}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pair's key is the trigger
  useEffect(() => {
    let live = true;
    Promise.all([versions.load(pair.from), versions.load(pair.to)])
      .then(([from, to]) => {
        if (live) setLoaded({ pair: key, value: { state: 'ready', from, to } });
      })
      .catch(() => {
        if (live) setLoaded({ pair: key, value: { state: 'failed' } });
      });
    return () => {
      live = false;
    };
  }, [versions.load, key]);
  return loaded?.pair === key ? loaded.value : { state: 'loading' };
}

const STATUS_WORDS: Readonly<Record<SectionDiff['status'], string>> = {
  unchanged: 'Unchanged',
  added: 'New',
  removed: 'Removed',
  changed: 'Changed',
};

function SectionChange({ section }: { readonly section: SectionDiff }) {
  return (
    <section className="fy-diff__section" data-agenda-diff-section={section.key} data-status={section.status}>
      <h5 className="fy-diff__section-head">
        <span className="fy-diff__section-name">{section.label}</span>
        <span className="fy-diff__status">{STATUS_WORDS[section.status]}</span>
        <span className="fy-diff__count">
          <span>
            +{section.addedWords}
            <span className="sr-only"> words added</span>
          </span>
          <span>
            −{section.removedWords}
            <span className="sr-only"> words removed</span>
          </span>
        </span>
      </h5>
      <p className="fy-diff__text m-0">
        {section.runs.flatMap((run, index) => {
          const at = `${String(index)}:${run.kind}`;
          if (run.kind === 'added') return [<ins key={at}>{run.text}</ins>];
          if (run.kind === 'same') return [<span key={at}>{run.text}</span>];
          // A struck word and the word that replaces it are kept apart, so neither reads as one glued word.
          const next = section.runs[index + 1];
          const glued = next?.kind === 'added' && !/\s$/u.test(run.text) && !/^\s/u.test(next.text);
          return glued ? [<del key={at}>{run.text}</del>, ' '] : [<del key={at}>{run.text}</del>];
        })}
      </p>
    </section>
  );
}

/** The comparison panel: which two versions, what changed, and the sections that did not. */
export function VersionDiffPanel({
  id,
  versions,
  now,
}: {
  readonly id: string;
  readonly versions: AgendaVersionsView;
  readonly now: number;
}) {
  const { list } = versions;
  const fallback = useMemo(() => defaultComparison(list), [list]);
  const [custom, setCustom] = useState<VersionPair | null>(null);
  const pair = custom ?? fallback?.pair ?? { from: 1, to: Math.max(1, list.latest) };
  const loaded = usePair(versions, pair);
  const fromId = useId();
  const toId = useId();
  const choose = (from: number, to: number): void => {
    const next = orderedPair(from, to);
    setCustom(fallback !== null && next.from === fallback.pair.from && next.to === fallback.pair.to ? null : next);
  };
  const diff = useMemo(() => (loaded.state === 'ready' ? diffItems(loaded.from, loaded.to) : []), [loaded]);
  const changed = changedSections(diff);
  const unchanged = diff.filter(section => section.status === 'unchanged');
  const heading =
    custom === null && fallback !== null ? BASIS_WORDS[fallback.basis] : `v${String(pair.from)} to v${String(pair.to)}`;
  const options = [...list.versions].sort((a, b) => b.version - a.version);

  return (
    <section aria-label="Changes between versions" className="fy-diff" data-agenda-diff="" id={id}>
      <div className="fy-diff__head">
        <p className="fy-diff__basis m-0" data-agenda-diff-basis="">
          <strong>{heading}</strong>
          {custom === null && fallback !== null ? (
            <span className="fy-diff__range">{` · v${String(pair.from)} to v${String(pair.to)}`}</span>
          ) : null}
        </p>
        <div className="fy-diff__pickers">
          <label className="fy-diff__pick" htmlFor={fromId}>
            <span>From</span>
            <select
              className="fy-diff__select"
              data-agenda-diff-from=""
              id={fromId}
              onChange={event => choose(Number(event.currentTarget.value), pair.to)}
              value={pair.from}
            >
              {options.map(version => (
                <option key={version.version} value={version.version}>
                  {versionLabel(version, now)}
                </option>
              ))}
            </select>
          </label>
          <label className="fy-diff__pick" htmlFor={toId}>
            <span>To</span>
            <select
              className="fy-diff__select"
              data-agenda-diff-to=""
              id={toId}
              onChange={event => choose(pair.from, Number(event.currentTarget.value))}
              value={pair.to}
            >
              {options.map(version => (
                <option key={version.version} value={version.version}>
                  {versionLabel(version, now)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {loaded.state === 'loading' ? (
        <p className="fy-diff__note m-0" role="status">
          Reading both versions…
        </p>
      ) : loaded.state === 'failed' ? (
        <p className="fy-diff__note m-0" role="alert">
          One of these versions could not be read. Try again in a moment.
        </p>
      ) : (
        <>
          <p className="fy-diff__summary m-0" data-agenda-diff-summary="" role="status">
            {pair.from === pair.to ? 'Pick two different versions to compare.' : diffSummary(diff)}
          </p>
          <p className="fy-diff__legend m-0">
            <ins>Underlined</ins> was added. <del>Struck through</del> was removed.
          </p>
          {changed.map(section => (
            <SectionChange key={section.key} section={section} />
          ))}
          {unchanged.length === 0 ? null : (
            <details className="fy-diff__unchanged" data-agenda-diff-unchanged="">
              <summary>
                {unchanged.length === 1 ? '1 section unchanged' : `${String(unchanged.length)} sections unchanged`}
              </summary>
              <ul className="fy-diff__unchanged-list">
                {unchanged.map(section => (
                  <li key={section.key}>{section.label}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
