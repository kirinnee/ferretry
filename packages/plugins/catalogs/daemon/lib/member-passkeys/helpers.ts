export const relyingPartyIdFor = (origin: string): string => new URL(origin).hostname;
