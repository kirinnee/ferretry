/**
 * `@ferretry/app` — THE APP SHELL'S PUBLIC API (§2.1, §5): what a plugin's app half may import from the shell. The
 * shell holds no feature; this is the seam plugin halves plug into. See `packages/app/README.md`.
 *
 * Subpaths: `@ferretry/app/ui` (the shared UI kit) and `@ferretry/app/testing` (fakes for the connect interface).
 */

// ─── the fy-render sandbox shells' and Conversation's shared numbers, palette and HTML kit ───────────────────────────
export * from './fy-render/index.ts';

// ─── reaching a daemon: what Access and Connections provide (§4.8, §4.13) ─────────────────────────────────────────
export {
  CARRIER_TAKERS,
  CLAIM_TAKERS,
  type CarrierDialer,
  type CarrierControl,
  type ConnectPorts,
  type DaemonlessPorts,
  type PairedList,
  type DaemonlessScreenProps,
  type DaemonlessViews,
  type DeviceClaims,
  type BackgroundViewProps,
  type DeviceViewProps,
  type DirectoryFetch,
  type PairedOver,
  type PairingAttempt,
  type PairingCarriers,
  type PairingLeg,
  type PairDirectInput,
  type PairingKey,
  provideToShell,
  registeredDaemonless,
  type ShellAppImplementation,
  type ShellProvides,
} from './connect/provides.ts';
export { CONTROL_UNREACHABLE, type DirectDial, PairingOutcomeUnknownError } from './connect/connector.ts';
export { daemonOfClient } from './connect/daemon-of.ts';
export { directDial, type DirectDialOptions, directSessionUrl, type SocketLike } from './session/direct-dial.ts';
export {
  PAIRING_REFUSED_REASON,
  type DeviceKeyRotation,
  type RelayClientSocket,
  RelayPairingRefusedError,
  type RelayPairingOutcome,
  RelayClientSession,
  type RelayClientSessionDependencies,
  RelayJoinRefusedError,
  RelaySessionError,
  type RelayTunnelAnswer,
  RelayStreamRefusedError,
  type SessionDeviceClaim,
} from './session/session-client.ts';
export {
  type AmendedRotation,
  type CarrierDial,
  type CarrierSocketEvents,
  type CarrierWalkSocket,
  fromBase64Url,
  NO_DEVICE_KEY,
  type RotatingSession,
  type RotationRequest,
  type SessionKeyRotation,
  toBase64Url,
} from './session/session-transport.ts';
export { RelayKeyHandleError, WebCryptoRelayCrypto } from './session/webcrypto.ts';
export {
  DaemonIdSchema,
  HEARTBEAT_GRACE_SECONDS,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  type OwnerPayload,
  OwnerPayloadSchema,
  type PrivateKeyHandle,
  type RelayCrypto,
  RELAY_CLOSE_CODES,
} from './session/wire/index.ts';

// ─── the one passkey prompt: what Access provides, and where every daemon call consults it (G95, G105) ──────────
export {
  PASSKEY_TAKERS,
  type PasskeyAsk,
  type PasskeyHandler,
  type PasskeyNeed,
  type PasskeyPorts,
  type PasskeyProvision,
  type PasskeyRefusal,
  type PasskeyWords,
  type PromptOrigin,
  requestOrigin,
} from './passkey/passkey.ts';
export { useLockedDaemons, usePasskeyAsk } from './shell/passkey-mount.tsx';

// ─── the paired daemons ────────────────────────────────────────────────────────────────────────────────────────────
export {
  type DaemonList,
  type DaemonListSnapshot,
  daemonOrigin,
  daemonTitle,
  type MachineGroup,
  MAX_DAEMONS,
  type PairedDaemon,
  PairedDaemonSchema,
  type PairingInput,
} from './daemons/daemon-list.ts';

// ─── the per-daemon client a half talks through (§9.6) ─────────────────────────────────────────────────────────────
export { fillPath, HEALTH_ROUTE, INVENTORY_ROUTE, type ShellPluginClient } from './client/daemon-client.ts';
export type { BlockReason, InventoryEntry, Standing } from './client/inventory.ts';
export { UPDATE_DAEMON_COMMAND } from './client/sentences.ts';
export {
  DaemonCallError,
  isCarrierOutage,
  type SocketListeners,
  type TransportSocket,
} from './client/transport.ts';
export type { View } from './surfaces/halves.ts';
export type { GeneratedSurfaces, SurfaceEntry } from './surfaces/registry.ts';

