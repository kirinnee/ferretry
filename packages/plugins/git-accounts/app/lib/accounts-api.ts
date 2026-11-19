/**
 * The app's half of the Git accounts routes. Every call goes through the machine's plugin client and every answer is
 * parsed against the contract's strict schemas, so a reply that carried a field no schema names (a token, a device
 * code) is refused rather than drawn. Nothing here is cached at module scope: an account belongs to a machine.
 */
import {
  type GitAccount,
  type GitAccountId,
  GitAccountListSchema,
  type GitAccountRemoved,
  GitAccountRemovedSchema,
  type GitDeviceFlow,
  GitDeviceFlowSchema,
  type GitDeviceFlowStatus,
  GitDeviceFlowStatusSchema,
} from '../../contract/index.ts';
import type { GitAccountsClient } from '../shell.tsx';

const LIST_ROUTE = 'GET /v1/git-accounts';
const START_ROUTE = 'POST /v1/git-accounts/github/device';
const POLL_ROUTE = 'GET /v1/git-accounts/github/device/:flowId';
const REMOVE_ROUTE = 'DELETE /v1/git-accounts/:id';

/** `pressed`: the owner pressed for this read (a retry after a cancelled passkey prompt), so it may ask again. */
export async function listAccounts(client: GitAccountsClient, pressed = false): Promise<readonly GitAccount[]> {
  return GitAccountListSchema.parse(
    await (pressed ? client.call(LIST_ROUTE, { quiet: false }) : client.call(LIST_ROUTE)),
  );
}

export async function startFlow(client: GitAccountsClient): Promise<GitDeviceFlow> {
  return GitDeviceFlowSchema.parse(await client.call(START_ROUTE));
}

/** `pressed`: the person pressed to confirm with their passkey, so this poll may ask for the step-up. */
export async function pollFlow(
  client: GitAccountsClient,
  flowId: string,
  pressed = false,
): Promise<GitDeviceFlowStatus> {
  const params = { flowId };
  return GitDeviceFlowStatusSchema.parse(
    await (pressed ? client.call(POLL_ROUTE, { params, quiet: false }) : client.call(POLL_ROUTE, { params })),
  );
}

export async function removeAccount(client: GitAccountsClient, id: GitAccountId): Promise<GitAccountRemoved> {
  return GitAccountRemovedSchema.parse(await client.call(REMOVE_ROUTE, { params: { id } }));
}
