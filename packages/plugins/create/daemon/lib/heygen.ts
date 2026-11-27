/**
 * HeyGen avatar video over `kernel.secrets.send`: the KERNEL places `HEYGEN_API_KEY` (as `x-api-key`), so this file never
 * holds it. `generate_avatar_video` and `avatar_video_status` are `generate_video` and `generation_status` for a talking
 * avatar: a video takes minutes, so it is two calls, and it stands under the SAME money steps as every creative tool
 * (`paid-call.ts`: the one daily cap, the ask over a limit, the reservation before the provider is called, one queue).
 *
 *   generate_avatar_video  price it from the table BEFORE sending → cap, ask, RESERVE → `POST api.heygen.com/v3/videos`
 *                          → keep the job (`avatar-jobs.jsonl`) → answer at once with a job id.
 *   avatar_video_status    ask HeyGen about the job → still being made (say so), or made (fetch the file from HeyGen's
 *                          storage with no key, hand it to the ferret's media folder, answer with the piece to paste), or failed.
 *
 * THE MONEY. Reserved at submit; given back only when the submit was refused with a definite no-charge (a 4xx). Every other
 * ending (a failed video, a result that cannot be fetched) stays counted and the ferret is told not to ask again: HeyGen
 * documents no refund Create can rely on, so money that may have been spent is money recorded. Checking never charges. The
 * reservation is an UPPER BOUND on the seconds (see `priceAvatarVideo`); once a made video's real length is read it is
 * SETTLED to that length (a refund of the difference, or a charge for any excess), after the job's end is written. The
 * order that matters is the one `generate_video` keeps: the reservation is written before HeyGen is called and a job's end
 * before anything else, so a crash can only OVER-count.
 *
 * Wire (HeyGen API reference, "Create Video" and "Get Video", v3; the v2/v1 endpoints were retired on 2026-10-31):
 * `POST /v3/videos` with `{ type: 'avatar', avatar_id, script, voice_id, aspect_ratio, resolution, engine }` answers
 * `{ data: { video_id, status } }`; `GET /v3/videos/{video_id}` answers `{ data: { id, status, video_url } }` with
 * `status` one of pending, processing, completed, failed. The engine is pinned so the reservation is that engine's price.
 */
import { randomBytes } from 'node:crypto';
import type { CredentialPlacement, FetchPort, SecretsPort, StatePort } from '@ferretry/kernel/contract';
import { MAX_MEDIA_BYTES } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import {
  AVATAR_ENGINE,
  AVATAR_JOBS,
  SPEND_LEDGER,
  type SpendRecord,
  type AvatarJobRecord,
  AVATAR_RESOLUTION,
  avatarCostOf,
  AvatarVideoStatusInputSchema,
  GenerateAvatarVideoInputSchema,
  HEYGEN_API_HOST,
  isHeygenCdn,
  priceAvatarVideo,
  usdWords,
} from '../../contract/index.ts';
import { downloadSlots } from './download-slots.ts';
import { answerOf, type FalFailure, type Provider } from './fal.ts';
import {
  altOf,
  type DeliverMedia,
  download,
  failed,
  paidCall,
  type PaidDeps,
  refusal,
  requestDigest,
  type Serial,
  type Store,
  type ToolAnswer,
} from './paid-call.ts';

const KEY_NAME = 'HEYGEN_API_KEY';
const PLACEMENT: CredentialPlacement = { header: 'x-api-key' };

const HEYGEN: Provider = {
  name: 'HeyGen',
  noKey:
    'avatar video is off: no HeyGen key. The owner adds one with `fy secret set HEYGEN_API_KEY`, then names it in create.yaml as `heygen: { key: ${secret:HEYGEN_API_KEY} }`',
};
const HEYGEN_STORE: Store = { name: 'HeyGen', allows: isHeygenCdn };

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const REPLY_BYTES = 256 * 1024;

const SubmitReplySchema = z.object({ data: z.object({ video_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u) }) });

