import type { JsonValue } from '@ferretry/std';
import type { FerretPrompt } from '../../../contract/index.ts';
import type { SessionState } from '../protocol/session.ts';

/** Every string in a JSON value passed through `mask`, keys included; the shape is kept. Pure and total. */
export function maskedStrings(value: JsonValue, mask: (text: string) => string): JsonValue {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map(item => maskedStrings(item, mask));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [mask(key), maskedStrings(item as JsonValue, mask)]),
    );
  return value;
}

/**
 * What a ferret's state document says its pane is asking (`FerretsApi.prompt`): the recorded turn, the dialog words,
 * the permission request and the harness dialog, every string passed through `mask` (one `Redaction.read`'s
 * `scope.text`). Nothing recorded is `{}`. Pure.
 */
export function promptOf(
  state: Pick<SessionState, 'turnState' | 'turnPrompt' | 'permissionRequest' | 'harnessDialog'>,
  mask: (text: string) => string,
): FerretPrompt {
  return {
    ...(state.turnState === undefined ? {} : { turnState: state.turnState }),
    ...(state.turnPrompt === undefined ? {} : { prompt: mask(state.turnPrompt) }),
    ...(state.permissionRequest === undefined
      ? {}
      : { permissionRequest: maskedStrings(state.permissionRequest as unknown as JsonValue, mask) }),
    ...(state.harnessDialog === undefined
      ? {}
      : { dialog: maskedStrings(state.harnessDialog as unknown as JsonValue, mask) }),
  };
}
