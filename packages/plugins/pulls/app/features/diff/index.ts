/**
 * The Files tab (r9 E5): `PullFilesView` is what the PR page mounts. `LineExtras` is the seam review threads (E6) draw
 * through: a function from a line's place to what sits under it.
 */
export { PullFilesView, type PullFilesViewProps } from './files-view.tsx';
export type { LineAt, LineExtras } from './diff-rows.tsx';