// ─── a poll beside the event feed (today's feed-aware-poll) ───────────────────────────────────────────────────────
export {
  browserFeedAwarePollEnvironment,
  FEED_EVENT_SETTLE_MS,
  type FeedAwarePollEnvironment,
  type FeedAwarePollOptions,
  type LiveFeedSignal,
  startFeedAwarePoll,
  startVisiblePoll,
  whileVisible,
} from './poll/feed-aware-poll.ts';

// ─── layout, slots, theme (§5.2, §5.3) ────────────────────────────────────────────────────────────────────────────
export type { OwnerLayout } from './layout/daemon-layout.ts';
export { LAYOUTS_PLUGIN } from './layout/daemon-layout.ts';
export type { NavEntry, PanelRef, ScreenRef, SideHolds } from './layout/engine.ts';
export {
  applyOverrides,
  checkLayout,
  DEFAULT_LAYOUT,
  type InstalledViews,
  type Layout,
  type LayoutIssue,
  type LayoutOverrides,
  setDeviceOverride,
} from './layout/layout.ts';
export { FRAME_SLOTS, isFrameSlot, isSlotName, PANEL_SLOTS, SHELL_ITEMS } from './layout/slots.ts';
/** @public Layouts' Settings tab reads and writes this device's own layout choice (§5.3: the app's saved data, no route). */
export { type DeviceLayout, useDeviceLayout } from './shell/use-device-layout.ts';
/** @public A plugin screen mounts the panels contributed to a slot it offers (§5.2). */
export { PanelSlot, useSlotHasPanels } from './shell/views.tsx';
/** @public A plugin's command bar entries (its app half's `shell.commands`), built per daemon by the bar (§5.1). */
export type { PluginCommandContext, PluginCommandSource } from './shell/command-sources.ts';
/** @public An app hook another half offers (`<offerer>.<name>`): the provider's `shell.hooks`, the offerer's `useAppHook` (§5.2). */
export { type AppHookContext, type AppHookProvider, type AppHookProviders, useAppHook } from './shell/app-hooks.ts';
/** @public This device's theme, read on any screen, daemon-less ones included (§5.2: a device setting; shell contract S9). */
export {
  type DevicePaired,
  type DevicePairedMachine,
  type DeviceTheme,
  useDevicePaired,
  useDeviceTheme,
} from './shell/device-context.tsx';
/** @public Where a per-daemon view is drawn — its machine, feed and authority — and how a control shows for it (§5.2; shell contract S1). */
export {
  type Authority,
  type Axis,
  CAPABILITY_NAMES,
  type CapabilityName,
  controlState,
  useViewPlace,
  type ViewPlace,
} from './shell/view-place.tsx';
export {
  COLOUR_TOKENS,
  SPACING_TOKENS,
  type ThemeItem,
  ThemeItemSchema,
  type ThemeToken,
  TYPE_TOKENS,
  themeProperties,
} from './theme/tokens.ts';
export { CODE_FACE_URLS } from './theme/fonts.ts';
export {
  DEFAULT_THEME_PREFERENCE,
  THEME_FAMILIES,
  type ThemeFamily,
  type ThemeFamilyId,
  type ThemeMode,
  type ThemePreference,
  ThemePreferenceSchema,
} from './theme/preferences.ts';

// ─── routing ───────────────────────────────────────────────────────────────────────────────────────────────────────
export { type NavigateOptions, type RouterController, useOptionalRouter, useRouter } from './router/router.tsx';
// ─── other paired daemons, for a page that reads several (the Warden page) ───────────────────────────────────────
export {
  distinctDaemonName,
  machineDisplayOrder,
  reconcileMachineOrder,
  replacedPairing,
} from './daemons/machine-names.ts';
export { usePairedDaemons } from './shell/daemon-access.ts';
/** @public The same plugin on every paired machine (§5.1; shell contract S2): each row's place and the plugin's own client. */
export { type DaemonReach, useEveryDaemon, useNoReach, useNoReaches } from './shell/every-daemon.ts';
export type { NoReach } from './shell/plugin-identity.tsx';
// ─── declared fragments, device views and the in-memory hand-off (shell contract S3) ─────────────────────────────
export { type FragmentDecl, FRAGMENT_KEY } from './router/address.ts';
export { type FragmentArrival, useFragment } from './shell/use-fragment.ts';
export {
  type InstallOutcome,
  type InstallPlatform,
  type InstallPrompt,
  useInstallPrompt,
} from './shell/install-prompt.ts';
export { type NavForm, useNavForm } from './shell/device-panels.tsx';
export { handOff, type OwnScreenRef, useHandOff, useOwnScreen } from './shell/hand-off.ts';

