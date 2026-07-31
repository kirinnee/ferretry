import { Maximize2, Minus, Plus } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { TaskStatus } from '@ferretry/protocol';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { TASK_STATUS_META, taskAssigneePresentation } from './task-presentation.ts';
import {
  layoutTaskDag,
  taskTitlePreview,
  type FilteredTaskDag,
  type TaskDagNode,
  type TaskDagLayout,
} from './task-dag.ts';
import { taskReference } from './task-board-model.ts';

interface Transform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}
interface Size {
  readonly width: number;
  readonly height: number;
}
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const DEFAULT_SIZE: Size = { width: 390, height: 520 };
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

/** Fits nodes to a viewport while retaining a 46px minimum mobile target. */
export const fitTaskDagTransform = (layout: Pick<TaskDagLayout, 'width' | 'height'>, viewport: Size): Transform => {
  const scale = clamp(
    Math.min(Math.max(1, viewport.width - 24) / layout.width, Math.max(1, viewport.height - 24) / layout.height),
    MIN_SCALE,
    1.25,
  );
  return { x: (viewport.width - layout.width * scale) / 2, y: (viewport.height - layout.height * scale) / 2, scale };
};

export const shouldNavigateTaskAgentLink = (
  event: Pick<MouseEvent, 'altKey' | 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): boolean => !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;

const COLORS: Record<TaskStatus, readonly [string, string]> = {
  todo: ['var(--muted)', 'var(--surface-2)'],
  researched: ['var(--warn)', 'var(--warn-bg)'],
  designed: ['var(--accent)', 'var(--accent-soft)'],
  in_progress: ['var(--warn)', 'var(--warn-bg)'],
  built: ['var(--accent)', 'var(--accent-soft)'],
  live: ['var(--ok)', 'var(--ok-bg)'],
  done: ['var(--ok)', 'var(--ok-bg)'],
  blocked: ['var(--err)', 'var(--err-bg)'],
  dropped: ['var(--err)', 'var(--err-bg)'],
};
const visualStatus = (node: TaskDagNode): TaskStatus | null =>
  node.task ? (node.task.blocked ? 'blocked' : node.task.status) : null;
const variables = (node: TaskDagNode): CSSProperties => {
  const status = visualStatus(node);
  const [color, fill] = status === null ? ['var(--warn)', 'var(--surface-2)'] : COLORS[status];
  return { '--task-node-color': color, '--task-node-fill': fill } as CSSProperties;
};

export interface TaskDagGraphProps {
  readonly daemonId: DaemonId;
  readonly dag: FilteredTaskDag;
  readonly onOpen: (node: TaskDagNode) => void;
  readonly onNavigate?: (to: string) => void;
  readonly onShowAll?: () => void;
}

