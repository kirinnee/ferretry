import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { SurfaceNameSchema } from '../../../contract/index.ts';

/** What the owner is asked to do when a surface is handed to them: a short plain sentence, never a secret. */
const AGENT_TOOL_MAX_ASK_CHARS = 280;
const AskOwnerMessageSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_ASK_CHARS);
const AGENT_TOOL_MAX_URL_CHARS = 2_048;

/**
 * Who is driving, has taken over, was handed or was asked to take each page (today's `surface.*` views of
 * `protocol/src/lib/agent-tools.ts`). Terminals keeps its own copy; there is no contract edge between the two.
 */
export const SurfaceKindSchema = z.enum(['terminal', 'browser']);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

/** One page as a listing shows it: never so much as the title of a person's page to an agent. */
export const AgentSurfaceSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  title: z.string().max(512),
  /** A throwaway browser page with its own cookies, shared with nothing. */
  incognito: z.literal(true).optional(),
  url: z
    .string()
    .max(AGENT_TOOL_MAX_URL_CHARS * 4)
    .optional(),
  /**
   * For an agent's listing only: whether this agent may act on it. An agent acts on what it opened,
   * and on what a person explicitly handed to it — never on a person's own shell or page by default,
   * nor on anything a person has taken over.
   */
  available: z.boolean().optional(),
  /** A popup: the page that opened it. Listed so an agent can tell which tabs are its own pages' popups. */
  openerId: z.string().min(1).max(128).optional(),
});
export type AgentSurface = z.infer<typeof AgentSurfaceSchema>;
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
 * `GET /v1/sessions/:sessionId/surfaces/terminals/control` and `…/surfaces/browser/control` — one kind
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

/**
 * `POST /v1/sessions/:sessionId/surfaces/terminals/control` and `…/surfaces/browser/control`: a person takes a surface
 * over from the agent, or hands it back. The answer is the session's {@link SurfaceControlViewSchema}.
 */

/**
 * The session-journal events control changes are published as, on the existing `/v1/events` feed.
 * `surface.driving` carries {@link SurfaceDrivingSchema}; `surface.takeover` carries
 * {@link SurfaceTakeoverSchema}; `surface.handback` carries {@link SurfaceHandbackSchema}; `surface.handed`
 * carries {@link SurfaceHandedSchema}; `surface.opened` carries {@link SurfaceOpenedSchema} and `surface.asked`
 * carries {@link SurfaceAskedSchema}. The daemon replays them on start, so a takeover outlives a restart.
 */
export const SURFACE_EVENT_TYPES = {
  driving: 'surface.driving',
  takeover: 'surface.takeover',
  handback: 'surface.handback',
  handed: 'surface.handed',
  opened: 'surface.opened',
  asked: 'surface.asked',
} as const;

export const SurfaceHandbackSchema = z.strictObject({
  surface: SurfaceKindSchema,
  id: z.string().min(1).max(128),
  name: SurfaceNameSchema.optional(),
  at: InstantSchema,
});
export type SurfaceHandback = z.infer<typeof SurfaceHandbackSchema>;
