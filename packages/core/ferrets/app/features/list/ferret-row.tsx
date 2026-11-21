/**
 * ONE FERRET IN THE LIST: the status mark, its task as the title and the directory it runs in. The callsign is not
 * drawn (a title names the work); it stays in the row's tooltip, in Info and in `:agent` references. The whole row is ONE link to the ferret's chat; the open one is a soft filled pill.
 *
 * THE TITLE IS ALWAYS THE TASK, else the folder. A batch label never stands in for it: a rename changes the task, so a
 * title that preferred the label would hide the rename.
 *
 * A ferret with sub-ferrets draws a chevron with their count (`branch`): the sub-ferrets are the row's `children`, drawn
 * only while it is open. A pin button (`onPin`) pins or unpins in one press; the same act is in the row menu.
 *
 * The row menu belongs to whoever provides `RowMenuContext`. Without one the row draws no ⋯ and leaves the browser's own
 * right-click alone.
 */

import { PanelSlot } from '@ferretry/app';
import { ChevronDown, ChevronRight, Pin } from 'lucide-react';
import { type ReactNode, useContext, useRef, useState } from 'react';
import {
  FERRET_LIST_ROW_MARK_SLOT,
  type FerretListRowMarkSlotProps,
  type FerretNeedsYou,
  type FerretSummary,
} from '../../../contract/index.ts';
import { ferretTitles } from '../../lib/ferret-title.ts';
import { StatusMark } from '../../lib/status-mark.tsx';
import { RouteLink } from '../../ui.ts';
import { ferretChatHref } from '../new-ferret/hrefs.ts';
import { OutdatedMark } from '../restart-outdated/outdated-mark.tsx';
import { ferretDirectory, isPinned, isStopped } from './list-model.ts';
import { useRowContextGesture } from './row-context-gesture.ts';
import { RowMenuContext, type RowMenuTrigger } from './row-menu-context.ts';

export interface FerretRowProps {
  readonly ferret: FerretSummary;
  readonly daemon: string;
  readonly active: boolean;
  /** Open items waiting on the owner (`ferrets.needs-you`): a bold name, a count and the ask. Absent: none. */
  readonly needsYou?: FerretNeedsYou;
  readonly onNavigate?: (to: string) => void;
  /** The daemon's client, which keys what "Restart outdated" last answered (`restart-outdated/restart-overlay.ts`). */
  readonly overlayKey?: object;
  /** Pins (`true`) or unpins the ferret. Absent: the row draws no pin button. */
  readonly onPin?: (pinned: boolean) => void;
  /** The sub-ferrets under this one: how many, whether they are drawn now, and how the reader flips it. */
  readonly branch?: { readonly count: number; readonly open: boolean; readonly toggle: () => void };
  /** The rows of the sub-ferrets, drawn under this one while `branch.open`. */
  readonly children?: ReactNode;
}

/** What a count badge says aloud: "3 open Inbox items". */
const waitingWords = (count: number): string => `${count} open Inbox ${count === 1 ? 'item' : 'items'}`;

