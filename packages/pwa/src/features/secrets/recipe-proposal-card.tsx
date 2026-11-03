/**
 * A ferret's suggested sign-in recipe, drawn where it is suggested: the steps it would follow, against the ones it
 * replaces, the ferret's words, what Ferretry itself saw, and the owner's three answers. Drawn from what the host read;
 * it reads and sends nothing. None of it is secret: a recipe holds no value.
 */

import { type LoginObserved, LOGIN_RECIPE_MAX_LENGTH, observedWords } from '@ferretry/protocol';
import { Check, Eye, Pencil, ShieldCheck, X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import {
  changeWords,
  RECIPE_APPROVES_WORDS,
  RECIPE_SAW_NOTE,
  type RecipeChange,
  type RecipeStep,
  recipeEditProblem,
} from '../../lib/recipe-proposal.ts';

export interface RecipeProposalCardProps {
  readonly place: string;
  readonly ferret: string;
  readonly why: string;
  readonly version: number | undefined;
  readonly change: RecipeChange;
  /** The daemon's own observations of this sign-in; absent or empty: the box is not drawn. */
  readonly observed: readonly LoginObserved[];
  /** The owner's text while editing; `null`: the steps are shown, not edited. */
  readonly editing: string | null;
  readonly busy: boolean;
  /** The recipe changed under the proposal: shown above the buttons. */
  readonly stale?: string;
  /** Any other refusal, in words. */
  readonly error?: string;
  /** The proposal is gone (it was decided elsewhere or went stale): the words stay, the answers do not. */
  readonly closed?: boolean;
  readonly onApprove: () => void;
  readonly onDecline: () => void;
  readonly onEdit: () => void;
  readonly onText: (text: string) => void;
  readonly onApproveMine: () => void;
  readonly onCancel: () => void;
}

const STEP_STYLE: Readonly<Record<RecipeStep['kind'], string>> = {
  kept: 'text-fg',
  added: 'bg-ok-bg text-fg',
  removed: 'bg-err-bg text-muted line-through',
};
const NUMBER_STYLE: Readonly<Record<RecipeStep['kind'], string>> = {
  kept: 'text-faint',
  added: 'text-ok',
  removed: 'text-err',
};

function Steps({ steps }: { readonly steps: readonly RecipeStep[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-0.5 p-0" data-recipe-steps="">
      {steps.map((step, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: a step has no identity beyond its place
          key={index}
          className={`flex min-w-0 items-baseline gap-2 rounded-control px-2 py-1 text-cell ${STEP_STYLE[step.kind]}`}
          data-recipe-step={step.kind}
        >
          <span className={`mono w-6 shrink-0 text-right text-meta ${NUMBER_STYLE[step.kind]}`} aria-hidden="true">
            {step.kind === 'removed' ? '−' : step.kind === 'added' ? `+${String(step.number)}` : String(step.number)}
          </span>
          <span className="min-w-0 break-words">
            {step.kind === 'removed' ? <span className="sr-only">Removed: </span> : null}
            {step.kind === 'added' ? <span className="sr-only">Added: </span> : null}
            {step.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Saw({ observed }: { readonly observed: readonly LoginObserved[] }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-control border border-border-strong bg-surface-2 p-3"
      data-recipe-saw=""
    >
      <p className="m-0 flex items-center gap-1.5 text-cell font-semibold text-fg">
        <Eye aria-hidden="true" size={14} /> What Ferretry saw
      </p>
      <p className="m-0 text-meta text-faint">{RECIPE_SAW_NOTE}</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {observed.map(seen => (
          <li key={`${seen.surface}:${seen.at}`} className="min-w-0 break-words text-meta text-muted">
            {observedWords(seen)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RecipeProposalCard({
  place,
  ferret,
  why,
  version,
  change,
  observed,
  editing,
  busy,
  stale,
  error,
  closed = false,
  onApprove,
  onDecline,
  onEdit,
  onText,
  onApproveMine,
  onCancel,
}: RecipeProposalCardProps): ReactNode {
  const textId = useId();
  const problem = editing === null ? undefined : recipeEditProblem(editing);
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-recipe-proposal=""
      data-recipe-mode={editing === null ? 'view' : 'edit'}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-ui font-medium text-fg" data-recipe-title="">
          Sign-in steps for {place}
        </span>
        <span className="text-meta text-faint" data-recipe-change="">
          {changeWords(version, change)}
        </span>
      </div>

      {editing === null ? (
        <Steps steps={change.steps} />
      ) : (
        <div className="flex min-w-0 flex-col gap-1">
          <label className="text-cell font-medium text-fg" htmlFor={textId}>
            Your version
          </label>
          <textarea
            className="mono min-h-[168px] w-full min-w-0 resize-y rounded-control border border-border-strong bg-surface p-2 text-cell text-fg"
            data-recipe-text=""
            id={textId}
            maxLength={LOGIN_RECIPE_MAX_LENGTH}
            onChange={event => onText(event.target.value)}
            rows={7}
            spellCheck={false}
            value={editing}
          />
          <p className="m-0 text-meta text-muted">
            Saved as your own recipe. The ferret’s version is closed as replaced.
          </p>
        </div>
      )}

      <p className="m-0 min-w-0 break-words text-meta text-faint" data-recipe-why="">
        {ferret} says: “{why}”
      </p>
      {editing === null && observed.length > 0 ? <Saw observed={observed} /> : null}

      <p className="m-0 flex items-start gap-2 text-cell text-muted" data-recipe-approves="">
        <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
        <span>
          Every ferret signs in to {place} this way once you approve. {RECIPE_APPROVES_WORDS}
        </span>
      </p>

      {stale === undefined ? null : (
        <p className="m-0 text-ui text-warn" data-recipe-stale="" role="alert">
          {stale}
        </p>
      )}
      {error === undefined ? null : (
        <p className="m-0 text-ui text-err" data-recipe-error="" role="alert">
          {error}
        </p>
      )}
      {problem !== undefined && editing !== null && editing !== '' ? (
        <p className="m-0 text-meta text-err" data-recipe-problem="">
          {problem}
        </p>
      ) : null}

      {closed ? null : (
        <div className="flex flex-wrap items-center justify-end gap-2" data-recipe-actions="">
          {editing === null ? (
            <>
              <button
                className="kt-btn min-h-[44px]"
                data-recipe-decline=""
                disabled={busy}
                onClick={onDecline}
                type="button"
              >
                <X aria-hidden="true" size={14} /> Decline
              </button>
              <button
                className="kt-btn min-h-[44px]"
                data-recipe-edit=""
                disabled={busy}
                onClick={onEdit}
                type="button"
              >
                <Pencil aria-hidden="true" size={14} /> Edit
              </button>
              <button
                className="kt-btn min-h-[44px]"
                data-recipe-approve=""
                data-variant="primary"
                disabled={busy}
                onClick={onApprove}
                type="button"
              >
                <Check aria-hidden="true" size={14} /> Approve
              </button>
            </>
          ) : (
            <>
              <button
                className="kt-btn min-h-[44px]"
                data-recipe-cancel=""
                disabled={busy}
                onClick={onCancel}
                type="button"
              >
                Cancel
              </button>
              <button
                className="kt-btn min-h-[44px]"
                data-recipe-approve-mine=""
                data-variant="primary"
                disabled={busy || problem !== undefined}
                onClick={onApproveMine}
                type="button"
              >
                <Check aria-hidden="true" size={14} /> Approve my version
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
