/** One rollout line as a record: a `type` and an object `payload`. */
export type RolloutRecord = Record<string, unknown> & { type: string; payload: Record<string, unknown> };

export const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

type Rewritten = { readonly kind: 'rewritten'; readonly record: RolloutRecord };
type Refused = { readonly kind: 'refused'; readonly reason: string };

/** Where a conversation lived and where it lives now. `id` is set only when the conversation takes a new id. */
export interface Relocation {
  /** The id the rollout carries now. */
  readonly from: string;
  /** The folder it was started in (its header's `cwd`). */
  readonly oldFolder: string;
  readonly folder: string;
  /** The conversation's new id, when it changes; absent: it keeps `from`. */
  readonly id?: string;
  /** The harness homes the source ran in, and the home it runs in now: the skills a developer message lists are files of the home. */
  readonly oldHomes: readonly string[];
  readonly home: string;
}

/**
 * The self ids and the work-folder fields the tested Codex writers emit, moved to where the conversation lives now. It
 * is field by field, never a text replacement over history: the words a person and the agent exchanged stay as they
 * were said, and a field that names the old folder or id somewhere this does not know refuses the whole conversation.
 */
export function relocateIdentity(record: RolloutRecord, move: Relocation): Rewritten | Refused {
  const { from, oldFolder, folder } = move;
  const id = move.id ?? from;
  const changed = id !== from;
  const event = record.type === 'event_msg' ? record.payload.type : undefined;
  const settings = event === 'thread_settings_applied';
  const workspace =
    record.type === 'session_meta' || record.type === 'turn_context'
      ? 'payload'
      : settings
        ? 'payload.thread_settings'
        : undefined;
  const self = new Set<string>();
  if (
    ['session_meta', 'turn_context', 'token_usage_record'].includes(record.type) ||
    (record.type === 'event_msg' &&
      [
        'task_started',
        'task_complete',
        'turn_aborted',
        'user_message',
        'agent_message',
        'token_count',
        'thread_settings_applied',
        'item_completed',
      ].includes(String(event)))
  )
    self.add('session_id');
  if (record.type === 'session_meta') {
    self.add('payload.id');
    self.add('payload.session_id');
  }
  if (record.type === 'token_usage_record' || settings) {
    self.add('payload.session_id');
    self.add('payload.thread_id');
  }
  if (event === 'item_completed') self.add('payload.thread_id');
  let refusal: string | undefined;
  const unknown = (path: string): void => {
    refusal ??= `the ${record.type}${event === undefined ? '' : `/${event}`} record has an untested identity/worktree field (${path}), so it cannot be moved safely`;
  };
  const under = (path: string): boolean => oldFolder !== '' && (path === oldFolder || path.startsWith(`${oldFolder}/`));
  const relocated = (path: string): string => (under(path) ? `${folder}${path.slice(oldFolder.length)}` : path);
  const xmlEscape = (value: string): string =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  const oldXml = xmlEscape(oldFolder);
  const folderXml = xmlEscape(folder);
  const environmentXml = (value: string, path: string): string => {
    // Codex serializes these same workspace facts into a native environment preamble and world-state filesystem.
    const next = value.replace(/<(cwd|root|path|glob_pattern)>([^<]*)<\/\1>/gu, (whole, tag: string, text: string) =>
      oldXml !== '' && (text === oldXml || text.startsWith(`${oldXml}/`))
        ? `<${tag}>${folderXml}${text.slice(oldXml.length)}</${tag}>`
        : whole,
    );
    if ((oldXml !== '' && next.includes(oldXml)) || (changed && next.includes(from))) unknown(path);
    return next;
  };
  const workspacePath = (path: string): boolean => {
    if (workspace === undefined || !path.startsWith(`${workspace}.`)) return false;
    const field = path.slice(workspace.length + 1);
    return (
      field === 'cwd' ||
      /^(workspace_roots|runtime_workspace_roots|writable_roots)\.\d+$/u.test(field) ||
      /^sandbox_policy\.(cwd|writable_roots\.\d+)$/u.test(field) ||
      /^permission_profile\.file_system\.entries\.\d+\.path\.value$/u.test(field)
    );
  };
  const worldCwd = record.type === 'world_state' ? 'payload.state.environments.environments.local.cwd' : undefined;
  const worldFilesystem = record.type === 'world_state' ? 'payload.state.environments.filesystem' : undefined;
  const historyText = (path: string): boolean => {
    if (record.type === 'response_item')
      return /^payload\.(content\.\d+\.(text|output_text)|arguments|output)$/u.test(path);
    if (record.type === 'event_msg' && ['agent_message', 'user_message', 'task_complete'].includes(String(event)))
      return ['payload.message', 'payload.last_agent_message'].includes(path);
    return event === 'item_completed' && /^payload\.item\.content\.\d+\.text$/u.test(path);
  };
  const rehomed = (value: string): string =>
    move.oldHomes.reduce((text, old) => text.split(old).join(move.home), value);
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (self.has(path)) return id;
      if (workspacePath(path) || path === worldCwd) return path.endsWith('.cwd') ? folder : relocated(value);
      if (path === worldFilesystem) return environmentXml(value, path);
      if (historyText(path)) {
        // What Codex told the model about the home it ran in (its skills, with their files) is the home's, not words said.
        if (record.type === 'response_item' && record.payload.role === 'developer') return rehomed(value);
        if (
          record.payload.role === 'user' &&
          /^payload\.content\.\d+\.text$/u.test(path) &&
          value.trimStart().startsWith('<environment_context>') &&
          value.trimEnd().endsWith('</environment_context>')
        )
          return environmentXml(value, path);
        return value;
      }
      const key = path.split('.').at(-1);
      // The world state is what Codex knew of the home it ran in (its skills and their files): the new home's now.
      const text = record.type === 'world_state' ? rehomed(value) : value;
      // A `cwd` field under the old folder is the folder the conversation worked in, wherever the writer put it.
      if (key === 'cwd' && under(text)) return relocated(text);
      if (
        (changed && text.includes(from)) ||
        (oldFolder !== '' && text.includes(oldFolder)) ||
        key === 'cwd' ||
        key === 'thread_id' ||
        key === 'session_id'
      )
        unknown(path);
      return text;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}.${index}`));
    const fields = asObject(value);
    return fields === undefined
      ? value
      : Object.fromEntries(
          Object.entries(fields).map(([key, item]) => [key, walk(item, path === '' ? key : `${path}.${key}`)]),
        );
  };
  const rewritten = walk(record, '') as RolloutRecord;
  return refusal === undefined ? { kind: 'rewritten', record: rewritten } : { kind: 'refused', reason: refusal };
}

/**
 * Whether the conversation leans on a native subagent: such a child keeps its own rollout, which a copy of this one does
 * not carry, so it cannot be resumed on another machine (refused, as a fork refuses it).
 */
export function dependsOnSubagent(records: readonly RolloutRecord[]): boolean {
  return records.some(record => {
    const payload = record.payload;
    // Native compaction can carry response items as replacement_history, including stored child tool calls.
    if (
      record.type === 'compacted' &&
      Array.isArray(payload.replacement_history) &&
      dependsOnSubagent(
        payload.replacement_history.flatMap(item => {
          const response = asObject(item);
          return response === undefined ? [] : [{ type: 'response_item', payload: response }];
        }),
      )
    )
      return true;
    if (record.type === 'session_meta' && asObject(payload.source)?.subagent !== undefined) return true;
    if (record.type === 'event_msg' && String(payload.type).startsWith('collab_')) return true;
    if (record.type !== 'response_item') return false;
    const name = typeof payload.name === 'string' ? payload.name.split('.').at(-1) : undefined;
    return (
      name !== undefined &&
      ['spawn_agent', 'resume_agent', 'send_input', 'wait', 'wait_agent', 'close_agent'].includes(name)
    );
  });
}
