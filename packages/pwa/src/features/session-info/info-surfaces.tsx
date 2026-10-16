/**
 * Info › Surfaces: this ferret's terminals and browser pages, who is driving each, and Take over /
 * Hand back — the one control Info carries, because it is per-surface state rather than an action on
 * the ferret.
 *
 * Driving is the workspace's own `SurfaceDriving` (the same reads, the same live feed, the same posts)
 * and a surface is addressed by the same workspace tab id the terminal and browser tabs use, so a take
 * over here shows in the tab's marker at once and the other way round. Take over is offered where the agent
 * is driving, exactly as the tab's own marker offers it; opening a surface opens its tab.
 */

import type { BrowserPageSummary, BrowserStatus, TerminalListView } from '@ferretry/protocol';
import { EyeOff, Globe, Hand, SquareTerminal } from 'lucide-react';
import { sidePaneInstanceTabId } from '../../shell/side-pane-tab-model.ts';
import { Button } from '../../shell/primitives.tsx';
import { browserPageLabel } from '../browser/browser-surface-list.tsx';
import type { SurfaceDriving } from '../workspace/use-surface-driving.ts';
import { InfoChip, InfoNote } from './info-parts.tsx';

export interface InfoSurfacesProps {
  readonly agentName: string;
  readonly terminals: TerminalListView | null;
  readonly browser: BrowserStatus | null;
  readonly driving: SurfaceDriving;
  readonly onOpenTerminal: (terminalId: string, label: string) => void;
  readonly onOpenPage: (page: BrowserPageSummary) => void;
}

interface SurfaceRow {
  readonly kind: 'terminal' | 'browser';
  readonly tabId: string;
  readonly name: string;
  readonly what: string;
  readonly incognito: boolean;
  readonly open: () => void;
}

const pagesOf = (browser: BrowserStatus | null): readonly BrowserPageSummary[] =>
  browser !== null && 'pages' in browser ? (browser.pages ?? []) : [];

export function InfoSurfaces({ agentName, terminals, browser, driving, onOpenTerminal, onOpenPage }: InfoSurfacesProps) {
  const rows: SurfaceRow[] = [
    ...(terminals?.terminals ?? []).map(terminal => ({
      kind: 'terminal' as const,
      tabId: sidePaneInstanceTabId('terminal', terminal.id),
      name: terminal.name ?? terminal.title,
      what: terminal.title,
      incognito: false,
      open: () => onOpenTerminal(terminal.id, terminal.name ?? terminal.title),
    })),
    ...pagesOf(browser).map(page => ({
      kind: 'browser' as const,
      tabId: sidePaneInstanceTabId('browser', page.id),
      name: browserPageLabel(page),
      what: page.url,
      incognito: page.incognito === true,
      open: () => onOpenPage(page),
    })),
  ];
  return (
    <div className="fy-info-surfaces">
      <InfoNote>Terminals and browser pages {agentName} owns. Taking over pauses its input on that surface.</InfoNote>
      {rows.length === 0 ? (
        <InfoNote>{terminals === null && browser === null ? 'Reading surfaces…' : 'No terminals or browser pages yet.'}</InfoNote>
      ) : (
        <ul className="fy-info-surface-list">
          {rows.map(row => {
            const driver = driving.driverFor(row.tabId);
            const held = driving.takenOver(row.tabId);
            const Icon = row.kind === 'terminal' ? SquareTerminal : Globe;
            return (
              <li className="fy-info-surface" data-info-surface={row.tabId} key={row.tabId}>
                <div className="fy-info-surface__head">
                  <Icon aria-hidden="true" size={14} />
                  <button className="fy-info-link font-mono" onClick={row.open} type="button">
                    {row.name}
                  </button>
                  {row.incognito ? (
                    <InfoChip>
                      <EyeOff aria-hidden="true" size={11} />
                      incognito
                    </InfoChip>
                  ) : null}
                  <span className="fy-info-surface__spacer" />
                  {held ? (
                    <InfoChip tone="warn">You’re driving</InfoChip>
                  ) : driver === null ? (
                    <InfoChip>idle</InfoChip>
                  ) : (
                    <InfoChip tone="accent">{driver.name} drives</InfoChip>
                  )}
                </div>
                <div className="fy-info-surface__head">
                  <span className="fy-info-muted fy-info-surface__what">{row.what}</span>
                  <span className="fy-info-surface__spacer" />
                  {held ? (
                    <Button
                      data-info-hand-back={row.tabId}
                      onClick={() => driving.handBack(row.tabId)}
                      size="sm"
                      type="button"
                    >
                      <Hand aria-hidden="true" size={13} />
                      Hand back
                    </Button>
                  ) : driver === null ? null : (
                    <Button
                      data-info-take-over={row.tabId}
                      onClick={() => driving.takeOver(row.tabId)}
                      size="sm"
                      type="button"
                      variant="primary"
                    >
                      <Hand aria-hidden="true" size={13} />
                      Take over
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {driving.failure === null ? null : (
        <p className="fy-action-form__failure" role="alert">
          {driving.failure}
        </p>
      )}
    </div>
  );
}
