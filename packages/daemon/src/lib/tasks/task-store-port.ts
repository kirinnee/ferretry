/** The value and result returned atomically from a serialized persistence mutation. */
export interface TaskStoreMutation<TContainer, TResult> {
  readonly container: TContainer;
  readonly result: TResult;
}

/**
 * Generic authoritative-container boundary. Placement and container metadata belong to the caller;
 * the adapter's only task-specific guarantee is global serialization of every transaction.
 */
export interface TaskStorePort<TContainer> {
  read(): Promise<TContainer>;
  transact<TResult>(transform: (current: TContainer) => TaskStoreMutation<TContainer, TResult>): Promise<TResult>;
}
