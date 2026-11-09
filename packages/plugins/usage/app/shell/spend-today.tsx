/**
 * `daemon.status:spend-today`: the "Spend today" tile of the machine's home — what today's ferrets on this machine
 * cost, read from this machine's own insights (today's `machine-home.tsx` tile fed by `useSpendToday`).
 *
 * Unknown is not zero: a machine that has not answered, or whose ferrets today carry no price, draws a dash and says
 * "not available" — never "$0". It links to Insights.
 */
import { useOptionalRouter } from '@ferretry/app';
import { RouteLink } from '@ferretry/app/ui';
import { useSpendToday } from '../hooks/use-spend-today.ts';
import { daemonInsightsPath, THIS_MACHINE_NAME, type UsageClient, useDaemonConnection } from '../shell.ts';

const DASH = '—';

/** Dollars as the tile says them: a true zero is "$0", a hundred or more is whole dollars. */
export const spendDollars = (usd: number): string =>
  usd === 0 ? '$0' : `$${usd >= 100 ? Math.round(usd) : usd.toFixed(2)}`;

export function SpendTodayPanel({ client, now }: { readonly client: UsageClient; readonly now?: () => Date }) {
  const connection = useDaemonConnection();
  const router = useOptionalRouter();
  const usd = useSpendToday(connection, client, now);
  return (
    <RouteLink
      className="flex min-h-[88px] min-w-0 flex-col justify-between rounded-panel border border-border bg-surface px-3 py-2.5 text-fg no-underline transition-colors hover:bg-surface-2"
      data-home-tile="Spend today"
      to={daemonInsightsPath(connection.daemonId)}
      {...(router ? { onNavigate: router.navigate } : {})}
    >
      <span className="text-meta text-muted">Spend today</span>
      <span className="font-display text-display font-bold leading-none tracking-display">
        {usd === null ? DASH : spendDollars(usd)}
      </span>
      <span className="line-clamp-2 text-meta text-faint">{usd === null ? 'not available' : THIS_MACHINE_NAME}</span>
    </RouteLink>
  );
}
