/**
 * The Info panel's content: a title line, six tabs, and the shown tab's rows. Presentational — the
 * frame around it (a resizable right panel on a desktop, a half/full bottom sheet on a phone) is
 * `info-frame.tsx`, and each tab's body is the host's render prop, so the panel never reads a daemon.
 */

import { Maximize2, Minimize2, X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Badge } from '../../shell/primitives.tsx';
import { SheetTabs, sheetPanelId, sheetTabId } from '../../shell/sheet-tabs.tsx';
import { INFO_TAB_LABEL, INFO_TABS_WITHOUT_BOARD, type InfoTab } from './info-model.ts';

export type InfoSheetSize = 'half' | 'full';

export interface InfoPanelProps {
  readonly name: string;
  readonly tab: InfoTab;
  readonly onTabChange: (tab: InfoTab) => void;
  readonly onClose: () => void;
  /** Each tab's body, rendered only while it is shown. */
  readonly render: Readonly<Record<InfoTab, () => ReactNode>>;
  /** Open signals, as a count on the Signals tab. */
  readonly openSignals?: number;
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
  openSignals = 0,
  tabs = INFO_TABS_WITHOUT_BOARD,
  sheetSize,
  onSheetSizeChange,
  titleId,
}: InfoPanelProps) {
  const id = useId().replace(/:/gu, '');
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
      <div className="fy-info__tabs">
        <SheetTabs
          current={tab}
          label="Info sections"
          onChange={onTabChange}
          order={tabs}
          sheetId={id}
          tabs={tabs.map(key => ({
            key,
            label: INFO_TAB_LABEL[key],
            ...(key === 'signals' && openSignals > 0
              ? {
                  badge: (
                    <Badge aria-label={`${openSignals} open`} data-info-signals-count="" tone="warn">
                      {openSignals}
                    </Badge>
                  ),
                }
              : {}),
          }))}
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
