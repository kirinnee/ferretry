import type { FleetManifest, FleetManifestAccount } from './manifest.ts';

export type FleetLoginOutcome =
  | { readonly status: 'logged-in' }
  | { readonly status: 'not-required' }
  | { readonly status: 'failed'; readonly message: string };

export interface FleetLoginPort {
  login(account: FleetManifestAccount): Promise<FleetLoginOutcome>;
}

export interface FleetLoginResult {
  readonly accountId: string;
  readonly status: FleetLoginOutcome['status'] | 'unavailable';
  readonly message?: string;
}

export class FleetLoginService {
  constructor(private readonly loginPort: FleetLoginPort) {}

  async login(manifest: FleetManifest, accountIds?: readonly string[]): Promise<readonly FleetLoginResult[]> {
    const accountsById = new Map(manifest.accounts.map(account => [account.id, account]));
    const selected =
      accountIds === undefined
        ? [...manifest.accounts].sort((left, right) => left.id.localeCompare(right.id))
        : accountIds.map(accountId => {
            const account = accountsById.get(accountId);
            if (!account) {
              throw new UnknownFleetAccountError(accountId);
            }
            return account;
          });

    const results: FleetLoginResult[] = [];
    for (const account of selected) {
      if (!account.available) {
        results.push({
          accountId: account.id,
          status: 'unavailable',
          ...(account.unavailableReason === null ? {} : { message: account.unavailableReason }),
        });
        continue;
      }

      try {
        const outcome = await this.loginPort.login(account);
        results.push({
          accountId: account.id,
          status: outcome.status,
          ...(outcome.status === 'failed' ? { message: outcome.message } : {}),
        });
      } catch (error) {
        results.push({
          accountId: account.id,
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }
}

export class UnknownFleetAccountError extends Error {
  constructor(readonly accountId: string) {
    super(`unknown fleet account "${accountId}"`);
    this.name = 'UnknownFleetAccountError';
  }
}
