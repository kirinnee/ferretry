import type { TerminalSize } from '@ferretry/protocol';

export const TERMINAL_TMUX_PREFIX = 'fy-webterm-';
export const TERMINAL_SCROLLBACK_LINES = 5_000;
export const TERMINAL_REATTACH_LINES = 2_000;
export const TERMINAL_INPUT_CHUNK_BYTES = 512;

export interface TerminalRuntimeMetadata extends TerminalSize {
  readonly id: string;
  readonly owner: string;
  readonly title: string;
  readonly root: string;
  readonly tmuxSession: string;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
}

function stableOwnerHash(owner: string): string {
  let hash = 0x811c9dc5;
  for (const character of owner) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function terminalTmuxSessionName(owner: string, id: string): string {
  const stem = owner.replaceAll(/[^A-Za-z0-9_-]/g, '-').slice(0, 28) || 'session';
  return `${TERMINAL_TMUX_PREFIX}${stem}-${stableOwnerHash(owner)}-${id}`.slice(0, 80);
}

export function terminalPaneTarget(record: Pick<TerminalRuntimeMetadata, 'tmuxSession'>): string {
  return `${record.tmuxSession}:0.0`;
}

export function hexInputChunks(
  bytes: Uint8Array,
  chunkSize = TERMINAL_INPUT_CHUNK_BYTES,
): readonly (readonly string[])[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0)
    throw new RangeError('terminal input chunk size must be positive');
  const chunks: string[][] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push([...bytes.subarray(offset, offset + chunkSize)].map(byte => byte.toString(16).padStart(2, '0')));
  }
  return chunks;
}

export function terminalMetadataIsSane(value: TerminalRuntimeMetadata): boolean {
  return (
    /^[a-f0-9]{12}$/u.test(value.id) &&
    value.owner.length > 0 &&
    value.root.startsWith('/') &&
    value.tmuxSession.startsWith(TERMINAL_TMUX_PREFIX) &&
    Number.isFinite(value.createdAtMs) &&
    Number.isFinite(value.lastActivityAtMs) &&
    value.lastActivityAtMs >= value.createdAtMs
  );
}

/**
 * The tmux option that marks a session as a terminal; other subsystems must not disturb one. Here, in a
 * module with no value imports, so a lean session-worker thread can read it without loading the terminal
 * runtime (and zod with it).
 */
export const TERMINAL_OWNER_OPTION = '@fy_terminal_owner';