/** `POST /v3/videos`: one avatar reading one script. HeyGen answers at once with the video's id; the video is made later. */
async function submitAvatar(
  secrets: SecretsPort,
  input: { script: string; avatar: string; voice: string; aspect: '16:9' | '9:16' },
): Promise<{ readonly videoId: string } | FalFailure> {
  const outcome = await secrets.send(
    KEY_NAME,
    {
      method: 'POST',
      url: `https://${HEYGEN_API_HOST}/v3/videos`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        type: 'avatar',
        avatar_id: input.avatar,
        script: input.script,
        voice_id: input.voice,
        aspect_ratio: input.aspect,
        resolution: AVATAR_RESOLUTION,
        engine: { type: AVATAR_ENGINE },
      }),
      timeoutMs: SUBMIT_TIMEOUT_MS,
      maxResponseBytes: REPLY_BYTES,
    },
    PLACEMENT,
  );
  const answer = answerOf(outcome, HEYGEN);
  if ('code' in answer) return answer;
  const parsed = SubmitReplySchema.safeParse(answer.payload);
  // HeyGen took it but said nothing Create can read it back by: it may be billed, so it stays counted.
  if (!parsed.success)
    return { code: 'unavailable', sentence: 'HeyGen queued the video but its answer could not be used' };
  return { videoId: parsed.data.data.video_id };
}

const StatusReplySchema = z.object({
  data: z.object({
    status: z.string().max(32),
    video_url: z.string().max(2048).nullish(),
    /** The length of the finished video, in seconds. A length that is 0 or unusable is no length (never a reason to reject the status). */
    duration: z.number().positive().max(86_400).nullish().catch(undefined),
    error: z.unknown().optional(),
  }),
});

type Poll =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'completed'; readonly url: string; readonly seconds: number | undefined }
  /** HeyGen ended it with no video, or has no such video any more: it may have been billed. */
  | { readonly kind: 'failed'; readonly sentence: string }
  /** A check that did not answer: never a verdict on the video. */
  | { readonly kind: 'retry'; readonly sentence: string };

/** `GET /v3/videos/{video_id}`: what HeyGen says of one video now. */
async function pollAvatar(secrets: SecretsPort, videoId: string): Promise<Poll> {
  const outcome = await secrets.send(
    KEY_NAME,
    {
      method: 'GET',
      url: `https://${HEYGEN_API_HOST}/v3/videos/${encodeURIComponent(videoId)}`,
      headers: { accept: 'application/json' },
      timeoutMs: POLL_TIMEOUT_MS,
      maxResponseBytes: REPLY_BYTES,
    },
    PLACEMENT,
  );
  if (outcome.kind === 'status' && outcome.status === 404)
    return { kind: 'failed', sentence: 'HeyGen does not know this video any more (it expired)' };
  const answer = answerOf(outcome, HEYGEN);
  if ('code' in answer) return { kind: 'retry', sentence: answer.sentence };
  const parsed = StatusReplySchema.safeParse(answer.payload);
  if (!parsed.success) return { kind: 'retry', sentence: 'HeyGen’s answer about the video could not be read' };
  const { status, video_url: url, duration } = parsed.data.data;
  if (status === 'pending' || status === 'waiting' || status === 'processing') return { kind: 'waiting' };
  if (status === 'failed') return { kind: 'failed', sentence: 'HeyGen could not make the video' };
  if (status !== 'completed') return { kind: 'retry', sentence: 'HeyGen’s answer about the video could not be read' };
  return typeof url === 'string' && url !== ''
    ? { kind: 'completed', url, seconds: duration ?? undefined }
    : { kind: 'failed', sentence: 'HeyGen’s finished answer held no video' };
}

// ─── the two tools ───────────────────────────────────────────────────────────────────────────────────────────────

export interface AvatarVideoDeps extends PaidDeps {
  readonly secrets: SecretsPort;
  readonly fetch: FetchPort;
  readonly state: StatePort;
  readonly deliver: DeliverMedia;
  readonly serial: Serial;
  /** A new job id's randomness: injectable so a test names its jobs. */
  readonly newJobId?: () => string;
}

