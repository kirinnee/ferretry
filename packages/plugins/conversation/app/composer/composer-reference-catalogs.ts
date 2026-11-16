/**
 * ONE FERRET-SCOPED CATALOG feeding both composer autocomplete and Markdown proof (lead decision Q6).
 *
 * The facts a reference names are other plugins': a ferret's cards are Board's, its asks Agenda's, its skills
 * Skills', its terminals and pages Terminals' and Browsers', its files and the other ferrets Ferrets'. Each owner
 * PROVIDES the entries of its own prefix through the `reference.catalog` hook, and Conversation reads them back
 * through ONE route of its own, `GET /v1/ferrets/:ferretId/references?prefix=&q=`. So this module never reads
 * another plugin's route, and a prefix nobody provides is simply an empty menu: `provided: false`, never an error.
 *
 * A FAILED FAMILY STAYS `undefined`: that is "not proved", never an empty daemon fact. Preview and autocomplete
 * receive the same arrays, read once per prefix per ferret; a navigation to another ferret aborts the reads in
 * flight and fences their late answers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ReferenceCatalogAnswer,
  ReferenceCatalogAnswerSchema,
  type ReferenceCatalogEntry,
  type ReferenceCatalogPrefix,
} from '../../contract/index.ts';
import { type ConversationCaller, DaemonCallError } from './seam.ts';

/** The prefixes a ferret's page reads up front: the families Markdown proves a reference against (`&`, `!`, `/`, `$`). */
export const HOSTED_REFERENCE_PREFIXES: readonly ReferenceCatalogPrefix[] = ['&', '!', '/', '$'];

export type ComposerReferenceCatalogReader = ConversationCaller;

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

/**
 * One prefix's entries for one ferret, parsed before anything trusts them. An answer for another ferret or another
 * prefix is refused: a menu that offered another ferret's terminals would type into the wrong shell.
 */
export const readReferenceCatalog = async (
  client: ComposerReferenceCatalogReader,
  ferretId: string,
  prefix: ReferenceCatalogPrefix,
  signal: AbortSignal,
  query?: string,
): Promise<ReferenceCatalogAnswer> => {
  if (signal.aborted) throw abortReason(signal);
  const answer = await client.call('GET /v1/ferrets/:ferretId/references', {
    params: { ferretId },
    query: { prefix, ...(query === undefined || query === '' ? {} : { q: query }) },
  });
  if (signal.aborted) throw abortReason(signal);
  const parsed = ReferenceCatalogAnswerSchema.safeParse(answer);
  if (!parsed.success) throw new DaemonCallError(502, '', `the daemon answered the ${prefix} catalog with no entries`);
  if (parsed.data.ferret !== ferretId)
    throw new DaemonCallError(502, '', `the daemon returned ${parsed.data.ferret} while reading ${ferretId}`);
  if (parsed.data.prefix !== prefix)
    throw new DaemonCallError(502, '', `the daemon returned the ${parsed.data.prefix} catalog for ${prefix}`);
  return parsed.data;
};

export interface ComposerReferenceCatalogs {
  /**
   * The entries of each prefix read. Absent is NOT PROVED (still reading, or the read failed); a prefix nobody
   * provides reads as `[]`, which proves nothing either.
   */
  readonly entries: Readonly<Partial<Record<ReferenceCatalogPrefix, readonly ReferenceCatalogEntry[]>>>;
  /** Whether a plugin provides each prefix that was read. */
  readonly provided: Readonly<Partial<Record<ReferenceCatalogPrefix, boolean>>>;
  readonly failures: Readonly<Partial<Record<ReferenceCatalogPrefix, string>>>;
}

interface CatalogPatch {
  readonly prefix: ReferenceCatalogPrefix;
  readonly answer?: ReferenceCatalogAnswer;
  readonly failure?: string;
}

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const EMPTY_CATALOGS: ComposerReferenceCatalogs = Object.freeze({
  entries: Object.freeze({}),
  provided: Object.freeze({}),
  failures: Object.freeze({}),
});

