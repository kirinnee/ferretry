/** The project board and the work search/tidy over its cards (`board.*`, `work.search.*`, `tidy.*`). One fragment of `DAEMON_FEATURES`; `index.ts` spreads them all. */
export const BOARD_FEATURES = {
  /** The board's per-project lane sets: `GET /v1/board/projects` and `GET|POST /v1/board/projects/:projectId/lanes`. */
  boardLanes: 'board.lanes.1',
  /**
   * Whether a project uses the board (`GET|PUT /v1/board/projects/:projectId/switch`, docs/board.md § The board is
   * opt-in). A daemon without this name answers 404: the app offers the 'Use the board' switch only where the
   * machine reports it, and otherwise says the machine needs an update.
   */
  boardSwitch: 'board.switch.1',
  /**
   * A board move back (`move` or `reopen`) may carry `attachments` — files the owner sent with "Not good" —
   * which the daemon delivers to the card's ferret with the reopen and names in the card's history. A daemon
   * without this name refuses the field: the app offers the composer's attach only where the machine reports it.
   */
  boardReopenAttachments: 'board.reopen.attachments.1',
  /**
   * PATCHING A CARD AS ONE DOCUMENT (docs/board.md § Patch, `fy task patch`): a card edit names the `revision` it read
   * (the seq of the card's newest history event) and is refused `version-conflict` when the card has moved on. A daemon
   * without this name refuses the field as malformed, so a client sends it only to one that reports it.
   */
  boardPatch: 'board.patch.1',
  /**
   * The owner's answer to a card's gate moves the card (docs/board.md § Cards show progress). The app hides its own
   * to-test rows only for a machine that reports it. A daemon that also reports {@link agendaCardAsks} asks on the
   * card's agenda instead of raising a gate item, and has no to-test rows to hide.
   */
  boardGateItems: 'board.gate-items.1',
  /**
   * Cards are public or private (docs/board.md § Public and private cards): every card the daemon sends carries
   * `visibility`, `GET /v1/board` takes `?visibility=public|private|all`, `fy task create` takes `--private|--public`
   * and a card's visibility changes with the `visibility` action. A daemon without this name ignores the query
   * parameter and sends no field, so the app keeps the older "Ferret cards" rule and the Board shows every card.
   */
  boardVisibility: 'board.visibility.1',
  /**
   * One search over cards and agenda items (`GET /v1/search`, `POST /v1/search/related`, docs/work-search.md). A
   * daemon without this name answers 404: the app keeps searching what it already loaded and the CLI files without
   * the related check.
   */
  workSearch: 'work.search.1',
  /**
   * One ferret's clean-up of its own unwanted cards and work-tracking agenda items (`POST /v1/tidy/plan`, docs/board.md,
   * "Tidy"). A daemon without this name answers 404: `fy tidy` says the machine needs an update.
   */
  tidy: 'tidy.1',
} as const;
