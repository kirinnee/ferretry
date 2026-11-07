/** The contract owns these shapes (`contract/view/session-live.ts`); the daemon's bodies read them by today's names. */
export * from '../../../contract/view/session-live.ts';
export {
  type FerretLiveActivity as SessionLiveActivity,
  FerretLiveActivitySchema as SessionLiveActivitySchema,
} from '../../../contract/view/session-live.ts';