export {
  type AddressPlace,
  addressPlace,
  DEVICE_SETTINGS_HREF,
  daemonHomeHref,
  daemonSettingsHref,
  HOME_HREF,
  type Route,
  type RouteTable,
  routeTable,
} from './router/routes.ts';
export { notificationTapTarget, PUSH_TAP_SCREENS } from './router/tap-target.ts';
export {
  notificationClickUrl,
  notificationUrl,
  PUSH_ASK_PATTERN,
  PUSH_FERRET_PATTERN,
  type PushMachine,
  pushMachineOf,
} from './worker/notifications.ts';
// The page's half of a notification tap (S6) and of a clear: the inbox the entry point creates before the app mounts.
export {
  attachNotificationOpens,
  type NotificationOpen,
  NotificationOpenInbox,
  type NotificationOpenSource,
} from './worker/notification-open.ts';
export { type ClearRegistration, closeShownTags, type ShownNotification, shownTag } from './worker/push-clear.ts';

// ─── the reference grammar (docs/reference-standard.md) ───────────────────────────────────────────────────────────
export * from './references/grammar.ts';
export { type CodeDecorationRequest, type CodeNode, decoratedCodeNodes } from './references/code-spans.ts';

// ─── browser-side names and records (§9.4) ─────────────────────────────────────────────────────────────────────────
export { databaseName, localKey, speechModelCache } from './storage/names.ts';
export {
  type KeyValueStore,
  memoryStore,
  RECORD_FORMAT,
  readRecord,
  removeRecord,
  writeRecord,
} from './storage/records.ts';

// ─── shared browser facilities used by app halves ─────────────────────────────────────────────────────────────
export { Badge, Button, cn, FullscreenToggle, useDocumentVisible, useFullscreen } from './ui/index.ts';
export { describeSurfaceOwnership, type SurfaceOwnership, type SurfaceOwnershipLabel } from './references/ownership.ts';
export { FY_REQUEST_ID_HEADER } from './client/request-id.ts';
export {
  type DeadlineSchedule,
  MACHINE_READ_DEADLINE_MS,
  MachineDeadlineError,
  realSchedule,
  untilAborted,
  withDeadline,
} from './client/machine-deadline.ts';
export {
  browserListRefreshEnvironment,
  LIST_REFRESH_MIN_MS,
  ListRefresh,
  type ListRefreshEnvironment,
} from './client/list-refresh.ts';

// ─── prose: Markdown and the kit around it (conversation-app plan C1-1 … C1-10) ───────────────────────────────────
export {
  Markdown,
  type MarkdownAstFenceNode,
  type MarkdownFences,
  type MarkdownProps,
  locationFenceBody,
  referenceHasTrustedOrigin,
} from './prose/markdown.tsx';
export { CopyableFence, CopyableSpan } from './prose/markdown-copy.tsx';
export { MarkdownTable, type MarkdownTableProps } from './prose/markdown-table.tsx';
export { cellText, remarkTableLabels } from './prose/remark-table-labels.ts';
export {
  DEFAULT_TABLE_VIEW,
  parseTableView,
  TABLE_VIEW_KEY,
  type TableView,
  TableViewPreferenceStore,
  type TableViewStorage,
} from './prose/table-view-preference.ts';
export { ChatProse } from './prose/chat-prose.tsx';
export { CodeBlock, type CodeBlockProps } from './prose/code-block.tsx';
export { escapeHtml, fenceLanguage, highlightToHtml, isKnownLanguage, type Tokenizer } from './prose/highlight.ts';
export {
  type ReferenceSurface,
  ReferenceSurfaceProvider,
  useReferenceSurface,
} from './references/reference-surface.tsx';
export {
  type BrowserStatus,
  createSurfaceReferenceResolver,
  type SessionSurface,
  sessionSurfaces,
  type SurfaceScope,
  type TerminalListView,
  terminalIdForSurfaceKey,
} from './references/surface-references.ts';
export {
  asLocationError,
  accuracyLabel,
  browserLocationShareHost,
  cleanPlace,
  coordinatePair,
  formatLocationBlock,
  LOCATION_FENCE_LANGUAGE,
  LOCATION_TIMEOUT_MS,
  type LocationEnvironment,
  LocationError,
  type LocationFailureCode,
  type LocationFix,
  type LocationShareHost,
  parseLocationBlock,
} from './shared/location-share.ts';
export {
  type LocationDraft,
  LocationChip,
  PendingLocationChip,
  type PendingLocationChipProps,
} from './shared/location-chip.tsx';
export { type ClockEnvironment, clockOfInstant, type MessageClock } from './shared/message-clock.ts';
export {
  nameToneClass,
  StatusMark,
  statusMark,
  type StatusMarkInfo,
  type StatusMarkProps,
  type StatusMarkStatus,
  type StatusMarkView,
  TERMINAL_STATUSES,
  WAITING_STATUSES,
} from './shared/status-mark.tsx';
export { absoluteTime, relativeTime, statusLabel } from './shared/time-labels.ts';

