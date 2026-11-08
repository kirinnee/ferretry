/**
 * THE `#rules/<stage>?machine=<daemon id>` LINK (`ruleDeepLink`, printed by `fy rules add`): Accounts' DEVICE VIEW
 * (shell contract S3, MA2). The shell takes the declared `#rules/…` fragment off the address before anything draws and
 * hands it whole to this one view — mounted once, over every machine (`useEveryDaemon`), so the per-machine halves never
 * race for it — and this view sends the page to one machine's Secure copy tab, where that machine's list highlights the
 * row (v4's `useRuleDeepLink`, unchanged in what the owner sees):
 *
 * - a link that names a machine opens on that one; a link that names none opens on the machine on screen, else the
 *   selected one, else the first (v4's rule);
 * - the link is decided against the PAIRED list (known at boot), not the connected rows: a machine that is paired but
 *   has no row yet (still connecting) is waited for — bounded by two minutes — and is never called "not on this machine";
 * - a link that names a machine this device is not paired with is dropped and said so, in one line;
 * - with no paired machine there is nowhere to look, and the link is dropped.
 *
 * The link is untrusted input (anyone can send one): it only picks where to navigate and which row to show, and never
 * reaches a daemon.
 */

import {
  type DeviceViewProps,
  daemonSettingsHref,
  useDevicePaired,
  useEveryDaemon,
  useFragment,
  useOptionalRouter,
} from '@ferretry/app';
import { useEffect, useRef, useState } from 'react';
import { ruleDeepLinkFromFragment } from '../../../contract/routes/index.ts';
import { RULE_LINKED_ELSEWHERE_WORDS, type RuleLinkHold } from '../../lib/rule-link.ts';

/** The fragment key Accounts declares. */
export const RULE_FRAGMENT_KEY = 'rules';
/** How long a link may wait for the machine it opens on to connect. */
export const RULE_LINK_WAIT_MS = 120_000;
/** Accounts' plugin id and its Secure copy tab, where the list a link opens on lives. */
const SECURE_COPY = { plugin: 'accounts', tab: 'secure-copy' } as const;

/** The machine the page is on, when it is on one. */
const onScreen = (route: ReturnType<typeof useOptionalRouter>): string | undefined =>
  route === null || !('daemon' in route.route) ? undefined : route.route.daemon;

export function ruleLinkView(hold: RuleLinkHold) {
  return function RuleLinkView({ navigate }: DeviceViewProps) {
    const rows = useEveryDaemon();
    const router = useOptionalRouter();
    const { daemons, selected } = useDevicePaired();
    const { arrival, take } = useFragment(RULE_FRAGMENT_KEY);
    const [elsewhere, setElsewhere] = useState(false);
    const [link, setLink] = useState<ReturnType<typeof ruleDeepLinkFromFragment>>(null);
    const here = onScreen(router);
    // Each arrival is taken once; the link then waits in state for the machine it opens on.
    const handled = useRef(0);
    useEffect(() => {
      if (arrival === 0 || handled.current === arrival) return;
      handled.current = arrival;
      setElsewhere(false);
      setLink(ruleDeepLinkFromFragment(take() ?? ''));
    }, [arrival, take]);
    useEffect(() => {
      if (link === null) return;
      const timer = setTimeout(() => setLink(null), RULE_LINK_WAIT_MS);
      return () => clearTimeout(timer);
    }, [link]);
    useEffect(() => {
      if (link === null) return;
      const paired = daemons.map(daemon => daemon.daemon);
      const first = paired[0];
      if (first === undefined) return setLink(null);
      const wanted =
        link.machine ?? (here !== undefined && paired.includes(here) ? here : selected !== null ? selected : first);
      if (!paired.includes(wanted)) {
        // Only a machine this device is not paired with is "not on this machine".
        setLink(null);
        if (link.machine !== undefined) setElsewhere(true);
        return;
      }
      // Paired but no row yet: still connecting (or the plugin is not on there yet) — wait, bounded by the hold.
      if (!rows.some(row => row.daemon === wanted)) return;
      setLink(null);
      hold.hold(link.stage, wanted);
      navigate(daemonSettingsHref(wanted, SECURE_COPY.plugin, SECURE_COPY.tab));
    }, [link, daemons, selected, rows, here, navigate]);
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
