/** The attested opener, or an explicit absence of evidence. Copied from today's PWA surface-references. */
export type SurfaceOwnership =
  | { readonly by: 'agent'; readonly sessionId: string }
  | { readonly by: 'human'; readonly deviceId: string }
  | { readonly by: 'local' }
  | { readonly by: 'unrecorded' };

export interface SurfaceOwnershipLabel {
  readonly text: string;
  readonly tone: 'warn' | 'pend' | 'accent';
  readonly detail?: string;
}

export const describeSurfaceOwnership = (ownership: SurfaceOwnership): SurfaceOwnershipLabel => {
  if (ownership.by === 'agent')
    return { text: 'Opened by an agent', tone: 'warn', detail: `agent session ${ownership.sessionId}` };
  if (ownership.by === 'human')
    return { text: 'Opened from a paired device', tone: 'accent', detail: `device ${ownership.deviceId}` };
  if (ownership.by === 'local') return { text: 'Opened on the daemon host', tone: 'accent' };
  return { text: 'Owner unrecorded', tone: 'pend' };
};
