/** PENDING(connections): inject Connections-owned discovery here when its app contract is available.
 * No directory, endpoint validation or network reader belongs to Onboarding. */
export type HostedRelayFallback =
  | { readonly kind: 'checking' }
  | { readonly kind: 'available'; readonly relayUrl: string }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'undetermined'; readonly reason: string };
export const CHECKING_HOSTED_RELAY: HostedRelayFallback = Object.freeze({ kind: 'checking' });
