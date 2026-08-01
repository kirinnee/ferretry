import { MAX_PIN_NOTE_LENGTH } from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { getForegroundPinScope } from './pin-bridge.ts';
import type { DaemonPinClient } from './pin-client.ts';

/** Fits a selected snippet into the protocol's note limit without losing its source. */
export const truncatePinSelection = (value: string, max = MAX_PIN_NOTE_LENGTH): string => {
  const trimmed = value.trim();
  if (!trimmed || max < 1) return '';
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).replace(/\s+$/u, '')}…`;
};

/** Finds the nearest transcript row holding either endpoint of a selection. */
export const pinSelectionBlockId = (
  anchorNode: Node | null,
  focusNode: Node | null,
  root: Element | null,
): string | null => {
  const find = (node: Node | null): string | null => {
    if (node === null || root === null) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const holder = element?.closest('[data-block-id]');
    return holder === null || holder === undefined || !root.contains(holder)
      ? null
      : holder.getAttribute('data-block-id');
  };
  return find(anchorNode) ?? find(focusNode);
};

export type PinSelectionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'empty' | 'no-session' };

/** Stores a captured selection as a note in the current daemon's foreground session. */
export const pinSelection = (
  connection: DaemonConnection,
  client: DaemonPinClient,
  selection: string,
  blockId?: string | null,
  scope: DaemonSessionScope | null = getForegroundPinScope(),
): PinSelectionResult => {
  const text = truncatePinSelection(selection);
  if (!text) return { ok: false, reason: 'empty' };
  if (scope === null || scope.daemonId !== connection.daemonId) return { ok: false, reason: 'no-session' };
  void client.add(connection, scope, {
    action: 'add',
    kind: 'note',
    text,
    ...(blockId ? { source: { blockId } } : {}),
  });
  return { ok: true };
};
