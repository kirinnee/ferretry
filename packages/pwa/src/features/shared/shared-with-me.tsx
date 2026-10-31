/**
 * /shared: the publishers this browser belongs to, and what each one shares.
 *
 * Only a verified, signed manifest is ever listed. A catalog that did not verify shows its problem and
 * nothing else. The person's own label for a publisher comes first; the publisher's own name never
 * stands in for it. Nothing here is kept offline.
 */

import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import type { SharedCatalogManifestEntry } from '@ferretry/protocol';
import type { MemberSubscription } from '../../lib/member-keys.ts';
import { Button } from '../../shell/primitives.tsx';
import { FailureLine } from '../catalogs/catalog-parts.tsx';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import { AccessRefused } from './access-refused.tsx';
import type { Attempt, SharedCatalogView, SharedController } from './shared-controller.ts';
import {
  LEAVE,
  LEAVE_NOTE,
  LEFT_SENTENCE,
  NOTHING_SHARED,
  ONLINE_ONLY,
  publisherLine,
  SHARED_WITH_ME,
  UNLOCK_BUTTON,
  UNLOCK_NOTE,
} from './shared-model.ts';
import {
  BACK_TO_MACHINES,
  CANCEL,
  CONFIRM_LEAVE,
  CONFIRM_LEAVE_YES,
  type CardState,
  cardState,
  isRefused,
  KEEP,
  LOADING_CATALOGS,
  NAME_LABEL,
  NAME_NOT_SAVED,
  nameProblem,
  NO_ITEMS,
  OPENING_ITEM,
  RENAME,
  SAVE_NAME,
  TRY_AGAIN,
  WITHDRAWN_INSTALLED,
  withdrawnSummary,
  WORKING,
} from './shared-screens-model.ts';
import { useInstalledFromPublisher } from './shared-installs.ts';
import { Fingerprint, SharedPage } from './shared-parts.tsx';
import { type InstallMachine, type OpenedSharedItem, SharedItemSheet } from './shared-item-sheet.tsx';

type SharedPort = Pick<
  SharedController,
  'list' | 'browse' | 'unlock' | 'openItem' | 'leave' | 'forget' | 'rename' | 'tryAgain'
>;

interface SharedWithMeProps {
  readonly members: SharedPort;
  /** The machines this browser is paired with. None means no Install button. */
  readonly machines: readonly InstallMachine[];
  readonly installHost?: InstallHost;
  readonly onHome: () => void;
}

