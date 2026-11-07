/**
 * The CLI's copy of the surface-control wire shape the daemon answers on `GET|POST /v1/ferrets/:ferretId/surfaces/terminals/control`
 * (the daemon's `lib/protocol/surface-control.ts`). It belongs in the contract: a half may not import the other half.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { AskOwnerMessageSchema, SurfaceNameSchema } from '../../../contract/index.ts';

/**
 * Who drives, holds or was handed a terminal (today's `protocol/src/lib/agent-tools.ts` surface control schemas, the
 * terminal side). `surface` stays a field so the stored events and the control view keep today's shape.
 */
export const SurfaceKindSchema = z.enum(['terminal', 'browser']);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

/**
 * An agent driving a surface right now — the "AGENT · Hadi is typing here" marker.
 *
 * `until` is when the marker lapses unless the agent acts again: the daemon republishes before it
 * does, so a reader shows the marker while `now < until` and needs no second event to clear it.
 */
export const SurfaceDrivingSchema = z.strictObject({
  surface: SurfaceKindSchema,
  /** The terminal id or browser page id — stable for the surface's life. */
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  agentSessionId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(128).optional(),
  /** The page is incognito: its own throwaway cookies and storage. */
  incognito: z.literal(true).optional(),
  since: InstantSchema,
  until: InstantSchema,
});
export type SurfaceDriving = z.infer<typeof SurfaceDrivingSchema>;
/** An agent opened this surface: the workspace adds it as a tab. */
export const SurfaceOpenedSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  agentSessionId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(128).optional(),
  incognito: z.literal(true).optional(),
  at: InstantSchema,
});
export type SurfaceOpened = z.infer<typeof SurfaceOpenedSchema>;
/** An agent handed this surface to the owner: their tab comes forward with "Your turn here". */
export const SurfaceAskedSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  agentSessionId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(128).optional(),
  incognito: z.literal(true).optional(),
  /** What the owner is asked to do there. */
  message: AskOwnerMessageSchema.optional(),
  at: InstantSchema,
});
export type SurfaceAsked = z.infer<typeof SurfaceAskedSchema>;
/** Who took a surface over: a paired device (a person holding it), or somebody at this machine. */
export const SurfaceControllerSchema = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('human'), deviceId: z.string().min(1).max(128) }),
  z.strictObject({ by: z.literal('local') }),
]);
export type SurfaceController = z.infer<typeof SurfaceControllerSchema>;
/** A person holding a surface: agent tool calls on it are refused until they hand it back. */
export const SurfaceTakeoverSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  by: SurfaceControllerSchema,
  since: InstantSchema,
});
export type SurfaceTakeover = z.infer<typeof SurfaceTakeoverSchema>;
/** A surface a person opened and then handed to the agent, so the agent may act on it. */
export const SurfaceHandedSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  by: SurfaceControllerSchema,
  at: InstantSchema,
});
export type SurfaceHanded = z.infer<typeof SurfaceHandedSchema>;

/**
 * `GET /v1/ferrets/:ferretId/surfaces/terminals/control` and `…/surfaces/browser/control` — one kind
 * each, so each is governed by that kind's grant — and the answer to every control change.
 */
export const SurfaceControlViewSchema = z.strictObject({
  sessionId: z.string().min(1),
  driving: z.array(SurfaceDrivingSchema),
  takeovers: z.array(SurfaceTakeoverSchema),
  handed: z.array(SurfaceHandedSchema),
  /** Surfaces an agent opened and that are still alive. */
  opened: z.array(SurfaceOpenedSchema),
  /** Surfaces an agent handed to the owner and that the owner has not taken over since. */
  asked: z.array(SurfaceAskedSchema),
});
export type SurfaceControlView = z.infer<typeof SurfaceControlViewSchema>;
