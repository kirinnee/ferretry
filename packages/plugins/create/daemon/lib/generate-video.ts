/**
 * `generate_video` and `generation_status`: a clip takes minutes, so it goes through fal's QUEUE and is two calls.
 *
 *   generate_video    price it BEFORE sending → the shared money steps (`paid-call.ts`: cap, ask, RESERVE) → put the
 *                     request in fal's queue → keep the job (`jobs.jsonl`) → answer at once with a job id.
 *   generation_status ask fal about the job → still waiting (say so), or made (fetch the file from fal's storage with no
 *                     key, hand it to the ferret's media folder, answer with the one piece to paste), or failed.
 *
 * THE MONEY. The spend is reserved at submit, as for every creative tool. The ONLY refund comes from the STATUS
 * endpoint's own error: fal's one statement on billing is "failed requests that return 5xx status codes are not billed"
 * (docs/documentation/model-apis/inference/reliability.md), so a job ended with an error_type of that class (a timeout,
 * a runner failure, an internal error), or with a bad_request (the 4xx "no charge" rule a submit already holds), is
 * REFUNDED. Every other ending (a cancel, a content-policy refusal, an error_type Create does not know, a result that
 * has expired, an answer without a video) stays counted, and the ferret is told not to ask again. A job whose status
 * says COMPLETED with no error succeeded and was billed: a failed READ of its result or its file is only a read that
 * failed. The job stays open and is read again on the next generation_status (free); after `MAX_UNREAD` failed reads it
 * is closed as counted ("made and paid for, could not be fetched, do NOT retry"). Checking a job never charges: the one
 * reservation is made once, at submit.
 *
 * A RESTART loses nothing. The job (fal's request id and the two queue addresses) is on disk before the answer, and
 * `generation_status` reads it from there. The order that matters is chosen so a crash can only OVER-count: the
 * reservation is written before fal is called; a job's end is written before its refund; so a crash between two steps
 * leaves money counted that may not have been spent, never the reverse. And the same request made again while its job
 * is still open is answered with that job, not queued a second time.
 */
import { randomBytes } from 'node:crypto';
import type { FetchPort, SecretsPort, StatePort } from '@ferretry/kernel/contract';
import { MAX_MEDIA_BYTES } from '@ferretry/core-ferrets/contract';
import {
  GenerateVideoInputSchema,
  GenerationStatusInputSchema,
  type JobRecord,
  priceVideo,
  type SpendRecord,
  usdWords,
  VIDEO_JOBS,
  VIDEO_MODELS,
  type VideoModel,
} from '../../contract/index.ts';
import { FAL, fetchQueuedResult, pollQueued, submitQueued } from './fal.ts';
import {
  altOf,
  type DeliverMedia,
  download,
  failed,
  falRate,
  paidCall,
  type PaidDeps,
  refusal,
  requestDigest,
  type Serial,
  type ToolAnswer,
} from './paid-call.ts';

export interface GenerateVideoDeps extends PaidDeps {
  readonly secrets: SecretsPort;
  readonly fetch: FetchPort;
  readonly state: StatePort;
  readonly deliver: DeliverMedia;
  readonly serial: Serial;
  /** A new job id's randomness: injectable so a test names its jobs. */
  readonly newJobId?: () => string;
}

type Submitted = Extract<JobRecord, { kind: 'submitted' }>;
type Finished = Extract<JobRecord, { kind: 'finished' }>;
interface Job {
  readonly submitted: Submitted;
  readonly finished?: Finished;
  /** How many reads of the made clip have failed so far. */
  readonly unread: number;
}

/** Failed reads of a made clip (its result, its file) after which the job is closed as counted rather than read forever. */
const MAX_UNREAD = 5;

const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const VIDEO_EXTENSION: Readonly<Record<string, string>> = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
/** A clip is a few MB to tens of MB, fetched with no key from fal's storage: more time than a picture is given. */
const VIDEO_DOWNLOAD = { maxBytes: MAX_MEDIA_BYTES, timeoutMs: 120_000 } as const;

const defaultJobId = (): string => `vid_${randomBytes(6).toString('hex')}`;

/** Every job the file holds: its `submitted` line, its failed reads, and its `finished` line if it has one (the first one counts). */
async function loadJobs(state: StatePort): Promise<ReadonlyMap<string, Job>> {
  const { records } = await state.records(VIDEO_JOBS);
  const jobs = new Map<string, Job>();
  for (const record of records) {
    if (record.kind === 'submitted') jobs.set(record.job, { submitted: record, unread: 0 });
    else {
      const job = jobs.get(record.job);
      if (job === undefined || job.finished !== undefined) continue;
      jobs.set(
        record.job,
        record.kind === 'unread' ? { ...job, unread: job.unread + 1 } : { ...job, finished: record },
      );
    }
  }
  return jobs;
}

