/**
 * People and codes: who can read your catalogs, on which browsers, and the share codes you made.
 *
 * Every act here ends access, so each one says what it does BEFORE it is done (§5.5) and nothing is
 * undone silently. After an act the lists are read again from the machine, never patched by hand.
 * What a person already downloaded or installed stays with them; the confirm sentences say so.
 */

import type { CatalogMemberView, CatalogShareView, OwnedCatalog } from '@ferretry/protocol';
import { CircleCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import { FailureLine, SharingOffPanel } from './catalog-parts.tsx';
import {
  endShare,
  listMembers,
  listShares,
  removeMemberBrowser,
  revokeMember,
  takeAwayCatalog,
} from './catalog-shares-api.ts';
import {
  browserLine,
  browserRemovedNote,
  type ConfirmWords,
  catalogTakenNote,
  liveShareCount,
  MEMBERS_EMPTY,
  MEMBERS_NOTE,
  MEMBERS_TITLE,
  memberCatalogNames,
  multiShareOf,
  multiSummary,
  orderedShares,
  removeBrowserConfirm,
  revokeConfirm,
  revokedNote,
  revokeLabel,
  SHARES_EMPTY,
  shareEndedNote,
  shareRow,
  sharingRefusal,
  takeAwayChoices,
  takeAwayConfirm,
} from './catalog-sharing-model.ts';
import type { CatalogClientFactory } from './catalogs-api.ts';
import type { OwnerRefusal } from './catalogs-model.ts';

export interface CatalogMembersPanelProps {
  readonly connection: DaemonConnection;
  readonly createClient?: CatalogClientFactory;
  /** The catalogs on this machine, to name what each person can read. */
  readonly catalogs: readonly OwnedCatalog[];
  readonly onBack: () => void;
  /** Test and harness seams. */
  readonly now?: () => number;
  readonly timeZone?: string;
  /** Opens with one confirm already showing (the harness uses this). */
  readonly initialConfirm?: Confirm | null;
}

type Read =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly members: readonly CatalogMemberView[];
      readonly shares: readonly CatalogShareView[];
    }
  | { readonly kind: 'failed'; readonly refusal: OwnerRefusal };

export type Confirm =
  | { readonly kind: 'revoke'; readonly memberId: string }
  | { readonly kind: 'browser'; readonly memberId: string; readonly keyId: string }
  | { readonly kind: 'catalog'; readonly memberId: string; readonly catalogId: string };