type Submitted = Extract<AvatarJobRecord, { kind: 'submitted' }>;
type Finished = Extract<AvatarJobRecord, { kind: 'finished' }>;
interface Job {
  readonly submitted: Submitted;
  readonly finished?: Finished;
}

const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const VIDEO_EXTENSION: Readonly<Record<string, string>> = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const MAX_DOWNLOADS = 2;
const MAX_WAITING_DOWNLOADS = 2;
const VIDEO_DOWNLOAD = { maxBytes: MAX_MEDIA_BYTES, timeoutMs: 120_000 } as const;

const defaultJobId = (): string => `avt_${randomBytes(6).toString('hex')}`;

/** Every job the file holds: its `submitted` line and its `finished` line if it has one (the first one counts). */
async function loadJobs(state: StatePort): Promise<ReadonlyMap<string, Job>> {
  const { records } = await state.records(AVATAR_JOBS);
  const jobs = new Map<string, Job>();
  for (const record of records) {
    if (record.kind === 'submitted') jobs.set(record.job, { submitted: record });
    else {
      const job = jobs.get(record.job);
      if (job !== undefined && job.finished === undefined) jobs.set(record.job, { ...job, finished: record });
    }
  }
  return jobs;
}

/** The cost line a finished video is shown with: the settled cost once HeyGen reported the length, else what was reserved. */
const costLineOf = (job: Submitted, finished?: Finished): string =>
  finished?.settledMicroUsd === undefined || finished.seconds === undefined
    ? job.costLine
    : `${job.label} · ${usdWords(finished.settledMicroUsd)} (${Math.ceil(finished.seconds)} s made; ${usdWords(job.microUsd)} was held${overrunWords(finished)})`;

/** An overrun, said out loud wherever the cost is shown: it was spent already, so it is recorded and flagged, never asked. */
const overrunWords = (finished: Pick<Finished, 'overrunMicroUsd'>): string =>
  finished.overrunMicroUsd === undefined
    ? ''
    : `; an overrun of ${usdWords(finished.overrunMicroUsd)}: HeyGen billed past the upper bound, recorded and counted toward today’s limit`;

const pasteOf = (job: Submitted, where: string, costLine: string = job.costLine): string[] => [
  'Put these lines in your reply:',
  costLine,
  '```fy-render',
  'type: video',
  `alt: ${job.alt}`,
  `src: media:${where}`,
  '---',
  '```',
];

function generateAvatarVideo(deps: AvatarVideoDeps) {
  return (ferret: string, rawInput: unknown): Promise<ToolAnswer> =>
    deps.serial(async () => {
      const parsed = GenerateAvatarVideoInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return refusal(`The avatar video request is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
      const input = parsed.data;
      if (deps.config().heygen.key === undefined) return failed({ code: 'no_key', sentence: HEYGEN.noKey });

      const request = requestDigest('generate_avatar_video', {
        script: input.script,
        avatar: input.avatar,
        voice: input.voice,
        aspect: input.aspect,
      });
      // The same request made again while the first is still being made is that video, not a second one to pay for.
      const open = [...(await loadJobs(deps.state)).values()].find(
        job => job.finished === undefined && job.submitted.ferret === ferret && job.submitted.request === request,
      );
      if (open !== undefined)
        return {
          text: `That video is already being made as job ${open.submitted.job}, paid for once (${open.submitted.paid}). Nothing more was spent. Call avatar_video_status with job "${open.submitted.job}" to get it.`,
        };

      const priced = priceAvatarVideo(input.script);
      if (!priced.ok) return refusal(`${priced.why}.`);
      const label = `avatar video, ${input.aspect}`;
      const paid = await paidCall(deps, {
        tool: 'generate_avatar_video',
        model: 'avatar',
        label,
        ferret,
        request,
        cost: priced.microUsd,
        priced: priced.from,
        provider: 'HeyGen',
        what: 'one avatar video',
        promptLabel: 'Script',
        prompt: input.script,
        cheaper: 'Ask for a shorter script',
        run: () => submitAvatar(deps.secrets, input),
      });
      if (!paid.ok) return paid.answer;

      const job = (deps.newJobId ?? defaultJobId)();
      const record: Submitted = {
        kind: 'submitted',
        job,
        at: paid.reservation.at,
        day: paid.reservation.day,
        ferret,
        request,
        microUsd: priced.microUsd,
        heygenVideo: paid.value.videoId,
        costLine: paid.costLine,
        paid: paid.paid,
        alt: altOf(input.script),
        label,
      };
      try {
        await deps.state.append(AVATAR_JOBS, record);
      } catch {
        return refusal(
          `The video was queued and paid for (${paid.paid}), but the job could not be saved, so it cannot be fetched. ${usdWords(priced.microUsd)} still counts toward today's limit. Do NOT ask again: tell the owner.`,
        );
      }
      return {
        text: [
          `Queued one avatar video (${label}) as job ${job}, paid for now: ${paid.paid}.`,
          `It takes a few minutes. Call avatar_video_status with job "${job}" in about two minutes; checking is free and can be repeated until it is ready.`,
          'Do NOT call generate_avatar_video again for this video: that would be charged again.',
        ].join('\n'),
      };
    });
}

