/**
 * `generate_image`: price it, judge it, (ask), send it, record it, fetch the picture, hand it to the ferret. The order
 * is the contract and each step can only END the call or hand on to the next:
 *
 *   1. no key named in create.yaml → say so; nothing leaves the machine.
 *   2. price the call BEFORE sending (fal's price endpoint, else the table); a price in a unit we cannot read refuses.
 *   3. the daily cap refuses; a call over the ask threshold raises an ask and waits for the owner (nothing is sent).
 *   4. only then fal is called, and the spend is written to the ledger the moment fal answers with a picture, before
 *      the picture is even downloaded: money spent is money recorded, whatever happens next.
 *
 * The whole call runs one at a time, so two ferrets asking together cannot both pass the same day's cap.
 */
import { createHash } from 'node:crypto';
import type { FetchPort, SecretsPort } from '@ferretry/kernel/contract';
import {
  type CreateConfig,
  DEFAULT_IMAGE_MODEL,
  GenerateImageInputSchema,
  IMAGE_MODELS,
  MAX_CHAT_IMAGE_BYTES,
  priceImage,
  usdWords,
} from '../../contract/index.ts';
import { type FalFailure, isFailure, readPrice, runImage } from './fal.ts';
import { approvalFor, dayOf, judgeSpend, requestDigest, type SpendAsks, type SpendLedger } from './spend.ts';

export interface ToolAnswer {
  readonly text: string;
  readonly isError?: boolean;
}

/** Hands a made picture to a ferret and says where it is, or `undefined` when it could not be placed. */
export type DeliverPicture = (ferret: string, name: string, bytes: Uint8Array) => Promise<string | undefined>;

export interface GenerateImageDeps {
  readonly secrets: SecretsPort;
  readonly fetch: FetchPort;
  readonly config: () => CreateConfig;
  readonly ledger: SpendLedger;
  readonly asks: SpendAsks;
  readonly now: () => Date;
  readonly deliver: DeliverPicture;
}

/** The longest picture Create will take from fal's CDN, whatever the chat can show. */
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const refusal = (text: string): ToolAnswer => ({ text, isError: true });
const failed = (failure: FalFailure): ToolAnswer => refusal(`Not made: ${failure.sentence}.`);

const EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** fal's CDN, over https, and nothing else: the one place a picture is fetched from, with no key on the request. */
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

async function download(
  fetcher: FetchPort,
  url: string,
): Promise<{ readonly bytes: Uint8Array; readonly type: string } | string> {
  if (!isFalCdn(url)) return 'the picture was not on fal’s own storage, so it was not fetched';
  try {
    const response = await fetcher.request(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return `fal’s storage answered ${response.status}`;
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD_BYTES) return 'the picture is larger than Create will fetch';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return 'fal’s storage sent an empty file';
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) return 'the picture is larger than Create will fetch';
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!PICTURE_TYPES.includes(type)) return 'what fal’s storage sent was not a picture';
    return { bytes, type };
  } catch {
    return 'the picture could not be fetched from fal’s storage';
  }
}

/** One line, no control characters, ≤ 200: what `alt:` takes. */
const altOf = (prompt: string): string => {
  const line = prompt
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
};

