import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

/** Separate from the kept ferret's files: its permanent mutation fence survives a restart or Relocate being off. */
export const RelocationStubsFile = defineState({
  name: 'relocation-stubs',
  path: 'relocation-stubs.json',
  store: 'json',
  format: 1,
  mode: 0o600,
  onDamaged: {
    narrower: 'a damaged relocation fence refuses ferret mutations; reads and other features remain available',
  },
  schema: z.strictObject({
    moved: z.record(
      z.string(),
      z.strictObject({
        daemonId: z.string().min(1),
        ferretId: z.string().min(1),
        machine: z.string().min(1),
      }),
    ),
  }),
});
