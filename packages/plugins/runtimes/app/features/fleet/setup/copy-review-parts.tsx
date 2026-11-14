/**
 * What a copy shows BEFORE anything is written. A copy brings in hooks, skills, scripts and MCP commands from another
 * machine, so a compromised source is how a command gets planted on the others: every command and every document the
 * copy would run is on screen IN FULL (never a placeholder standing in for its text), for a first copy and for a repeat
 * one, including a command that CHANGED since the last copy, each login's own variables, and — at the confirm step — the
 * daemon's whole description of what it will do.
 */

import { SetupNote, SetupSection } from '@ferretry/app/ui';
import type { ReactNode } from 'react';
import type {
  AccountChangeView,
  CloneKeyChoice,
  CloneReview,
  CloneReviewItem,
  CloneReviewLogin,
  CloneSettingsDoc,
} from '../../../../contract/index.ts';
import type { CopyDoneReport, SettingsPick } from './copy-model.ts';

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
export function RunnableEntries({ entries }: { readonly entries: readonly Entry[] }): ReactNode {
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
  updating,
  decided,
}: {
  readonly item: CloneReviewItem;
  /** Whether the copy writes this item. */
  readonly ticked: boolean;
  readonly onTick: (on: boolean) => void;
  /** A repeat copy (an update): an item both machines changed is decided, never defaulted. */
  readonly updating: boolean;
  readonly decided: boolean;
}): ReactNode {
  const both = updating && item.outcome === 'both';
  const tickLabel = updating ? 'Apply this change' : 'Copy this';
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
      {both ? (
        <span className="flex flex-wrap gap-3 text-meta text-muted" data-copy-item-choice={item.ref}>
          {([true, false] as const).map(take => (
            <label key={String(take)} className="flex min-h-11 items-center gap-1">
              <input
                type="radio"
                name={`item:${item.ref}`}
                data-copy-item-pick={take ? 'take' : 'keep'}
                checked={decided && ticked === take}
                onChange={() => onTick(take)}
              />
              {take ? 'Take the source’s' : 'Keep mine'}
            </label>
          ))}
          {decided ? null : <span className="text-warn">decide this one</span>}
        </span>
      ) : item.runnable === undefined ? (
        <label className="flex min-h-11 min-w-0 items-center gap-2 text-cell font-semibold text-fg">
          <input
            type="checkbox"
            data-copy-item-tick={item.ref}
            checked={ticked}
            onChange={event => onTick(event.target.checked)}
          />
          <span>{tickLabel}</span>
        </label>
      ) : null}
      {item.runnable === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-2" data-copy-runnable={item.ref}>
          {both ? null : (
            <label className="flex min-h-11 min-w-0 items-center gap-2 text-cell font-semibold text-fg">
              <input type="checkbox" checked={ticked} onChange={event => onTick(event.target.checked)} />
              <span>{tickLabel}: it starts or runs what is shown</span>
            </label>
          )}
          <RunnableEntries entries={item.runnable.entries} />
        </div>
      )}
    </li>
  );
}

/**
 * The settings keys that differ, with both values (configuration text, never a secret) and what taking one would
 * loosen. The person includes each document and decides each key: a key both machines changed has no default and
 * must be settled before the copy can be previewed.
 */
