import type { FerretId } from '@ferretry/kernel/contract';
import type { CompactAt } from '../view/compact-at.ts';

/** A ferret's own compaction trigger. */
export interface CompactionApi {
  /**
   * A ferret's OWN compaction trigger (additive; Conversation's compact-at setting): what its session config records, else
   * what its start asked, else `undefined` (it follows its login's default). Same `mayTouch` rule as `harness`.
   * `undefined` also for a ferret this daemon does not know.
   */
  compactAt?(ferret: FerretId, caller?: FerretId): Promise<CompactAt | undefined>;
  /**
   * Records a ferret's OWN compaction trigger in its session config (`compactAt`), the field every launch and relaunch
   * already reads; `undefined` drops it, so the login's default applies again. Additive and optional. The value is parsed
   * with {@link CompactAtSchema} (the floor included) and anything it cannot parse is refused 400 `invalid_compact_at`;
   * an unknown ferret is 404 `not-found`; a `caller` that may not touch the ferret is 403 `forbidden`. Every other
   * field of the config is kept, and the write is atomic. Takes effect at the ferret's next launch.
   */
  setCompactAt?(ferret: FerretId, value: CompactAt | undefined, caller?: FerretId): Promise<void>;
}
