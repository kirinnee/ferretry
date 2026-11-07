import type { z } from 'zod';
import type {
  BrowserLoginConnectionSchema,
  BrowserLoginStateSchema,
  BrowserLoginStatusSchema,
} from '../../../contract/index.ts';

/** The sign-in window's wire is the contract's (`contract/wire.ts`); these are its derived types. */
export type BrowserLoginState = z.infer<typeof BrowserLoginStateSchema>;
export type BrowserLoginConnection = z.infer<typeof BrowserLoginConnectionSchema>;
export type BrowserLoginStatus = z.infer<typeof BrowserLoginStatusSchema>;
export type { BrowserLoginAction } from '../../../contract/index.ts';
