import { readConfigText } from '@ferretry/std/yaml';

/**
 * THE ONE OWNER OF "THIS HOME'S DAEMON PORT": the `direct.port` key of Connections' own `connections.yaml` (a migrated
 * v4 home carries `daemon.json`'s bind there, and `ConnectionsConfigSchema` is the document's schema). Both the daemon
 * (to bind) and `fy` (to dial while no daemon has recorded one) read it through {@link homePortOf}, so they cannot
 * disagree — and neither keeps a second copy of the number. The kernel names the FILE and this ONE key only; every other
 * key, and the whole document's validity, stays with Connections and the configuration layer.
 */
export const HOME_PORT_FILE = 'config/connections.yaml';
/** How a sentence names the key, so an operator can find it. */
export const HOME_PORT_KEY = `${HOME_PORT_FILE} direct.port`;

export type HomePort =
  | { readonly kind: 'none' }
  | { readonly kind: 'port'; readonly port: number }
  | { readonly kind: 'refused'; readonly sentence: string };

const NONE: HomePort = { kind: 'none' };

/**
 * The port the home's configuration names, from the document's text (`undefined`: there is no file). Pure.
 *
 * The same rule as `--port` and the schema: a whole number from 0 to 65535, otherwise REFUSED with a sentence, never
 * clamped. A text that is not YAML at all says nothing here: the configuration layer refuses that file on its own.
 */
export function homePortOf(documentText: string | undefined): HomePort {
  if (documentText === undefined) return NONE;
  const read = readConfigText(documentText);
  if (!read.ok) return NONE;
  const document = read.read.value;
  if (typeof document !== 'object' || document === null) return NONE;
  const direct = (document as Record<string, unknown>).direct;
  if (typeof direct !== 'object' || direct === null || !('port' in direct)) return NONE;
  const port = (direct as Record<string, unknown>).port;
  if (typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535) return { kind: 'port', port };
  return { kind: 'refused', sentence: `${HOME_PORT_KEY} ${JSON.stringify(port)} is not a port number.` };
}
