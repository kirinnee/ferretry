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

export function terminalSnapshotFrame(captured: string, cursorX: number, cursorY: number): string {
  const x = Number.isFinite(cursorX) ? Math.max(0, Math.trunc(cursorX)) : 0;
  const y = Number.isFinite(cursorY) ? Math.max(0, Math.trunc(cursorY)) : 0;
  const paneText = captured.replace(/\n$/u, '').replaceAll('\n', '\r\n');
  return `\u001b[3J\u001b[2J\u001b[H${paneText}\u001b[${y + 1};${x + 1}H`;
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
