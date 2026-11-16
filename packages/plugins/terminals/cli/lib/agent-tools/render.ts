import type { SurfaceControlView } from '../protocol/surface-control.ts';
import type { ToolReport } from './client.ts';

/** A terminal as a reader writes it. */
const reference = (id: string, name: string | undefined): string => `%terminal:${name ?? id}`;

/** A tool's answer as lines: what happened, what is open, then whatever it read. */
export function renderToolReport(report: ToolReport): string {
  const lines = [report.summary];
  for (const surface of report.surfaces ?? [])
    lines.push(
      `  ${surface.name ?? surface.id}  ${surface.title}${surface.available === false ? '  [not yours]' : ''}`,
    );
  if (report.output !== undefined && report.output !== '') lines.push(report.output);
  return lines.join('\n');
}

/** Who is driving which terminal, and what a person holds. Browser pages are the Browsers verbs' to show. */
export function renderControlView(view: SurfaceControlView): string {
  const lines: string[] = [];
  for (const driving of view.driving.filter(entry => entry.surface === 'terminal'))
    lines.push(
      `${reference(driving.id, driving.name)}  driven by ${driving.agentName ?? driving.agentSessionId} until ${driving.until}`,
    );
  for (const takeover of view.takeovers.filter(entry => entry.surface === 'terminal'))
    lines.push(
      `${reference(takeover.id, takeover.name)}  taken over by ${takeover.by.by === 'human' ? `device ${takeover.by.deviceId}` : 'this computer'} since ${takeover.since}`,
    );
  for (const handed of view.handed.filter(entry => entry.surface === 'terminal'))
    lines.push(
      `${reference(handed.id, handed.name)}  handed to the ferret by ${handed.by.by === 'human' ? `device ${handed.by.deviceId}` : 'this computer'}`,
    );
  return lines.length === 0
    ? `no ferret is driving a terminal in ${view.sessionId}, and none is taken over`
    : lines.join('\n');
}
