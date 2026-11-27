import { object, type ForkRecord } from './fork-records.ts';

type Rewritten = { readonly kind: 'rewritten'; readonly record: ForkRecord };
type Refused = { readonly kind: 'refused'; readonly reason: string };

/** The self/workspace locations emitted by the three tested writers, not a text replacement over history. */
export function forkIdentity(
  record: ForkRecord,
  from: string,
  oldFolder: string,
  id: string,
  folder: string,
): Rewritten | Refused {
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
    refusal ??= `the ${record.type}${event === undefined ? '' : `/${event}`} record has an untested identity/worktree field (${path}), so it cannot be forked safely`;
  };
  const relocated = (path: string): string =>
    oldFolder !== '' && (path === oldFolder || path.startsWith(`${oldFolder}/`))
      ? `${folder}${path.slice(oldFolder.length)}`
      : path;
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
    if ((oldXml !== '' && next.includes(oldXml)) || next.includes(from)) unknown(path);
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
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (self.has(path)) return id;
      if (workspacePath(path) || path === worldCwd) return path.endsWith('.cwd') ? folder : relocated(value);
      if (path === worldFilesystem) return environmentXml(value, path);
      if (historyText(path)) {
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
      if (
        value.includes(from) ||
        (oldFolder !== '' && value.includes(oldFolder)) ||
        key === 'cwd' ||
        key === 'thread_id' ||
        key === 'session_id'
      )
        unknown(path);
      return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}.${index}`));
    const fields = object(value);
    return fields === undefined
      ? value
      : Object.fromEntries(
          Object.entries(fields).map(([key, item]) => [key, walk(item, path === '' ? key : `${path}.${key}`)]),
        );
  };
  const rewritten = walk(record, '') as ForkRecord;
  return refusal === undefined ? { kind: 'rewritten', record: rewritten } : { kind: 'refused', reason: refusal };
}
