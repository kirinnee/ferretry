import { readConfigText } from '@ferretry/std/yaml';
import { acceptedName } from './accepted.ts';

/**
 * THE ONE OWNER OF "THIS HOME'S DAEMON PORT": the `direct.port` key of Connections' own `connections.yaml` (a migrated
 * v4 home carries `daemon.json`'s bind there, and `ConnectionsConfigSchema` is the document's schema). The kernel names
 * the FILE and this ONE key only; every other key, and whether the document is valid or its edit is held for the owner,
 * stays with Connections and the configuration service.
 *
 * WHAT COUNTS IS THE VERSION IN EFFECT, never the text on disk: the configuration service keeps an edit that loosens
 * (a different `direct` listener is one) on disk but HELD until the owner confirms it, and the tighter version stays in
 * effect. So the daemon asks the service's own read-only decision (`inEffectConfigReader`) before it binds, and `fy`,
 * which must not run the service, reads the record the service keeps of that decision (`state/kernel/accepted-config/`,
 * through {@link homePortAccepted}). Neither ever adopts a held edit.
 */
export const HOME_PORT_FILE = 'config/connections.yaml';
/** The file's name under `config/`: the service's own path for it, and the name of its accepted record. */
export const HOME_PORT_DOCUMENT = 'connections.yaml';
/** How a sentence names the key, so an operator can find it. */
export const HOME_PORT_KEY = `${HOME_PORT_FILE} direct.port`;
/** Said for ANY malformed value, and never with it: a configuration text may hold a credential. */
export const HOME_PORT_REFUSAL = `${HOME_PORT_KEY} must be a whole number from 0 to 65535.`;

export type HomePort =
  | { readonly kind: 'none' }
  | { readonly kind: 'port'; readonly port: number }
  | { readonly kind: 'refused'; readonly sentence: string };

const NONE: HomePort = { kind: 'none' };

/**
 * The port a document's TEXT names. Pure. The same rule as `--port` and the schema: a whole number from 0 to 65535,
 * otherwise REFUSED with {@link HOME_PORT_REFUSAL} (never clamped, never the rejected value). A text that is not YAML at
 * all says nothing here: the configuration layer refuses that file on its own.
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
  return { kind: 'refused', sentence: HOME_PORT_REFUSAL };
}

/** Where the configuration service keeps what it put into effect for the file: `<home>/state/kernel/accepted-config/…`. */
export const homePortAcceptedPath = (home: string): string =>
  `${home}/state/kernel/accepted-config/${acceptedName(HOME_PORT_DOCUMENT)}.json`;

/**
 * The port in the service's accepted record for the file (its text is the version it last put into effect), from that
 * record's JSON text. Nothing accepted, or a record that cannot be read, says nothing: the safe direction to be wrong in.
 */
export function homePortAccepted(recordText: string | undefined): HomePort {
  if (recordText === undefined) return NONE;
  try {
    const record = JSON.parse(recordText) as { readonly text?: unknown };
    return typeof record.text === 'string' ? homePortOf(record.text) : NONE;
  } catch {
    return NONE;
  }
}
