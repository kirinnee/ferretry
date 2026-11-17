/**
 * The ask a ferret raises to track work on a board that is off (docs/board.md § The board is opt-in), as the command it
 * is told to run. It is a contract fact so a test in the plugin that owns `fy agenda add` can read it with that plugin's
 * own parser: the wording and the flags the command needs cannot drift apart unseen.
 */
export const TRACK_ASK_COMMAND =
  'fy agenda add -k yesno "Track this on the board?" --premise "<what you are doing>" --context "<why it needs a task>"';
