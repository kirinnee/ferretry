import { z } from 'zod';

/** Parse an ISO instant and canonicalize equivalent offsets to UTC for stable storage and ordering. */
export const InstantSchema = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
