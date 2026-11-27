/** Rollout shapes pinned by the explicitly tested writers. No IO and no guesses about other versions. */
export type ForkRecord = Record<string, unknown> & { type: string; payload: Record<string, unknown> };

export const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Match Conversation's CodexObservedInputObserver, including drained and injected response_items. The other plugin's
 * daemon cannot be imported here; contract/testing/fork-inputs.ts pins both readers to the same native records.
 */
export function startsTurn(record: ForkRecord): boolean {
  const payload = record.payload;
  if (record.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') return false;
  const content = Array.isArray(payload.content) ? payload.content : [payload.content];
  const text = content
    .flatMap(value => {
      if (typeof value === 'string') return [value];
      const block = object(value);
      const words = typeof block?.text === 'string' ? block.text : block?.output_text;
      return typeof words === 'string' && (block?.type === undefined || block.type === 'input_text') ? [words] : [];
    })
    .join('\n')
    .trimStart();
  return (
    text.trim() !== '' &&
    !['<environment_context>', '<user_instructions>', '<user_environment>'].some(prefix => text.startsWith(prefix))
  );
}

/** A new native task can precede its user response_item. It belongs to the excluded prompt, never to the previous one. */
export function beforeNextTask(records: readonly ForkRecord[], start: number, end: number): number {
  let boundary = end;
  for (let index = end - 1; index > start; index--) {
    const record = records[index];
    if (record === undefined) break;
    // Only the new task's setup records may precede the input; do not cut away a previous answer.
    if (
      record.type !== 'turn_context' &&
      record.type !== 'session_meta' &&
      record.type !== 'world_state' &&
      !(
        record.type === 'event_msg' && ['task_started', 'thread_settings_applied'].includes(String(record.payload.type))
      ) &&
      !(
        record.type === 'response_item' &&
        (['developer', 'system'].includes(String(record.payload.role)) ||
          (record.payload.role === 'user' && !startsTurn(record)))
      )
    )
      break;
    boundary = index;
  }
  return boundary;
}

/** A safe cut never leaves half a native task or an unanswered tool call, even at an injected input. */
export function incompleteCut(records: readonly ForkRecord[]): string | undefined {
  const calls = new Set<string>();
  const tasks = new Set<string>();
  for (const record of records) {
    const payload = record.payload;
    const type = String(payload.type);
    if (record.type === 'event_msg') {
      const id = typeof payload.turn_id === 'string' ? payload.turn_id : 'native';
      if (type === 'task_started') tasks.add(id);
      if (type === 'task_complete' || type === 'turn_aborted') tasks.delete(id);
    }
    if (record.type !== 'response_item') continue;
    const id = typeof payload.call_id === 'string' ? payload.call_id : payload.id;
    if (typeof id !== 'string') continue;
    if (type.endsWith('_call_output') || type === 'tool_search_output') calls.delete(id);
    else if (type.endsWith('_call')) {
      // These server-side tools carry their completed result in the same item, with no client output record.
      const completed = ['web_search_call', 'image_generation_call'].includes(type) && payload.status === 'completed';
      if (!completed) calls.add(id);
    }
  }
  if (calls.size > 0) return 'this cut ends inside a tool call; pick a later turn that includes its answer';
  if (tasks.size > 0) return 'this cut ends inside a native turn; pick a later input after that turn completes';
  return undefined;
}

/** Native children have their own stored rollouts. A top-level-only copy cannot safely resume them. */
export function dependsOnSubagent(records: readonly ForkRecord[]): boolean {
  return records.some(record => {
    const payload = record.payload;
    // Native compaction can carry response items as replacement_history, including stored child tool calls.
    if (
      record.type === 'compacted' &&
      Array.isArray(payload.replacement_history) &&
      dependsOnSubagent(
        payload.replacement_history.flatMap(item => {
          const response = object(item);
          return response === undefined ? [] : [{ type: 'response_item', payload: response }];
        }),
      )
    )
      return true;
    if (record.type === 'session_meta' && object(payload.source)?.subagent !== undefined) return true;
    if (record.type === 'event_msg' && String(payload.type).startsWith('collab_')) return true;
    if (record.type !== 'response_item') return false;
    const name = typeof payload.name === 'string' ? payload.name.split('.').at(-1) : undefined;
    return (
      name !== undefined &&
      ['spawn_agent', 'resume_agent', 'send_input', 'wait', 'wait_agent', 'close_agent'].includes(name)
    );
  });
}
