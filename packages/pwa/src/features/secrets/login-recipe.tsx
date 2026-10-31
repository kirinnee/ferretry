/**
 * One saved login's recipe: how it signs in, what Ferretry saw while it did, and the ferret's suggested
 * changes waiting for the owner. None of it is secret; a recipe holding a saved value is refused by the daemon.
 */

import {
  LOGIN_RECIPE_MAX_LENGTH,
  type LoginEntrySummary,
  type PutLoginEntryRequest,
  observedWords,
  recipeDiff,
} from '@ferretry/protocol';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

type Write = Promise<boolean> | boolean;

export interface LoginRecipeProps {
  readonly entry: LoginEntrySummary;
  readonly busy: boolean;
  /** The refusal the daemon last gave, shown here when this section's own action caused it. */
  readonly error: string | null;
  readonly onPut: (id: string, body: PutLoginEntryRequest) => Write;
  readonly onDecide: (id: string, proposalId: string, decision: 'approve' | 'decline') => Write;
  /** Told when an action here was refused, so the card does not show the same message twice. */
  readonly onRefused: (id: string) => void;
}

const DIFF_TONE = {
  ' ': 'text-muted',
  '-': 'bg-err-bg text-err',
  '+': 'bg-ok-bg text-ok',
} as const;

export function LoginRecipe({ entry, busy, error, onPut, onDecide, onRefused }: LoginRecipeProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.recipe ?? '');
  const [refused, setRefused] = useState(false);
  const proposals = entry.proposals ?? [];
  const observed = entry.observed ?? [];

  const act = async (write: Write, then?: () => void): Promise<void> => {
    setRefused(false);
    const ok = await write;
    if (ok) then?.();
    else {
      setRefused(true);
      onRefused(entry.id);
    }
  };

  const open = () => {
    setText(entry.recipe ?? '');
    setRefused(false);
    setEditing(true);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() !== '' && !busy) void act(onPut(entry.id, { recipe: text }), () => setEditing(false));
  };
  const problem = refused && error !== null ? error : null;
  const fault =
    problem === null ? null : (
      <p role="alert" className="m-0 text-cell text-err" data-login-recipe-error="">
        {problem}
      </p>
    );

  return (
    <section
      className="flex min-w-0 flex-col gap-2 border-t border-border pt-2"
      aria-label={`Recipe for ${entry.label}`}
      data-login-recipe=""
    >
      <h4 className="m-0 text-cell font-semibold text-fg">Recipe</h4>

      {editing ? (
        <form className="flex min-w-0 flex-col gap-2" onSubmit={submit} aria-label={`Edit recipe for ${entry.label}`}>
          <label htmlFor={`recipe-${entry.id}`} className="text-cell font-medium text-fg">
            Recipe (Markdown)
          </label>
          <textarea
            id={`recipe-${entry.id}`}
            className="kt-input mono min-h-[140px] w-full resize-y rounded-control border border-border bg-surface-2 p-2 text-cell text-fg"
            value={text}
            maxLength={LOGIN_RECIPE_MAX_LENGTH}
            spellCheck={false}
            data-login-recipe-text=""
            onChange={event => setText(event.target.value)}
          />
          {fault}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="kt-btn min-h-[44px]"
              data-variant="primary"
              disabled={text.trim() === '' || busy}
            >
              <Check size={14} aria-hidden="true" /> Save recipe
            </button>
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              onClick={() => {
                setEditing(false);
                setRefused(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {entry.recipe === undefined ? (
            <p className="m-0 text-cell text-faint" data-login-recipe-empty="">
              No recipe yet.
            </p>
          ) : (
            <>
              {entry.recipeBy === 'ferret' && (
                <p className="m-0 text-cell text-warn" data-login-recipe-unreviewed="">
                  Written by a ferret, not reviewed. Edit or save it to make it yours.
                </p>
              )}
              {/* Plain text, not Markdown: a recipe a ferret wrote must not load images or show a link unlike its target. */}
              <p className="m-0 min-w-0 whitespace-pre-wrap break-words text-cell" data-login-recipe-body="">
                {entry.recipe}
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              disabled={busy}
              onClick={open}
              aria-label={`${entry.recipe === undefined ? 'Add' : 'Edit'} recipe for ${entry.label}`}
            >
              {entry.recipe === undefined ? (
                <Plus size={14} aria-hidden="true" />
              ) : (
                <Pencil size={14} aria-hidden="true" />
              )}{' '}
              {entry.recipe === undefined ? 'Add recipe' : 'Edit recipe'}
            </button>
            {entry.recipe !== undefined && (
              <button
                type="button"
                className="kt-btn min-h-[44px]"
                data-variant="danger"
                disabled={busy}
                aria-label={`Remove recipe from ${entry.label}`}
                onClick={() => void act(onPut(entry.id, { recipe: null }))}
              >
                <Trash2 size={14} aria-hidden="true" /> Remove recipe
              </button>
            )}
          </div>
        </>
      )}

      {observed.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1" data-login-observed="">
          <h5 className="m-0 text-cell font-semibold text-fg">What Ferretry saw</h5>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {observed.map(seen => (
              <li key={`${seen.surface}:${seen.at}`} className="min-w-0 break-words text-meta text-muted">
                {observedWords(seen)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {proposals.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2" data-login-proposals="">
          <h5 className="m-0 text-cell font-semibold text-fg">Proposed changes</h5>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {proposals.map(proposal => (
              <li
                key={proposal.id}
                className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface p-2"
                data-login-proposal={proposal.id}
              >
                <p className="m-0 min-w-0 break-words text-cell text-fg" data-login-proposal-why="">
                  The ferret says: {proposal.why}
                </p>
                <p className="m-0 text-meta text-faint">{proposal.proposedAt.slice(0, 10)}</p>
                <pre
                  className="mono m-0 min-w-0 whitespace-pre-wrap break-words rounded-control border border-border p-0 text-meta"
                  data-login-diff=""
                >
                  {recipeDiff(proposal.base, proposal.recipe).map((line, index) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity beyond its place
                      key={index}
                      className={`block px-2 ${DIFF_TONE[line.op]}`}
                      data-diff-op={line.op}
                    >
                      {line.op === ' ' ? '  ' : `${line.op} `}
                      {line.text}
                    </span>
                  ))}
                </pre>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="kt-btn min-h-[44px]"
                    data-variant="primary"
                    disabled={busy}
                    aria-label={`Approve recipe change for ${entry.label}`}
                    onClick={() => void act(onDecide(entry.id, proposal.id, 'approve'))}
                  >
                    <Check size={14} aria-hidden="true" /> Approve
                  </button>
                  <button
                    type="button"
                    className="kt-btn min-h-[44px]"
                    disabled={busy}
                    aria-label={`Decline recipe change for ${entry.label}`}
                    onClick={() => void act(onDecide(entry.id, proposal.id, 'decline'))}
                  >
                    <X size={14} aria-hidden="true" /> Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!editing && fault}

      <label className="flex min-h-[44px] items-center gap-2 text-cell text-fg">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={entry.autoApplyRecipe === true}
          disabled={busy}
          data-login-auto-apply=""
          onChange={event => void act(onPut(entry.id, { autoApplyRecipe: event.target.checked }))}
        />
        <span>Apply ferret recipe changes without asking</span>
      </label>
    </section>
  );
}
