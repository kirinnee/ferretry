import type { AccessApi } from '@ferretry/plugin-access/contract';

/** What Agenda asks of Access (§2.3): one push to the owner's devices, and taking those pushes down again. */
export type AccessBuzzApi = Pick<AccessApi, 'buzz' | 'clear'>;
