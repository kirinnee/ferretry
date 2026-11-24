/**
 * fal over `kernel.secrets.send`: the KERNEL places `FAL_KEY` on the request, so this file never holds it (docs/secrets.md,
 * "A plugin's own key, placed by the kernel"). It builds the two requests Create makes, and says what came back in
 * words and a code; no branch returns the request, a header or a body fal sent that was not asked for.
 *
 * fal wants `Authorization: Key <key>` (https://fal.ai/docs/documentation/model-apis/authentication), so the placement
 * is `{ header: 'authorization', scheme: 'Key' }`. Both hosts are named exactly in the manifest's `permissions.network`.
 */
import type { CredentialPlacement, OutboundSecretOutcome, SecretsPort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { ImageSizeId, LiveRate } from '../../contract/index.ts';
import { IMAGE_SIZES } from '../../contract/index.ts';

const FAL_KEY_NAME = 'FAL_KEY';
const FAL_RUN_HOST = 'fal.run';
const FAL_API_HOST = 'api.fal.ai';

const PLACEMENT: CredentialPlacement = { header: 'authorization', scheme: 'Key' };

/** The price read is a tiny JSON; the picture's JSON is a few links. Both stay far under the kernel's own bound. */
const PRICE_BYTES = 64 * 1024;
const RUN_BYTES = 1024 * 1024;
const PRICE_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 90_000;

/** Why a fal call did not give an answer, in the owner's words: a code for a branch, a sentence to say. */
export type FalFailure =
  | { readonly code: 'no_key'; readonly sentence: string }
  | { readonly code: 'rejected'; readonly sentence: string }
  | { readonly code: 'unavailable'; readonly sentence: string };

const NO_KEY =
  'creative tools are off: no fal key. The owner adds one with `fy secret set FAL_KEY`, then names it in create.yaml as `fal: { key: ${secret:FAL_KEY} }`.';

/** The kernel's outcome as what fal answered (a completion's payload) or as one of three failures. */
function answerOf(outcome: OutboundSecretOutcome): { readonly payload: unknown } | FalFailure {
  switch (outcome.kind) {
    case 'completion':
      return { payload: outcome.payload };
    case 'refused':
      return outcome.refused === 'destination' || outcome.refused === 'placement'
        ? { code: 'unavailable', sentence: 'the request to fal was refused before it was sent' }
        : { code: 'no_key', sentence: NO_KEY };
    case 'vault_damaged':
      return {
        code: 'unavailable',
        sentence: 'the secret store could not be opened, so the fal key could not be used',
      };
    case 'status':
      if (outcome.status === 401 || outcome.status === 403)
        return { code: 'rejected', sentence: 'fal refused the key (is it valid, and is there credit on the account?)' };
      if (outcome.status === 429)
        return { code: 'unavailable', sentence: 'fal says too many requests; try again in a minute' };
      return { code: 'unavailable', sentence: `fal answered ${outcome.status}` };
    case 'timeout':
      return { code: 'unavailable', sentence: 'fal did not answer in time' };
    case 'network':
      return { code: 'unavailable', sentence: 'fal could not be reached' };
    case 'too_large':
    case 'unreadable':
      return { code: 'unavailable', sentence: 'fal answered something Create could not read' };
  }
}

const PriceReplySchema = z.object({
  prices: z.array(
    z.object({ endpoint_id: z.string(), unit_price: z.number().nonnegative(), unit: z.string().max(40) }),
  ),
});

/** What fal says one endpoint costs: a rate and its unit, `undefined` when it names none, or a failure. */
export async function readPrice(secrets: SecretsPort, endpoint: string): Promise<LiveRate | FalFailure | undefined> {
  const outcome = await secrets.send(
    FAL_KEY_NAME,
    {
      method: 'GET',
      url: `https://${FAL_API_HOST}/v1/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`,
      headers: { accept: 'application/json' },
      timeoutMs: PRICE_TIMEOUT_MS,
      maxResponseBytes: PRICE_BYTES,
    },
    PLACEMENT,
  );
  const answer = answerOf(outcome);
  // A key problem is the caller's to hear about; any other failure just means "ask the table".
  if ('code' in answer) return answer.code === 'unavailable' ? undefined : answer;
  const parsed = PriceReplySchema.safeParse(answer.payload);
  const row = parsed.success ? parsed.data.prices.find(price => price.endpoint_id === endpoint) : undefined;
  return row === undefined ? undefined : { unitPrice: row.unit_price, unit: row.unit };
}

const RunReplySchema = z.object({
  images: z.array(z.object({ url: z.string().max(2048) })).min(1),
});

export interface FalImage {
  readonly url: string;
}

/** One synchronous run of an image endpoint (`POST fal.run/<endpoint>`): the link to the picture it made. */
export async function runImage(
  secrets: SecretsPort,
  endpoint: string,
  prompt: string,
  size: ImageSizeId,
): Promise<FalImage | FalFailure> {
  const { width, height } = IMAGE_SIZES[size];
  const outcome = await secrets.send(
    FAL_KEY_NAME,
    {
      method: 'POST',
      url: `https://${FAL_RUN_HOST}/${endpoint}`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        prompt,
        image_size: { width, height },
        num_images: 1,
        output_format: 'jpeg',
        enable_safety_checker: true,
      }),
      timeoutMs: RUN_TIMEOUT_MS,
      maxResponseBytes: RUN_BYTES,
    },
    PLACEMENT,
  );
  const answer = answerOf(outcome);
  if ('code' in answer) return answer;
  const parsed = RunReplySchema.safeParse(answer.payload);
  if (!parsed.success) return { code: 'unavailable', sentence: 'fal made no picture (its answer held none)' };
  return { url: parsed.data.images[0]!.url };
}

/** A failure carries a `code`; a rate and a picture's link never do. */
export const isFailure = (value: object): value is FalFailure => 'code' in value;