/** The one line that gives a refused or failed job's reservation back: it repeats the reserved line (see `SpendRecord.refund`). */
const reservationOf = (job: Submitted): SpendRecord => ({
  at: job.at,
  day: job.day,
  tool: 'generate_video',
  model: job.model,
  ferret: job.ferret,
  microUsd: job.microUsd,
  priced: job.priced,
  request: job.request,
});

/** The request body fal takes, per model: every setting named, so no default of fal's can change the price. */
function bodyFor(
  model: VideoModel,
  input: { prompt: string; seconds: number; aspect: string; audio: boolean; resolution: string },
): object {
  return model.id === 'kling'
    ? {
        prompt: input.prompt,
        duration: String(input.seconds),
        aspect_ratio: input.aspect,
        generate_audio: input.audio,
        enable_safety_checker: true,
      }
    : {
        prompt: input.prompt,
        duration: `${input.seconds}s`,
        aspect_ratio: input.aspect,
        resolution: input.resolution,
        generate_audio: input.audio,
      };
}

/** The piece to paste: the cost line and the `fy-render` block that plays the clip. */
function pasteOf(job: Submitted, where: string): string[] {
  // A clip over the chat's bound is never delivered (download refuses it), so every delivered clip has a player block.
  return [
    'Put these lines in your reply:',
    job.costLine,
    '```fy-render',
    'type: video',
    `alt: ${job.alt}`,
    `src: media:${where}`,
    '---',
    '```',
  ];
}

function generateVideo(deps: GenerateVideoDeps) {
  return (ferret: string, rawInput: unknown): Promise<ToolAnswer> =>
    deps.serial(async () => {
      const parsed = GenerateVideoInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return refusal(`The video request is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
      const input = parsed.data;
      const model = VIDEO_MODELS[input.model];
      const seconds = input.seconds ?? model.defaultSeconds;
      if (!model.seconds.includes(seconds))
        return refusal(`${model.id} makes a clip of ${model.seconds.join(', ')} seconds, not ${seconds}.`);
      if (!model.aspects.includes(input.aspect))
        return refusal(`${model.id} makes ${model.aspects.join(', ')} clips, not ${input.aspect}.`);
      if (input.resolution !== undefined && !model.resolutions.includes(input.resolution))
        return refusal(
          `${model.id} ${model.resolutions.length === 0 ? 'has one resolution; leave resolution out' : `makes ${model.resolutions.join(' or ')}, not ${input.resolution}`}.`,
        );
      const resolution = input.resolution ?? model.resolutions[0] ?? '';
      if (deps.config().fal.key === undefined) return failed({ code: 'no_key', sentence: FAL.noKey });

      const request = requestDigest('generate_video', {
        prompt: input.prompt,
        model: model.id,
        seconds,
        aspect: input.aspect,
        resolution,
        audio: input.audio,
      });
      // The same words made again while the first is still being made is that clip, not a second one to pay for.
      const open = [...(await loadJobs(deps.state)).values()].find(
        job => job.finished === undefined && job.submitted.ferret === ferret && job.submitted.request === request,
      );
      if (open !== undefined)
        return {
          text: `That clip is already being made as job ${open.submitted.job}, paid for once (${open.submitted.paid}). Nothing more was spent. Call generation_status with job "${open.submitted.job}" to get it.`,
        };

      const rate = await falRate(deps.secrets, model.endpoint);
      if (rate.kind === 'end') return rate.answer;
      const priced = priceVideo(model, seconds, input.audio, rate.live);
      if (!priced.ok) return refusal(`${priced.why}.`);

      const label = `${model.id}, ${seconds} s${input.audio ? ', with sound' : ''}`;
      const paid = await paidCall(deps, {
        tool: 'generate_video',
        model: model.id,
        label,
        ferret,
        request,
        cost: priced.microUsd,
        priced: priced.from,
        provider: 'fal',
        what: 'one video clip',
        promptLabel: 'Prompt',
        prompt: input.prompt,
        cheaper: 'Ask for a shorter clip, or one with no sound',
        run: () => submitQueued(deps.secrets, model.endpoint, bodyFor(model, { ...input, seconds, resolution })),
      });
      if (!paid.ok) return paid.answer;

      const job = (deps.newJobId ?? defaultJobId)();
      const record: Submitted = {
        kind: 'submitted',
        job,
        at: paid.reservation.at,
        // The reservation's own day and moment: a refund later cancels exactly that line.
        day: paid.reservation.day,
        ferret,
        model: model.id,
        request,
        microUsd: priced.microUsd,
        priced: priced.from,
        falRequest: paid.value.requestId,
        statusUrl: paid.value.statusUrl,
        resultUrl: paid.value.resultUrl,
        costLine: paid.costLine,
        paid: paid.paid,
        alt: altOf(input.prompt),
        label,
      };
      try {
        await deps.state.append(VIDEO_JOBS, record);
      } catch {
        return refusal(
          `The clip was queued and paid for (${paid.paid}), but the job could not be saved, so it cannot be fetched. ${usdWords(priced.microUsd)} still counts toward today's limit. Do NOT ask again: tell the owner.`,
        );
      }
      return {
        text: [
          `Queued one video clip (${label}) as job ${job}, paid for now: ${paid.paid}.`,
          `It takes a few minutes. Call generation_status with job "${job}" in about two minutes; checking is free and can be repeated until it is ready.`,
          'Do NOT call generate_video again for this clip: that would be charged again.',
        ].join('\n'),
      };
    });
}

