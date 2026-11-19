/**
 * "We found": what the host's own setup holds for one tool, grouped, each with a checkbox and what it BECOMES in Ferretry.
 * Below it, the fixed lines: hooks and project instructions that stay where they are, and the one-way conversations line.
 * Names only: the scan carries no value, so this draws none.
 */
import { Lock } from 'lucide-react';
import { useId } from 'react';
import type { ImportItemId } from '../../../contract/index.ts';
import type { FoundGroup, FoundItem, LeftAlone, UpdateItem } from './model.ts';
import { becomes } from './mapping-words.ts';
import {
  CONVERSATIONS_LINE,
  GITHUB_TOKEN_SENTENCE,
  HOOKS_NOT_IMPORTED,
  plural,
  PROJECT_INSTRUCTIONS_STAY,
  SECRET_KEPT,
  VAULT_VS_ENVIRONMENT,
} from './mapping-words.ts';

function Row({
  item,
  on,
  onChange,
  name,
  plain = false,
  children,
}: {
  readonly item: FoundItem;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
  readonly name: string;
  /** A row with no item id of its own (a changed source): always a choice, and its words stand as written. */
  readonly plain?: boolean;
  readonly children?: React.ReactNode;
}) {
  const id = useId();
  return (
    <li className="min-w-0" data-found-item={item.id ?? item.label}>
      <label
        htmlFor={id}
        data-found-row={name}
        className="kt-panel flex min-h-[44px] min-w-0 cursor-pointer items-start gap-3 p-panel hover:border-accent has-[input:not(:checked)]:opacity-70 has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus"
      >
        <input
          id={id}
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
          checked={on}
          disabled={item.id === null && !plain}
          onChange={event => onChange(event.currentTarget.checked)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">{item.label}</span>
          <span className="text-cell text-fg" data-found-becomes="">
            {plain ? item.becomes : `Becomes: ${item.becomes}${item.id === null ? ' · comes in with the rest' : ''}`}
          </span>
          {children}
        </span>
      </label>
    </li>
  );
}

/** One GitHub-token variable: its own choice, unticked until ticked (ferrets use the connected GitHub account instead). */
function TokenRow({
  name,
  on,
  disabled,
  onChange,
}: {
  readonly name: string;
  readonly on: boolean;
  readonly disabled: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <li className="min-w-0" data-found-token={name}>
      <label
        htmlFor={id}
        className="kt-panel flex min-h-[44px] min-w-0 cursor-pointer items-start gap-3 p-panel hover:border-accent has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus"
      >
        <input
          id={id}
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
          checked={on && !disabled}
          disabled={disabled}
          onChange={event => onChange(event.currentTarget.checked)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="inline-flex items-center gap-1 text-row font-semibold text-fg">
            <Lock size={12} aria-hidden="true" className="shrink-0 text-accent" />
            <code className="[overflow-wrap:anywhere]">{name}</code>
          </span>
          <span className="text-cell text-fg">{`Becomes: ${becomes('claude-code', 'env')} (kept in the Vault)`}</span>
          <span className="text-cell text-fg" data-found-token-note="">
            {GITHUB_TOKEN_SENTENCE}
          </span>
        </span>
      </label>
    </li>
  );
}

function Fixed({
  name,
  title,
  children,
}: {
  readonly name: string;
  readonly title: string;
  readonly children: string;
}) {
  return (
    <li
      className="flex min-h-[44px] min-w-0 flex-col gap-1 rounded-md border border-dashed border-border-strong p-panel"
      data-found-fixed={name}
    >
      <span className="text-row font-semibold text-muted">{title}</span>
      <span className="text-cell text-muted">{children}</span>
    </li>
  );
}

export interface FoundListProps {
  readonly harness: string;
  readonly groups: readonly FoundGroup[];
  readonly left: ReadonlySet<ImportItemId>;
  readonly leftAlone: LeftAlone;
  readonly onToggle: (id: ImportItemId, on: boolean) => void;
  /** The GitHub-token variables the person ticked; none until they do. */
  readonly tickedEnv: ReadonlySet<string>;
  readonly onTickEnv: (name: string, on: boolean) => void;
  /** Sources changed since the last import: each is taken again unless unticked. */
  readonly updates: readonly UpdateItem[];
  readonly declined: ReadonlySet<string>;
  readonly onTakeUpdate: (reference: string, on: boolean) => void;
}

export function FoundList({
  harness,
  groups,
  left,
  leftAlone,
  onToggle,
  tickedEnv,
  onTickEnv,
  updates,
  declined,
  onTakeUpdate,
}: FoundListProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-found-list={harness}>
      {updates.length === 0 ? null : (
        <section className="flex min-w-0 flex-col gap-2" data-found-group="updates">
          <h4 className="m-0 text-meta font-semibold uppercase text-muted">
            Changed since you last brought it in{updates.length > 1 ? ` · ${String(updates.length)}` : ''}
          </h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {updates.map(update => (
              <Row
                key={update.reference}
                name="updates"
                item={{
                  id: null,
                  label: update.reference,
                  becomes: `Updated from ${update.sources.join(', ')}. Unticked, it is kept as it was`,
                }}
                on={!declined.has(update.reference)}
                onChange={on => onTakeUpdate(update.reference, on)}
                plain
              />
            ))}
          </ul>
        </section>
      )}
      {groups.map(group => (
        <section key={group.key} className="flex min-w-0 flex-col gap-2" data-found-group={group.key}>
          <h4 className="m-0 text-meta font-semibold uppercase text-muted">
            {group.title}
            {group.items.length > 1 ? ` · ${String(group.items.length)}` : ''}
          </h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {group.items.map(item => (
              <Row
                key={item.id ?? item.label}
                item={item}
                name={group.key}
                on={item.id === null || !left.has(item.id)}
                onChange={on => {
                  if (item.id !== null) onToggle(item.id, on);
                }}
              >
                {group.locked === undefined ? null : (
                  <span className="flex min-w-0 flex-col gap-1" data-found-locked="">
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                      {group.locked.map(key => (
                        <span key={key} className="inline-flex items-center gap-1 text-cell text-fg">
                          <Lock size={12} aria-hidden="true" className="shrink-0 text-accent" />
                          <code className="[overflow-wrap:anywhere]">{key}</code>
                        </span>
                      ))}
                    </span>
                    <span className="text-cell text-fg">{`Secret-looking keys are ${SECRET_KEPT}. ${VAULT_VS_ENVIRONMENT}`}</span>
                  </span>
                )}
              </Row>
            ))}
            {(group.githubTokens ?? []).map(name => (
              <TokenRow
                key={name}
                name={name}
                on={tickedEnv.has(name)}
                disabled={group.items.some(item => item.id !== null && left.has(item.id))}
                onChange={on => onTickEnv(name, on)}
              />
            ))}
          </ul>
        </section>
      ))}
      <ul className="m-0 flex list-none flex-col gap-2 p-0" data-found-left-alone="">
        {leftAlone.hooks > 0 ? (
          <Fixed name="hooks" title={`Hooks (${String(leftAlone.hooks)})`}>
            {HOOKS_NOT_IMPORTED}
          </Fixed>
        ) : null}
        {leftAlone.projectFolders > 0 ? (
          <Fixed
            name="project-instructions"
            title={`Project instructions (${plural(leftAlone.projectFolders, 'folder')})`}
          >
            {PROJECT_INSTRUCTIONS_STAY}
          </Fixed>
        ) : null}
        <Fixed name="conversations" title="Conversations">
          {CONVERSATIONS_LINE.replace(/^Conversations: /u, '')}
        </Fixed>
      </ul>
    </div>
  );
}
