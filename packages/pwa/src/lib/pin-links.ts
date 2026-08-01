import type { DaemonSessionScope } from './daemon-scope.ts';

/** Pins are readable composer text, never a second canonical reference grammar. */
export interface PinReferenceLookup extends DaemonSessionScope {
  readonly pinId: string;
}

export interface ResolvedPinReference extends PinReferenceLookup {
  readonly label: string;
}

export type PinReferenceResolver = (lookup: PinReferenceLookup) => ResolvedPinReference | null | undefined;

const pinLabel = (value: string): string => value.replace(/\s+/gu, ' ').trim() || 'Untitled pin';

export const pinReferenceMarkdown = (reference: ResolvedPinReference): string => `pin: ${pinLabel(reference.label)}`;
