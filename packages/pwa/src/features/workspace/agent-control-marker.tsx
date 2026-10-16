/**
 * THE AGENT-CONTROL MARKER: the pill over a terminal or browser body saying
 * who is driving it. While the agent drives, it reads "‹name› is typing here"
 * with Take over; once the reader has taken over, "You have control" with Hand
 * back. Nobody driving and nothing taken over renders nothing.
 *
 * Presentational only. Who is driving comes from the daemon (stream T); this
 * component just reports it and raises the two intents.
 */

export interface AgentControlDriver {
  readonly name: string;
}

export interface AgentControlMarkerProps {
  readonly driver: AgentControlDriver | null;
  readonly takenOver: boolean;
  readonly onTakeOver: () => void;
  readonly onHandBack: () => void;
}

export function AgentControlMarker({ driver, takenOver, onTakeOver, onHandBack }: AgentControlMarkerProps) {
  if (takenOver) {
    return (
      <div className="fy-ws-marker" data-state="human" role="status">
        <span className="fy-ws-marker-text">You have control</span>
        <button type="button" className="fy-ws-marker-action" onClick={onHandBack}>
          Hand back
        </button>
      </div>
    );
  }
  if (!driver) return null;
  return (
    <div className="fy-ws-marker" data-state="agent" role="status">
      <span aria-hidden="true" className="fy-ws-marker-dot" />
      <span className="fy-ws-marker-text">{`${driver.name} is typing here`}</span>
      <button type="button" className="fy-ws-marker-action" onClick={onTakeOver}>
        Take over
      </button>
    </div>
  );
}
