/**
 * The names a ferret's own `fy` reads inside its pane: the tools server's one-line MCP instructions and
 * the launch variables that say which sections this ferret was given. Their meaning is documented where
 * the fixed layer uses them (`./fixed-layer.ts`), which re-exports every one.
 *
 * Its own module, importing only one leaf constant, because `fy mcp serve` reads them and every agent pane keeps one of
 * those running: reached through the fleet's barrel, a handful of constants made each of them load the
 * whole fleet library (`@ferretry/fleet/pane-contract`; docs/performance.md § "A waiting fy is small").
 */

/** What the tools server says when an agent connects: Runtimes' contract owns the line (`fy mcp serve` reads it there). */
export { TOOLS_SERVER_INSTRUCTIONS } from '../../../contract/tools-server.ts';

/** The launch variable naming a ferret's mode (`interactive` or `auto`). */
export const SESSION_MODE_ENV = 'FY_SESSION_MODE';
/** Whether this ferret is told to file lessons. */
export const PASSIVE_LEARNING_ENV = 'FY_LEARNING_PASSIVE';
/** Whether this ferret was given the hypermedia section. */
export const HYPERMEDIA_ENV = 'FY_HYPERMEDIA';
/** Whether this ferret may delegate to sub-ferrets. */
export const PACK_ENV = 'FY_PACK';
/** Whether this ferret keeps the owner's agendas. */
export const AGENDA_ENV = 'FY_AGENDA';
