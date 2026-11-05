/**
 * Managing this daemon's secrets from a browser.
 *
 * WRITE-ONLY. A person can create a secret, replace one, and delete one. They cannot read one back,
 * and neither can this browser: the daemon serves no route that returns a value, so there is nothing
 * here to hide behind a "reveal" affordance. The mask is not a UI decision that could be undone by a
 * button — it is the only thing that exists.
 *
 * THE HONEST SENTENCE IS ON THE SCREEN, not only in a document nobody opens. "Agents cannot see
 * these" would be false; the true statement is that agents USE them without holding one, and that
 * this is not a defence against an agent deliberately trying to leak one.
 */

import { MIN_SECRET_VALUE_LENGTH, type SecretList, SecretNameSchema } from '@ferretry/protocol';
import { AlertTriangle, KeyRound, MoreHorizontal, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useInputModality } from '../../hooks/use-input-modality.ts';
import { cn } from '../../lib/class-names.ts';
import { ContextMenu, type MenuAnchor } from '../../shell/context-menu.tsx';
import { SECRET_LIMIT, SECRET_MASK, SECRET_PROMISE } from './secrets-api.ts';

export interface SecretsCardProps {
  readonly list: SecretList;
  readonly busy?: string | null;
  readonly error?: string | null;
  readonly onPut: (name: string, value: string) => void | Promise<void>;
  readonly onRemove: (name: string) => void | Promise<void>;
}

/** Why a draft cannot be saved yet, or nothing. Kept beside the form so the button's disabled state
 *  and the message a person reads can never disagree. */
export function secretDraftProblem(name: string, value: string, held: readonly string[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '' || value === '') return undefined;
  if (!SecretNameSchema.safeParse(trimmed).success)
    return 'A name is uppercase letters, digits and underscores — it becomes an environment variable.';
  if (value.length < MIN_SECRET_VALUE_LENGTH)
    return `At least ${MIN_SECRET_VALUE_LENGTH} characters. A shorter value cannot be masked out of output safely.`;
  return held.includes(trimmed) ? `${trimmed} already exists — saving replaces it.` : undefined;
}

/** What the daemon said when a write was refused. Its own component so the refusal is a statement
 *  the test tier can see executed, rather than a branch buried in one JSX expression. */
function WriteFailure({ error }: { readonly error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="m-0 text-ui text-err">
      {error}
    </p>
  );
}

