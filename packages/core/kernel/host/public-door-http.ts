import { PUBLIC_DOOR_PLUGINS } from '../contract/ports/public-door.ts';
import type { Dispatcher } from './dispatch.ts';

/** MCP JSON is at most 1 MiB; OAuth forms and registration (8 KiB) fit inside the same transport ceiling. */
export const PUBLIC_DOOR_BODY_BYTES = 1024 * 1024;

/**
 * Bun's native routes match the literal HTTP target before Request.url resolves dot segments. Only these exact
 * declared paths may enter public dispatch; the fetch fallback never dispatches public HTTP. Availability remains
 * the dispatcher's live decision, so off or failed plugins disappear without rebuilding the listener.
 */
export function publicDoorHttpRoutes(
  dispatcher: Dispatcher,
  handle: (request: Request) => Promise<Response>,
  plugin?: string,
): Record<string, (request: Request) => Promise<Response>> {
  return Object.fromEntries(
    dispatcher.table
      .filter(
        route =>
          route.door === 'public' &&
          (PUBLIC_DOOR_PLUGINS as readonly string[]).includes(route.owner.plugin) &&
          (plugin === undefined || route.owner.plugin === plugin),
      )
      .map(route => [route.path, handle]),
  );
}