function generationStatus(deps: GenerateVideoDeps) {
  return (ferret: string, rawInput: unknown): Promise<ToolAnswer> =>
    deps.serial(async () => {
      const parsed = GenerationStatusInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return refusal(`The status request is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
      const found = (await loadJobs(deps.state)).get(parsed.data.job);
      // A job is its ferret's own: another ferret's id is answered as if there were none.
      if (found === undefined || found.submitted.ferret !== ferret)
        return refusal(`There is no video job ${parsed.data.job} for you. Nothing was spent by asking.`);
      const { submitted, finished } = found;

      if (finished !== undefined) return answerFinished(submitted, finished);

      const poll = await pollQueued(deps.secrets, submitted.statusUrl);
      switch (poll.kind) {
        case 'retry':
          return {
            text: `Could not check job ${submitted.job} right now: ${poll.sentence}. The job is kept and nothing more was spent; call generation_status again in a minute.`,
          };
        case 'waiting':
          return {
            text: `Job ${submitted.job} is ${poll.status === 'IN_QUEUE' ? `waiting in fal's queue${poll.position === undefined ? '' : ` (${poll.position} ahead)`}` : 'being made'}. Nothing more was spent. Call generation_status again in about a minute.`,
          };
        case 'gone':
          return await end(deps, submitted, 'counted', {
            sentence: `fal does not know job ${submitted.job} any more (it expired), so the clip cannot be fetched. It may have been billed, so ${usdWords(submitted.microUsd)} still counts toward today's limit.`,
          });
        case 'failed':
          return await end(deps, submitted, poll.refund ? 'refunded' : 'counted', {
            sentence: poll.refund
              ? poll.sentence
              : `${poll.sentence}. fal may have billed it, so ${usdWords(submitted.microUsd)} still counts toward today's limit.`,
          });
        case 'completed':
          break;
      }

      const result = await fetchQueuedResult(deps.secrets, submitted.resultUrl);
      switch (result.kind) {
        case 'retry':
          // fal said the clip is made: it was billed. A result that will not read is a failed read, never a refund.
          return (
            (await unreadAndGiveUp(deps, submitted, found.unread, result.sentence)) ?? {
              text: `The clip for job ${submitted.job} is made and paid for (${submitted.paid}), but fal's result could not be read yet: ${result.sentence}. Nothing more was spent; call generation_status again in a minute.`,
              isError: true,
            }
          );
        case 'lost':
          return await end(deps, submitted, 'counted', {
            sentence: `${result.sentence}. It may have been billed, so ${usdWords(submitted.microUsd)} still counts toward today's limit.`,
          });
        case 'video':
          break;
      }

      const got = await download(deps.fetch, result.url, VIDEO_TYPES, 'video', VIDEO_DOWNLOAD);
      if ('why' in got) {
        if (got.hostRefused === true || got.permanent === true)
          return await end(deps, submitted, 'counted', { sentence: unfetchedSentence(submitted, got.why) });
        return (
          (await unreadAndGiveUp(deps, submitted, found.unread, got.why)) ?? {
            text: `The clip for job ${submitted.job} was made and paid for (${submitted.paid}), but ${got.why}. Nothing more is charged for checking; call generation_status again in a minute.`,
            isError: true,
          }
        );
      }
      const name = `create-video-${submitted.model}-${submitted.job.slice(4)}.${VIDEO_EXTENSION[got.type] ?? 'mp4'}`;
      const where = await deps.deliver(ferret, name, got.bytes);
      if (where === undefined)
        return {
          text: `The clip for job ${submitted.job} was made and paid for (${submitted.paid}), but it could not be saved for you yet. Nothing more is charged for checking; call generation_status again in a minute.`,
          isError: true,
        };
      const done = await closeJob(deps, submitted, { outcome: 'delivered', where, bytes: got.bytes.byteLength });
      if (done !== undefined) return done;
      return {
        text: [
          `The video clip is ready (job ${submitted.job}, ${submitted.label}), paid for: ${submitted.paid}.`,
          ...pasteOf(submitted, where),
        ].join('\n'),
      };
    });
}

