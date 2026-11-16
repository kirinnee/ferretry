import { InputTargetFactsSchema } from '@ferretry/core-vault/contract';
import {
  BROWSER_INPUT_TEXT_MAX_CHARS,
  BROWSER_INPUT_WORKER_METHODS,
  type BrowserInputClearJob,
  type BrowserInputClearOutcome,
  type BrowserInputDocument,
  type BrowserInputFacts,
  type BrowserInputFieldPointer,
  type BrowserInputFieldsPort,
  type BrowserInputObservation,
  type BrowserInputOutcome,
  type BrowserInputShot,
  type BrowserInputValue,
  type BrowserPushNumberRead,
} from './contracts.ts';
import { parseNavigationEvidence } from './navigation-evidence.ts';

/**
 * THE DAEMON'S SIDE OF THE PAGE INPUT SEAM: {@link BrowserInputFieldsPort} over the browser worker's JSON lines, copied
 * from today's `daemon/src/adapters/browser/transport/worker-client.ts` (the `input*` and `pushNumberRead` methods and
 * the parsers they use). The worker client lends its `request`; every answer is parsed here before it is believed, and
 * a malformed one is refused in words that quote none of it, because it may carry a value.
 */

/** One JSON-line request to the browser worker; rejects on a worker error. */
export type WorkerRequest = (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** A worker answer the daemon does not believe. Its message is fixed: it quotes nothing the worker said. */
class InputAnswerRefused extends Error {
  readonly code = 'upstream_failed' as const;
  readonly status = 502 as const;
}

/** The longest a document id or an origin may be, as the input bridge bounds them. */
const READ_LIMITS = { origin: 256, navigationId: 128 } as const;

/** What the worker saw of a page's fields, checked against the Vault's `page` facts before it is believed. */
function parseObservation(raw: unknown): BrowserInputObservation {
  const observation = (raw as { observation?: unknown } | null)?.observation as Record<string, unknown> | undefined;
  if (observation?.ok === false && typeof observation.missing === 'string')
    return { ok: false, missing: observation.missing.slice(0, 64) };
  if (observation?.ok === false && typeof observation.ambiguous === 'string')
    return { ok: false, ambiguous: observation.ambiguous.slice(0, 64) };
  const facts = InputTargetFactsSchema.safeParse(observation?.facts);
  if (observation?.ok === true && facts.success && facts.data.kind === 'page') return { ok: true, facts: facts.data };
  throw new InputAnswerRefused('the browser described the fields in a form Ferretry does not accept');
}

const PUSH_NUMBER_PROVIDERS: ReadonlySet<unknown> = new Set(['okta', 'microsoft', 'google', 'duo']);
const PUSH_NUMBER_MISSING: ReadonlySet<unknown> = new Set(['none-found', 'changed']);
const PUSH_NUMBER_KEYS: ReadonlySet<string> = new Set(['origin', 'navigationId', 'provider', 'number', 'missing']);
const PUSH_NUMBER_VALUE_KEYS: ReadonlySet<string> = new Set(['value', 'from', 'frameOrigin']);

/**
 * A push-number read, checked before it is believed: exactly the shape `BrowserPushNumberRead` names, a number of one
 * to six digits from a known source, and either a number or why there is none, never both. A malformed answer is
 * refused in words that quote none of it.
 */
export function parsePushNumberRead(raw: unknown): BrowserPushNumberRead {
  const refuse = (): never => {
    throw new InputAnswerRefused('the browser answered the push number in a form Ferretry does not accept');
  };
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const bounded = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && value !== '' && value.length <= limit;
  if (!object(raw) || Object.keys(raw).some(key => !PUSH_NUMBER_KEYS.has(key))) return refuse();
  const { origin, navigationId, provider, number, missing } = raw;
  if (!bounded(origin, READ_LIMITS.origin) || !bounded(navigationId, READ_LIMITS.navigationId)) return refuse();
  if (provider !== undefined && !PUSH_NUMBER_PROVIDERS.has(provider)) return refuse();
  if ((number === undefined) === (missing === undefined)) return refuse();
  const base = {
    origin,
    navigationId,
    ...(provider === undefined ? {} : { provider: provider as NonNullable<BrowserPushNumberRead['provider']> }),
  };
  if (missing !== undefined)
    return PUSH_NUMBER_MISSING.has(missing)
      ? { ...base, missing: missing as NonNullable<BrowserPushNumberRead['missing']> }
      : refuse();
  if (!object(number) || Object.keys(number).some(key => !PUSH_NUMBER_VALUE_KEYS.has(key))) return refuse();
  const { value, from, frameOrigin } = number;
  if (typeof value !== 'string' || !/^[0-9]{1,6}$/u.test(value)) return refuse();
  if (!PUSH_NUMBER_PROVIDERS.has(from) || !bounded(frameOrigin, READ_LIMITS.origin)) return refuse();
  return {
    ...base,
    number: { value, from: from as NonNullable<BrowserPushNumberRead['number']>['from'], frameOrigin },
  };
}

/** The most a field shot may be as base64: a 900px-square PNG is far under it. */
const MAX_INPUT_SHOT_CHARS = 4_000_000;

/** A field shot: a bounded PNG and a finite clip, or a refusal. */
function parseShot(raw: unknown): BrowserInputShot {
  const shot = (raw as { shot?: unknown } | null)?.shot as Record<string, unknown> | undefined;
  const clip = shot?.clip as Record<string, unknown> | undefined;
  const numbers = ['x', 'y', 'w', 'h'].map(key => clip?.[key]);
  if (
    typeof shot?.pngBase64 === 'string' &&
    shot.pngBase64.length > 0 &&
    shot.pngBase64.length <= MAX_INPUT_SHOT_CHARS &&
    /^[A-Za-z0-9+/]+=*$/u.test(shot.pngBase64) &&
    numbers.every(value => typeof value === 'number' && Number.isFinite(value))
  ) {
    const [x, y, w, h] = numbers as number[];
    return { pngBase64: shot.pngBase64, clip: { x: x as number, y: y as number, w: w as number, h: h as number } };
  }
  throw new InputAnswerRefused('the browser sent no usable picture of the fields');
}

/** The page input port over a worker's requests. */
export function workerInputFields(request: WorkerRequest): Required<BrowserInputFieldsPort> {
  return {
    /**
     * The push number a page shows (push-number-read.ts), as a provider's own challenge view shows it. Believed only in
     * its exact shape; anything else is refused in words that quote none of it.
     */
    async pushNumberRead(pageId: string): Promise<BrowserPushNumberRead> {
      const raw = await request(BROWSER_INPUT_WORKER_METHODS.pushNumber, { pageId });
      return parsePushNumberRead((raw as { read?: unknown } | null)?.read);
    },

    async inputDocument(pageId: string): Promise<BrowserInputDocument> {
      const raw = await request(BROWSER_INPUT_WORKER_METHODS.document, { pageId });
      const navigationId = ((raw as { document?: { navigationId?: unknown } } | null)?.document ?? {}).navigationId;
      if (typeof navigationId !== 'string' || navigationId === '' || navigationId.length > 128)
        throw new InputAnswerRefused('the browser did not say which document the page shows');
      const document = (
        raw as {
          document?: {
            host?: unknown;
            frameHosts?: unknown;
            framesUnreadable?: unknown;
            pairingScreen?: unknown;
            pairingSeen?: unknown;
            navigation?: unknown;
          };
        } | null
      )?.document;
      const host = document?.host;
      const frameHosts = Array.isArray(document?.frameHosts)
        ? (document.frameHosts as unknown[]).filter(
            (each): each is string => typeof each === 'string' && each !== '' && each.length <= 260,
          )
        : [];
      // Frame hosts that do not parse are frames that cannot be told: the page's frames are unreadable, not absent.
      const unreadable =
        document?.framesUnreadable === true ||
        (Array.isArray(document?.frameHosts) && frameHosts.length !== (document.frameHosts as unknown[]).length) ||
        frameHosts.length > 64;
      const pairingSeen = document?.pairingSeen;
      const navigation = parseNavigationEvidence(document?.navigation);
      return {
        navigationId,
        ...(navigation === undefined ? {} : { navigation }),
        ...(typeof host === 'string' && host !== '' && host.length <= 260 ? { host } : {}),
        ...(frameHosts.length === 0 || unreadable ? {} : { frameHosts }),
        ...(unreadable ? { framesUnreadable: true as const } : {}),
        // Anything but a plain yes is NOT a no: a reply that cannot be believed is a marked page (fail closed).
        ...(document?.pairingScreen === true || typeof pairingSeen !== 'number' || !Number.isInteger(pairingSeen)
          ? { pairingScreen: true }
          : {}),
        pairingSeen: typeof pairingSeen === 'number' && Number.isInteger(pairingSeen) ? pairingSeen : -1,
      };
    },

    /** The page's visible text, for the daemon's own look for a just-typed value. A malformed answer is refused. */
    async inputText(pageId: string): Promise<string> {
      const raw = await request(BROWSER_INPUT_WORKER_METHODS.text, { pageId });
      const text = (raw as { text?: unknown } | null)?.text;
      if (typeof text !== 'string' || text.length > BROWSER_INPUT_TEXT_MAX_CHARS * 7 + 2)
        throw new InputAnswerRefused('the browser did not answer with the page text');
      return text;
    },

    async inputObserve(pageId: string, fields: readonly BrowserInputFieldPointer[]): Promise<BrowserInputObservation> {
      return parseObservation(await request(BROWSER_INPUT_WORKER_METHODS.observe, { pageId, fields }));
    },

    async inputRefind(
      pageId: string,
      expected: BrowserInputFacts,
      fields: readonly BrowserInputFieldPointer[],
    ): Promise<BrowserInputObservation> {
      return parseObservation(await request(BROWSER_INPUT_WORKER_METHODS.refind, { pageId, expected, fields }));
    },

    async inputShot(pageId: string, facts: BrowserInputFacts): Promise<BrowserInputShot> {
      return parseShot(await request(BROWSER_INPUT_WORKER_METHODS.shot, { pageId, facts }));
    },

    /**
     * The one write of owner-supplied values. The values ride only in this request's params; the answer is a word.
     * Anything but one of the four words (a crash, a timeout, a garbled line) is `uncertain`: the write may have
     * begun, so it is never repeated.
     */
    async inputType(
      pageId: string,
      expected: BrowserInputFacts,
      values: readonly BrowserInputValue[],
      submit: boolean,
    ): Promise<BrowserInputOutcome> {
      try {
        const raw = await request(BROWSER_INPUT_WORKER_METHODS.type, { pageId, expected, values, submit });
        const outcome = (raw as { outcome?: unknown } | null)?.outcome;
        return outcome === 'typed' || outcome === 'target_changed' || outcome === 'target_gone' ? outcome : 'uncertain';
      } catch {
        return 'uncertain';
      }
    },

    /** A grant fill arms its `pagehide` clear before the write. A failure or any odd answer is `refused`: the daemon then types nothing. */
    async inputArm(
      pageId: string,
      expected: BrowserInputFacts,
      fieldIds: readonly string[],
    ): Promise<'armed' | 'refused'> {
      try {
        const raw = await request(BROWSER_INPUT_WORKER_METHODS.arm, { pageId, expected, fieldIds });
        return (raw as { outcome?: unknown } | null)?.outcome === 'armed' ? 'armed' : 'refused';
      } catch {
        return 'refused';
      }
    },

    /**
     * A grant fill's check before its page hold ends: the job names nodes, never a value. Any failure or odd answer is
     * `unknown`, which stops the line.
     */
    async inputClear(pageId: string, job: BrowserInputClearJob): Promise<BrowserInputClearOutcome> {
      try {
        const raw = await request(BROWSER_INPUT_WORKER_METHODS.clear, { pageId, job });
        const outcome = (raw as { outcome?: unknown } | null)?.outcome;
        return outcome === 'cleared' || outcome === 'moved' ? outcome : 'unknown';
      } catch {
        return 'unknown';
      }
    },

    /** The dummy probe; any failure or odd answer is `aborted`, which only keeps the lock long. */
    async inputProbe(
      pageId: string,
      expected: BrowserInputFacts,
      fieldIds: readonly string[],
      dummy: string,
    ): Promise<'hidden' | 'shown' | 'aborted'> {
      try {
        const raw = await request(BROWSER_INPUT_WORKER_METHODS.probe, { pageId, expected, fieldIds, dummy });
        const outcome = (raw as { outcome?: unknown } | null)?.outcome;
        return outcome === 'hidden' || outcome === 'shown' ? outcome : 'aborted';
      } catch {
        return 'aborted';
      }
    },
  };
}