export function CatalogMembersPanel({
  connection,
  createClient: injected,
  catalogs,
  onBack,
  now = Date.now,
  timeZone,
  initialConfirm = null,
}: CatalogMembersPanelProps) {
  const routed = useDaemonClient();
  const createClient: CatalogClientFactory = injected ?? routed;
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(initialConfirm);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OwnerRefusal | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const reload = useCallback(() => setTick(previous => previous + 1), []);

  useEffect(() => {
    let live = true;
    // `tick` is the reload trigger: finishing an act bumps it.
    void tick;
    void (async () => {
      try {
        const client = await createClient(connection);
        const [people, codes] = await Promise.all([listMembers(client), listShares(client)]);
        if (live) setRead({ kind: 'ready', members: people.members, shares: codes.shares });
      } catch (error) {
        if (live) setRead({ kind: 'failed', refusal: sharingRefusal(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [connection, createClient, tick]);

  const act = async (work: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      setNote(await work());
      reload();
    } catch (error) {
      setFailure(sharingRefusal(error));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const nowMs = now();
  const members = read.kind === 'ready' ? read.members : [];
  const shares = read.kind === 'ready' ? read.shares : [];

  return (
    <div className="flex min-w-0 flex-col gap-sm" data-catalog-members="">
      <div>
        <Button type="button" variant="ghost" className="kt-btn--flush-start" onClick={onBack} data-members-back="">
          Back to catalogs
        </Button>
      </div>
      <header className="flex min-w-0 flex-col gap-0.5">
        <h4 className="m-0 text-row font-semibold text-fg">{MEMBERS_TITLE}</h4>
        <p className="m-0 text-cell text-muted">{MEMBERS_NOTE}</p>
      </header>
      {read.kind === 'loading' ? (
        <p className="m-0 text-cell text-muted" role="status">
          Reading people…
        </p>
      ) : read.kind === 'failed' ? (
        read.refusal.sharingOff ? (
          <SharingOffPanel connection={connection} createClient={createClient} />
        ) : (
          <FailureLine sentence={read.refusal.sentence} again onAgain={reload} againLabel="Try again" />
        )
      ) : null}
      {failure === null ? null : failure.sharingOff ? (
        <SharingOffPanel connection={connection} createClient={createClient} />
      ) : (
        <FailureLine sentence={failure.sentence} />
      )}
      {note === null ? null : (
        <p className="m-0 flex items-start gap-2 break-words text-cell text-ok" role="status" data-members-note="">
          <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{note}</span>
        </p>
      )}
      {read.kind !== 'ready' ? null : (
        <>
          <section className="flex min-w-0 flex-col gap-xs" aria-label="People" data-members-people="">
            <h5 className="m-0 text-cell font-semibold text-fg">People</h5>
            {members.length === 0 ? (
              <p className="m-0 text-cell text-muted" data-members-empty="">
                {MEMBERS_EMPTY}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-xs p-0">
                {members.map(member => (
                  <MemberCard
                    key={member.memberId}
                    member={member}
                    catalogs={catalogs}
                    shares={shares}
                    nowMs={nowMs}
                    timeZone={timeZone}
                    busy={busy}
                    confirm={confirm}
                    onAsk={setConfirm}
                    onCancel={() => setConfirm(null)}
                    onRevoke={() =>
                      void act(async () => {
                        const done = await revokeMember(await createClient(connection), member.memberId);
                        return revokedNote(member.label, done.keysRemoved, done.sharesEnded);
                      })
                    }
                    onRemoveBrowser={keyId =>
                      void act(async () => {
                        await removeMemberBrowser(await createClient(connection), member.memberId, keyId);
                        const name = member.keys.find(key => key.keyId === keyId)?.clientName ?? 'That browser';
                        return browserRemovedNote(member.label, name);
                      })
                    }
                    onTakeAway={catalogId =>
                      void act(async () => {
                        await takeAwayCatalog(await createClient(connection), member.memberId, catalogId);
                        const name = catalogs.find(catalog => catalog.id === catalogId)?.name ?? 'that catalog';
                        return catalogTakenNote(member.label, name);
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </section>
          <section className="flex min-w-0 flex-col gap-xs" aria-label="Codes" data-members-shares="">
            <h5 className="m-0 text-cell font-semibold text-fg">Codes</h5>
            {shares.length === 0 ? (
              <p className="m-0 text-cell text-muted" data-shares-empty="">
                {SHARES_EMPTY}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-xs p-0">
                {orderedShares(shares, nowMs).map(share => (
                  <ShareRowView
                    key={share.shareId}
                    share={share}
                    nowMs={nowMs}
                    timeZone={timeZone}
                    busy={busy}
                    onEnd={() =>
                      void act(async () => {
                        await endShare(await createClient(connection), share.shareId);
                        return shareEndedNote(share.memberLabel);
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ConfirmBox({
  words,
  busy,
  onYes,
  onCancel,
}: {
  readonly words: ConfirmWords;
  readonly busy: boolean;
  readonly onYes: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-xs rounded-control border border-err-border bg-err-bg p-control-x py-2 text-err"
      role="alertdialog"
      aria-label={words.title}
      data-members-confirm=""
    >
      <p className="m-0 break-words text-cell font-semibold">{words.title}</p>
      {words.lines.map(line => (
        <p key={line} className="m-0 break-words text-cell">
          {line}
        </p>
      ))}
      <div className="flex flex-wrap gap-xs">
        <Button type="button" variant="danger" disabled={busy} onClick={onYes} data-members-confirm-yes="">
          {words.yes}
        </Button>
        <Button type="button" onClick={onCancel} data-members-confirm-no="">
          Keep it
        </Button>
      </div>
    </section>
  );
}

function MemberCard({
  member,
  catalogs,
  shares,
  nowMs,
  timeZone,
  busy,
  confirm,
  onAsk,
  onCancel,
  onRevoke,
  onRemoveBrowser,
  onTakeAway,
}: {
  readonly member: CatalogMemberView;
  readonly catalogs: readonly OwnedCatalog[];
  readonly shares: readonly CatalogShareView[];
  readonly nowMs: number;
  readonly timeZone: string | undefined;
  readonly busy: boolean;
  readonly confirm: Confirm | null;
  readonly onAsk: (next: Confirm) => void;
  readonly onCancel: () => void;
  readonly onRevoke: () => void;
  readonly onRemoveBrowser: (keyId: string) => void;
  readonly onTakeAway: (catalogId: string) => void;
}) {
  const multi = multiShareOf(member, shares);
  const mine = confirm !== null && confirm.memberId === member.memberId ? confirm : null;
  const browsers = (
    <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label={`${member.label}’s browsers`}>
      {member.keys.map(key => (
        <li key={key.keyId} className="flex min-w-0 flex-col gap-0.5" data-members-browser={key.clientName}>
          <span className="break-words text-cell font-semibold text-fg">{key.clientName}</span>
          <span className="break-words text-meta text-muted">{browserLine(key, nowMs, timeZone)}</span>
          {mine?.kind === 'browser' && mine.keyId === key.keyId ? (
            <ConfirmBox
              words={removeBrowserConfirm(member, key)}
              busy={busy}
              onYes={() => onRemoveBrowser(key.keyId)}
              onCancel={onCancel}
            />
          ) : (
            <div>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => onAsk({ kind: 'browser', memberId: member.memberId, keyId: key.keyId })}
                data-members-remove-browser={key.clientName}
              >
                Remove this browser…
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <li className="kt-panel flex min-w-0 flex-col gap-xs p-control-x py-2" data-members-person={member.label}>
      <span className="break-words text-ui font-semibold text-fg">{member.label}</span>
      <span className="break-words text-meta text-muted" data-members-catalogs="">
        Can read: {memberCatalogNames(member, catalogs)}
      </span>
      {multi === null ? null : (
        <span className="break-words text-meta text-muted" data-members-multi="">
          {multiSummary(multi, nowMs, timeZone)}
        </span>
      )}
      {multi === null ? (
        browsers
      ) : (
        <details className="text-meta text-muted" data-members-browsers-folded="">
          <summary className="cursor-pointer select-none">{member.keys.length} browsers</summary>
          {browsers}
        </details>
      )}
      <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label={`Take a catalog away from ${member.label}`}>
        {takeAwayChoices(member, catalogs).map(catalog => (
          <li key={catalog.id} className="flex min-w-0 flex-col gap-xs">
            {mine?.kind === 'catalog' && mine.catalogId === catalog.id ? (
              <ConfirmBox
                words={takeAwayConfirm(member, catalog.name)}
                busy={busy}
                onYes={() => onTakeAway(catalog.id)}
                onCancel={onCancel}
              />
            ) : (
              <div>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => onAsk({ kind: 'catalog', memberId: member.memberId, catalogId: catalog.id })}
                  data-members-take-away={catalog.name}
                >
                  Take away {catalog.name}…
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {mine?.kind === 'revoke' ? (
        <ConfirmBox
          words={revokeConfirm(member, liveShareCount(member, shares, nowMs))}
          busy={busy}
          onYes={onRevoke}
          onCancel={onCancel}
        />
      ) : (
        <div>
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => onAsk({ kind: 'revoke', memberId: member.memberId })}
            data-members-revoke={member.label}
          >
            {revokeLabel(member, multi !== null)}
          </Button>
        </div>
      )}
    </li>
  );
}

function ShareRowView({
  share,
  nowMs,
  timeZone,
  busy,
  onEnd,
}: {
  readonly share: CatalogShareView;
  readonly nowMs: number;
  readonly timeZone: string | undefined;
  readonly busy: boolean;
  readonly onEnd: () => void;
}) {
  const row = shareRow(share, nowMs, timeZone);
  return (
    <li className="kt-panel flex min-w-0 flex-col gap-0.5 p-control-x py-2" data-members-share={row.state}>
      <span className="break-words text-cell text-fg">{row.line}</span>
      {row.usedBy.length === 0 ? null : (
        <span className="break-words text-meta text-muted" data-members-used-by="">
          Used by {row.usedBy.join(', ')}
        </span>
      )}
      {row.canEnd ? (
        <div>
          <Button type="button" size="sm" disabled={busy} onClick={onEnd} data-members-end-share="">
            End now
          </Button>
        </div>
      ) : null}
    </li>
  );
}
