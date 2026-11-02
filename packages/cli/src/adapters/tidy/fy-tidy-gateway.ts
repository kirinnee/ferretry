import { type IFyApiClient, TIDY_PLAN_PATH, TidyPlanSchema } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME, FY_SESSION_ID_HEADER } from '../../lib/session/connection';
import type { ITidyPlanGateway } from '../../lib/tidy/ports';

/** The tidy plan route of the daemon API: the only place `fy tidy` knows about its URL and headers. */
export class FyTidyGateway implements ITidyPlanGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request'>) {}

  async plan(as: string | undefined) {
    try {
      return await this.client.request(TIDY_PLAN_PATH, TidyPlanSchema, {
        method: 'POST',
        headers: {
          [FY_CLIENT_HEADER]: FY_CLIENT_NAME,
          ...(as === undefined || as === '' ? {} : { [FY_SESSION_ID_HEADER]: as }),
        },
      });
    } catch (error) {
      if (error instanceof FyHttpError && error.status === 404) return undefined;
      throw error;
    }
  }
}
