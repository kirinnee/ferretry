/** ONE CONNECTED APP: its name, what it may do, who approved it and when it last called, and Revoke (live grants only). */
import { ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@ferretry/app/ui';
import type { ConnectorGrantView } from '../../contract/index.ts';
import { agoWords, approvedByWords, scopeSentence } from '../lib/words.ts';

export function GrantRow({
  grant,
  now,
  busy,
  onRevoke,
}: {
  readonly grant: ConnectorGrantView;
  readonly now: number;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}) {
  return (
    <li
      data-connector-grant={grant.id}
      data-connector-revoked={grant.revokedAt === undefined ? undefined : ''}
      className="flex min-w-0 flex-col gap-1 px-panel py-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ShieldCheck size={15} className="shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-[9rem] flex-1 break-words text-ui font-semibold text-fg">{grant.clientName}</span>
        {grant.revokedAt !== undefined ? (
          <span className="text-meta text-faint" data-connector-revoked-label="">
            Revoked {agoWords(grant.revokedAt, now)}
          </span>
        ) : (
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            data-connector-revoke={grant.id}
            icon={<Trash2 size={14} aria-hidden="true" />}
            onClick={onRevoke}
            className="min-h-[44px] shrink-0"
          >
            Revoke
          </Button>
        )}
      </div>
      <p className="m-0 text-cell leading-base text-muted">Can {scopeSentence(grant.scopes)}.</p>
      <p className="m-0 flex flex-wrap gap-x-1 text-meta leading-base text-faint" data-connector-grant-facts="">
        {[
          approvedByWords(grant.approvedBy),
          `connected ${agoWords(grant.createdAt, now)}`,
          grant.lastUsedAt === undefined ? 'never used' : `last used ${agoWords(grant.lastUsedAt, now)}`,
        ].map((fact, at, all) => (
          // A fact keeps its own separator, so a wrapped line never starts with a dot.
          <span key={fact} className="whitespace-nowrap">
            {at < all.length - 1 ? `${fact} ·` : fact}
          </span>
        ))}
      </p>
    </li>
  );
}
