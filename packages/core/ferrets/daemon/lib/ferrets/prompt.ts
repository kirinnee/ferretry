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
 * The usage limit a session is parked on: only while its status is `rate_limited`, in the harness's own words (the
 * quota's notice, else the first line of the usage-limit dialog it is parked on). No words, no limit.
 */
function limitOf(
  state: Pick<SessionState, 'harnessDialog'> & Partial<Pick<SessionState, 'status' | 'quota'>>,
  mask: (text: string) => string,
): FerretPrompt['limit'] {
  if (state.status !== 'rate_limited') return undefined;
  const dialog = state.harnessDialog;
  const words =
    state.quota?.limitNotice ??
    (dialog?.kind === 'usage-limit' ? dialog.body?.split('\n')[0]?.trim() || dialog.title : undefined);
  if (words === undefined || words === '') return undefined;
  const retryAt = state.quota?.retryAt;
  return {
    notice: mask(words),
    spend: state.quota?.unavailableReason === 'spend_limit',
    ...(retryAt === undefined ? {} : { retryAt }),
  };
}

/**
 * What a ferret's state document says its pane is asking (`FerretsApi.prompt`): the recorded turn, the dialog words,
 * the permission request and the harness dialog, every string passed through `mask` (one `Redaction.read`'s
 * `scope.text`). Nothing recorded is `{}`. Pure.
 */
export function promptOf(
  state: Pick<SessionState, 'turnState' | 'turnPrompt' | 'permissionRequest' | 'harnessDialog'> &
    Partial<Pick<SessionState, 'status' | 'quota'>>,
  mask: (text: string) => string,
): FerretPrompt {
  const limit = limitOf(state, mask);
  return {
    ...(limit === undefined ? {} : { limit }),
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
