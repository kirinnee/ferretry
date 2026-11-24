/**
 * `generate_image`: price it, judge it, (ask), send it, record it, fetch the picture, hand it to the ferret. The order
 * is the contract and each step can only END the call or hand on to the next:
 *
 *   1. no key named in create.yaml → say so; nothing leaves the machine.
 *   2. price the call BEFORE sending (fal's price endpoint, else the table); a price in a unit we cannot read refuses.
 *   3. the money steps (cap, ask, reserve, refund) are `paid-call.ts`'s, shared by every creative tool.
 *   4. the picture is fetched and handed to the ferret's media folder; the answer is one piece to paste, cost first.
 */
import { createHash } from 'node:crypto';
import type { FetchPort, SecretsPort } from '@ferretry/kernel/contract';
import {
  DEFAULT_IMAGE_MODEL,
  GenerateImageInputSchema,
  IMAGE_MODELS,
  MAX_CHAT_IMAGE_BYTES,
  priceImage,
} from '../../contract/index.ts';
import { FAL, isFailure, readPrice, runImage } from './fal.ts';
import {
  altOf,
  type DeliverMedia,
  download,
  failed,
  kib,
  paidCall,
  type PaidDeps,
  refusal,
  requestDigest,
  type Serial,
  type ToolAnswer,
} from './paid-call.ts';

export interface GenerateImageDeps extends PaidDeps {
  readonly secrets: SecretsPort;
  readonly fetch: FetchPort;
  readonly deliver: DeliverMedia;
  readonly serial: Serial;
}

const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** One call at a time, with every other creative tool (see `serialQueue`). */
export function generateImageTool(deps: GenerateImageDeps) {
  return (ferret: string, rawInput: unknown): Promise<ToolAnswer> =>
    deps.serial(() => generate(deps, ferret, rawInput));
}

async function generate(deps: GenerateImageDeps, ferret: string, rawInput: unknown): Promise<ToolAnswer> {
  const parsed = GenerateImageInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return refusal(`The picture request is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
  const input = parsed.data;
  const config = deps.config();
  if (config.fal.key === undefined) return failed({ code: 'no_key', sentence: FAL.noKey });
  const model = IMAGE_MODELS[input.model ?? DEFAULT_IMAGE_MODEL];

  // The price, before anything is sent.
  const live = await readPrice(deps.secrets, model.endpoint);
  if (live !== undefined && isFailure(live)) return failed(live);
  const priced = priceImage(model, input.size, live);
  if (!priced.ok) return refusal(`${priced.why}.`);

  const paid = await paidCall(deps, {
    tool: 'generate_image',
    model: model.id,
    label: model.id,
    ferret,
    request: requestDigest('generate_image', { prompt: input.prompt, model: input.model, size: input.size }),
    cost: priced.microUsd,
    priced: priced.from,
    provider: 'fal',
    what: 'one picture',
    promptLabel: 'Prompt',
    prompt: input.prompt,
    cheaper: 'Ask for a cheaper one (a smaller size or flux-schnell)',
    run: () => runImage(deps.secrets, model.endpoint, input.prompt, input.size),
  });
  if (!paid.ok) return paid.answer;

  const got = await download(deps.fetch, paid.value.url, PICTURE_TYPES, 'picture');
  if (typeof got === 'string')
    return refusal(
      `The picture was made and paid for (${paid.paid}), but ${got}. Nothing more was spent; try the same request again and it will be charged again.`,
    );
  const name = `create-${model.id}-${createHash('sha256').update(got.bytes).digest('hex').slice(0, 8)}.${EXTENSION[got.type] ?? 'jpg'}`;
  const where = await deps.deliver(ferret, name, got.bytes);
  if (where === undefined)
    return refusal(
      `The picture was made and paid for (${paid.paid}), but it could not be saved for you. It was not kept.`,
    );

  // ONE piece to paste: the cost line, then the block. No ferret step stands between the picture and the chat.
  const shown =
    got.bytes.byteLength <= MAX_CHAT_IMAGE_BYTES
      ? [
          'Put these lines in your reply:',
          paid.costLine,
          '```fy-render',
          'type: image',
          `alt: ${altOf(input.prompt)}`,
          `src: media:${where}`,
          '---',
          '```',
        ]
      : [
          `It is ${kib(got.bytes.byteLength)}, over the 1 MB the chat shows, so there is no picture block. Put this line in your reply:`,
          paid.costLine,
          `The file is in your media folder as ${where}.`,
        ];
  return { text: [`Made one picture with ${model.id} for ${paid.paid}.`, ...shown].join('\n') };
}
