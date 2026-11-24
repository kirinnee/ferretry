/**
 * The steps every creative tool shares, so a picture, a voiceover, a sound effect and a song all stand under ONE
 * ledger, ONE daily cap and ONE queue. A tool prices its own call and fetches its own file; this file does the money:
 *
 *   1. the daily cap refuses; a call over the ask threshold raises an ask and waits for the owner (nothing is sent).
 *   2. the spend is RESERVED in the ledger before the provider is called, and given back only when it definitely billed
 *      nothing (refused, 401/403/429, any other 4xx). A timeout, a dropped connection, a 5xx or an unreadable answer may
 *      have been billed, so it stays counted: money that may be spent is money recorded, whatever happens next.
 *   3. the tool's `run` is called; its failure becomes one answer that says what is counted.
 *
 * Every tool call runs one at a time through ONE queue, so two ferrets asking together (even for different tools) cannot
 * both pass the same day's cap.
 */
import { createHash } from 'node:crypto';
import type { FetchPort } from '@ferretry/kernel/contract';
import {
  type MicroUsd,
  type PriceSource,
  type ResolvedCreateConfig,
  type SpendRecord,
  type SpendTool,
  usdWords,
} from '../../contract/index.ts';
import { type FalFailure, isFailure } from './fal.ts';
import { approvalFor, dayOf, judgeSpend, type SpendAsks, type SpendLedger } from './spend.ts';

export interface ToolAnswer {
  readonly text: string;
  readonly isError?: boolean;
}

/** Hands a made file to a ferret's media folder and answers its media-relative name, or `undefined` when it could not be placed. */
export type DeliverMedia = (ferret: string, name: string, bytes: Uint8Array) => Promise<string | undefined>;

export const refusal = (text: string): ToolAnswer => ({ text, isError: true });
export const failed = (failure: FalFailure): ToolAnswer => refusal(`Not made: ${failure.sentence}.`);

/** Runs its work after every earlier call has ended, whatever became of them. */
export type Serial = <T>(work: () => Promise<T>) => Promise<T>;

export function serialQueue(): Serial {
  let running: Promise<unknown> = Promise.resolve();
  return async work => {
    // `running` never rejects (it holds the previous call's end, caught), so one handler is enough.
    const turn = running.then(work);
    running = turn.catch(() => undefined);
    return await turn;
  };
}

/** A request's identity: the tool and what it asks for, nothing about who. The same words with the same settings are one request. */
export function requestDigest(tool: SpendTool, parts: Readonly<Record<string, string | number | boolean>>): string {
  const body = Object.keys(parts)
    .sort()
    .map(key => `${key}=${String(parts[key])}`);
  return createHash('sha256')
    .update([tool, ...body].join('\0'))
    .digest('hex')
    .slice(0, 16);
}

export interface PaidDeps {
  readonly config: () => ResolvedCreateConfig;
  readonly ledger: SpendLedger;
  readonly asks: SpendAsks;
  readonly now: () => Date;
}

export interface PaidJob<T extends object> {
  readonly tool: SpendTool;
  /** The model's short name as the ledger keeps it. */
  readonly model: string;
  /** Said first on the cost line: what was made (`flux-schnell`, `flash voice`, `sound effect, 5 s`). */
  readonly label: string;
  readonly ferret: string;
  readonly request: string;
  readonly cost: MicroUsd;
  readonly priced: PriceSource;
  /** The provider said in a sentence: `fal`, `ElevenLabs`. */
  readonly provider: string;
  /** What the owner is asked to pay for (`one picture`, `a voiceover`). */
  readonly what: string;
  /** What the owner reads under the ask: `Prompt` or `Text`, and the ferret's own words. */
  readonly promptLabel: string;
  readonly prompt: string;
  /** What to do instead when the owner declines. */
  readonly cheaper: string;
  readonly run: () => Promise<T | FalFailure>;
}

export type Paid<T extends object> =
  | {
      readonly ok: true;
      readonly value: T;
      /** `$0.03 (fal’s price; $0.05 of $5.00 spent today)`: for "paid for" in a sentence. */
      readonly paid: string;
      /** `flux-schnell · $0.03 · $0.05 of $5.00 today`: the line the ferret pastes first. */
      readonly costLine: string;
    }
  | { readonly ok: false; readonly answer: ToolAnswer };

const end = (answer: ToolAnswer): { readonly ok: false; readonly answer: ToolAnswer } => ({ ok: false, answer });

