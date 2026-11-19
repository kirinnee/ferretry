/**
 * WHAT THE CREATE-A-PROJECT FLOW READS OF GIT ACCOUNTS. Projects does not depend on `git-accounts`: like the ferret
 * list, these are another plugin's routes called by key, and only the fields this flow draws are read. A daemon with
 * Git accounts off answers a refusal the flow states, and the rest of the flow still works.
 *
 * NOTHING SECRET CAN BE HERE. An account is a login and which keys it has; the sign-in code is the short code the person
 * types at GitHub, never the device code GitHub issued to the daemon.
 */
import { z } from 'zod';
import {
  type ProjectInfo,
  ProjectInfoSchema,
  type SetProjectAccountsRequest,
  SetProjectAccountsRequestSchema,
} from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';

const ACCOUNTS_ROUTE = 'GET /v1/git-accounts';
const DEVICE_START_ROUTE = 'POST /v1/git-accounts/github/device';
const DEVICE_POLL_ROUTE = 'GET /v1/git-accounts/github/device/:flowId';
const KEYS_ROUTE = 'POST /v1/git-accounts/:id/keys';
const SET_ACCOUNTS_ROUTE = 'PUT /v1/projects/:id/accounts';

const GitAccountRowSchema = z.looseObject({
  id: z.string().min(1),
  login: z.string().min(1),
  name: z.string().optional(),
  keys: z.looseObject({ ssh: z.unknown().optional(), signing: z.unknown().optional() }).default({}),
});
export type GitAccountRow = z.infer<typeof GitAccountRowSchema>;

/** Whether this machine has registered anything on the account yet: the offer to set up push and signing is for these. */
export const accountHasKeys = (account: GitAccountRow): boolean =>
  account.keys.ssh !== undefined || account.keys.signing !== undefined;

export const readGitAccounts = async (client: ProjectsClient): Promise<readonly GitAccountRow[]> =>
  z.array(GitAccountRowSchema).parse(await client.call(ACCOUNTS_ROUTE));

const DeviceFlowSchema = z.looseObject({
  flowId: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.url(),
  expiresAt: z.string().min(1),
  interval: z.number().int().min(1),
});
export type DeviceFlow = z.infer<typeof DeviceFlowSchema>;

export const startDeviceFlow = async (client: ProjectsClient): Promise<DeviceFlow> =>
  DeviceFlowSchema.parse(await client.call(DEVICE_START_ROUTE));

const DeviceStatusSchema = z.discriminatedUnion('status', [
  z.looseObject({ status: z.literal('pending'), interval: z.number().int().min(1).optional() }),
  z.looseObject({ status: z.literal('slow_down'), interval: z.number().int().min(1).optional() }),
  z.looseObject({ status: z.literal('done'), accountId: z.string().min(1), login: z.string().min(1) }),
  z.looseObject({ status: z.literal('expired') }),
  z.looseObject({ status: z.literal('denied') }),
]);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const pollDeviceFlow = async (
  client: ProjectsClient,
  flowId: string,
  signal?: AbortSignal,
): Promise<DeviceStatus> =>
  DeviceStatusSchema.parse(
    await client.call(DEVICE_POLL_ROUTE, { params: { flowId }, ...(signal === undefined ? {} : { signal }) }),
  );

const KeysAnswerSchema = z.looseObject({ fingerprint: z.string().min(1), registered: z.boolean().optional() });
export type KeysAnswer = z.infer<typeof KeysAnswerSchema>;

/** "Set up push and signing for this account": one key for both. The daemon answers the public fingerprint only. */
export const setUpKeys = async (client: ProjectsClient, accountId: string): Promise<KeysAnswer> =>
  KeysAnswerSchema.parse(await client.call(KEYS_ROUTE, { params: { id: accountId }, body: { purpose: 'both' } }));

/** Links the project to exactly these accounts, the first being its default. */
export const setProjectAccounts = async (
  client: ProjectsClient,
  projectId: string,
  accounts: readonly string[],
): Promise<ProjectInfo> => {
  const body: SetProjectAccountsRequest = SetProjectAccountsRequestSchema.parse({ accounts });
  return ProjectInfoSchema.parse(await client.call(SET_ACCOUNTS_ROUTE, { params: { id: projectId }, body }));
};
