import { callDaemon, type DaemonCaller } from '../../shell.ts';
import type { InputGateway } from './ports.ts';
import {
  type InputDeliverAnswer,
  InputDeliverAnswerSchema,
  type InputDeliverBodyView,
  type InputRequestListView,
  InputRequestListViewSchema,
  type InputRequestView,
  InputRequestViewSchema,
} from './wire.ts';

/** The manifest's route keys for one ferret's input requests (docs/input-requests.md). */
const LIST_ROUTE = 'GET /v1/ferrets/:ferretId/input-requests';
const DELIVER_ROUTE = 'POST /v1/ferrets/:ferretId/input-requests/:requestId/deliver';
const CANCEL_ROUTE = 'POST /v1/ferrets/:ferretId/input-requests/:requestId/cancel';

/**
 * Speaks the input routes as the person at this machine, through the plugin's generated client (which never sends a
 * ferret's credential): answering an input request is the owner's. Replies are parsed, never cast; none has a field for
 * a value, and nothing here logs a body.
 */
export class RouteInputGateway implements InputGateway {
  constructor(private readonly client: DaemonCaller) {}

  async list(sessionId: string): Promise<InputRequestListView> {
    return InputRequestListViewSchema.parse(
      await callDaemon(this.client, LIST_ROUTE, { params: { ferretId: sessionId } }),
    );
  }

  async deliver(sessionId: string, requestId: string, body: InputDeliverBodyView): Promise<InputDeliverAnswer> {
    return InputDeliverAnswerSchema.parse(
      await callDaemon(this.client, DELIVER_ROUTE, { params: { ferretId: sessionId, requestId }, body }),
    );
  }

  async cancel(sessionId: string, requestId: string): Promise<InputRequestView> {
    return InputRequestViewSchema.parse(
      await callDaemon(this.client, CANCEL_ROUTE, { params: { ferretId: sessionId, requestId }, body: {} }),
    );
  }
}
