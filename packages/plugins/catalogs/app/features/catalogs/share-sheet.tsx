/**
 * The Invite people sheet: their user ID, for how long, for how many, then a link shown once.
 *
 * ## THE LINK LIVES IN THIS COMPONENT'S STATE AND NOWHERE ELSE
 *
 * The code and link come back from the mint and are held in state until the sheet closes, the code
 * expires or the owner ends it. They are never written to a store, the URL or a log, and never put in a
 * live region. The QR is drawn here from that state, so no image service ever sees the credential.
 * This is why the harness shows a fixed fake code.
 *
 * ## ONE FIELD, AND THE SHEET SAYS WHAT IT MEANS BEFORE ANYTHING IS MADE
 *
 * The owner types a user ID. An ID someone already has reaches that same person (they sign in with their own
 * passkey); a new one makes a new person. The line under the field says which, before the passkey button.
 * "They need a new passkey" (D8) appears only for an existing person on a single-use invite and is never on
 * unless the owner ticked it or the person has no passkey left.
 *
 * ## THE PASSKEY IS THE CARRIER'S JOB
 *
 * The act `share-catalog` is confirmed by the carrier when the daemon answers `403 grant_step_up_required`,
 * so this sheet only offers the button and renders whatever the machine answers.
 */

import {
  type CatalogMemberView,
  type CatalogShareMintResponse,
  type OwnedCatalog,
  shareLinkNotice,
} from '../../../contract/wire/index.ts';
import { CircleAlert, Copy, Fingerprint } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { QrSymbol } from './qr-symbol.tsx';
import type { DaemonConnection } from '../../lib/machine.ts';
/** How often the share countdown moves. */
const PAIRING_TICK_MS = 1_000;
import { encodeQr, QrEncodeError, type QrMatrix } from '../../lib/qr.ts';
import { useDaemonClient } from '../../lib/client-context.tsx';
import { Button } from '@ferretry/app/ui';
import { CatalogSheet, FailureLine, SharingOffPanel } from './catalog-parts.tsx';
import { endShare, listMembers, mintShare } from './catalog-shares-api.ts';
import {
  CAP_PROBLEM,
  DEFAULT_CAP_TEXT,
  EXPIRY_CHOICES,
  emptyDraft,
  expiryLine,
  mintRequest,
  newPasskeyChoice,
  newPasskeyHelp,
  newPasskeyPreTicked,
  personWithId,
  recipientName,
  SHARE_CAP_LABEL,
  SHARE_CLOSE_NOTE,
  SHARE_CONFIRM_LABEL,
  SHARE_COPIED_LINE,
  SHARE_COPY_FAILED_LINE,
  SHARE_ENDED_LINE,
  SHARE_MANY_LABEL,
  SHARE_NEW_PASSKEY_LABEL,
  SHARE_ONE_LABEL,
  SHARE_QR_FAILED_LINE,
  SHARE_QR_LABEL,
  SHARE_USER_ID_HELP,
  SHARE_USER_ID_LABEL,
  SHARE_USER_ID_PLACEHOLDER,
  SHARE_WAITING_LABEL,
  type ShareDraft,
  shareCountdown,
  shareProblem,
  shareResultTitle,
  shareSheetTitle,
  sharingRefusal,
  shownOnceLine,
  suggestPeople,
  userIdLine,
  userIdProblem,
} from './catalog-sharing-model.ts';
import type { CatalogClientFactory } from './catalogs-api.ts';
import type { OwnerRefusal } from './catalogs-model.ts';

export interface ShareSheetProps {
  readonly connection: DaemonConnection;
  readonly createClient?: CatalogClientFactory;
  readonly catalog: OwnedCatalog;
  /** Every catalog on this machine, so an existing person's line can name theirs. */
  readonly catalogs?: readonly OwnedCatalog[];
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
  catalogs = [catalog],
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
  const problem = shareProblem(draft);