export function FerretRow({
  ferret,
  daemon,
  active,
  needsYou,
  onNavigate,
  overlayKey,
  onPin,
  branch,
  children,
}: FerretRowProps): ReactNode {
  const { title, ferret: callsign } = ferretTitles(ferret);
  const openMenu = useContext(RowMenuContext);
  const link = useRef<HTMLAnchorElement | null>(null);
  const [pressing, setPressing] = useState(false);
  const ask = (x: number, y: number, trigger: RowMenuTrigger): void =>
    openMenu?.({
      ferret,
      x,
      y,
      trigger,
      focusRow: () => {
        const node = link.current;
        if (node === null || !node.isConnected) return false;
        node.focus();
        return true;
      },
    });
  // Right-click, the Menu key, Shift+F10 and a held finger all open the same menu; `undefined` (no provider) leaves the
  // browser's own context menu and every key alone.
  const gesture = useRowContextGesture<FerretSummary>(
    openMenu === undefined ? undefined : (_ferret, x, y, by) => ask(x, y, by),
    ferret,
    setPressing,
  );
  const pinned = isPinned(ferret);
  return (
    <li className="fy-sbar__row" data-sbar-row={ferret.id}>
      <RouteLink
        aria-current={active ? 'page' : undefined}
        aria-haspopup={openMenu === undefined ? undefined : 'menu'}
        className="fy-sbar__session"
        data-sbar-branch={branch === undefined ? undefined : ''}
        data-sbar-needs-you={needsYou === undefined ? undefined : ''}
        data-sbar-pinned={isPinned(ferret) ? '' : undefined}
        data-sbar-pressing={pressing ? '' : undefined}
        data-sbar-session={ferret.id}
        data-sbar-stopped={isStopped(ferret) ? '' : undefined}
        {...gesture}
        ref={link}
        title={`${title}${callsign === null ? '' : ` — ${callsign}`}\n${ferret.folder}`}
        to={ferretChatHref(daemon, ferret.id)}
        {...(onNavigate === undefined ? {} : { onNavigate })}
      >
        <StatusMark ferret={ferret} />
        <span className="fy-sbar__title">
          <span className="fy-sbar__name">{title}</span>
          {needsYou === undefined ? null : (
            <span aria-label={waitingWords(needsYou.count)} className="fy-sbar__unread" data-sbar-unread="" role="img">
              {needsYou.count}
            </span>
          )}
          <OutdatedMark ferret={ferret} overlayKey={overlayKey} />
        </span>
        <span className="fy-sbar__detail" data-sbar-detail="">
          {needsYou === undefined || needsYou.ask === '' ? null : (
            <span className="fy-sbar__sub fy-sbar__ask" data-sbar-ask="">
              {needsYou.ask}
            </span>
          )}
          {/* Truncated from the left (`direction: rtl`), so the folder's own name survives; `bdi` keeps the path's
              slashes reading left to right inside it. */}
          <span className="fy-sbar__dir" data-sbar-dir="">
            <bdi>{ferretDirectory(ferret)}</bdi>
          </span>
          {/* Marks other plugins own (Usage: the account's quota) are drawn through the slot Ferrets offers. */}
          {ferret.runtime === undefined ? null : (
            <span className="fy-sbar__marks" data-sbar-marks="">
              <PanelSlot
                daemon={daemon}
                props={
                  {
                    ferret: ferret.id,
                    runtime: ferret.runtime,
                    ...(ferret.login === undefined ? {} : { login: ferret.login }),
                  } satisfies FerretListRowMarkSlotProps
                }
                slot={FERRET_LIST_ROW_MARK_SLOT}
                subject={ferret.id}
              />
            </span>
          )}
        </span>
      </RouteLink>
      {branch === undefined ? null : (
        <button
          aria-expanded={branch.open}
          aria-label={`${branch.open ? 'Hide' : 'Show'} ${branch.count} sub-${branch.count === 1 ? 'ferret' : 'ferrets'} of ${title}`}
          className="fy-sbar__branch"
          data-sbar-branch-toggle=""
          onClick={branch.toggle}
          type="button"
        >
          {branch.open ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
          <span>{branch.count}</span>
        </button>
      )}
      {onPin === undefined ? null : (
        <button
          aria-label={`${pinned ? 'Unpin' : 'Pin'} ${title}`}
          aria-pressed={pinned}
          className="fy-sbar__pin"
          data-sbar-pin=""
          onClick={() => onPin(!pinned)}
          type="button"
        >
          <Pin aria-hidden="true" size={14} />
        </button>
      )}
      {openMenu === undefined ? null : (
        <button
          aria-haspopup="menu"
          aria-label={`Actions for ${title}`}
          className="fy-sbar__more"
          data-sbar-more=""
          onClick={event => {
            const box = event.currentTarget.getBoundingClientRect();
            ask(box.left, box.bottom, 'mouse');
          }}
          type="button"
        >
          ⋯
        </button>
      )}
      {branch?.open === true && children !== undefined ? <ul className="fy-sbar__children">{children}</ul> : null}
    </li>
  );
}
