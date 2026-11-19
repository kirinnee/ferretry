/**
 * WHAT THE CREATE-A-PROJECT FLOW READS OF GIT ACCOUNTS. Projects does not depend on `git-accounts`: like the ferret
 * list, these are another plugin's routes called by key, and only the fields this flow draws are read. A daemon with
 * Git accounts off answers a refusal the flow states, and the rest of the flow still works. (Connecting an account is
 * not here: that card is Git accounts' own, mounted through `projects.connect-account`.)
 *
 * NOTHING SECRET CAN BE HERE. An account is a login and which keys it has; a key answer is a public fingerprint.
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

/** `pressed`: the person pressed to confirm with their passkey, so this read may ask for the step-up. Every other read is the page's own. */
export const readGitAccounts = async (client: ProjectsClient, pressed = false): Promise<readonly GitAccountRow[]> =>
  z
    .array(GitAccountRowSchema)
    .parse(await (pressed ? client.call(ACCOUNTS_ROUTE, { quiet: false }) : client.call(ACCOUNTS_ROUTE)));

/** `POST /v1/git-accounts/:id/keys`' answer (`GitKeyResult`): the public half and what is registered. Never the private half. */
const KeysAnswerSchema = z.looseObject({
  fingerprint: z.string().min(1),
  registered: z.array(z.enum(['auth', 'signing'])),
});
export type KeysAnswer = z.infer<typeof KeysAnswerSchema>;

/** "Set up push and signing for this account": one key, registered for both. The daemon answers the public fingerprint only. */
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
