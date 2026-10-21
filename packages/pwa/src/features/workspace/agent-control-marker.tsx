/**
 * THE AGENT-CONTROL MARKER: the pill over a terminal or browser body saying
 * who is driving it. While the agent drives, it reads "‹name› is typing here"
 * with Take over; once the reader has taken over, "You have control" with Hand
 * back. Nobody driving and nothing taken over renders nothing.
 *
 * Over a terminal it floats at the body's top-right corner. Over a browser it
 * sits INLINE at the end of the page strip instead, because floating there would
 * cover the browser's own toolbar.
 *
 * An ASK comes first: the agent handed the surface over ("your turn here"), so the marker says so, with
 * the agent's one line on what to do, Take over and Dismiss.
 *
 * Presentational only. Who is driving comes from the daemon (`useSurfaceDriving`);
 * this component just reports it and raises the two intents.
 */

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
  /** In a strip's flow rather than floating over the body. */
  readonly inline?: boolean;
}

export function AgentControlMarker({
  driver,
  ask = null,
  onDismissAsk,
  takenOver,
  onTakeOver,
  onHandBack,
  inline = false,
}: AgentControlMarkerProps) {
  const placement = inline ? 'inline' : 'float';
  if (takenOver) {
    return (
      <div className="fy-ws-marker" data-placement={placement} data-state="human" role="status">
        <span className="fy-ws-marker-text">You have control</span>
        <button type="button" className="fy-ws-marker-action" onClick={onHandBack}>
          Hand back
        </button>
      </div>
    );
  }
  if (ask) {
    return (
      <div className="fy-ws-marker" data-placement={placement} data-state="ask" role="status">
        <span aria-hidden="true" className="fy-ws-marker-dot" />
        <span className="fy-ws-marker-text">
          <strong>Your turn here</strong>
          {ask.message === undefined ? ` — ${ask.agent} needs you` : ` — ${ask.message}`}
        </span>
        <button type="button" className="fy-ws-marker-action" onClick={onTakeOver}>
          Take over
        </button>
        {onDismissAsk && (
          <button type="button" className="fy-ws-marker-action" onClick={onDismissAsk}>
            Dismiss
          </button>
        )}
      </div>
    );
  }
  if (!driver) return null;
  return (
    <div className="fy-ws-marker" data-placement={placement} data-state="agent" role="status">
      <span aria-hidden="true" className="fy-ws-marker-dot" />
      <span className="fy-ws-marker-text">{`${driver.name} is typing here`}</span>
      <button type="button" className="fy-ws-marker-action" onClick={onTakeOver}>
        Take over
      </button>
    </div>
  );
}
