/** The capture path writes only a frame it actually observed. */
export interface LastSnapshotWriter {
  write(id: string, text: string): Promise<void>;
  /**
   * Forgets the stored frame: a pane that is observed BLANK now is the newest word on how the ferret ended, so an older
   * frame must not stand in as its "last screen". Absent: nothing is forgotten. A frame that is not there is no fault.
   */
  clear?(id: string): Promise<void>;
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
