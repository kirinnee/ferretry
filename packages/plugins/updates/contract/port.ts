import { defineEvent, definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { type UpdateStatus, UpdateOutcomeSchema, VersionSchema } from './wire.ts';

/** Updates' port (§2.3): whether this daemon is behind. Installing is a route, never a port call. */
export interface UpdatesApi {
  status(): Promise<UpdateStatus>;
}
export const UpdatesPort = definePort<UpdatesApi>('updates');

/** A check found a release this daemon does not run, or an update finished. */
export const UpdateAvailable = defineEvent('updates.available', z.strictObject({ latest: VersionSchema }));
export const UpdateFinished = defineEvent(
  'updates.finished',
  z.strictObject({ target: VersionSchema, outcome: UpdateOutcomeSchema }),
);
