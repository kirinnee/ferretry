/**
 * The app's half of the input bridge: read a ferret's open requests, deliver one, cancel one.
 *
 * Every call goes through the machine's plugin client by the manifest's route key, and nothing is cached at module
 * scope: a request belongs to one machine's ferret. The deliver body is the only place a value travels, padded, and
 * this module never keeps it.
 */
import { z } from 'zod';
import type { VaultClient } from '../shell.tsx';
import {
  type InputDeliverAnswer,
  InputDeliverAnswerSchema,
  type InputDeliverBodyView,
  InputRequestListViewSchema,
  type InputRequestView,
  InputRequestViewSchema,
} from './input-wire.ts';

const LIST_ROUTE = 'GET /v1/ferrets/:ferretId/input-requests';
const DELIVER_ROUTE = 'POST /v1/ferrets/:ferretId/input-requests/:requestId/deliver';
const CANCEL_ROUTE = 'POST /v1/ferrets/:ferretId/input-requests/:requestId/cancel';

/** A listed request this build can read, or one it cannot (a newer daemon's), kept apart so the owner is told to update. */
export type ListedRequest =
  | { readonly kind: 'open'; readonly request: InputRequestView }
  | { readonly kind: 'unreadable'; readonly id: string | undefined };

/** A ferret's open requests; each is read on its own, so one card this build cannot parse never fails the others. */
export async function listInputRequests(client: VaultClient, ferretId: string): Promise<readonly ListedRequest[]> {
  const { requests } = InputRequestListViewSchema.parse(await client.call(LIST_ROUTE, { params: { ferretId } }));
  return requests.map((each): ListedRequest => {
    const parsed = InputRequestViewSchema.safeParse(each);
    if (parsed.success) return { kind: 'open', request: parsed.data };
    const id = z.looseObject({ id: z.string() }).safeParse(each);
    return { kind: 'unreadable', id: id.success ? id.data.id : undefined };
  });
}

type Ids = Pick<InputRequestView, 'id' | 'sessionId'>;

export async function deliverInput(
  client: VaultClient,
  request: Ids,
  body: InputDeliverBodyView,
): Promise<InputDeliverAnswer> {
  return InputDeliverAnswerSchema.parse(
    await client.call(DELIVER_ROUTE, { params: { ferretId: request.sessionId, requestId: request.id }, body }),
  );
}

export async function cancelInput(client: VaultClient, request: Ids): Promise<void> {
  await client.call(CANCEL_ROUTE, { params: { ferretId: request.sessionId, requestId: request.id }, body: {} });
}
