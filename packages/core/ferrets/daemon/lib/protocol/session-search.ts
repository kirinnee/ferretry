/** The contract owns these shapes (`contract/view/session-search.ts`); the daemon's bodies read them by today's names. */
export * from '../../../contract/view/session-search.ts';
export {
  type FerretSearchQuery as SessionSearchQuery,
  FerretSearchQuerySchema as SessionSearchQuerySchema,
} from '../../../contract/view/session-search.ts';
