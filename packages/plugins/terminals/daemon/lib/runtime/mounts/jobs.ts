import { ferretOf } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  queryValue,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  JobAttachmentRegisterSchema,
  JobKeySchema,
  type JobAttachmentListView,
  type JobAttachmentView,
  type JobListView,
  type JobOutputView,
  type JobStartedBy,
  JobStartRequestSchema,
  type JobView,
} from '../../../../contract/index.ts';
import { parseBody, parseOptionalBody } from '../../api/body.ts';
import { z } from 'zod';

/**
 * The job keeper as the routes need it (declared here because the service is an adapter and a route may not import one).
 * The composition root answers it with every text — a command, the log — already masked inside one `Redaction.read`.
 */
export interface JobSubsystem {
  list(sessionId: string): Promise<JobListView>;
  start(
    sessionId: string,
    input: { readonly command: string; readonly cwd?: string; readonly name?: string },
    startedBy: JobStartedBy,
  ): Promise<JobView>;
  get(sessionId: string, key: string): Promise<JobView>;
  output(
    sessionId: string,
    key: string,
    request: { readonly from?: number; readonly tail?: number; readonly attachment?: string },
  ): Promise<JobOutputView>;
  stop(sessionId: string, key: string): Promise<JobView>;
  registerAttachment(
    sessionId: string,
    input: { readonly jobId: string; readonly pid: number; readonly claudeTaskId?: string },
  ): Promise<JobAttachmentView>;
  unregisterAttachment(sessionId: string, id: string): Promise<void>;
  listAttachments(sessionId: string): Promise<JobAttachmentListView>;
  detachAll(sessionId: string, jobKey?: string): Promise<number>;
}

const ferretParam = (call: CallContext): string => {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_session_id');
  return decoded;
};

/**
 * A ferret acts only on its OWN jobs: whatever credential a ferret holds, a path naming another ferret is refused. A person
 * (a device, the host's admin token) acts for any ferret, as for terminals — what a device may do is the `terminal` grant.
 */
function scoped(call: CallContext): { readonly ferret: string; readonly startedBy: JobStartedBy } {
  const ferret = ferretParam(call);
  const caller = ferretOf(call);
  if (caller !== undefined && caller !== ferret)
    throw new ApiError(403, 'a ferret acts on its own jobs only', 'forbidden');
  return { ferret, startedBy: caller === undefined ? { by: 'person' } : { by: 'agent', sessionId: caller } };
}

const jobKey = (call: CallContext): string => {
  const parsed = JobKeySchema.safeParse(decodeParameter(call.params.get('jobId') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'not a job name or id', 'invalid_job');
  return parsed.data;
};

const whole = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{1,15}$/u.test(value))
    throw new ApiError(400, `query parameter "${name}" must be a whole number`, 'invalid_query');
  return Number(value);
};

/** The routes this mount answers: named, so the composition's route table keeps every key (an index signature would drop them). */
export type JobRouteKey =
  | 'GET /v1/ferrets/:ferretId/jobs'
  | 'POST /v1/ferrets/:ferretId/jobs'
  | 'GET /v1/ferrets/:ferretId/jobs/:jobId'
  | 'GET /v1/ferrets/:ferretId/jobs/:jobId/output'
  | 'POST /v1/ferrets/:ferretId/jobs/:jobId/stop'
  | 'GET /v1/ferrets/:ferretId/job-attachments'
  | 'POST /v1/ferrets/:ferretId/job-attachments'
  | 'DELETE /v1/ferrets/:ferretId/job-attachments/:attachmentId'
  | 'POST /v1/ferrets/:ferretId/job-attachments/detach';

export function jobRouteHandlers(jobs: JobSubsystem): Readonly<Record<JobRouteKey, RouteHandler>> {
  return {
    'GET /v1/ferrets/:ferretId/jobs': async call => jsonResponse(await jobs.list(scoped(call).ferret)),
    'POST /v1/ferrets/:ferretId/jobs': async call => {
      const { ferret, startedBy } = scoped(call);
      const body = await parseBody(call.request, JobStartRequestSchema);
      return jsonResponse(
        await jobs.start(
          ferret,
          {
            command: body.command,
            ...(body.cwd === undefined ? {} : { cwd: body.cwd }),
            ...(body.name === undefined ? {} : { name: body.name }),
          },
          startedBy,
        ),
      );
    },
    'GET /v1/ferrets/:ferretId/jobs/:jobId': async call =>
      jsonResponse(await jobs.get(scoped(call).ferret, jobKey(call))),
    'GET /v1/ferrets/:ferretId/jobs/:jobId/output': async call => {
      const from = whole(queryValue(call.request, 'from'), 'from');
      const tail = whole(queryValue(call.request, 'tail'), 'tail');
      const attachment = queryValue(call.request, 'attachment');
      return jsonResponse(
        await jobs.output(scoped(call).ferret, jobKey(call), {
          ...(from === undefined ? {} : { from }),
          ...(tail === undefined ? {} : { tail }),
          ...(attachment === undefined ? {} : { attachment }),
        }),
      );
    },
    'POST /v1/ferrets/:ferretId/jobs/:jobId/stop': async call =>
      jsonResponse(await jobs.stop(scoped(call).ferret, jobKey(call))),
    'GET /v1/ferrets/:ferretId/job-attachments': async call =>
      jsonResponse(await jobs.listAttachments(scoped(call).ferret)),
    'POST /v1/ferrets/:ferretId/job-attachments': async call => {
      const body = await parseBody(call.request, JobAttachmentRegisterSchema);
      return jsonResponse(
        await jobs.registerAttachment(scoped(call).ferret, {
          jobId: body.jobId,
          pid: body.pid,
          ...(body.claudeTaskId === undefined ? {} : { claudeTaskId: body.claudeTaskId }),
        }),
      );
    },
    'DELETE /v1/ferrets/:ferretId/job-attachments/:attachmentId': async call => {
      const id = decodeParameter(call.params.get('attachmentId') ?? '');
      if (id === undefined || id === '') throw new ApiError(400, 'not an attachment id', 'invalid_attachment');
      await jobs.unregisterAttachment(scoped(call).ferret, id);
      return jsonResponse({ ok: true });
    },
    'POST /v1/ferrets/:ferretId/job-attachments/detach': async call => {
      const body = await parseOptionalBody(call.request, z.object({ jobId: JobKeySchema.optional() }));
      const detached = await jobs.detachAll(scoped(call).ferret, body?.jobId);
      return jsonResponse({ detached });
    },
  };
}
