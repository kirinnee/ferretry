/** The capture path writes only a frame it actually observed. */
export interface LastSnapshotWriter {
  write(id: string, text: string): Promise<void>;
}