/** A job's end, written once. `undefined` when written; an answer to give when the write failed (nothing else was changed). */
async function closeJob(
  deps: AvatarVideoDeps,
  submitted: Submitted,
  ending: Omit<Finished, 'kind' | 'job' | 'at'>,
): Promise<ToolAnswer | undefined> {
  try {
    await deps.state.append(AVATAR_JOBS, {
      kind: 'finished',
      job: submitted.job,
      at: deps.now().toISOString(),
      ...ending,
    });
    return undefined;
  } catch {
    return refusal(
      `Job ${submitted.job} ended, but its end could not be saved, so nothing was changed. Call avatar_video_status again in a minute.`,
    );
  }
}

/** The digest the settlement line is kept under: its own, so a settled video never gives back or spends the REQUEST's approval. */
const settlementRequest = (job: Submitted): string => requestDigest('generate_avatar_video', { settles: job.job });

/**
 * Brings the reservation to what the made video really cost: `seconds` (as HeyGen reported them) at Avatar IV's per-second
 * rate. A smaller cost gives the difference back; a larger one (HeyGen made it longer than the upper bound) is already
 * spent, so it is recorded as a marked OVERRUN line that counts toward the daily cap and is reported in the job's result
 * (no approval is possible after the fact), so the ledger never undercounts or hides it. Written ONCE per job (a line
 * already kept for it is found and left), appended never rewritten. Without a reported length the reservation stands.
 * Answers what the job file keeps of it. A failing ledger read or write THROWS: the caller must not close the job then.
 */
async function settle(
  deps: AvatarVideoDeps,
  submitted: Submitted,
  seconds: number | undefined,
): Promise<
  { readonly seconds: number; readonly settledMicroUsd: number; readonly overrunMicroUsd?: number } | undefined
> {
  if (seconds === undefined) return undefined;
  const settledMicroUsd = avatarCostOf(seconds);
  const request = settlementRequest(submitted);
  const kept = (await deps.state.records(SPEND_LEDGER)).records.some(line => line.request === request);
  const difference = settledMicroUsd - submitted.microUsd;
  if (!kept && difference !== 0) {
    const line: SpendRecord = {
      at: submitted.at,
      day: submitted.day,
      tool: 'generate_avatar_video',
      model: 'avatar',
      ferret: submitted.ferret,
      microUsd: Math.abs(difference),
      priced: 'table',
      request,
    };
    if (difference < 0) await deps.ledger.refund(line);
    else await deps.ledger.record({ ...line, overrun: true });
  }
  return difference > 0 ? { seconds, settledMicroUsd, overrunMicroUsd: difference } : { seconds, settledMicroUsd };
}

