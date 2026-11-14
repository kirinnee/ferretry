/**
 * ONE FERRET IN THE LIST: the status mark, its task as the title, the ferret doing it (an initial and its name) and the
 * directory it runs in. The whole row is ONE link to the ferret's chat; the open one is a soft filled pill.
 *
 * THE TITLE IS ALWAYS THE TASK, else the folder. A batch label never stands in for it: a rename changes the task, so a
 * title that preferred the label would hide the rename.
 *
 * The row menu belongs to whoever provides `RowMenuContext`. Without one the row draws no ⋯ and leaves the browser's own
 * right-click alone.
 */

import { type ReactNode, useContext, useRef, useState } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
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
  readonly onNavigate?: (to: string) => void;
}

export function FerretRow({ ferret, daemon, active, onNavigate }: FerretRowProps): ReactNode {
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
  return (
    <li className="fy-sbar__row">
      <RouteLink
        aria-current={active ? 'page' : undefined}
        aria-haspopup={openMenu === undefined ? undefined : 'menu'}
        className="fy-sbar__session"
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
          <OutdatedMark ferret={ferret} />
        </span>
        <span className="fy-sbar__detail" data-sbar-detail="">
          {callsign === null ? null : (
            <span className="fy-sbar__sub fy-sbar__ferret" data-sbar-ferret="">
              <span aria-hidden="true" className="fy-sbar__initial">
                {callsign.charAt(0).toUpperCase()}
              </span>
              <span className="fy-sbar__ferret-name">{callsign}</span>
            </span>
          )}
          {/* Truncated from the left (`direction: rtl`), so the folder's own name survives; `bdi` keeps the path's
              slashes reading left to right inside it. */}
          <span className="fy-sbar__dir" data-sbar-dir="">
            <bdi>{ferretDirectory(ferret)}</bdi>
          </span>
        </span>
      </RouteLink>
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
    </li>
  );
}
