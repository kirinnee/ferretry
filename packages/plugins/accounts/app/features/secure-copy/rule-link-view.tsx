/**
 * THE `#rules/<stage>?machine=<daemon id>` LINK (`ruleDeepLink`, printed by `fy rules add`): Accounts' DEVICE VIEW
 * (shell contract S3, MA2). The shell takes the declared `#rules/…` fragment off the address before anything draws and
 * hands it whole to this one view — mounted once, over every machine (`useEveryDaemon`), so the per-machine halves never
 * race for it — and this view sends the page to one machine's Secure copy tab, where that machine's list highlights the
 * row (v4's `useRuleDeepLink`, unchanged in what the owner sees):
 *
 * - a link that names a machine opens on that one; a link that names none opens on the machine on screen, else the
 *   first;
 * - a link that names a machine this device is not paired with is dropped and said so, in one line;
 * - with no paired machine there is nowhere to look, and the link is dropped.
 *
 * The link is untrusted input (anyone can send one): it only picks where to navigate and which row to show, and never
 * reaches a daemon.
 */

import {
  type DeviceViewProps,
  daemonSettingsHref,
  useEveryDaemon,
  useFragment,
  useOptionalRouter,
} from '@ferretry/app';
import { useEffect, useRef, useState } from 'react';
import { ruleDeepLinkFromFragment } from '../../../contract/routes/index.ts';
import { RULE_LINKED_ELSEWHERE_WORDS, type RuleLinkHold } from '../../lib/rule-link.ts';

/** The fragment key Accounts declares. */
export const RULE_FRAGMENT_KEY = 'rules';
/** Accounts' plugin id and its Secure copy tab, where the list a link opens on lives. */
const SECURE_COPY = { plugin: 'accounts', tab: 'secure-copy' } as const;

/** The machine the page is on, when it is on one. */
const onScreen = (route: ReturnType<typeof useOptionalRouter>): string | undefined =>
  route === null || !('daemon' in route.route) ? undefined : route.route.daemon;

export function ruleLinkView(hold: RuleLinkHold) {
  return function RuleLinkView({ navigate }: DeviceViewProps) {
    const rows = useEveryDaemon();
    const router = useOptionalRouter();
    const { arrival, take } = useFragment(RULE_FRAGMENT_KEY);
    const [elsewhere, setElsewhere] = useState(false);
    const here = onScreen(router);
    // Each arrival is read once, against the machines and the page of that moment.
    const handled = useRef(0);
    useEffect(() => {
      if (arrival === 0 || handled.current === arrival) return;
      handled.current = arrival;
      const link = ruleDeepLinkFromFragment(take() ?? '');
      setElsewhere(false);
      if (link === null || rows.length === 0) return;
      const target =
        link.machine === undefined
          ? (rows.find(row => row.daemon === here) ?? rows[0])
          : rows.find(row => row.daemon === link.machine);
      if (target === undefined) {
        setElsewhere(true);
        return;
      }
      hold.hold(link.stage, target.daemon);
      navigate(daemonSettingsHref(target.daemon, SECURE_COPY.plugin, SECURE_COPY.tab));
    }, [arrival, take, rows, here, navigate]);
    if (!elsewhere) return null;
    return (
      <div
        className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md items-center gap-3 rounded-control border border-border bg-surface-2 p-3 shadow-lg"
        data-rule-linked-elsewhere=""
        role="status"
      >
        <p className="m-0 min-w-0 flex-1 text-ui text-fg">{RULE_LINKED_ELSEWHERE_WORDS}</p>
        <button className="kt-btn min-h-[44px]" onClick={() => setElsewhere(false)} type="button">
          Dismiss
        </button>
      </div>
    );
  };
}
