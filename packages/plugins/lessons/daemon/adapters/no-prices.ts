import type { PricePort } from '../lib/index.ts';

/**
 * A scan's equivalent price comes from the owner's price list, which is Usage's. Lessons needs only Conversation and may
 * not import Usage, so an estimate reports no price (`usd` absent): never a guess.
 */
export class UnpricedModels implements PricePort {
  async usd(): Promise<number | undefined> {
    return undefined;
  }
}