export function SharedWithMe({ members, machines, installHost, onHome }: SharedWithMeProps) {
  const [subs, setSubs] = useState<readonly MemberSubscription[] | null>(null);
  const [left, setLeft] = useState(false);
  const reload = useCallback(async (): Promise<void> => {
    setSubs(await members.list());
  }, [members]);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SharedPage title={SHARED_WITH_ME}>
      {left ? (
        <p className="m-0 text-cell text-ok" role="status" data-shared-left="">
          {LEFT_SENTENCE}
        </p>
      ) : null}
      {subs === null ? (
        <p className="m-0 text-cell text-muted" role="status">
          {LOADING_CATALOGS}
        </p>
      ) : subs.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-shared-empty="">
          {NOTHING_SHARED}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-sm p-0" aria-label="Publishers">
          {subs.map(sub => (
            <li key={sub.daemonId} className="min-w-0">
              <PublisherCard
                sub={sub}
                members={members}
                machines={machines}
                {...(installHost === undefined ? {} : { installHost })}
                onChanged={() => void reload()}
                onLeft={() => {
                  setLeft(true);
                  void reload();
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button type="button" variant="ghost" className="kt-btn--flush-start" onClick={onHome} data-shared-home="">
          {BACK_TO_MACHINES}
        </Button>
      </div>
    </SharedPage>
  );
}

function PublisherCard({
  sub,
  members,
  machines,
  installHost,
  onChanged,
  onLeft,
}: {
  readonly sub: MemberSubscription;
  readonly members: SharedPort;
  readonly machines: readonly InstallMachine[];
  readonly installHost?: InstallHost;
  readonly onChanged: () => void;
  readonly onLeft: () => void;
}) {
  const line = publisherLine(sub);
  const [state, setState] = useState<CardState>(isRefused(sub) ? { kind: 'refused' } : { kind: 'loading' });
  const [renaming, setRenaming] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaveFailure, setLeaveFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    setState(cardState(await members.browse(sub)));
  }, [members, sub]);
  const installed = useInstalledFromPublisher(sub.daemonId, machines, installHost);
  const refused = isRefused(sub);
  useEffect(() => {
    if (!refused) void load();
  }, [refused, load]);

  const unlock = async (): Promise<void> => {
    setBusy(true);
    const attempt = await members.unlock(sub);
    setBusy(false);
    if (attempt.kind === 'ok') await load();
    else
      setState(
        attempt.kind === 'refused' ? { kind: 'refused' } : { kind: 'failed', sentence: attempt.problem.sentence },
      );
  };

  const leave = async (): Promise<void> => {
    setBusy(true);
    const attempt = await members.leave(sub);
    setBusy(false);
    if (attempt.kind === 'ok') onLeft();
    else if (attempt.kind === 'refused') setState({ kind: 'refused' });
    else setLeaveFailure(attempt.problem.sentence);
    setConfirmLeave(false);
  };

  return (
    <article className="kt-panel flex min-w-0 flex-col gap-xs p-panel" data-shared-publisher={sub.daemonId}>
      <header className="flex min-w-0 flex-col gap-xs">
        {renaming ? (
          <RenameForm
            current={sub.ownLabel}
            onSave={async next => {
              const saved = await members.rename(sub.daemonId, next);
              if (saved) {
                setRenaming(false);
                onChanged();
              }
              return saved;
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-xs">
            <h2 className="m-0 min-w-0 flex-1 break-words text-row font-semibold text-fg" data-publisher-label="">
              {line.label}
            </h2>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(true)} data-publisher-rename="">
              {RENAME}
              <span className="sr-only"> {line.label}</span>
            </Button>
          </div>
        )}
        <Fingerprint head={line.fingerprint} full={line.fingerprintFull} />
      </header>
      <CardBody
        state={state}
        sub={sub}
        members={members}
        machines={machines}
        {...(installHost === undefined ? {} : { installHost })}
        busy={busy}
        installed={installed}
        onUnlock={() => void unlock()}
        onAgain={() => void load()}
        onRefused={() => setState({ kind: 'refused' })}
        onTryAgain={async () => {
          const attempt = await members.tryAgain(sub);
          if (attempt.kind === 'ok') onChanged();
          return attempt;
        }}
        onForget={async () => {
          await members.forget(sub.daemonId);
          onChanged();
        }}
        label={line.label}
      />
      {state.kind === 'refused' ? null : (
        <div className="flex min-w-0 flex-col items-start gap-xs">
          {leaveFailure === null ? null : <FailureLine sentence={leaveFailure} />}
          {confirmLeave ? (
            <fieldset className="m-0 flex border-0 p-0 min-w-0 flex-col items-start gap-xs" aria-label={CONFIRM_LEAVE}>
              <p className="m-0 text-cell text-muted">{LEAVE_NOTE}</p>
              <p className="m-0 text-cell font-semibold text-fg">{CONFIRM_LEAVE}</p>
              <div className="flex flex-wrap gap-xs">
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void leave()}
                  data-publisher-leave-yes=""
                >
                  {CONFIRM_LEAVE_YES}
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmLeave(false)}
                  data-publisher-leave-keep=""
                >
                  {KEEP}
                </Button>
              </div>
            </fieldset>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="kt-btn--flush-start"
              onClick={() => setConfirmLeave(true)}
              data-publisher-leave=""
            >
              {LEAVE}
              <span className="sr-only"> {line.label}</span>
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function RenameForm({
  current,
  onSave,
  onCancel,
}: {
  readonly current: string;
  readonly onSave: (label: string) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const bad = nameProblem(value);
    if (bad !== null) {
      setProblem(bad);
      return;
    }
    setProblem((await onSave(value.trim())) ? null : NAME_NOT_SAVED);
  };
  return (
    <form className="flex min-w-0 flex-col gap-xs" onSubmit={event => void submit(event)} data-publisher-rename-form="">
      <label htmlFor={id} className="text-meta font-semibold text-muted">
        {NAME_LABEL}
      </label>
      <input
        id={id}
        className="kt-input"
        value={value}
        onChange={event => setValue(event.target.value)}
        aria-invalid={problem !== null}
        data-publisher-rename-input=""
      />
      {problem === null ? null : (
        <p className="m-0 text-cell text-err" role="alert">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-xs">
        <Button type="submit" variant="primary" size="sm" data-publisher-rename-save="">
          {SAVE_NAME}
        </Button>
        <Button type="button" size="sm" onClick={onCancel} data-publisher-rename-cancel="">
          {CANCEL}
        </Button>
      </div>
    </form>
  );
}

function CardBody({
  state,
  sub,
  members,
  machines,
  installHost,
  busy,
  installed,
  label,
  onUnlock,
  onAgain,
  onRefused,
  onTryAgain,
  onForget,
}: {
  readonly state: CardState;
  readonly sub: MemberSubscription;
  readonly members: SharedPort;
  readonly machines: readonly InstallMachine[];
  readonly installHost?: InstallHost;
  readonly busy: boolean;
  readonly installed: ReadonlyMap<string, string>;
  readonly label: string;
  readonly onUnlock: () => void;
  readonly onAgain: () => void;
  readonly onRefused: () => void;
  readonly onTryAgain: () => Promise<Attempt<void>>;
  readonly onForget: () => Promise<void>;
}) {
  switch (state.kind) {
    case 'loading':
      return (
        <p className="m-0 text-cell text-muted" role="status">
          {LOADING_CATALOGS}
        </p>
      );
    case 'refused':
      return <AccessRefused label={label} level={3} onTryAgain={onTryAgain} onForget={onForget} />;
    case 'locked':
      return (
        <div className="flex min-w-0 flex-col items-start gap-xs" data-shared-locked="">
          <p className="m-0 text-cell text-fg">{UNLOCK_NOTE}</p>
          <Button type="button" variant="primary" disabled={busy} onClick={onUnlock} data-publisher-unlock="">
            {busy ? WORKING : UNLOCK_BUTTON}
          </Button>
        </div>
      );
    case 'offline':
      return (
        <div className="flex min-w-0 flex-col items-start gap-xs" data-shared-offline="">
          <p className="m-0 text-cell text-fg">{ONLINE_ONLY}</p>
          <Button type="button" size="sm" onClick={onAgain} data-publisher-again="">
            {TRY_AGAIN}
          </Button>
        </div>
      );
    case 'failed':
      return <FailureLine sentence={state.sentence} again onAgain={onAgain} againLabel={TRY_AGAIN} />;
    case 'ok':
      return (
        <div className="flex min-w-0 flex-col gap-sm">
          {state.blocks.map(block =>
            block.kind === 'problem' ? (
              <section
                key={block.catalogId}
                className="flex min-w-0 flex-col gap-xs"
                data-shared-catalog={block.catalogId}
              >
                <h3 className="m-0 break-words text-cell font-semibold text-fg">{block.name}</h3>
                <p className="m-0 text-cell text-err" data-shared-catalog-problem="">
                  {block.sentence}
                </p>
              </section>
            ) : (
              <section
                key={block.catalogId}
                className="flex min-w-0 flex-col gap-xs"
                data-shared-catalog={block.catalogId}
              >
                <h3 className="m-0 break-words text-cell font-semibold text-fg">{block.name}</h3>
                {block.items.length === 0 && block.withdrawn.length === 0 ? (
                  <p className="m-0 text-cell text-muted">{NO_ITEMS}</p>
                ) : null}
                <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label={`Items in ${block.name}`}>
                  {block.items.map(item => (
                    <li key={item.entry.itemId} className="min-w-0">
                      <ItemButton
                        sub={sub}
                        view={block.view}
                        entry={item.entry}
                        title={item.title}
                        summary={item.summary}
                        members={members}
                        machines={machines}
                        {...(installHost === undefined ? {} : { installHost })}
                        onRefused={onRefused}
                      />
                    </li>
                  ))}
                </ul>
                <WithdrawnNote withdrawn={block.withdrawn} installed={installed} />
              </section>
            ),
          )}
        </div>
      );
  }
}

function WithdrawnNote({
  withdrawn,
  installed,
}: {
  readonly withdrawn: readonly { readonly itemId: string }[];
  readonly installed: ReadonlyMap<string, string>;
}) {
  const summary = withdrawnSummary(withdrawn, installed);
  if (summary.installed.length === 0 && summary.rest === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-shared-withdrawn="">
      {summary.installed.map(item => (
        <p
          key={item.itemId}
          className="m-0 break-words text-meta text-muted"
          data-shared-withdrawn-installed={item.itemId}
        >
          {item.name} · {WITHDRAWN_INSTALLED}
        </p>
      ))}
      {summary.rest === null ? null : <p className="m-0 text-meta text-muted">{summary.rest}</p>}
    </div>
  );
}

function ItemButton({
  sub,
  view,
  entry,
  title,
  summary,
  members,
  machines,
  installHost,
  onRefused,
}: {
  readonly sub: MemberSubscription;
  readonly view: SharedCatalogView;
  readonly entry: SharedCatalogManifestEntry;
  readonly title: string;
  readonly summary: string;
  readonly members: SharedPort;
  readonly machines: readonly InstallMachine[];
  readonly installHost?: InstallHost;
  readonly onRefused: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [shown, setShown] = useState<OpenedSharedItem | null>(null);
  const open = async (): Promise<void> => {
    setOpening(true);
    setFailure(null);
    const attempt = await members.openItem(sub, view, entry);
    setOpening(false);
    if (attempt.kind === 'refused') onRefused();
    else if (attempt.kind === 'failed') setFailure(attempt.problem.sentence);
    else setShown(attempt.value);
  };
  return (
    <>
      <button
        type="button"
        className="kt-panel flex min-h-[44px] w-full min-w-0 flex-col items-start gap-0.5 px-control-x py-2 text-left focus-visible:outline-focus focus-visible:outline-offset-focus"
        disabled={opening}
        onClick={() => void open()}
        data-shared-item={entry.itemId}
      >
        <span className="break-words text-cell font-semibold text-fg">{title}</span>
        <span className="break-words text-meta text-muted">{opening ? OPENING_ITEM : summary}</span>
      </button>
      {failure === null ? null : <FailureLine sentence={failure} />}
      {shown === null ? null : (
        <SharedItemSheet
          shown={shown}
          publisherLabel={sub.ownLabel}
          machines={machines}
          {...(installHost === undefined ? {} : { installHost })}
          onClose={() => setShown(null)}
        />
      )}
    </>
  );
}
