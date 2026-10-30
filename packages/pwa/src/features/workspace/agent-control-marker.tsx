/**
 * THE AGENT-CONTROL MARKER: who is driving a terminal or browser page, in the one slim
 * row the surface already has. A small chip names the state — "‹name› is typing here",
 * "You have control", or "Your turn here" when the agent has handed the surface over — and
 * small icon buttons (each with its tooltip and accessible name) raise the intents: Take
 * over, Hand back, Dismiss. Nobody driving and nothing taken over renders nothing.
 *
 * It never has a bar of its own: the host puts it inside its toolbar (the shell's) or
 * at the end of its page strip (the browser's), so a surface pays for it in width, not in
 * height. An ask's one line on what to do rides after the chip and truncates; its full text
 * is the tooltip.
 *
 * Presentational only. Who is driving comes from the daemon (`useSurfaceDriving`);
 * this component just reports it and raises the intents.
 */

import { Hand, Undo2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../shell/primitives.tsx';

export interface AgentControlDriver {
  readonly name: string;
}

/** The agent has handed this surface to the owner. */
export interface AgentControlAsk {
  readonly agent: string;
  readonly message?: string;
}

export interface AgentControlMarkerProps {
  readonly driver: AgentControlDriver | null;
  readonly ask?: AgentControlAsk | null;
  readonly onDismissAsk?: () => void;
  readonly takenOver: boolean;
  readonly onTakeOver: () => void;
  readonly onHandBack: () => void;
}

function MarkerAction({
  label,
  detail,
  onClick,
  children,
}: {
  readonly label: string;
  readonly detail: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="fy-ws-marker-action"
      aria-label={label}
      title={`${label} — ${detail}`}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function AgentControlMarker({
  driver,
  ask = null,
  onDismissAsk,
  takenOver,
  onTakeOver,
  onHandBack,
}: AgentControlMarkerProps) {
  if (takenOver) {
    return (
      <div className="fy-ws-marker" data-state="human" role="status">
        <span className="fy-ws-marker-chip" title="You have control">
          <span aria-hidden="true" className="fy-ws-marker-dot" />
          <span className="fy-ws-marker-label">You have control</span>
        </span>
        <span className="fy-ws-marker-actions">
          <MarkerAction label="Hand back" detail="let the agent type here again" onClick={onHandBack}>
            <Undo2 aria-hidden="true" size={14} />
          </MarkerAction>
        </span>
      </div>
    );
  }
  if (ask) {
    const note = ask.message ?? `${ask.agent} needs you`;
    return (
      <div className="fy-ws-marker" data-state="ask" role="status">
        <span className="fy-ws-marker-chip">
          <span aria-hidden="true" className="fy-ws-marker-dot" />
          <span className="fy-ws-marker-label">Your turn here</span>
        </span>
        <span className="fy-ws-marker-note" title={note}>
          {note}
        </span>
        <span className="fy-ws-marker-actions">
          <MarkerAction label="Take over" detail="type into this surface yourself" onClick={onTakeOver}>
            <Hand aria-hidden="true" size={14} />
          </MarkerAction>
          {onDismissAsk && (
            <MarkerAction label="Dismiss" detail="clear this request without taking over" onClick={onDismissAsk}>
              <X aria-hidden="true" size={14} />
            </MarkerAction>
          )}
        </span>
      </div>
    );
  }
  if (!driver) return null;
  return (
    <div className="fy-ws-marker" data-state="agent" role="status">
      <span className="fy-ws-marker-chip" title={`${driver.name} is typing here`}>
        <span aria-hidden="true" className="fy-ws-marker-dot" />
        <span className="fy-ws-marker-label">{`${driver.name} is typing here`}</span>
      </span>
      <span className="fy-ws-marker-actions">
        <MarkerAction label="Take over" detail="type into this surface yourself" onClick={onTakeOver}>
          <Hand aria-hidden="true" size={14} />
        </MarkerAction>
      </span>
    </div>
  );
}