export async function paidCall<T extends object>(deps: PaidDeps, job: PaidJob<T>): Promise<Paid<T>> {
  const config = deps.config();
  const day = dayOf(deps.now(), config.timeZone);
  const facts = await deps.ledger.facts(day, job.request);
  const verdict = judgeSpend(job.cost, facts, config);
  if (verdict.kind === 'refuse') return end(refusal(`Not sent: ${verdict.sentence}`));
  if (verdict.kind === 'ask') {
    const approval = await approvalFor(deps.asks, {
      tool: job.tool,
      ferret: job.ferret,
      request: job.request,
      earlierSpends: facts.earlierSpends,
      cost: job.cost,
      model: job.model,
      what: job.what,
      threshold: verdict.threshold,
      promptLabel: job.promptLabel,
      prompt: job.prompt,
    });
    if (approval.kind === 'unavailable') return end(refusal(`Not sent: ${approval.sentence}.`));
    if (approval.kind === 'declined')
      return end(
        refusal(
          `Not sent: the owner declined to spend ${usdWords(job.cost)} on ${job.what}. ${job.cheaper} instead of the same request.`,
        ),
      );
    if (approval.kind === 'waiting')
      return end({
        text: `Not sent yet: ${job.what} costs ${usdWords(job.cost)}, over the owner's limit for one call, so an ask (${approval.ask}) is waiting for their approval. Nothing was spent. When they answer, call ${job.tool} again with exactly the same arguments.`,
      });
  }

  // Reserve the spend, then send. Only a definite no-charge gives the reservation back.
  const reservation: SpendRecord = {
    at: deps.now().toISOString(),
    day,
    tool: job.tool,
    model: job.model,
    ferret: job.ferret,
    microUsd: job.cost,
    priced: job.priced,
    request: job.request,
  };
  await deps.ledger.record(reservation);
  const made = await job.run();
  if (isFailure(made)) {
    if (made.noCharge === true) {
      await deps.ledger.refund(reservation);
      return end(failed(made));
    }
    return end(
      refusal(
        `Not made: ${made.sentence}. ${job.provider} may have billed it, so ${usdWords(job.cost)} still counts toward today's limit.`,
      ),
    );
  }
  const spentToday = facts.spentToday + job.cost;
  const dailyCap = usdWords(Math.round(config.limits.dailyUsd * 1_000_000));
  return {
    ok: true,
    value: made,
    costLine: `${job.label} · ${usdWords(job.cost)} · ${usdWords(spentToday)} of ${dailyCap} today`,
    paid: `${usdWords(job.cost)} (${job.priced === 'fal' ? 'fal’s price' : 'the listed price'}; ${usdWords(spentToday)} of ${dailyCap} spent today)`,
  };
}

// ─── fal's storage ───────────────────────────────────────────────────────────────────────────────────────────────

/** The longest file Create will take from fal's CDN, whatever the chat can show. */
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** fal's CDN, over https, and nothing else: the one place a made file is fetched from, with no key on the request. */
export function isFalCdn(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && host.endsWith('.fal.media')
    );
  } catch {
    return false;
  }
}

/** Why a made file was not taken: a sentence, and whether its host was refused (every retry is refused the same way). */
export interface Unfetched {
  readonly why: string;
  readonly hostRefused?: true;
}

/**
 * The answer when a made, PAID file could not be fetched. A refused host is the same on every retry and every retry is
 * charged again, so the ferret is told NOT to retry; any other failure keeps the "try again, charged again" line.
 */
export const unfetched = (noun: string, paid: string, got: Unfetched): ToolAnswer =>
  refusal(
    got.hostRefused === true
      ? `The ${noun} was made and paid for (${paid}), but it could not be fetched: ${got.why}. The result was paid for and could not be fetched. Do NOT retry: a retry would be charged again and be refused the same way. Tell the owner.`
      : `The ${noun} was made and paid for (${paid}), but ${got.why}. Nothing more was spent; try the same request again and it will be charged again.`,
  );

/** One file from fal's storage, of one of the `types` asked for, or why it was not taken. */
export async function download(
  fetcher: FetchPort,
  url: string,
  types: readonly string[],
  noun: 'picture' | 'sound',
): Promise<{ readonly bytes: Uint8Array; readonly type: string } | Unfetched> {
  if (!isFalCdn(url))
    return { why: `the ${noun} was not on fal’s own storage, so it was not fetched`, hostRefused: true };
  try {
    const response = await fetcher.request(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return { why: `fal’s storage answered ${response.status}` };
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD_BYTES) return { why: `the ${noun} is larger than Create will fetch` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return { why: 'fal’s storage sent an empty file' };
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) return { why: `the ${noun} is larger than Create will fetch` };
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!types.includes(type)) return { why: `what fal’s storage sent was not a ${noun}` };
    return { bytes, type };
  } catch {
    return { why: `the ${noun} could not be fetched from fal’s storage` };
  }
}

/** One line, no control characters, ≤ 200: what `alt:` takes. */
export const altOf = (text: string): string => {
  const line = text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
};

export const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;