  const mint = async (): Promise<void> => {
    if (problem !== null || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await mintShare(await createClient(connection), mintRequest(catalog.id, draft, members));
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
    <CatalogSheet name="share" title={title} closeLabel="Close the invite sheet" onClose={onClose}>
      {made === null ? (
        <ShareForm
          draft={draft}
          members={members}
          catalogs={catalogs}
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
  catalogs,
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
  readonly catalogs: readonly OwnedCatalog[];
  readonly people: Read;
  readonly problem: string | null;
  readonly busy: boolean;
  readonly failure: OwnerRefusal | null;
  readonly connection: DaemonConnection;
  readonly createClient: CatalogClientFactory;
  readonly onDraft: (next: ShareDraft) => void;
  readonly onSubmit: () => void;
}) {
  const idField = useId();
  const expiryId = useId();
  const capId = useId();
  const usesGroup = useId();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit();
  };

  if (people.kind === 'failed' && people.refusal.sharingOff)
    return <SharingOffPanel connection={connection} createClient={createClient} />;

  const line = userIdLine(draft, members, catalogs);
  const hidden = userIdProblem(draft.userId);
  const suggestions = suggestPeople(draft.userId, members);
  const person = personWithId(draft.userId, members);
  const passkey = newPasskeyChoice(draft, members);

  return (
    <form className="flex min-w-0 flex-col gap-sm" onSubmit={submit} data-share-form="">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={idField} className="text-meta font-semibold text-muted">
          {SHARE_USER_ID_LABEL}
        </label>
        <input
          id={idField}
          className="kt-input"
          value={draft.userId}
          placeholder={SHARE_USER_ID_PLACEHOLDER}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={`${idField}-help ${idField}-line`}
          aria-invalid={hidden === null ? undefined : true}
          onChange={event => onDraft({ ...draft, userId: event.target.value, newPasskey: null })}
          data-share-user-id=""
        />
        <p id={`${idField}-help`} className="m-0 text-meta text-muted" data-share-user-id-help="">
          {SHARE_USER_ID_HELP}
        </p>
        {suggestions.length === 0 ? null : (
          <ul
            className="m-0 flex min-w-0 list-none flex-wrap gap-xs p-0"
            aria-label="People already here"
            data-share-suggestions=""
          >
            {suggestions.map(suggestion => (
              <li key={suggestion.memberId} className="min-w-0">
                <Button
                  type="button"
                  size="sm"
                  className="min-h-[44px] max-w-full break-all"
                  onClick={() => onDraft({ ...draft, userId: suggestion.label, newPasskey: null })}
                  data-share-suggestion=""
                >
                  {suggestion.label}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {hidden === null ? null : <FailureLine sentence={hidden} />}
        <p
          id={`${idField}-line`}
          className="m-0 break-words text-cell text-fg"
          aria-live="polite"
          data-share-user-id-line=""
        >
          {hidden !== null || failure !== null || line === null ? null : (
            <>
              {line.before}
              <strong>{line.id}</strong>
              {line.after}
            </>
          )}
        </p>
      </div>

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
        <label className="flex min-h-[44px] items-center gap-2 text-cell text-fg">
          <input
            type="radio"
            name={usesGroup}
            checked={draft.howMany.kind === 'single'}
            onChange={() => onDraft({ ...draft, howMany: { kind: 'single' } })}
            data-share-uses-single=""
          />
          {SHARE_ONE_LABEL}
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-cell text-fg">
          <input
            type="radio"
            name={usesGroup}
            checked={draft.howMany.kind === 'multi'}
            onChange={() => onDraft({ ...draft, howMany: { kind: 'multi', cap: DEFAULT_CAP_TEXT } })}
            data-share-uses-multi=""
          />
          {SHARE_MANY_LABEL}
        </label>
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

      {passkey.offered && person !== undefined ? (
        <div className="flex min-w-0 flex-col gap-1" data-share-new-passkey="">
          <label className="flex min-h-[44px] items-center gap-2 text-cell text-fg">
            <input
              type="checkbox"
              checked={passkey.ticked}
              onChange={event => onDraft({ ...draft, newPasskey: event.target.checked })}
              aria-describedby={`${idField}-passkey`}
              data-share-new-passkey-box=""
            />
            {SHARE_NEW_PASSKEY_LABEL}
          </label>
          <p id={`${idField}-passkey`} className="m-0 break-words text-meta text-muted" data-share-new-passkey-help="">
            {passkey.preTicked ? newPasskeyPreTicked(person.label) : newPasskeyHelp(person.label)}
          </p>
        </div>
      ) : null}

      {failure === null ? null : failure.sharingOff ? (
        <SharingOffPanel connection={connection} createClient={createClient} />
      ) : (
        <FailureLine sentence={failure.sentence} />
      )}
      {problem === null || busy || hidden !== null ? null : (
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
    <div className="flex justify-center rounded-control border border-border bg-white p-3" data-share-qr="">
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
  // Read from the minted link, never from the one in state: an ended or expired link still told the truth.
  const relayed = shareLinkNotice(response.link);

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
          {relayed === undefined ? null : (
            <p className="m-0 text-meta text-muted" data-share-relayed="">
              {relayed}
            </p>
          )}
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
