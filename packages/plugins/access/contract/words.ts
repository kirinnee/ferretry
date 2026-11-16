import type { Word } from '@ferretry/kernel/contract';

/** Access's glossary entries (§2.3). Owned here once (`words` check). */
export const ACCESS_WORDS = [
  { word: 'device', means: 'your phone or browser, paired to a daemon', insteadOf: ['client'] },
  { word: 'invite', means: 'the QR code that pairs a device', insteadOf: ['pairing code'] },
  { word: 'grant', means: 'what one device may do', insteadOf: ['permission'] },
  { word: 'unlock', means: 'proving it is you before a sensitive act', insteadOf: ['operator password'] },
  { word: 'passkey', means: 'your fingerprint or face check', insteadOf: ['WebAuthn'] },
] as const satisfies readonly Word[];