const unfetchedSentence = (submitted: Submitted, why: string): string =>
  `The clip was made and paid for (${submitted.paid}), but it could not be fetched: ${why}. The result was paid for and could not be fetched. Do NOT retry: a retry would be refused the same way, and generate_video again would be charged again. Tell the owner.`;

/**
 * A read of a made clip failed. It is written down; the `MAX_UNREAD`-th failure closes the job as counted (the answer to
 * give), an earlier one leaves it open (`undefined`: the caller says "ask again", for free).
 */
async function unreadAndGiveUp(
  deps: GenerateVideoDeps,
  submitted: Submitted,
  before: number,
  why: string,
): Promise<ToolAnswer | undefined> {
  if (before + 1 >= MAX_UNREAD)
    return await end(deps, submitted, 'counted', {
      sentence: unfetchedSentence(submitted, `${why} (it failed ${MAX_UNREAD} times)`),
    });
  try {
    await deps.state.append(VIDEO_JOBS, { kind: 'unread', job: submitted.job, at: deps.now().toISOString() });
  } catch {
    // The count is only a bound: a failed write leaves it where it was, and the job is still read again.
  }
  return undefined;
}

/** Writes a job's end. `undefined` when it was written; an answer to give when it could not be (nothing was refunded). */
async function closeJob(
  deps: GenerateVideoDeps,
  submitted: Submitted,
  end: Omit<Finished, 'kind' | 'job' | 'at'>,
): Promise<ToolAnswer | undefined> {
  try {
    await deps.state.append(VIDEO_JOBS, {
      kind: 'finished',
      job: submitted.job,
      at: deps.now().toISOString(),
      ...end,
    });
    return undefined;
  } catch {
    return refusal(
      `Job ${submitted.job} ended, but its end could not be saved, so nothing was changed. Call generation_status again in a minute.`,
    );
  }
}

/** A job that ended without a clip: its end first, then (only for a failure fal does not bill) the refund, so a crash can only over-count. */
async function end(
  deps: GenerateVideoDeps,
  submitted: Submitted,
  outcome: 'refunded' | 'counted',
  said: { readonly sentence: string },
): Promise<ToolAnswer> {
  const sentence =
    outcome === 'refunded'
      ? `${said.sentence}. fal does not bill a request that fails this way, so ${usdWords(submitted.microUsd)} was given back.`
      : said.sentence;
  const failedToClose = await closeJob(deps, submitted, { outcome, sentence });
  if (failedToClose !== undefined) return failedToClose;
  if (outcome === 'refunded') await deps.ledger.refund(reservationOf(submitted));
  return refusal(`Not made: ${sentence} Do not ask for it with generate_video unless the owner wants it tried again.`);
}

/** What a job that ended says, every time it is asked about: never a new charge, never a new fetch. */
function answerFinished(submitted: Submitted, finished: Finished): ToolAnswer {
  if (finished.outcome === 'delivered' && finished.where !== undefined)
    return {
      text: [
        `The video clip is ready (job ${submitted.job}, ${submitted.label}), paid for once: ${submitted.paid}.`,
        ...pasteOf(submitted, finished.where),
      ].join('\n'),
    };
  return refusal(`Job ${submitted.job} ended without a clip: ${finished.sentence ?? 'it was not made'}`);
}

/** The two video tools, each a ferret's call: the daemon names them. */
export function generateVideoTools(deps: GenerateVideoDeps) {
  return { generate_video: generateVideo(deps), generation_status: generationStatus(deps) };
}
