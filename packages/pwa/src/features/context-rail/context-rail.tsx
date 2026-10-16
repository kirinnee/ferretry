/**
 * The desktop right rail, "This folder": a title, a collapse control, and `ContextRailBody`.
 *
 * Collapsed it is a thin strip holding only the expand control and, when something is waiting, the
 * count of open signals — so collapsing the rail never hides that the agent needs you. The host owns
 * whether it is collapsed (it is remembered per agent) and how wide it is (the workspace's resize
 * handle); the rail fills whatever box it is given.
 */

import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Badge } from '../../shell/primitives.tsx';
import { ContextRailBody, type ContextRailBodyProps } from './context-rail-body.tsx';
import { useContextSignals } from './context-rail-signals.tsx';

export const CONTEXT_RAIL_TITLE = 'This folder';

export interface ContextRailProps extends ContextRailBodyProps {
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
}

export function ContextRail({ collapsed, onCollapsedChange, ...body }: ContextRailProps) {
  const { snapshot } = useContextSignals(body.signals);
  const open = snapshot?.count ?? 0;

  if (collapsed)
    return (
      <aside
        aria-label={CONTEXT_RAIL_TITLE}
        className="flex h-full w-10 shrink-0 flex-col items-center gap-sm border-l border-border-soft bg-surface py-sm"
        data-context-rail="collapsed"
      >
        <button
          type="button"
          className="kt-btn min-h-[36px] min-w-[36px] justify-center p-0"
          aria-label={`Show ${CONTEXT_RAIL_TITLE}`}
          aria-expanded={false}
          title={`Show ${CONTEXT_RAIL_TITLE}`}
          onClick={() => onCollapsedChange(false)}
          data-context-rail-toggle=""
        >
          <PanelRightOpen size={16} aria-hidden="true" />
        </button>
        {open > 0 ? (
          <Badge tone="warn" aria-label={`${open} open signals`} data-context-rail-count="">
            {open}
          </Badge>
        ) : null}
      </aside>
    );

  return (
    <aside
      aria-label={CONTEXT_RAIL_TITLE}
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-border-soft bg-surface"
      data-context-rail="open"
    >
      <div className="flex min-w-0 items-center gap-xs px-sm py-xs">
        <button
          type="button"
          className="kt-btn min-h-[36px] min-w-[36px] justify-center p-0"
          aria-label={`Collapse ${CONTEXT_RAIL_TITLE}`}
          aria-expanded={true}
          title={`Collapse ${CONTEXT_RAIL_TITLE}`}
          onClick={() => onCollapsedChange(true)}
          data-context-rail-toggle=""
        >
          <PanelRightClose size={16} aria-hidden="true" />
        </button>
        <h2 className="m-0 min-w-0 truncate text-row font-semibold text-fg">{CONTEXT_RAIL_TITLE}</h2>
      </div>
      <ContextRailBody {...body} />
    </aside>
  );
}
