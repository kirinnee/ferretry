import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { LaunchPartSource } from '../kinds.ts';

/** Lessons, MCP, Skills, Shells add to every launch. Any plugin may take it. */
export const LaunchParts = defineHook('launch.parts', { mode: 'contribute', item: z.custom<LaunchPartSource>() });