/** A job that ended without a video stays counted (it may have been billed): its end is written, then said. */
async function endCounted(deps: AvatarVideoDeps, submitted: Submitted, sentence: string): Promise<ToolAnswer> {
  const notClosed = await closeJob(deps, submitted, { outcome: 'counted', sentence });
  if (notClosed !== undefined) return notClosed;
  return refusal(
    `Not made: ${sentence} Do not ask for it with generate_avatar_video unless the owner wants it tried again.`,
  );
}

/** What was paid, in a sentence: the settled cost when HeyGen reported the length, else what the reservation held. */
const paidOf = (
  job: Submitted,
  finished?: Pick<Finished, 'settledMicroUsd' | 'seconds' | 'overrunMicroUsd'>,
): string =>
  finished?.settledMicroUsd === undefined || finished.seconds === undefined
    ? job.paid
    : `${usdWords(finished.settledMicroUsd)} for ${Math.ceil(finished.seconds)} s at the listed price; ${usdWords(job.microUsd)} was held and the difference was settled${overrunWords(finished)}`;

const answerFinished = (submitted: Submitted, finished: Finished): ToolAnswer =>
  finished.outcome === 'delivered' && finished.where !== undefined
    ? {
        text: [
          `The avatar video is ready (job ${submitted.job}, ${submitted.label}), paid for once: ${paidOf(submitted, finished)}.`,
          ...pasteOf(submitted, finished.where, costLineOf(submitted, finished)),
        ].join('\n'),
      }
    : refusal(
        `Job ${submitted.job} ended without a video: ${finished.sentence ?? 'it was not made'}${settledWords(submitted, finished)}`,
      );

/** A video HeyGen made but that could not be delivered still cost what it cost: said with the settled cost (and any overrun). */
const settledWords = (
  job: Submitted,
  finished: Pick<Finished, 'settledMicroUsd' | 'seconds' | 'overrunMicroUsd'>,
): string =>
  finished.settledMicroUsd === undefined || finished.seconds === undefined ? '' : ` Billed: ${paidOf(job, finished)}.`;

/** A made video ready to be fetched: what the check found, handed on to the fetch that runs outside the shared queue. */
interface ToFetch {
  readonly submitted: Submitted;
  readonly url: string;
  readonly seconds: number | undefined;
}

