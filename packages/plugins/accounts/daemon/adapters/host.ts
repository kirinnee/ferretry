import { hostname } from 'node:os';

/** This machine's name: where a terminal sign-in a card saves runs its prompt, and the words on a 2FA card. */
export const machineName = (): string => hostname();
