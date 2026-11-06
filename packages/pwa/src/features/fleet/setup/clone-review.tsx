/**
 * The Update review sheet (docs/design/account-model.md §3.8 L8–L16, §4.7; smart re-copy design §6).
 *
 * A repeat copy shows only what DIFFERS, in groups whose heading says what will happen:
 * New on <source> · Changed on <source> · Both changed — pick one · Changed here (kept) · Gone from
 * <source> · Logins and keys · ▸ N things already the same.
 *
 * - **Both changed has no default.** The two radios start unselected; `clone.tsx` keeps Apply off until
 *   each one is chosen, and says so next to the button.
 * - **Everything that would be written lists everything it runs**, in full (`runnable`); a changed
 *   document shows a line diff against this machine, with a way to read the whole file.
 * - **A login is only ever reused or added empty.** There is no control that removes a login or touches
 *   its credentials, and a "Gone" row is never a login.
 *
 * The sheet is a view: the choices live in `clone.tsx` and the rules in `clone-review-model.ts`.
 */

import type { CloneChoice, CloneReviewItem, CloneReviewLogin, FleetCloneReview } from '@ferretry/protocol';
import { type ReactNode, useId, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { browserClipboardWriter, type ClipboardWriter } from '../../onboarding/copy-button.tsx';
import { documentSize } from './clone-model.ts';
import { NewerKeyRow } from './clone-settings.tsx';
import {
  type DiffLine,
  type ItemCompare,
  type LoginPicks,
  lineCountWords,
  lineDiff,
  NEW_SLOT,
  type ReviewGroup,
  type ReviewPicks,
  chosenFor,
  loginTarget,
  reviewGroups,
  reviewItemTitle,
  sameMatchedByName,
  sameTitle,
} from './clone-review-model.ts';
import { SetupCommand, SetupDisclosure, SetupRow, SetupSection } from './setup-ui.tsx';
import { countWords, SETUP_HARNESS_NAMES } from './setup-words.ts';

// ── What an item runs ────────────────────────────────────────────────────────────────────────────

/**
 * Everything an item would run on this machine, entry by entry. A document is folded, because a hook
 * script can be long — but every line of it is there, and its size is on the fold.
 */
export function RunnableEntries({
  entries,
}: {
  readonly entries: readonly { readonly label: string; readonly text: string; readonly document: boolean }[];
}) {
  return (
    <dl className="m-0 flex min-w-0 flex-col gap-2" data-review-runs="">
      {entries.map((entry, index) => (
        <div key={`${entry.label}-${String(index)}`} className="flex min-w-0 flex-col gap-1">
          <dt className="[overflow-wrap:anywhere] text-meta text-muted">{entry.label}</dt>
          <dd className="m-0 min-w-0">
            {entry.document ? (
              <details className="min-w-0">
                <summary className="min-h-[44px] cursor-pointer text-cell text-fg">
                  Show all {documentSize(entry.text)}
                </summary>
                <SetupCommand>{entry.text}</SetupCommand>
              </details>
            ) : (
              <SetupCommand>{entry.text}</SetupCommand>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── A changed document ───────────────────────────────────────────────────────────────────────────

const DIFF_MARK: Readonly<Record<'same' | 'add' | 'del', string>> = { same: '  ', add: '+ ', del: '− ' };

function DiffView({ lines }: { readonly lines: readonly DiffLine[] }) {
  return (
    <pre
      className="m-0 min-w-0 whitespace-pre-wrap break-all rounded-control border border-border bg-surface-2 px-2 py-1 font-mono text-meta text-fg"
      data-review-diff=""
    >
      {lines.map((line, index) =>
        line.kind === 'skip' ? (
          <span key={`skip-${String(index)}`} className="block text-faint">
            … {countWords(line.count, 'unchanged line')} …
          </span>
        ) : (
          <span
            key={`${line.kind}-${String(index)}`}
            data-diff={line.kind}
            className={cn('block', line.kind === 'add' && 'text-ok', line.kind === 'del' && 'text-err')}
          >
            {DIFF_MARK[line.kind]}
            {line.text}
          </span>
        ),
      )}
    </pre>
  );
}

/** One file the item would write: where it lands, what changes, and the change itself. */
function FileChange({
  file,
  mine,
  theirs,
}: {
  readonly file: CloneReviewItem['files'][number];
  /** This machine's text at that path, when this browser could read it. */
  readonly mine: string | undefined;
  /** The other machine's text, when the bundle carries it at that path. */
  readonly theirs: string | undefined;
}) {
  const [whole, setWhole] = useState(false);
  const diff = file.change === 'changed' && mine !== undefined && theirs !== undefined ? lineDiff(mine, theirs) : null;
  const words = file.change === 'added' ? 'added' : file.change === 'removed' ? 'removed' : 'changed';
  const counted = file.lines === undefined ? '' : ` (${lineCountWords(file.lines)})`;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-review-file={file.path}>
      <span className="[overflow-wrap:anywhere] text-cell text-fg">
        <span className="font-mono">{file.path}</span> {words}
        {counted}
      </span>
      {theirs === undefined || file.change === 'removed' ? null : (
        <details className="min-w-0">
          <summary className="min-h-[44px] cursor-pointer text-cell font-semibold text-accent">
            {diff === null ? 'Show the whole file' : 'See the change'}
          </summary>
          <div className="flex min-w-0 flex-col gap-2">
            {diff === null || whole ? <SetupCommand>{theirs}</SetupCommand> : <DiffView lines={diff} />}
            {diff === null ? null : (
              <button
                type="button"
                className="min-h-[44px] self-start text-cell font-semibold text-accent underline"
                data-review-whole=""
                onClick={() => setWhole(current => !current)}
              >
                {whole ? 'Show only the change' : 'Show the whole file'}
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Here beside the source ───────────────────────────────────────────────────────────────────────

/**
 * What an item both sides changed holds on each side, line by line: the value here (the one "Keep mine"
 * keeps) beside the source's (the one "Use …’s" writes). A row that differs says so in words, not only in
 * colour. The item's full list of what it would run stays below, unchanged.
 */
function ComparePanel({
  compare,
  source,
  machineName,
}: {
  readonly compare: ItemCompare;
  readonly source: string;
  readonly machineName: string;
}) {
  if (compare.kind === 'none') return null;
  if (compare.kind === 'unreadable') {
    return (
      <span className="[overflow-wrap:anywhere] text-cell text-warn" data-review-compare="unreadable">
        What is on {machineName} now couldn’t be read, so only {source}’s version is shown.
      </span>
    );
  }
  const side = (value: string | null, label: string, name: string) => (
    <div className="flex min-w-0 flex-col gap-1" data-review-compare-side={name}>
      <span className="text-meta text-muted">{label}</span>
      {value === null ? <span className="text-cell text-faint">Not set</span> : <SetupCommand>{value}</SetupCommand>}
    </div>
  );
  return (
    <div className="flex min-w-0 flex-col gap-2" data-review-compare="">
      <span className="text-meta font-semibold text-muted">Here and on {source}</span>
      {compare.rows.map((row, index) => (
        <div
          key={`${row.label}-${String(index)}`}
          className="flex min-w-0 flex-col gap-1"
          data-review-compare-row={row.label}
          data-differs={row.differs ? 'yes' : 'no'}
        >
          <span className="[overflow-wrap:anywhere] text-meta text-muted">
            {row.label}
            {row.differs ? ' · differs' : ''}
          </span>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            {side(row.here, 'Here (mine)', 'here')}
            {side(row.source, source, 'source')}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── One row ──────────────────────────────────────────────────────────────────────────────────────

/** The choice a ticked and an unticked box stand for, by outcome. */
const TICKED: Readonly<Record<'new' | 'theirs' | 'gone' | 'removed-here', { on: CloneChoice; off: CloneChoice }>> = {
  new: { on: 'add', off: 'skip' },
  theirs: { on: 'take', off: 'keep' },
  gone: { on: 'remove', off: 'keep' },
  'removed-here': { on: 'add', off: 'keep' },
};

/** What the row says is going to happen, given the choice in force. */
const happening = (item: CloneReviewItem, choice: CloneChoice | undefined, machine: string, source: string): string => {
  switch (item.outcome) {
    case 'new':
      return choice === 'add' ? `Added to ${machine}` : 'Left out: not copied';
    case 'theirs':
      return choice === 'take' ? `Updated to ${source}’s version` : 'Stays as it is here';
    case 'gone':
      return choice === 'remove' ? `Removed from ${machine}` : `Stays on ${machine}`;
    case 'removed-here':
      return choice === 'add' ? `Brought back to ${machine}` : 'Stays removed';
    case 'mine':
      return 'Yours stays. Nothing is written';
    case 'both':
      return choice === 'take' ? `Uses ${source}’s version` : choice === 'keep' ? 'Keeps yours' : 'Not chosen yet';
  }
};

function ReviewItemRow({
  item,
  picks,
  source,
  machineName,
  onPick,
  mineFiles,
  theirFiles,
  compare,
}: {
  readonly item: CloneReviewItem;
  readonly picks: ReviewPicks;
  readonly source: string;
  readonly machineName: string;
  readonly onPick: (ref: string, choice: CloneChoice) => void;
  readonly mineFiles: ReadonlyMap<string, string>;
  readonly theirFiles: ReadonlyMap<string, string>;
  readonly compare: ItemCompare;
}) {
  const group = useId();
  const choice = chosenFor(item, picks);
  const title = reviewItemTitle(item);
  const ticks = item.outcome === 'both' || item.outcome === 'mine' ? undefined : TICKED[item.outcome];
  const detail = (
    <>
      <span
        className={cn('text-cell', item.outcome === 'both' && choice === undefined ? 'text-warn' : 'text-muted')}
        data-review-happens=""
      >
        {happening(item, choice, machineName, source)}
        {item.match === 'probable' ? ' · matched by name' : ''}
      </span>
      {item.note === undefined ? null : (
        <span className="[overflow-wrap:anywhere] text-cell text-muted" data-review-note="">
          {item.note}
        </span>
      )}
      {item.needs === undefined || item.needs.length === 0 ? null : (
        <span className="[overflow-wrap:anywhere] text-cell text-muted" data-review-needs="">
          Needs <span className="font-mono">{item.needs.join(', ')}</span>
        </span>
      )}
      {item.files.length === 0 && item.fields !== undefined && item.fields.length > 0 ? (
        <span className="[overflow-wrap:anywhere] text-cell text-muted">
          Changed: <span className="font-mono">{item.fields.join(', ')}</span>
        </span>
      ) : null}
      {item.outcome === 'both' ? <ComparePanel compare={compare} source={source} machineName={machineName} /> : null}
      {item.files.map(file => (
        <FileChange key={file.path} file={file} mine={mineFiles.get(file.path)} theirs={theirFiles.get(file.path)} />
      ))}
      {item.runnable === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-meta font-semibold text-muted">Runs on {machineName}</span>
          <RunnableEntries entries={item.runnable.entries} />
        </div>
      )}
    </>
  );

  return (
    <div
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      data-review-item={item.ref}
      data-outcome={item.outcome}
      data-choice={choice ?? 'none'}
    >
      {item.outcome === 'both' ? (
        <fieldset className="relative m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-1 [overflow-wrap:anywhere] text-row font-semibold text-fg">{title}</legend>
          {(
            [
              ['keep', 'Keep mine'],
              ['take', `Use ${source}’s`],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="relative flex min-h-[44px] min-w-0 cursor-pointer items-center gap-3 has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus"
            >
              <input
                type="radio"
                name={group}
                className="shrink-0 accent-[var(--accent)]"
                checked={choice === value}
                onChange={() => onPick(item.ref, value)}
                data-review-pick={`${item.ref}:${value}`}
              />
              <span className="text-row text-fg">{label}</span>
            </label>
          ))}
          <div className="flex min-w-0 flex-col gap-1">{detail}</div>
        </fieldset>
      ) : item.outcome === 'mine' ? (
        <>
          <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">{title}</span>
          <div className="flex min-w-0 flex-col gap-1">{detail}</div>
        </>
      ) : ticks === undefined ? null : (
        <label className="relative flex min-h-[44px] min-w-0 cursor-pointer items-start gap-3 has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus">
          <input
            type="checkbox"
            className="mt-1 shrink-0 accent-[var(--accent)]"
            checked={choice === ticks.on}
            onChange={event => onPick(item.ref, event.currentTarget.checked ? ticks.on : ticks.off)}
            data-review-pick={item.ref}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">{title}</span>
            {item.outcome === 'gone' ? (
              <span className="text-cell text-muted">Tick to remove it from {machineName}</span>
            ) : null}
          </span>
        </label>
      )}
      {item.outcome === 'both' || item.outcome === 'mine' ? null : (
        <div className="flex min-w-0 flex-col gap-1 pl-7">{detail}</div>
      )}
    </div>
  );
}

// ── Logins ───────────────────────────────────────────────────────────────────────────────────────

function LoginRow({
  login,
  name,
  harness,
  targetName,
  picks,
  onPick,
  machineName,
}: {
  readonly login: CloneReviewLogin;
  /** The source login as a person knows it: its email or label. */
  readonly name: string;
  readonly harness: 'claude' | 'codex' | undefined;
  /** A login here by its id: its email or label. */
  readonly targetName: (id: string) => string;
  readonly picks: LoginPicks;
  readonly onPick: (sourceId: string, target: string) => void;
  readonly machineName: string;
}) {
  const group = useId();
  const tool = harness === undefined ? '' : `${SETUP_HARNESS_NAMES[harness]} · `;
  if (login.outcome === 'matched') {
    return (
      <SetupRow
        name={`login-${login.sourceId}`}
        status="ready"
        title={
          <>
            {tool}
            <span className="font-mono">{name}</span>
          </>
        }
        detail={
          login.target === undefined || login.target === login.sourceId
            ? 'Already here, no new sign-in'
            : `Already here as ${targetName(login.target)}, no new sign-in`
        }
      />
    );
  }
  if (login.outcome === 'ask') {
    const chosen = loginTarget(login, picks);
    const options = [...(login.candidates ?? []).map(id => [id, targetName(id)] as const), [NEW_SLOT, ''] as const];
    return (
      <div className="kt-panel flex min-w-0 flex-col gap-2 p-panel" data-review-login-ask={login.sourceId}>
        <fieldset className="relative m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-1 [overflow-wrap:anywhere] text-row font-semibold text-fg">
            {tool}
            <span className="font-mono">{name}</span>: use which login on {machineName}?
          </legend>
          {options.map(([id, label]) => (
            <label key={id} className="relative flex min-h-[44px] min-w-0 cursor-pointer items-center gap-3">
              <input
                type="radio"
                name={group}
                className="shrink-0 accent-[var(--accent)]"
                checked={chosen === id}
                onChange={() => onPick(login.sourceId, id)}
                data-review-login-pick={`${login.sourceId}:${id}`}
              />
              <span className="[overflow-wrap:anywhere] text-row text-fg">
                {id === NEW_SLOT ? (
                  'Add an empty slot'
                ) : (
                  <>
                    Use <span className="font-mono">{label}</span>
                  </>
                )}
              </span>
            </label>
          ))}
        </fieldset>
        <span className="text-cell text-muted" data-review-login-help="">
          {chosen === NEW_SLOT ? (
            <>
              More than one login here fits, so none is picked for you. An empty slot needs a sign-in on {machineName};
              pick a login to use it as it is instead. No login is changed.
            </>
          ) : (
            <>
              Uses <span className="font-mono">{targetName(chosen)}</span> as it is: no new sign-in, and no login is
              changed.
            </>
          )}
        </span>
      </div>
    );
  }
  if (login.runnable !== undefined) {
    return (
      <div className="kt-panel flex min-w-0 flex-col gap-2 p-panel" data-setup-row={`login-${login.sourceId}`}>
        <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">
          {tool}
          <span className="font-mono">{name}</span>
        </span>
        <span className="text-cell text-muted">Copies as a new API-key login on {machineName}</span>
        <RunnableEntries entries={login.runnable.entries} />
      </div>
    );
  }
  return (
    <SetupRow
      name={`login-${login.sourceId}`}
      status="needs_sign_in"
      title={
        <>
          {tool}
          <span className="font-mono">{name}</span>
        </>
      }
      detail={`Adds an empty slot: sign in on ${machineName}. Never copied: a refresh token on two machines would sign one of them out.`}
    />
  );
}

// ── The sheet ────────────────────────────────────────────────────────────────────────────────────

interface CloneReviewSheetProps {
  readonly review: FleetCloneReview;
  readonly source: string;
  readonly machineName: string;
  readonly picks: ReviewPicks;
  readonly onPick: (ref: string, choice: CloneChoice) => void;
  readonly loginPicks: LoginPicks;
  readonly onLoginPick: (sourceId: string, target: string) => void;
  /** A source login's email or label, and the tool it signs in. */
  readonly sourceLogin: (id: string) => { readonly name: string; readonly harness: 'claude' | 'codex' | undefined };
  /** A login here by its id, as a person knows it. */
  readonly targetName: (id: string) => string;
  /** The documents this machine holds, by path; empty when they could not be read. */
  readonly mineFiles: ReadonlyMap<string, string>;
  /** The documents the other machine carried, by path. */
  readonly theirFiles: ReadonlyMap<string, string>;
  /** This machine's value beside the source's for an item both sides changed. */
  readonly compare: (item: CloneReviewItem) => ItemCompare;
  /** The names behind the "already the same" count, or `null` when they could not be told. */
  readonly sameNames: readonly string[] | null;
  /** Extra rows for the Logins and keys group (the sealed key copy). */
  readonly keysAccessory?: ReactNode;
  /** Writes the `fy secret set` command to the clipboard; the browser's own unless a host or a test brings one. */
  readonly write?: ClipboardWriter;
}

export function CloneReviewSheet(props: CloneReviewSheetProps) {
  const { review, source, machineName, picks, onPick, loginPicks, onLoginPick, sameNames, keysAccessory } = props;
  const write = props.write ?? browserClipboardWriter();
  const groups = reviewGroups(review, source);
  const shownLogins = review.logins;
  const shownKeys = review.keys.filter(key => key.outcome !== 'same');
  const showSettings = review.settings.some(file => file.keys.length > 0);
  const hasLogins = shownLogins.length > 0 || shownKeys.length > 0 || showSettings || keysAccessory !== undefined;

  const groupSection = (group: ReviewGroup) => (
    // A short group stays whole in one column; a long one may flow, but its heading and hint stay with its first row.
    <div
      key={group.id}
      className={cn('mb-4 min-w-0', group.items.length <= 2 ? 'break-inside-avoid' : 'lg:break-inside-auto')}
      data-review-group={group.id}
    >
      <SetupSection title={`${group.title} · ${String(group.items.length)}`} name={`review-${group.id}`}>
        <p className="m-0 break-after-avoid text-cell leading-base text-muted">{group.hint}</p>
        {group.items.map(item => (
          <ReviewItemRow
            key={item.ref}
            item={item}
            picks={picks}
            source={source}
            machineName={machineName}
            onPick={onPick}
            mineFiles={props.mineFiles}
            theirFiles={props.theirFiles}
            compare={props.compare(item)}
          />
        ))}
      </SetupSection>
    </div>
  );

  return (
    // One column on a phone, in reading order; two on a wide screen, flowing down the first then the second.
    <div
      className="min-w-0 lg:columns-2 lg:gap-x-6 [&_.kt-panel]:break-inside-avoid [&_h4]:break-after-avoid"
      data-clone-review=""
    >
      {groups.map(groupSection)}
      {hasLogins ? (
        <div className="mb-4 min-w-0" data-review-group="logins">
          <SetupSection title="Logins and keys" name="review-logins">
            {shownLogins.map(login => {
              const known = props.sourceLogin(login.sourceId);
              return (
                <LoginRow
                  key={login.sourceId}
                  login={login}
                  name={known.name}
                  harness={known.harness}
                  targetName={props.targetName}
                  picks={loginPicks}
                  onPick={onLoginPick}
                  machineName={machineName}
                />
              );
            })}
            {shownKeys.map(key =>
              key.outcome === 'missing' ? (
                <SetupRow
                  key={key.name}
                  name={`key-${key.name}`}
                  status="ready"
                  title={<span className="font-mono">{key.name}</span>}
                  detail={`Missing here: copied with its login, sealed, with a passkey on ${source}`}
                />
              ) : (
                // A newer key is only REPORTED: never copied over the one held here, with the command to take it.
                <NewerKeyRow
                  key={key.name}
                  keyName={key.name}
                  both={key.outcome === 'both'}
                  machineName={machineName}
                  sourceName={source}
                  write={write}
                />
              ),
            )}
            {review.settings
              .filter(file => file.keys.length > 0)
              .map(file => (
                <SetupRow
                  key={file.path}
                  name={`settings-${file.path}`}
                  status="ready"
                  title={<span className="font-mono">{file.path}</span>}
                  detail={`${countWords(file.keys.length, 'setting')} differ: ${file.keys.map(key => key.key).join(', ')}`}
                />
              ))}
            {keysAccessory}
          </SetupSection>
        </div>
      ) : null}
      {review.same.count === 0 ? null : (
        <div className="mb-4 min-w-0" data-review-group="same">
          <SetupDisclosure label={`${sameTitle(review)}${sameLine(review)}`} name="review-same">
            {sameNames === null ? (
              <span data-review-same-names="">The list of names isn’t available for this copy.</span>
            ) : (
              <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0" data-review-same-names="">
                {sameNames.map(name => (
                  <li key={name} className="[overflow-wrap:anywhere] font-mono text-meta text-fg">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </SetupDisclosure>
        </div>
      )}
    </div>
  );
}

const sameLine = (review: FleetCloneReview): string => {
  const byName = sameMatchedByName(review);
  return byName === null ? '' : ` (${byName})`;
};
