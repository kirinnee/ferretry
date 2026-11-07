/** A stored terminal frame, distinguished from a missing or damaged artifact. */
export type StoredLastSnapshot =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly text: string };

/** Durable final-frame evidence for one daemon-owned session. */
export interface LastSnapshotReader {
  read(id: string): Promise<StoredLastSnapshot>;
}

/** The capture path writes only a frame it actually observed. */
export interface LastSnapshotWriter {
  write(id: string, text: string): Promise<void>;
}
