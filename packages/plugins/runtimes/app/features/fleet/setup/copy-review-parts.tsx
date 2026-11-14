/**
 * What a copy shows BEFORE anything is written. A copy brings in hooks, skills, scripts and MCP commands from another
 * machine, so a compromised source is how a command gets planted on the others: every command and every document the
 * copy would run is on screen IN FULL (never a placeholder standing in for its text), for a first copy and for a repeat
 * one, including a command that CHANGED since the last copy, each login's own variables, and — at the confirm step — the
 * daemon's whole description of what it will do.
 */

import { SetupNote, SetupSection } from '@ferretry/app/ui';
import type { ReactNode } from 'react';
import type { AccountChangeView, CloneReview, CloneReviewItem, CloneReviewLogin } from '../../../../contract/index.ts';

type Entry = NonNullable<CloneReviewItem['runnable']>['entries'][number];

/** The words an item's outcome is read in. */
const OUTCOME_WORDS: Readonly<Record<CloneReviewItem['outcome'], string>> = {
  new: 'new here',
  theirs: 'changed on the source',
  mine: 'changed here, kept',
  both: 'changed on both machines (kept as it is here unless you tick it)',
  gone: 'the source no longer has it',
  'removed-here': 'copied before and removed here',
};

/** Every command, variable and document, in full: a document's own text is shown, wrapped, never hidden. */
function RunnableEntries({ entries }: { readonly entries: readonly Entry[] }): ReactNode {
  return (
    <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-copy-entries="">
      {entries.map(entry => (
        <li key={`${entry.label}:${entry.text}`} className="flex min-w-0 flex-col gap-1">
          <span className="text-meta font-semibold text-muted">{entry.label}</span>
          {entry.document ? (
            <pre
              className="m-0 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-control bg-surface p-2 font-mono text-meta [overflow-wrap:anywhere]"
              data-copy-document=""
            >
              {entry.text}
            </pre>
          ) : (
            <span className="font-mono text-meta [overflow-wrap:anywhere]">{entry.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One item the review lists: what it is, how it stands, what changes, what it needs, and — if it runs — everything it runs. */
export function ReviewItem({
  item,
  ticked,
  onTick,
}: {
  readonly item: CloneReviewItem;
  /** Whether the copy writes this item; only an item that RUNS something can be unticked here. */
  readonly ticked: boolean;
  readonly onTick: (on: boolean) => void;
}): ReactNode {
  return (
    <li className="kt-panel flex min-w-0 flex-col gap-2 p-3" data-copy-item={item.ref}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-mono text-cell font-semibold text-fg [overflow-wrap:anywhere]">{item.ref}</span>
        <span className="text-meta text-muted">{OUTCOME_WORDS[item.outcome]}</span>
      </div>
      {item.files.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-copy-files="">
          {item.files.map(file => (
            <li key={file.path} className="text-meta text-muted [overflow-wrap:anywhere]">
              {file.change} <span className="font-mono">{file.path}</span>
              {file.lines === undefined ? '' : ` (+${String(file.lines.added)} −${String(file.lines.removed)})`}
            </li>
          ))}
        </ul>
      )}
      {item.fields === undefined || item.fields.length === 0 ? null : (
        <p className="m-0 text-meta text-muted [overflow-wrap:anywhere]">Changes: {item.fields.join(', ')}</p>
      )}
      {item.needs === undefined || item.needs.length === 0 ? null : (
        <p className="m-0 text-meta text-muted [overflow-wrap:anywhere]">Needs: {item.needs.join('; ')}</p>
      )}
      {item.note === undefined ? null : (
        <p className="m-0 text-meta text-muted [overflow-wrap:anywhere]">{item.note}</p>
      )}
      {item.runnable === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-2" data-copy-runnable={item.ref}>
          <label className="flex min-w-0 items-center gap-2 text-cell font-semibold text-fg">
            <input type="checkbox" checked={ticked} onChange={event => onTick(event.target.checked)} />
            <span>Copy this: it starts or runs what is shown</span>
          </label>
          <RunnableEntries entries={item.runnable.entries} />
        </div>
      )}
    </li>
  );
}

/** The settings keys that differ, with both values (configuration text, never a secret), and what taking one would loosen. */
export function SettingsChanges({ review }: { readonly review: CloneReview }): ReactNode {
  const docs = review.settings.filter(doc => doc.keys.length > 0 || doc.refused !== undefined);
  if (docs.length === 0) return null;
  return (
    <SetupSection title="Settings that differ" name="copy-settings-changes">
      {docs.map(doc => (
        <div key={doc.path} className="flex min-w-0 flex-col gap-1" data-copy-settings-doc={doc.path}>
          <span className="font-mono text-cell font-semibold text-fg">{doc.path}</span>
          {doc.refused === undefined ? null : <span className="text-meta text-warn">{doc.refused}</span>}
          {doc.keys.map(key => (
            <p
              key={key.key}
              className="m-0 text-meta text-muted [overflow-wrap:anywhere]"
              data-copy-settings-key={key.key}
            >
              <span className="font-mono">{key.key}</span>: {key.mine === undefined ? 'unset here' : key.mine} →{' '}
              {key.theirs === undefined ? 'removed' : key.theirs}
              {key.loosens === true ? ' (loosens what this machine may spend or its agents may do)' : ''}
              {key.choice === undefined ? ' — kept as it is here' : key.choice === 'take' ? ' — taken' : ' — kept'}
            </p>
          ))}
        </div>
      ))}
    </SetupSection>
  );
}

/** The logins a copy settles: a sign-in becomes an empty slot, and an environment login brings its variables, shown in full. */
export function LoginRows({ logins }: { readonly logins: readonly CloneReviewLogin[] }): ReactNode {
  if (logins.length === 0) return null;
  return (
    <SetupSection title="Logins" name="copy-logins-list">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {logins.map(login => (
          <li
            key={login.sourceId}
            className="kt-panel flex min-w-0 flex-col gap-1 p-3"
            data-copy-login={login.sourceId}
          >
            <span className="font-mono text-cell font-semibold text-fg [overflow-wrap:anywhere]">{login.sourceId}</span>
            <span className="text-meta text-muted">
              {login.outcome === 'matched'
                ? `uses ${login.target ?? 'a login here'}`
                : login.outcome === 'slot'
                  ? 'an empty slot to sign in to'
                  : 'arrives as an empty slot to sign in to'}
            </span>
            {login.runnable === undefined ? null : <RunnableEntries entries={login.runnable.entries} />}
          </li>
        ))}
      </ul>
    </SetupSection>
  );
}

/** The confirm step: the daemon's one-line summary, its consequences, and — whole — what it says this copy will do. */
export function ConfirmDescription({ staged }: { readonly staged: AccountChangeView }): ReactNode {
  return (
    <SetupNote tone="pend" name="copy-confirm" title={staged.summary}>
      {staged.preview.kind === 'executor' ? (
        <p
          className="m-0 whitespace-pre-wrap text-cell leading-base text-fg [overflow-wrap:anywhere]"
          data-copy-description=""
        >
          {staged.preview.description}
        </p>
      ) : null}
      {staged.consequences.map(line => (
        <span key={line}>{line}</span>
      ))}
    </SetupNote>
  );
}
