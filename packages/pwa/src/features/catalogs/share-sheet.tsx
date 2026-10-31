/**
 * The Share sheet: who a catalog is for, for how long, for how many, then a link shown once.
 *
 * ## THE LINK LIVES IN THIS COMPONENT'S STATE AND NOWHERE ELSE
 *
 * The code and link come back from the mint and are held in state until the sheet closes, the code
 * expires or the owner ends it. They are never written to a store, the URL or a log, and never put in a
 * live region. The QR is drawn here from that state, so no image service ever sees the credential.
 * This is why the harness shows a fixed fake code.
 *
 * ## AN EXISTING MEMBER IS WARNED BEFORE ANYTHING IS MADE
 *
 * A link for a person who can already read things lets whoever opens it read all of it. That sentence is
 * on screen the moment the owner picks such a person, before the passkey button, not after.
 *
 * ## THE PASSKEY IS THE CARRIER'S JOB
 *
 * The act `share-catalog` is confirmed by the carrier when the daemon answers `403 grant_step_up_required`,
 * so this sheet only offers the button and renders whatever the machine answers.
 */

import type { CatalogMemberView, CatalogShareMintResponse, OwnedCatalog } from '@ferretry/protocol';
import { CircleAlert, Copy, Fingerprint, TriangleAlert } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { QrSymbol } from '../../components/qr-symbol.tsx';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { PAIRING_TICK_MS } from '../../lib/pairing-invite.ts';
import { encodeQr, QrEncodeError, type QrMatrix } from '../../lib/qr-code.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import { CatalogSheet, FailureLine, SharingOffPanel } from './catalog-parts.tsx';
import { endShare, listMembers, mintShare } from './catalog-shares-api.ts';
import {
  CAP_PROBLEM,
  DEFAULT_CAP_TEXT,
  EXISTING_MEMBER_ADVICE,
  EXPIRY_CHOICES,
  emptyDraft,
  existingMemberWarning,
  expiryLine,
  mintRequest,
  recipientName,
  SHARE_CAP_LABEL,
  SHARE_CLOSE_NOTE,
  SHARE_CONFIRM_LABEL,
  SHARE_COPIED_LINE,
  SHARE_COPY_FAILED_LINE,
  SHARE_ENDED_LINE,
  SHARE_EXISTING_PERSON_LABEL,
  SHARE_MANY_LABEL,
  SHARE_MANY_NEEDS_NEW,
  SHARE_NEW_PERSON_LABEL,
  SHARE_NO_ONE_YET,
  SHARE_ONE_LABEL,
  SHARE_QR_FAILED_LINE,
  SHARE_QR_LABEL,
  SHARE_WAITING_LABEL,
  type ShareDraft,
  shareCountdown,
  shareProblem,
  shareResultTitle,
  shareSheetTitle,
  sharingRefusal,
  shownOnceLine,
} from './catalog-sharing-model.ts';
import type { CatalogClientFactory } from './catalogs-api.ts';
import type { OwnerRefusal } from './catalogs-model.ts';

export interface ShareSheetProps {
  readonly connection: DaemonConnection;
  readonly createClient?: CatalogClientFactory;
  readonly catalog: OwnedCatalog;
  readonly onClose: () => void;
  /** Called after a code is made or ended, so the lists behind the sheet read again. */
  readonly onChanged?: () => void;
  /** Test and harness seams: the clock, and how text reaches the clipboard. */
  readonly now?: () => number;
  readonly copyText?: (text: string) => Promise<void>;
}

const defaultCopy = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text);
};

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly members: readonly CatalogMemberView[] }
  | { readonly kind: 'failed'; readonly refusal: OwnerRefusal };