export function SettingsPicker({
  review,
  pick,
  onPick,
  source,
}: {
  readonly review: CloneReview;
  readonly pick: SettingsPick;
  readonly onPick: (next: SettingsPick) => void;
  readonly source: string;
}): ReactNode {
  const docs = review.settings.filter(doc => doc.keys.length > 0 || doc.refused !== undefined);
  if (docs.length === 0) return null;
  const setDoc = (path: CloneSettingsDoc, on: boolean): void => {
    const next = new Set(pick.docs);
    if (on) next.add(path);
    else next.delete(path);
    onPick({ ...pick, docs: next });
  };
  const setKey = (path: CloneSettingsDoc, key: string, choice: CloneKeyChoice): void =>
    onPick({ ...pick, keys: { ...pick.keys, [path]: { ...pick.keys[path], [key]: choice } } });
  return (
    <SetupSection title="Settings that differ" name="copy-settings-changes">
      <p className="m-0 text-meta leading-base text-muted">
        {review.mode === 'first'
          ? `Tick what to bring from ${source}. These are written right after the setup lands, as a second step you confirm.`
          : `Nothing is ticked for you: tick the settings to bring from ${source}, and decide each key.`}
      </p>
      {docs.map(doc => (
        <div key={doc.path} className="flex min-w-0 flex-col gap-1" data-copy-settings-doc={doc.path}>
          <label className="flex min-h-11 items-center gap-2 text-cell font-semibold text-fg">
            <input
              type="checkbox"
              data-copy-settings-tick={doc.path}
              disabled={doc.refused !== undefined}
              checked={pick.docs.has(doc.path)}
              onChange={event => setDoc(doc.path, event.target.checked)}
            />
            <span className="font-mono">{doc.path}</span>
          </label>
          {doc.refused === undefined ? null : <span className="text-meta text-warn">{doc.refused}</span>}
          {doc.keys.map(key => {
            const chosen = pick.keys[doc.path]?.[key.key];
            return (
              <div
                key={key.key}
                className="flex min-w-0 flex-col gap-1 pl-6 text-meta text-muted [overflow-wrap:anywhere]"
                data-copy-settings-key={key.key}
              >
                <span>
                  <span className="font-mono">{key.key}</span>: {key.mine === undefined ? 'unset here' : key.mine} →{' '}
                  {key.theirs === undefined ? 'removed' : key.theirs}
                  {key.loosens === true ? ' (loosens what this machine may spend or its agents may do)' : ''}
                </span>
                {pick.docs.has(doc.path) ? (
                  <span className="flex flex-wrap gap-3">
                    {(['take', 'keep'] as const).map(choice => (
                      <label key={choice} className="flex min-h-11 items-center gap-1">
                        <input
                          type="radio"
                          name={`${doc.path}:${key.key}`}
                          data-copy-key-choice={choice}
                          checked={chosen === choice}
                          onChange={() => setKey(doc.path, key.key, choice)}
                        />
                        {choice === 'take' ? `Take ${source}’s` : 'Keep mine'}
                      </label>
                    ))}
                    {chosen === undefined ? <span className="text-warn">decide this one</span> : null}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </SetupSection>
  );
}

/** The logins a copy settles: a sign-in becomes an empty slot, and an environment login brings its variables, shown in full. */
export function LoginRows({
  logins,
  picks,
  onPick,
}: {
  readonly logins: readonly CloneReviewLogin[];
  /** A repeat copy: which login here each sign-in uses, where the person chose; absent: the review's own answer. */
  readonly picks?: Readonly<Record<string, string>> | undefined;
  readonly onPick?: ((sourceId: string, target: string) => void) | undefined;
}): ReactNode {
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
            {onPick === undefined || login.candidates === undefined || login.candidates.length === 0 ? null : (
              <label className="flex min-h-11 flex-wrap items-center gap-2 text-meta text-muted">
                Use
                <select
                  className="min-h-11 rounded-control border border-line bg-surface px-2 text-cell text-fg"
                  data-copy-login-pick={login.sourceId}
                  value={picks?.[login.sourceId] ?? login.target ?? 'slot'}
                  onChange={event => onPick(login.sourceId, event.target.value)}
                >
                  {login.candidates.map(candidate => (
                    <option key={candidate} value={candidate}>
                      the login {candidate}
                    </option>
                  ))}
                  <option value="slot">an empty slot to sign in to</option>
                </select>
              </label>
            )}
          </li>
        ))}
      </ul>
    </SetupSection>
  );
}

/** A finished copy, said the way it happened: what the machine did, then everything it did NOT bring and what to do about it. */
export function DoneReport({
  report,
  source,
}: {
  readonly report: CopyDoneReport;
  readonly source: string;
}): ReactNode {
  return (
    <>
      <SetupNote live tone="ok" name="copy-done" title={`Copied from ${source}`}>
        <span className="[overflow-wrap:anywhere]">{report.did}</span>
      </SetupNote>
      {report.notWritten.length === 0 ? null : (
        <SetupNote tone="warn" name="copy-not-written" title="Not copied by this step">
          <span className="[overflow-wrap:anywhere]">
            {report.notWritten.join(', ')}: a first copy brings the logins, components, profiles and runtimes, and these
            were not written. Once this machine has its setup, copy again from Settings › Export &amp; copy: a repeat
            copy merges these settings.
          </span>
        </SetupNote>
      )}
      {report.settingsProblem === undefined ? null : (
        <SetupNote live tone="err" name="copy-settings-problem" title="The settings step did not finish">
          <span className="[overflow-wrap:anywhere]">{report.settingsProblem}</span>
        </SetupNote>
      )}
      {report.leftOutItems.length === 0 ? null : (
        <SetupNote tone="pend" name="copy-left-out-items" title="Left out by you">
          <span className="font-mono [overflow-wrap:anywhere]">{report.leftOutItems.join(', ')}</span>
        </SetupNote>
      )}
      {report.leftOutFiles.length === 0 ? null : (
        <SetupNote tone="warn" name="copy-left-out-files" title="Not read from the source">
          <span className="font-mono [overflow-wrap:anywhere]">{report.leftOutFiles.join(', ')}</span>
        </SetupNote>
      )}
      {report.signIns.length === 0 ? null : (
        <SetupNote tone="pend" name="copy-sign-ins" title="Sign in on this machine">
          <span className="[overflow-wrap:anywhere]">
            A sign-in never travels. Sign in to each one here (Settings › Logins): {report.signIns.join(', ')}.
          </span>
        </SetupNote>
      )}
      {report.missingKeys.length === 0 ? null : (
        <SetupNote tone="warn" name="copy-missing-keys" title="Add these API keys here">
          <span className="font-mono [overflow-wrap:anywhere]">{report.missingKeys.join(', ')}</span>
        </SetupNote>
      )}
    </>
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
