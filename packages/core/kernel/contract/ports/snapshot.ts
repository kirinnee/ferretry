import type { PostBuildSnapshot } from '../snapshot.ts';

/** The post-build snapshot; readers take it from the kernel, not a hook, so it adds no start-order edge. */
export interface SnapshotPort {
  /** Throws if called before the `bound` state. */
  current(): PostBuildSnapshot;
}