export function ShareSheet({
  connection,
  createClient: injected,
  catalog,
  onClose,
  onChanged,
  now = Date.now,
  copyText = defaultCopy,
}: ShareSheetProps) {
  const routed = useDaemonClient();
  const createClient: CatalogClientFactory = injected ?? routed;
  const [people, setPeople] = useState<Read>({ kind: 'loading' });
  const [draft, setDraft] = useState<ShareDraft>(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OwnerRefusal | null>(null);
  const [made, setMade] = useState<{ readonly response: CatalogShareMintResponse; readonly name: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await listMembers(await createClient(connection));
        if (live) setPeople({ kind: 'ready', members: list.members });
      } catch (error) {
        if (live) setPeople({ kind: 'failed', refusal: sharingRefusal(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  const members = people.kind === 'ready' ? people.members : [];
  const problem = shareProblem(draft, members);

  const mint = async (): Promise<void> => {
    if (problem !== null || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await mintShare(await createClient(connection), mintRequest(catalog.id, draft));
      setMade({ response, name: recipientName(draft, members) });
      onChanged?.();
    } catch (error) {
      setFailure(sharingRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  const title = made === null ? shareSheetTitle(catalog.name) : shareResultTitle(made.name);
  return (
    <CatalogSheet name="share" title={title} closeLabel="Close the share sheet" onClose={onClose}>
      {made === null ? (
        <ShareForm
          draft={draft}
          members={members}
          people={people}
          problem={problem}
          busy={busy}
          failure={failure}
          connection={connection}
          createClient={createClient}
          onDraft={setDraft}
          onSubmit={() => void mint()}
        />
      ) : (
        <ShareResult
          response={made.response}
          name={made.name}
          now={now}
          copyText={copyText}
          createClient={createClient}
          connection={connection}
          onChanged={onChanged}
          onDone={onClose}
        />
      )}
    </CatalogSheet>
  );
}

function ShareForm({
  draft,
  members,
  people,
  problem,
  busy,
  failure,
  connection,
  createClient,
  onDraft,
  onSubmit,
}: {
  readonly draft: ShareDraft;
  readonly members: readonly CatalogMemberView[];
  readonly people: Read;
  readonly problem: string | null;
  readonly busy: boolean;
  readonly failure: OwnerRefusal | null;
  readonly connection: DaemonConnection;
  readonly createClient: CatalogClientFactory;
  readonly onDraft: (next: ShareDraft) => void;
  readonly onSubmit: () => void;
}) {
  const nameId = useId();
  const memberId = useId();
  const expiryId = useId();
  const capId = useId();
  const whoGroup = useId();
  const usesGroup = useId();
  const existing = draft.who.kind === 'existing' ? draft.who : null;
  const picked = existing === null ? undefined : members.find(member => member.memberId === existing.memberId);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit();
  };

  if (people.kind === 'failed' && people.refusal.sharingOff)
    return <SharingOffPanel connection={connection} createClient={createClient} />;

  return (
    <form className="flex min-w-0 flex-col gap-sm" onSubmit={submit} data-share-form="">
      <fieldset className="m-0 flex min-w-0 flex-col gap-xs border-0 p-0" aria-labelledby={whoGroup}>
        <legend id={whoGroup} className="p-0 text-meta font-semibold text-muted">
          Who is this for?
        </legend>
        <label className="flex items-center gap-2 text-cell text-fg">
          <input
            type="radio"
            name={whoGroup}
            checked={draft.who.kind === 'new'}
            onChange={() => onDraft({ ...draft, who: { kind: 'new', name: '' } })}
            data-share-who-new=""
          />
          {SHARE_NEW_PERSON_LABEL}
        </label>
        <label className="flex items-center gap-2 text-cell text-fg">
          <input
            type="radio"
            name={whoGroup}
            checked={draft.who.kind === 'existing'}
            disabled={members.length === 0}
            onChange={() =>
              onDraft({
                ...draft,
                who: { kind: 'existing', memberId: members[0]?.memberId ?? '' },
                howMany: { kind: 'single' },
              })
            }
            data-share-who-existing=""
          />
          {SHARE_EXISTING_PERSON_LABEL}
        </label>
        {members.length === 0 && people.kind === 'ready' ? (
          <p className="m-0 text-meta text-muted" data-share-no-members="">
            {SHARE_NO_ONE_YET}
          </p>
        ) : null}
      </fieldset>

      {draft.who.kind === 'new' ? (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={nameId} className="text-meta font-semibold text-muted">
            Their name
          </label>
          <input
            id={nameId}
            className="kt-input"
            value={draft.who.name}
            maxLength={80}
            autoComplete="off"
            onChange={event => onDraft({ ...draft, who: { kind: 'new', name: event.target.value } })}
            data-share-name=""
          />
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-xs">
          <label htmlFor={memberId} className="text-meta font-semibold text-muted">
            Which person
          </label>
          <select
            id={memberId}
            className="kt-input"
            value={draft.who.memberId}
            onChange={event => onDraft({ ...draft, who: { kind: 'existing', memberId: event.target.value } })}
            data-share-member=""
          >
            {members.map(member => (
              <option key={member.memberId} value={member.memberId}>
                {member.label}
              </option>
            ))}
          </select>
          {picked === undefined ? null : (
            <div
              className="flex min-w-0 flex-col gap-1 rounded-control border border-warn-border bg-warn-bg p-control-x py-2 text-warn"
              data-share-existing-warning=""
            >
              <p className="m-0 flex items-start gap-2 break-words text-cell font-semibold">
                <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>{existingMemberWarning(picked.label)}</span>
              </p>
              <p className="m-0 text-cell">{EXISTING_MEMBER_ADVICE}</p>
            </div>
          )}
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={expiryId} className="text-meta font-semibold text-muted">
          The link works for
        </label>
        <select
          id={expiryId}
          className="kt-input"
          value={draft.expiresIn}
          onChange={event => onDraft({ ...draft, expiresIn: event.target.value as ShareDraft['expiresIn'] })}
          data-share-expiry=""
        >
          {EXPIRY_CHOICES.map(choice => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-xs border-0 p-0" aria-labelledby={usesGroup}>
        <legend id={usesGroup} className="p-0 text-meta font-semibold text-muted">
          How many people?
        </legend>
        <label className="flex items-center gap-2 text-cell text-fg">
          <input
            type="radio"
            name={usesGroup}
            checked={draft.howMany.kind === 'single'}
            onChange={() => onDraft({ ...draft, howMany: { kind: 'single' } })}
            data-share-uses-single=""
          />
          {SHARE_ONE_LABEL}
        </label>
        <label className="flex items-center gap-2 text-cell text-fg">
          <input
            type="radio"
            name={usesGroup}
            checked={draft.howMany.kind === 'multi'}
            disabled={draft.who.kind === 'existing'}
            onChange={() => onDraft({ ...draft, howMany: { kind: 'multi', cap: DEFAULT_CAP_TEXT } })}
            data-share-uses-multi=""
          />
          {SHARE_MANY_LABEL}
        </label>
        {draft.who.kind === 'existing' ? (
          <p className="m-0 text-meta text-muted" data-share-many-note="">
            {SHARE_MANY_NEEDS_NEW}
          </p>
        ) : null}
      </fieldset>

      {draft.howMany.kind === 'multi' ? (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={capId} className="text-meta font-semibold text-muted">
            {SHARE_CAP_LABEL}
          </label>
          <input
            id={capId}
            className="kt-input"
            inputMode="numeric"
            value={draft.howMany.cap}
            onChange={event => onDraft({ ...draft, howMany: { kind: 'multi', cap: event.target.value } })}
            aria-describedby={`${capId}-hint`}
            data-share-cap=""
          />
          <p id={`${capId}-hint`} className="m-0 text-meta text-muted">
            {CAP_PROBLEM}
          </p>
        </div>
      ) : null}

      {failure === null ? null : failure.sharingOff ? (
        <SharingOffPanel connection={connection} createClient={createClient} />
      ) : (
        <FailureLine sentence={failure.sentence} />
      )}
      {problem === null || busy ? null : (
        <p className="m-0 text-meta text-muted" data-share-problem="">
          {problem}
        </p>
      )}
      <div className="flex min-w-0 flex-col items-start gap-xs">
        <Button type="submit" variant="primary" disabled={busy || problem !== null} data-share-confirm="">
          <Fingerprint size={16} aria-hidden="true" />
          {busy ? SHARE_WAITING_LABEL : SHARE_CONFIRM_LABEL}
        </Button>
      </div>
    </form>
  );
}

function ShareQr({ link }: { readonly link: string }) {
  let matrix: QrMatrix;
  try {
    matrix = encodeQr(link);
  } catch (cause) {
    return (
      <p
        role="alert"
        className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-meta leading-base text-warn"
        data-share-qr-failure=""
      >
        {SHARE_QR_FAILED_LINE}
        {cause instanceof QrEncodeError ? ` ${cause.message}` : ''}
      </p>
    );
  }
  return (
    // theme-literal-ok: the QR plate must stay white behind the dark modules to scan, in every theme
    <div className="rounded-control border border-border bg-white p-3" data-share-qr="">
      <QrSymbol matrix={matrix} label={SHARE_QR_LABEL} className="h-auto w-full max-w-[240px]" />
    </div>
  );
}

function ShareResult({
  response,
  name,
  now,
  copyText,
  createClient,
  connection,
  onChanged,
  onDone,
}: {
  readonly response: CatalogShareMintResponse;
  readonly name: string;
  readonly now: () => number;
  readonly copyText: (text: string) => Promise<void>;
  readonly createClient: CatalogClientFactory;
  readonly connection: DaemonConnection;
  readonly onChanged: (() => void) | undefined;
  readonly onDone: () => void;
}) {
  const [link, setLink] = useState<string | null>(response.link);
  const [nowMs, setNowMs] = useState(now());
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OwnerRefusal | null>(null);
  const countdown = shareCountdown(response.share.expiresAt, nowMs);

  useEffect(() => {
    if (link === null) return;
    const timer = setInterval(() => setNowMs(now()), PAIRING_TICK_MS);
    return () => clearInterval(timer);
  }, [link, now]);

  useEffect(() => {
    if (countdown.expired) setLink(null);
  }, [countdown.expired]);

  const copy = async (): Promise<void> => {
    if (link === null) return;
    try {
      await copyText(link);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };

  const end = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await endShare(await createClient(connection), response.share.shareId);
      setLink(null);
      setEnded(true);
      onChanged?.();
    } catch (error) {
      setFailure(sharingRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-sm" data-share-result="">
      {link === null ? (
        <p className="m-0 text-cell text-muted" role="status" data-share-gone="">
          {ended ? SHARE_ENDED_LINE : expiryLine(countdown, response.share.uses)}
        </p>
      ) : (
        <>
          <p className="m-0 text-cell text-fg">{shownOnceLine(name)}</p>
          <ShareQr link={link} />
          <code
            data-share-link=""
            className="block select-all break-all rounded-control border border-border bg-surface-2 px-2 py-1 font-mono text-meta text-fg"
          >
            {link}
          </code>
          <p className="m-0 text-cell text-muted" data-share-countdown="">
            {expiryLine(countdown, response.share.uses)}
          </p>
          <div className="flex min-w-0 flex-wrap gap-xs">
            <Button type="button" variant="primary" onClick={() => void copy()} data-share-copy="">
              <Copy size={16} aria-hidden="true" />
              Copy link
            </Button>
            <Button type="button" variant="danger" disabled={busy} onClick={() => void end()} data-share-end="">
              End this code now
            </Button>
          </div>
          {copied === null ? null : (
            <p
              className={copied === 'ok' ? 'm-0 text-cell text-ok' : 'm-0 flex items-start gap-2 text-cell text-warn'}
              role="status"
              data-share-copy-note=""
            >
              {copied === 'failed' ? <CircleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" /> : null}
              {copied === 'ok' ? SHARE_COPIED_LINE : SHARE_COPY_FAILED_LINE}
            </p>
          )}
        </>
      )}
      {failure === null ? null : <FailureLine sentence={failure.sentence} />}
      <p className="m-0 text-meta text-muted">{SHARE_CLOSE_NOTE}</p>
      <div>
        <Button type="button" onClick={onDone} data-share-done="">
          Done
        </Button>
      </div>
    </div>
  );
}