const mergeCatalogPatch = (current: ComposerReferenceCatalogs, patch: CatalogPatch): ComposerReferenceCatalogs => {
  const { [patch.prefix]: _failure, ...failures } = current.failures;
  if (patch.answer === undefined)
    return { ...current, failures: { ...failures, [patch.prefix]: patch.failure ?? 'not read' } };
  return {
    entries: { ...current.entries, [patch.prefix]: patch.answer.entries },
    provided: { ...current.provided, [patch.prefix]: patch.answer.provided },
    failures,
  };
};

/**
 * Start every prefix's read once, then report each from its own promise: a slow sibling cannot withhold a proved
 * family from the page, while the returned promise is the one complete in-flight read a menu awaits.
 */
async function readCatalogsIncrementally(
  client: ComposerReferenceCatalogReader,
  ferretId: string,
  prefixes: readonly ReferenceCatalogPrefix[],
  signal: AbortSignal,
  publish: (patch: CatalogPatch) => void,
): Promise<void> {
  const publishIfLive = (patch: CatalogPatch): void => {
    if (!signal.aborted) publish(patch);
  };
  await Promise.allSettled(
    prefixes.map(prefix =>
      readReferenceCatalog(client, ferretId, prefix, signal).then(
        answer => publishIfLive({ prefix, answer }),
        (reason: unknown) => {
          publishIfLive({ prefix, failure: failureMessage(reason) });
          throw reason;
        },
      ),
    ),
  );
  if (signal.aborted) throw abortReason(signal);
}

/**
 * Hydrate on concrete ferret identity and fence late answers after navigation. A host without a client (a suite, a
 * partial host) proves no catalog facts. `refresh` reads every prefix again (after a send, say).
 */
export function useComposerReferenceCatalogs(
  client: Partial<ComposerReferenceCatalogReader>,
  ferretId: string,
  prefixes: readonly ReferenceCatalogPrefix[] = HOSTED_REFERENCE_PREFIXES,
): ComposerReferenceCatalogs & {
  /**
   * All in-flight reads for THIS ferret, or nothing once they settle.
   *
   * It exists for the race a reader hits on the first message of every ferret: a menu opened while the page is still
   * reading would otherwise offer an invented empty list, or make the composer issue its own second request for
   * exactly what is already being fetched. Awaiting the aggregate is what makes "one read per fact" true.
   */
  readonly settled: () => Promise<void> | undefined;
  readonly refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<{
    readonly ferretId: string;
    readonly catalogs: ComposerReferenceCatalogs;
  } | null>(null);
  const [generation, setGeneration] = useState(0);
  const pending = useRef<Promise<void> | null>(null);
  const settled = useCallback((): Promise<void> | undefined => pending.current ?? undefined, []);
  const refresh = useCallback(() => setGeneration(current => current + 1), []);
  const prefixKey = prefixes.join('\u0000');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `prefixKey` is the prefixes' identity and `generation` the refresh trigger.
  useEffect(() => {
    const controller = new AbortController();
    if (typeof client.call !== 'function') {
      pending.current = null;
      setSnapshot(null);
      return () => controller.abort();
    }
    const publish = (patch: CatalogPatch): void => {
      setSnapshot(current => ({
        ferretId,
        catalogs: mergeCatalogPatch(current?.ferretId === ferretId ? current.catalogs : EMPTY_CATALOGS, patch),
      }));
    };
    const read = readCatalogsIncrementally(
      client as ComposerReferenceCatalogReader,
      ferretId,
      prefixes,
      controller.signal,
      publish,
    )
      .catch(() => {
        // Abort is expected on navigation. Every non-abort family failure is already published by its own family.
      })
      .finally(() => {
        if (pending.current === read) pending.current = null;
      });
    pending.current = read;
    return () => {
      controller.abort();
      pending.current = null;
    };
  }, [client, ferretId, prefixKey, generation]);

  const catalogs = snapshot?.ferretId === ferretId ? snapshot.catalogs : EMPTY_CATALOGS;
  return useMemo(() => ({ ...catalogs, settled, refresh }), [catalogs, settled, refresh]);
}
