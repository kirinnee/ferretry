/** The capture path writes only a frame it actually observed. */
export interface LastSnapshotWriter {
  write(id: string, text: string): Promise<void>;
}

/** A stored terminal frame, distinguished from a missing or damaged artifact (today's `StoredLastSnapshot`). */
export type StoredLastSnapshot =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly text: string };

/** Durable final-frame evidence for one ferret (today's `LastSnapshotReader`). */
export interface LastSnapshotReader {
  read(id: string): Promise<StoredLastSnapshot>;
}
