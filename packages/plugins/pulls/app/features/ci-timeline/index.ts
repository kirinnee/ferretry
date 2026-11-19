/**
 * The CI timeline (r9 E10). E9's run page and the PR's CI tab mount `CiTimeline` with a `CiRun`; the layout is pure and
 * exported for the units that draw next to it (E11 reads the same `CiRun`, not this layout).
 */
export { CiTimeline, type CiTimelineProps } from './ci-timeline.tsx';
export { formatSpan, layoutTimeline, type TimelineLayout } from './timeline-model.ts';