/** THE CHECK IS SERIAL, THE DOWNLOAD IS NOT (as for `generation_status`): a two-minute fetch must not hold the other tools. */
function avatarVideoStatus(deps: AvatarVideoDeps) {
  const fetching = new Set<string>();
  const slots = downloadSlots(MAX_DOWNLOADS, MAX_WAITING_DOWNLOADS);
  const check = (ferret: string, rawInput: unknown): Promise<ToolAnswer | ToFetch> =>
    deps.serial(async (): Promise<ToolAnswer | ToFetch> => {
      const parsed = AvatarVideoStatusInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return refusal(`The status request is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
      const found = (await loadJobs(deps.state)).get(parsed.data.job);
      // A job is its ferret's own: another ferret's id is answered as if there were none.
      if (found === undefined || found.submitted.ferret !== ferret)
        return refusal(`There is no avatar video job ${parsed.data.job} for you. Nothing was spent by asking.`);
      const { submitted, finished } = found;
      if (finished !== undefined) return answerFinished(submitted, finished);
      if (fetching.has(submitted.job))
        return {
          text: `The video for job ${submitted.job} is being fetched right now. Nothing more was spent; call avatar_video_status again in a minute.`,
        };
      const poll = await pollAvatar(deps.secrets, submitted.heygenVideo);
      switch (poll.kind) {
        case 'retry':
          return {
            text: `Could not check job ${submitted.job} right now: ${poll.sentence}. The job is kept and nothing more was spent; call avatar_video_status again in a minute.`,
          };
        case 'waiting':
          return {
            text: `Job ${submitted.job} is being made. Nothing more was spent. Call avatar_video_status again in about a minute.`,
          };
        case 'failed':
          return await endCounted(
            deps,
            submitted,
            `${poll.sentence}. It may have been billed, so ${usdWords(submitted.microUsd)} still counts toward today’s limit.`,
          );
        case 'completed':
          fetching.add(submitted.job);
          return { submitted, url: poll.url, seconds: poll.seconds };
      }
    });

  return async (ferret: string, rawInput: unknown): Promise<ToolAnswer> => {
    const checked = await check(ferret, rawInput);
    if (!('submitted' in checked)) return checked;
    const { submitted } = checked;
    try {
      const placed = await slots.run(async () => {
        const got = await download(deps.fetch, checked.url, VIDEO_TYPES, 'video', VIDEO_DOWNLOAD, HEYGEN_STORE);
        return await deps.serial(async (): Promise<ToolAnswer> => {
          // HeyGen said the render completed, so what it cost is known whatever becomes of the delivery: settled FIRST (a refund,
          // or an OVERRUN line that counts toward the daily cap), so a failed fetch can never drop spend from the ledger. The
          // ledger line is idempotent, so a retry never writes it twice; one that cannot be written leaves the job OPEN (never
          // closed unsettled: a closed job is never settled again), so the next check retries it.
          const settlement = await settle(deps, submitted, checked.seconds).then(
            settled => ({ settled }),
            () => undefined,
          );
          if (settlement === undefined)
            return {
              text: `The video for job ${submitted.job} was made and paid for (${submitted.paid}), but its final cost could not be written to the ledger yet. Nothing more is charged for checking; call avatar_video_status again in a minute.`,
              isError: true,
            };
          if ('why' in got) {
            // A refused host or a file that is the wrong kind is the same on every retry: closed as counted. Anything else is read again, free.
            if (got.hostRefused === true || got.permanent === true) {
              const sentence = `The video was made and paid for, but it could not be fetched: ${got.why}.`;
              const notClosed = await closeJob(deps, submitted, {
                outcome: 'counted',
                sentence,
                ...settlement.settled,
              });
              if (notClosed !== undefined) return notClosed;
              return refusal(
                `Not made: ${sentence} It cost ${settlement.settled === undefined ? submitted.paid : paidOf(submitted, settlement.settled)}. Do NOT retry: a retry would be refused the same way, and generate_avatar_video again would be charged again. Tell the owner.`,
              );
            }
            return {
              text: `The video for job ${submitted.job} was made and paid for (${settlement.settled === undefined ? submitted.paid : paidOf(submitted, settlement.settled)}), but ${got.why}. Nothing more is charged for checking; call avatar_video_status again in a minute.`,
              isError: true,
            };
          }
          const name = `create-avatar-${submitted.job.slice(4)}.${VIDEO_EXTENSION[got.type] ?? 'mp4'}`;
          const where = await deps.deliver(ferret, name, got.bytes);
          if (where === undefined)
            return {
              text: `The video for job ${submitted.job} was made and paid for (${settlement.settled === undefined ? submitted.paid : paidOf(submitted, settlement.settled)}), but it could not be saved for you yet. Nothing more is charged for checking; call avatar_video_status again in a minute.`,
              isError: true,
            };
          const notClosed = await closeJob(deps, submitted, { outcome: 'delivered', where, ...settlement.settled });
          if (notClosed !== undefined) return notClosed;
          const finished: Finished = {
            kind: 'finished',
            job: submitted.job,
            at: deps.now().toISOString(),
            outcome: 'delivered',
            where,
            ...settlement.settled,
          };
          return {
            text: [
              `The avatar video is ready (job ${submitted.job}, ${submitted.label}), paid for: ${paidOf(submitted, finished)}.`,
              ...pasteOf(submitted, where, costLineOf(submitted, finished)),
            ].join('\n'),
          };
        });
      });
      return placed.ran
        ? placed.value
        : {
            text: `Too many videos are being fetched right now (job ${submitted.job} was not started). Nothing more was spent; call avatar_video_status again in a minute.`,
          };
    } finally {
      fetching.delete(submitted.job);
    }
  };
}

/** The two avatar video tools, each a ferret's call: the daemon names them. */
export function avatarVideoTools(deps: AvatarVideoDeps) {
  return { generate_avatar_video: generateAvatarVideo(deps), avatar_video_status: avatarVideoStatus(deps) };
}