const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** A shell word: single quotes, so a path with a space or a quote still copies. */
const quoted = (text: string): string => `'${text.replace(/'/gu, `'\\''`)}'`;

export function generateImageTool(deps: GenerateImageDeps) {
  // One call at a time: a chain, so a failure never blocks the next call.
  let running: Promise<unknown> = Promise.resolve();
  return async (ferret: string, rawInput: unknown): Promise<ToolAnswer> => {
    // `running` never rejects (it holds the previous call's end, caught), so one handler is enough.
    const turn = running.then(() => generate(deps, ferret, rawInput));
    running = turn.catch(() => undefined);
    return await turn;
  };
}

async function generate(deps: GenerateImageDeps, ferret: string, rawInput: unknown): Promise<ToolAnswer> {
  const parsed = GenerateImageInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return refusal(`The picture request is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
  const input = parsed.data;
  const config = deps.config();
  if (config.fal.key === undefined) return failed({ code: 'no_key', sentence: NO_KEY_SENTENCE });
  const model = IMAGE_MODELS[input.model ?? DEFAULT_IMAGE_MODEL];

  // 2. the price, before anything is sent.
  const live = await readPrice(deps.secrets, model.endpoint);
  if (live !== undefined && isFailure(live)) return failed(live);
  const priced = priceImage(model, input.size, live);
  if (!priced.ok) return refusal(`${priced.why}.`);
  const cost = priced.microUsd;

  // 3. the limits.
  const request = requestDigest(input);
  const day = dayOf(deps.now(), config.timeZone);
  const facts = await deps.ledger.facts(day, request);
  const verdict = judgeSpend(cost, facts, config);
  if (verdict.kind === 'refuse') return refusal(`Not sent: ${verdict.sentence}`);
  if (verdict.kind === 'ask') {
    const approval = await approvalFor(deps.asks, {
      ferret,
      request,
      earlierSpends: facts.earlierSpends,
      cost,
      model: model.id,
      threshold: verdict.threshold,
      prompt: input.prompt,
    });
    if (approval.kind === 'unavailable') return refusal(`Not sent: ${approval.sentence}.`);
    if (approval.kind === 'declined')
      return refusal(
        `Not sent: the owner declined to spend ${usdWords(cost)} on this picture. Ask for a cheaper one (a smaller size or flux-schnell) instead of the same request.`,
      );
    if (approval.kind === 'waiting')
      return {
        text: `Not sent yet: this picture costs ${usdWords(cost)}, over the owner's limit for one call, so an ask (${approval.ask}) is waiting for their approval. Nothing was spent. When they answer, call generate_image again with exactly the same prompt, model and size.`,
      };
  }

  // 4. send, then record the spend the moment a picture exists.
  const made = await runImage(deps.secrets, model.endpoint, input.prompt, input.size);
  if (isFailure(made)) return failed(made);
  await deps.ledger.record({
    at: deps.now().toISOString(),
    day,
    tool: 'generate_image',
    model: model.id,
    ferret,
    microUsd: cost,
    priced: priced.from,
    request,
  });
  const spentToday = facts.spentToday + cost;
  const paid = `${usdWords(cost)} (${priced.from === 'fal' ? 'fal’s price' : 'the listed price'}; ${usdWords(spentToday)} of ${usdWords(Math.round(config.limits.dailyUsd * 1_000_000))} spent today)`;

  const got = await download(deps.fetch, made.url);
  if (typeof got === 'string')
    return refusal(
      `The picture was made and paid for (${paid}), but ${got}. Nothing more was spent; try the same request again and it will be charged again.`,
    );
  const name = `create-${model.id}-${createHash('sha256').update(got.bytes).digest('hex').slice(0, 8)}.${EXTENSION[got.type] ?? 'jpg'}`;
  const where = await deps.deliver(ferret, name, got.bytes);
  if (where === undefined)
    return refusal(`The picture was made and paid for (${paid}), but it could not be saved for you. It was not kept.`);

  const shown =
    got.bytes.byteLength <= MAX_CHAT_IMAGE_BYTES
      ? [
          'To show it in the chat, copy it into your media folder, then put this block in your reply:',
          `cp ${quoted(where)} "$FY_MEDIA_DIR/${name}"`,
          '```fy-render',
          'type: image',
          `alt: ${altOf(input.prompt)}`,
          `src: media:${name}`,
          '---',
          '```',
        ]
      : [
          `It is ${kib(got.bytes.byteLength)}, over the 1 MB the chat shows, so give the person its path instead of a block.`,
        ];
  return {
    text: [
      `Made one picture with ${model.id} for ${paid}.`,
      `Saved: ${where} (${kib(got.bytes.byteLength)})`,
      ...shown,
    ].join('\n'),
  };
}

const NO_KEY_SENTENCE =
  'creative tools are off: no fal key. The owner adds one with `fy secret set FAL_KEY`, then names it in create.yaml as `fal: { key: ${secret:FAL_KEY} }`';