/** One stored secret: its name, the mask and when it changed, a small Replace and a ⋯ menu that holds Delete. */
function SecretRow({
  secret,
  busy,
  onReplace,
  onRemove,
}: {
  readonly secret: SecretList['secrets'][number];
  readonly busy: boolean;
  readonly onReplace: () => void;
  readonly onRemove: () => void;
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const { touchAffected } = useInputModality();
  return (
    <li
      className="flex min-h-[var(--row-min-h)] min-w-0 flex-wrap items-center gap-x-2 gap-y-0 py-1 pl-panel pr-1"
      data-secret={secret.name}
    >
      <span className="flex min-w-0 flex-1 basis-40 flex-col">
        <span className="mono min-w-0 break-all text-ui font-semibold text-fg">{secret.name}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta leading-tight text-muted">
          {/* Not a placeholder for a value this browser holds — it holds none. */}
          <span data-secret-mask="" title="the value is never shown" className="mono tracking-widest text-faint">
            {SECRET_MASK}
          </span>
          <span>
            {secret.updatedAt === secret.createdAt ? 'set' : 'changed'} {secret.updatedAt.slice(0, 10)}
          </span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="kt-btn kt-btn--sm"
          disabled={busy}
          onClick={onReplace}
          aria-label={`Replace ${secret.name}`}
        >
          <RefreshCw size={14} aria-hidden="true" /> Replace
        </button>
        <button
          ref={moreRef}
          type="button"
          className="kt-btn kt-btn--sm"
          data-variant="ghost"
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-label={`More actions for ${secret.name}`}
          data-secret-more=""
          onClick={() => {
            const rect = moreRef.current?.getBoundingClientRect();
            setAnchor({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
          }}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
        <ContextMenu
          open={anchor !== null}
          anchor={anchor ?? { x: 0, y: 0 }}
          ariaLabel={`Actions for ${secret.name}`}
          triggerRef={moreRef}
          touch={touchAffected}
          onClose={() => setAnchor(null)}
          items={[
            {
              key: 'delete',
              label: `Delete ${secret.name}`,
              icon: <Trash2 size={14} aria-hidden="true" />,
              danger: true,
              onSelect: onRemove,
            },
          ]}
        />
      </span>
    </li>
  );
}

export function SecretsCard({ list, busy = null, error = null, onPut, onRemove }: SecretsCardProps) {
  const nameId = useId();
  const valueId = useId();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const held = list.secrets.map(secret => secret.name);
  const problem = secretDraftProblem(name, value, held);
  const ready =
    name.trim() !== '' &&
    value.length >= MIN_SECRET_VALUE_LENGTH &&
    SecretNameSchema.safeParse(name.trim()).success &&
    busy === null;
  const unresolved = list.references.filter(reference => !reference.resolved);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    void Promise.resolve(onPut(name.trim(), value)).then(() => {
      setName('');
      setValue('');
    });
  };

  return (
    <section
      className="kt-panel flex flex-col gap-3 p-panel"
      aria-labelledby="secrets-heading"
      data-testid="secrets-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="secrets-heading" className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
          <KeyRound size={16} className="text-accent" aria-hidden="true" />
          Secrets
        </h2>
        <span className="rounded-control bg-surface-2 px-2 py-0.5 text-meta font-medium text-faint">write-only</span>
      </div>

      <p className="m-0 text-cell leading-base text-muted">{SECRET_PROMISE}</p>
      <p className="m-0 text-meta leading-base text-faint">{SECRET_LIMIT}</p>

      {list.health === 'damaged' ? (
        <div
          role="alert"
          className="flex gap-2 rounded-control border border-warn bg-warn/10 p-3"
          data-testid="secrets-damaged"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <div className="min-w-0">
            <p className="m-0 text-ui font-semibold text-fg">This daemon cannot read its secret store</p>
            <p className="m-0 mt-1 text-cell leading-base text-muted">{list.diagnosis}</p>
            <p className="m-0 mt-1 text-meta leading-base text-warn">
              It is not empty. Do not set these again until it is readable, or you will write over entries that are
              still there.
            </p>
          </div>
        </div>
      ) : list.secrets.length === 0 ? (
        <p className="m-0 text-ui text-faint" data-testid="secrets-empty">
          No secrets on this daemon yet.
        </p>
      ) : (
        <ul className="kt-groupcard m-0 list-none p-0" aria-label="Stored secrets">
          {list.secrets.map(secret => (
            <SecretRow
              key={secret.name}
              secret={secret}
              busy={busy !== null}
              onReplace={() => setName(secret.name)}
              onRemove={() => void onRemove(secret.name)}
            />
          ))}
        </ul>
      )}

      {unresolved.length > 0 && (
        <div
          className="flex min-w-0 gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2"
          data-testid="secrets-unresolved"
        >
          <TriangleAlert size={14} className="mt-1 shrink-0 text-warn" aria-hidden="true" />
          <div className="min-w-0">
            <p className="m-0 text-ui font-semibold text-fg">Configuration names a secret this daemon does not hold</p>
            <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
              {unresolved.map(reference => (
                <li key={`${reference.name}:${reference.origin}`} className="text-meta text-muted">
                  <span className="mono font-medium text-warn">{reference.name}</span> ← {reference.origin}
                </li>
              ))}
            </ul>
            <p className="m-0 mt-1 text-meta leading-base text-muted">
              Anything that uses one of these is refused rather than run with a blank value.
            </p>
          </div>
        </div>
      )}

      <WriteFailure error={error} />

      <form className="flex min-w-0 flex-col gap-2" onSubmit={submit} aria-label="Add or replace a secret">
        <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta font-medium text-fg" htmlFor={nameId}>
            Name
            <input
              id={nameId}
              className="kt-input mono !h-control-sm !min-h-0 w-full rounded-control border border-border bg-surface-2 px-2 text-fg"
              value={name}
              placeholder="ANTHROPIC_API_KEY"
              autoComplete="off"
              onChange={event => setName(event.target.value.toUpperCase())}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta font-medium text-fg" htmlFor={valueId}>
            Value
            <input
              id={valueId}
              // `password` so it is not read over a shoulder, and `new-password` so no password
              // manager offers to keep a copy of a credential this browser is only relaying.
              type="password"
              autoComplete="new-password"
              className="kt-input !h-control-sm !min-h-0 w-full rounded-control border border-border bg-surface-2 px-2 text-fg"
              value={value}
              placeholder="paste it here — it is never shown again"
              onChange={event => setValue(event.target.value)}
            />
          </label>
          <button type="submit" className="kt-btn kt-btn--sm justify-center" data-variant="primary" disabled={!ready}>
            <Plus size={14} aria-hidden="true" /> {busy === null ? 'Save' : 'Saving…'}
          </button>
        </div>
        {problem !== undefined && (
          <p className={cn('m-0 text-meta', problem.includes('replaces') ? 'text-warn' : 'text-err')}>{problem}</p>
        )}
      </form>
    </section>
  );
}
