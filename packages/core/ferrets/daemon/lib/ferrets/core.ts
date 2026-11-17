import type {
  FerretDetails,
  FerretId,
  FerretRecord,
  FerretChangedPayload,
  FerretState,
} from '../../../contract/index.ts';
import type { FerretRegistry } from '../registry/registry.ts';
import type { FerretTokenDirectory } from '../tokens/tokens.ts';
import type { SerialExecutor } from '../ports.ts';
import type { FerretsPorts } from './service.ts';

/**
 * What a member that lives OUTSIDE `service.ts` needs from the service that owns it: an explicit bundle, never a global.
 * The service builds it once (`FerretsService.core`); every moved slice (`runtime-records.ts`, `compact-at.ts`,
 * `turns.ts`, `insights.ts`) takes it as its first argument, as `openHarness` takes its own deps. A slice that needs one
 * more thing adds it here, in this file, and edits no other slice.
 */
export interface FerretsCore {
  readonly registry: FerretRegistry;
  readonly tokens: FerretTokenDirectory;
  readonly ports: FerretsPorts;
  /** Today's lifecycle gate: the per-ferret lane every write to a ferret's record runs on. */
  readonly serial: Pick<SerialExecutor, 'run'>;
  /** Throws a 403 when a ferret caller is neither the target nor its lead or helper (a person is never refused). */
  readonly requireMayTouch: (caller: FerretId | undefined, target: FerretId) => void;
  /** Throws a 503 when the credential state cannot be read safely. */
  readonly requireTokens: () => void;
  /** The durable write of one record, then the registry, then `ferret.changed`. */
  readonly write: (
    record: FerretRecord,
    previous: FerretState | undefined,
    change: FerretChangedPayload['change'],
  ) => Promise<void>;
  readonly saveDetails: (ferret: FerretId, details: FerretDetails) => Promise<void>;
}
