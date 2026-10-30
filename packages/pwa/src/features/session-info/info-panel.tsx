/**
 * The Info panel's content: a title line, six tabs, and the shown tab's rows. Presentational — the
 * frame around it (a resizable right panel on a desktop, a half/full bottom sheet on a phone) is
 * `info-frame.tsx`, and each tab's body is the host's render prop, so the panel never reads a daemon.
 */

import { Maximize2, Minimize2, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { SheetTabs, sheetPanelId, sheetTabId } from '../../shell/sheet-tabs.tsx';
import { INFO_TAB_LABEL, INFO_TABS_WITHOUT_BOARD, type InfoTab, scrollToShow } from './info-model.ts';

export type InfoSheetSize = 'half' | 'full';

export interface InfoPanelProps {
  readonly name: string;
  readonly tab: InfoTab;
  readonly onTabChange: (tab: InfoTab) => void;
  readonly onClose: () => void;
  /** Each tab's body, rendered only while it is shown. */
  readonly render: Readonly<Record<InfoTab, () => ReactNode>>;
  /** The tabs offered, in order. Absent: every tab but Tasks (the host has no board). */
  readonly tabs?: readonly InfoTab[];
  /** Phone: the sheet's height, and the control that switches it. */
  readonly sheetSize?: InfoSheetSize;
  readonly onSheetSizeChange?: (size: InfoSheetSize) => void;
  readonly titleId?: string;
}

export function InfoPanel({
  name,
  tab,
  onTabChange,
  onClose,
  render,
  tabs = INFO_TABS_WITHOUT_BOARD,
  sheetSize,
  onSheetSizeChange,
  titleId,
}: InfoPanelProps) {
  const id = useId().replace(/:/gu, '');
  const strip = useRef<HTMLDivElement>(null);

  // The strip scrolls sideways on a narrow screen; keep the shown tab inside it.
  useEffect(() => {
    const row = strip.current;
    const active = row?.querySelector<HTMLElement>(`[role="tab"][id$="-tab-${tab}"]`);
    if (row === null || row === undefined || active === null || active === undefined) return;
    row.scrollLeft = scrollToShow(row.scrollLeft, active.offsetLeft, active.offsetWidth, row.clientWidth);
  }, [tab]);
  return (
    <div className="fy-info" data-info-panel="" data-info-tab={tab}>
      <div className="fy-info__head">
        <h2 className="fy-info__title" id={titleId}>
          Info
        </h2>
        <span className="fy-info__name">{name}</span>
        {sheetSize === undefined || onSheetSizeChange === undefined ? null : (
          <button
            aria-label={sheetSize === 'half' ? 'Expand Info to full height' : 'Shrink Info to half height'}
            className="fy-info__icon"
            data-info-size={sheetSize}
            onClick={() => onSheetSizeChange(sheetSize === 'half' ? 'full' : 'half')}
            type="button"
          >
            {sheetSize === 'half' ? (
              <Maximize2 aria-hidden="true" size={15} />
            ) : (
              <Minimize2 aria-hidden="true" size={15} />
            )}
          </button>
        )}
        <button aria-label="Close Info" className="fy-info__icon" data-info-close="" onClick={onClose} type="button">
          <X aria-hidden="true" size={16} />
        </button>
      </div>
      <div className="fy-info__tabs" ref={strip}>
        <SheetTabs
          current={tab}
          label="Info sections"
          onChange={onTabChange}
          order={tabs}
          sheetId={id}
          tabs={tabs.map(key => ({ key, label: INFO_TAB_LABEL[key] }))}
        />
      </div>
      <div
        aria-labelledby={sheetTabId(id, tab)}
        className="fy-info__body"
        data-info-body={tab}
        id={sheetPanelId(id, tab)}
        role="tabpanel"
      >
        {render[tab]()}
      </div>
    </div>
  );
}