// ─── mounting other plugins' views, and addressing screens ────────────────────────────────────────────────────────
export { RendererView } from './shell/renderer-view.tsx';
export { ScreenHrefProvider, type ScreenHrefOf, screenHref, useScreenHref } from './router/screen-href.ts';

// ─── the composer's shared kit: the editor, quoting, this device's controls and preferences ───────────────────────
export * from './compose/composer-editing.ts';
export * from './compose/live-markdown.ts';
export * from './compose/live-markdown-editor.tsx';
export * from './compose/md-compose.ts';
export * from './compose/quote.ts';
export * from './compose/ferret-scope.ts';
export * from './compose/composer-keybinding.ts';
export * from './compose/controls.ts';
export * from './compose/device-controls.ts';
export * from './compose/setting-row.tsx';
export * from './compose/context-readout.ts';
export * from './compose/context-ring.tsx';
export * from './compose/use-location-share.ts';
export * from './compose/composer-draft.ts';
export { type DevicePreference, devicePreference } from './storage/device-preference.ts';

// ─── the chat's chrome: receipts, command rows, the live readout, quoting, the reading position (C3-1 … C3-6) ──────
export { ReceiptMark, type SendReceiptKind } from './shared/receipt-mark.tsx';
export { CommandRow, commandOutputIsLong, commandOutputSummary, type SlashCommand } from './shared/command-row.tsx';
export {
  LiveStreamIndicator,
  type LiveStreamIndicatorProps,
  type LiveStreamState,
  liveStreamState,
  type SessionEventStreamStatus,
} from './shared/live-stream-indicator.tsx';
export {
  type CountUpOptions,
  type LiveCounterOptions,
  type LiveScheduler,
  useCountUp,
  useLiveActivity,
  useLiveElapsed,
} from './shared/use-live-counter.ts';
export { COUNT_UP_MS, countUpValue, msToNextSecond, wholeSecondsSince } from './shared/live-counter-clock.ts';
export { createLiveActivityHub, type LiveActivityFeed, type LiveActivityHub } from './shared/live-activity-feed.ts';
export {
  type QuoteSelectionLike,
  type QuoteSurfaceHandlers,
  quotableTranscriptSelectionText,
  useQuoteMenu,
} from './shared/quote-menu.tsx';
export {
  type ChatScroll,
  type ChatScrollSlot,
  chatScrollSlot,
  restorableTop,
  ScrollMemory,
  type ScrollMemoryStorage,
} from './scroll/scroll-memory.ts';
export { useRouteScrollMemory } from './scroll/use-route-scroll-memory.ts';
export { useChatScrollSlot } from './scroll/chat-scroll.ts';
/** Follow-the-tail for a scroller whose content grows at the end (the chat transcript, a terminal capture). */
export * from './scroll/transcript-follow.ts';
export * from './scroll/use-stick-to-bottom.ts';
export { RECONNECTING_GRACE_MS } from './shared/reconnecting-grace.ts';
export * from './passkey/ceremony.ts';

// ─── a member session to a publisher this browser is not paired with (Connections provides; not implemented yet) ───
// `setMemberCarriers` is deliberately NOT exported: only the shell's composition root (`main.tsx`) installs carriers.
export {
  DIRECT_MEMBER_DEADLINE_MS,
  type MemberCarriers,
  type MemberPublisher,
  type MemberPurpose,
  type MemberSocket,
  type MemberStep,
  memberCarriers,
  memberTunnelRequest,
  memberTunnelResponse,
  memberWalk,
  RELAY_MEMBER_DEADLINE_MS,
} from './connect/member.ts';