export function TaskDagGraph({ daemonId, dag, onOpen, onNavigate, onShowAll }: TaskDagGraphProps) {
  const layout = useMemo(() => layoutTaskDag(dag), [dag]);
  const markerId = `task-dag-arrow-${useId().replaceAll(':', '')}`;
  const canvasRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, pinchDistance: 0 });
  const [viewport, setViewport] = useState(DEFAULT_SIZE);
  const [transform, setTransform] = useState(() => fitTaskDagTransform(layout, DEFAULT_SIZE));
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const size = canvas
      ? { width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight) }
      : DEFAULT_SIZE;
    setViewport(current => (current.width === size.width && current.height === size.height ? current : size));
    setTransform(fitTaskDagTransform(layout, size));
  }, [layout]);
  useEffect(() => {
    fit();
  }, [fit]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [fit]);
  const zoomAt = useCallback(
    (factor: number, anchorX: number, anchorY: number) =>
      setTransform(current => {
        const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
        if (scale === current.scale) return current;
        const graphX = (anchorX - current.x) / current.scale;
        const graphY = (anchorY - current.y) / current.scale;
        return { x: anchorX - graphX * scale, y: anchorY - graphY * scale, scale };
      }),
    [],
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(1.0016 ** -event.deltaY, event.clientX - rect.left, event.clientY - rect.top);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [zoomAt]);
  const point = (event: PointerEvent): { x: number; y: number } => ({ x: event.clientX, y: event.clientY });
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-task-agent-link]')) return;
    pointers.current.set(event.pointerId, point(event));
    if (pointers.current.size === 1) gesture.current.moved = false;
    if (pointers.current.size === 2) gesture.current.pinchDistance = 0;
    event.currentTarget.dataset.panning = 'true';
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* optional in windowless renderers */
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const next = point(event);
    pointers.current.set(event.pointerId, next);
    if (pointers.current.size >= 2) {
      const [first, second] = [...pointers.current.values()];
      if (!first || !second) return;
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const rect = event.currentTarget.getBoundingClientRect();
      if (gesture.current.pinchDistance > 0)
        zoomAt(
          distance / gesture.current.pinchDistance,
          (first.x + second.x) / 2 - rect.left,
          (first.y + second.y) / 2 - rect.top,
        );
      gesture.current.pinchDistance = distance;
      gesture.current.moved = true;
    } else {
      if (Math.abs(next.x - previous.x) + Math.abs(next.y - previous.y) > 2) gesture.current.moved = true;
      setTransform(current => ({ ...current, x: current.x + next.x - previous.x, y: current.y + next.y - previous.y }));
    }
    event.preventDefault();
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current.pinchDistance = 0;
    if (pointers.current.size === 0) delete event.currentTarget.dataset.panning;
  };
  const zoomCenter = (factor: number) => zoomAt(factor, viewport.width / 2, viewport.height / 2);
  return (
    <section data-task-graph="layered-svg" aria-label="Task dependency graph" className="kt-task-dag-shell">
      <div className="kt-task-dag-toolbar">
        <p className="kt-task-dag-help">Dependencies flow down · drag to pan · pinch or buttons to zoom</p>
        <fieldset className="kt-task-dag-zoom" aria-label="Graph zoom controls">
          <button type="button" aria-label="Zoom out" onClick={() => zoomCenter(1 / 1.25)}>
            <Minus size={16} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Fit graph" onClick={fit}>
            <Maximize2 size={15} aria-hidden="true" />
            <span>Fit</span>
          </button>
          <button type="button" aria-label="Zoom in" onClick={() => zoomCenter(1.25)}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </fieldset>
      </div>
      <div
        ref={canvasRef}
        className="kt-task-dag-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {layout.nodes.length === 0 ? (
          <div className="kt-task-dag-empty" role="status">
            <span>No task nodes match this status filter.</span>
            {onShowAll && (
              <button type="button" onClick={onShowAll}>
                Show all
              </button>
            )}
          </div>
        ) : (
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${viewport.width} ${viewport.height}`}
            aria-label={`${dag.matchCount} matching task ${dag.matchCount === 1 ? 'node' : 'nodes'} and ${dag.contextCount} dependency ${dag.contextCount === 1 ? 'path' : 'paths'}`}
          >
            <defs>
              <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path className="kt-task-dag-arrow" d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
            </defs>
            <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
              <g>
                {layout.edges.map(edge => (
                  <path
                    key={`${edge.dependentId}->${edge.dependencyId}`}
                    data-task-edge={`${edge.dependentId}->${edge.dependencyId}`}
                    className="kt-task-dag-edge"
                    d={edge.path}
                    markerEnd={`url(#${markerId})`}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
              {layout.nodes.map(node => {
                const task = node.task;
                const statusKey = visualStatus(node);
                const status = statusKey ? TASK_STATUS_META[statusKey].label : 'Missing dependency';
                const identity = task ? taskAssigneePresentation(task) : null;
                const href = identity?.sessionId ? daemonSessionPath(daemonId, identity.sessionId) : null;
                const context = node.matchesFilter ? '' : ' — PATH dependency context';
                const other = node.crossSession ? ' — owned by another session' : '';
                const accessible = `${taskReference(node.id)}: ${task?.title ?? taskReference(node.id)} — ${status}${identity ? ` — ${identity.label}` : ''}${context}${other}`;
                const open = () => {
                  if (!gesture.current.moved && !node.missing) onOpen(node);
                };
                const keydown = (event: KeyboardEvent<HTMLAnchorElement>) => {
                  if (node.missing || (event.key !== 'Enter' && event.key !== ' ')) return;
                  event.preventDefault();
                  onOpen(node);
                };
                const nodeBody = (
                  <>
                    <rect
                      className="kt-task-dag-node-box"
                      width={node.width}
                      height={node.height}
                      rx="5"
                      vectorEffect="non-scaling-stroke"
                    />
                    {task && (
                      <rect
                        className="kt-task-dag-node-rail"
                        x="2"
                        y="2"
                        width="3.5"
                        height={node.height - 4}
                        rx="1.75"
                      />
                    )}
                    <circle className="kt-task-dag-node-dot" cx="16" cy="18" r="4" />
                    <text className="kt-task-dag-node-title" x="27" y="23">
                      {taskTitlePreview(task?.title ?? taskReference(node.id))}
                    </text>
                    <text className="kt-task-dag-node-meta" x="16" y="49">
                      {taskReference(node.id)} · {status.toUpperCase()}
                    </text>
                    {identity && (
                      <circle
                        className="kt-task-dag-agent-dot"
                        data-health={task?.live.assigneeHealth ?? 'unknown'}
                        cx="16"
                        cy="72"
                        r="3"
                      />
                    )}
                    {identity && !href && (
                      <text className="kt-task-dag-node-agent kt-task-dag-node-agent--plain" x="27" y="76">
                        {taskTitlePreview(identity.name, 24)}
                      </text>
                    )}
                    {(!node.matchesFilter || node.crossSession) && (
                      <text className="kt-task-dag-node-context" x={node.width - 10} y="48" textAnchor="end">
                        {[!node.matchesFilter ? 'PATH' : '', node.crossSession ? 'OTHER' : '']
                          .filter(Boolean)
                          .join(' · ')}
                      </text>
                    )}
                  </>
                );
                return (
                  <g
                    key={node.id}
                    data-task-node={node.id}
                    data-task-status={statusKey ?? 'missing'}
                    data-task-filter={node.matchesFilter ? 'match' : 'context'}
                    data-task-cross-session={node.crossSession || undefined}
                    data-task-missing={node.missing || undefined}
                    className="kt-task-dag-node"
                    transform={`translate(${node.x} ${node.y})`}
                    style={variables(node)}
                  >
                    <title>{accessible}</title>
                    {node.missing ? (
                      <g data-task-node-hit className="kt-task-dag-node-hit">
                        {nodeBody}
                      </g>
                    ) : (
                      <a
                        data-task-node-hit
                        className="kt-task-dag-node-hit"
                        href={`#task-${node.id}`}
                        aria-label={accessible}
                        onClick={event => {
                          event.preventDefault();
                          open();
                        }}
                        onKeyDown={keydown}
                      >
                        {nodeBody}
                      </a>
                    )}
                    {identity && href && (
                      <a
                        href={href}
                        data-task-agent-link
                        aria-label={`Open ${identity.name}'s session`}
                        onPointerDown={event => event.stopPropagation()}
                        onClick={event => {
                          event.stopPropagation();
                          if (!shouldNavigateTaskAgentLink(event)) return;
                          event.preventDefault();
                          onNavigate?.(href);
                        }}
                      >
                        <text className="kt-task-dag-node-agent" x="27" y="76">
                          {taskTitlePreview(identity.name, 24)}
                        </text>
                      </a>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
    </section>
  );
}
