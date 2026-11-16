import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { SitrepLineSource } from '../kinds.ts';

/** Conversation and Board add sitrep lines. */
export const SitrepLines = defineHook('sitrep.lines', { mode: 'contribute', item: z.custom<SitrepLineSource>() });
