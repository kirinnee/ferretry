/** The flamegraph of a CI run (r9 E11). E9's run page mounts it; nothing else reaches into this folder. */
export { barLabel, CiFlame, flameNote } from './ci-flame.tsx';
export { formatDuration } from './format.ts';
export {
  buildFlame,
  DRAWN_CHILDREN,
  findPath,
  hiddenChildren,
  layoutBars,
  rowTotals,
  type Flame,
  type FlameBar,
  type FlameNode,
} from './model.ts';
