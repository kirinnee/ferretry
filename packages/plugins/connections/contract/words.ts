import type { Word } from '@ferretry/kernel/contract';

/** Connections' glossary entries (§2.3). */
export const CONNECTIONS_WORDS = [
  { word: 'carrier', means: 'one way a device reaches a daemon', insteadOf: ['transport'] },
  { word: 'direct', means: 'straight over your network', insteadOf: ['LAN'] },
  {
    word: 'relay',
    means: "through Ferretry's meeting point on the internet; it sees only sealed bytes",
    insteadOf: ['proxy'],
  },
  { word: 'tunnel', means: 'through a Cloudflare tunnel you own' },
] as const satisfies readonly Word[];
