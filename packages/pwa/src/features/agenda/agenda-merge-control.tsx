/**
 * WHERE AN ITEM CAME FROM, AND "MERGE WITH…" (docs/agenda.md § The item view, "Merge and split"). A line under the head
 * says what joined or left this item ("Merged into !A2", "Split from !A3", "Split into !A7, !A8") through the ONE reference
 * renderer, so each `!A…` reads and opens as it does in a message. Beside it, an open plain conversation offers "Merge
 * with…": a picker of the other open agendas, then a confirm step that says what will happen before anything is sent.
 * There is no split button: a split is made by the ferret, and the item only shows where it came from.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { type ReactNode, useId, useState } from 'react';
import {
  candidateLine,
  flipLabel,
  type LineageLine,
  type LineageTitles,
  lineageLines,
  mergeChoice,
  mergeWords,
  pickerLead,
} from '../../lib/agenda-merge.ts';
import type { AgendaMergeView } from './use-item-lifecycle.ts';

type Prose = (text: string) => ReactNode;

type Step =
  | { readonly step: 'closed' }
  | { readonly step: 'pick' }
  | { readonly step: 'confirm'; readonly picked: AgendaItem; readonly keepPicked: boolean };

function MergePanel({
  item,
  merge,
  renderProse,
  onDone,
}: {
  readonly item: AgendaItem;
  readonly merge: AgendaMergeView;
  readonly renderProse: Prose;
  readonly onDone: () => void;
}) {
  const [state, setState] = useState<Step>({ step: 'pick' });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupId = useId();
  const keepId = useId();

  if (state.step === 'closed') return null;
  if (state.step === 'pick') {
    return (
      <div className="fy-merge__panel" data-agenda-merge-picker="">
        <p className="fy-merge__lead m-0" id={groupId}>
          {pickerLead(item)}
        </p>
        {merge.candidates.length === 0 ? (
          <p className="fy-merge__note m-0" data-agenda-merge-none="">
            There is no other open conversation to merge with.
          </p>
        ) : (
          <ul aria-labelledby={groupId} className="fy-merge__list">
            {merge.candidates.map(candidate => (
              <li key={candidate.id}>
                <button
                  className="fy-merge__choice"
                  data-agenda-merge-candidate={candidate.id}
                  onClick={() => setState({ step: 'confirm', picked: candidate, keepPicked: false })}
                  type="button"
                >
                  {candidateLine(candidate)}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="fy-merge__quiet" onClick={onDone} type="button">
          Cancel
        </button>
      </div>
    );
  }

  const choice = mergeChoice(item, state.picked, state.keepPicked);
  const words = mergeWords(choice, item.id);
  const send = (): void => {
    setSending(true);
    setError(null);
    merge
      .merge(choice.survivor.id, choice.absorbed.id)
      .then(onDone)
      .catch((failure: unknown) => {
        setSending(false);
        setError(failure instanceof Error ? failure.message : 'The merge was not sent.');
      });
  };
  return (
    <div className="fy-merge__panel" data-agenda-merge-confirm="">
      <p className="fy-merge__lead m-0">{words.question}</p>
      <div className="fy-merge__note">{renderProse(words.outcome)}</div>
      <p className="fy-merge__note m-0">{words.kept}</p>
      <label className="fy-merge__flip" htmlFor={keepId}>
        <input
          checked={state.keepPicked}
          disabled={sending}
          id={keepId}
          onChange={event => setState({ ...state, keepPicked: event.currentTarget.checked })}
          type="checkbox"
        />
        <span>{flipLabel(state.picked)}</span>
      </label>
      {error === null ? null : (
        <p className="fy-merge__error m-0" role="alert">
          {error}
        </p>
      )}
      <div className="fy-merge__actions">
        <button className="fy-merge__go" data-agenda-merge-go="" disabled={sending} onClick={send} type="button">
          {words.button}
        </button>
        <button className="fy-merge__quiet" disabled={sending} onClick={() => setState({ step: 'pick' })} type="button">
          Back
        </button>
        <button className="fy-merge__quiet" disabled={sending} onClick={onDone} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The lineage lines and the merge control; nothing at all when the item has neither. */
export function AgendaLineage({
  item,
  merge,
  titles,
  renderProse,
}: {
  readonly item: AgendaItem;
  readonly merge: AgendaMergeView | undefined;
  /** The titles of the agendas this one names, where the board holds them. */
  readonly titles?: LineageTitles | undefined;
  readonly renderProse: Prose;
}) {
  const [open, setOpen] = useState(false);
  const lines: readonly LineageLine[] = lineageLines(item, titles);
  if (lines.length === 0 && merge === undefined) return null;
  return (
    <div className="fy-merge" data-agenda-lineage="">
      <div className="fy-merge__row">
        <ul className="fy-merge__lines">
          {lines.map(line => (
            <li data-agenda-lineage-line={line.key} key={line.key}>
              {renderProse(line.text)}
            </li>
          ))}
        </ul>
        {merge === undefined || open ? null : (
          <button
            aria-expanded={open}
            className="fy-merge__open"
            data-agenda-merge-open=""
            onClick={() => setOpen(true)}
            type="button"
          >
            Merge with…
          </button>
        )}
      </div>
      {merge !== undefined && open ? (
        <MergePanel item={item} merge={merge} onDone={() => setOpen(false)} renderProse={renderProse} />
      ) : null}
    </div>
  );
}
