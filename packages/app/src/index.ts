/**
 * `@ferretry/app` — THE APP SHELL'S PUBLIC API (§2.1, §5): what a plugin's app half may import from the shell. The
 * shell holds no feature; this is the seam plugin halves plug into. See `packages/app/README.md`.
 *
 * Subpaths: `@ferretry/app/ui` (the shared UI kit) and `@ferretry/app/testing` (fakes for the connect interface).
 */

// ─── reaching a daemon: what Access and Connections provide (§4.8, §4.13) ─────────────────────────────────────────
export {
  CARRIER_TAKERS,
  CLAIM_TAKERS,
  type CarrierDialer,
  type CarrierControl,
  type ConnectPorts,
  type DeviceClaims,
  type DirectoryFetch,
  type PairedOver,
  type PairingAttempt,
  type PairingCarriers,
  type PairingLeg,
  type PairDirectInput,
  type PairingKey,
  provideToShell,
  type ShellAppImplementation,
  type ShellProvides,
} from './connect/provides.ts';
export { CONTROL_UNREACHABLE, type DirectDial, PairingOutcomeUnknownError } from './connect/connector.ts';
export { daemonOfClient } from './connect/daemon-of.ts';
export { directDial, type DirectDialOptions, directSessionUrl, type SocketLike } from './session/direct-dial.ts';
export {
  PAIRING_REFUSED_REASON,
  type RelayClientSocket,
  RelayPairingRefusedError,
  type RelayPairingOutcome,
  RelaySessionError,
  RelayStreamRefusedError,
  type SessionDeviceClaim,
} from './session/session-client.ts';
export {
  type CarrierDial,
  type CarrierSocketEvents,
  type CarrierWalkSocket,
  fromBase64Url,
  toBase64Url,
} from './session/session-transport.ts';
export { RelayKeyHandleError } from './session/webcrypto.ts';
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
export { DaemonCallError, type SocketListeners, type TransportSocket } from './client/transport.ts';
export type { View } from './surfaces/halves.ts';
export type { GeneratedSurfaces, SurfaceEntry } from './surfaces/registry.ts';

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
/** @public A plugin screen mounts the panels contributed to a slot it offers (§5.2). */
export { PanelSlot } from './shell/views.tsx';
/** @public A plugin's command bar entries (its app half's `shell.commands`), built per daemon by the bar. */
export type { PluginCommandContext, PluginCommandSource } from './shell/command-sources.ts';
export {
  COLOUR_TOKENS,
  SPACING_TOKENS,
  type ThemeItem,
  ThemeItemSchema,
  type ThemeToken,
  TYPE_TOKENS,
  themeProperties,
} from './theme/tokens.ts';
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
export { DEVICE_SETTINGS_HREF, daemonHomeHref, daemonSettingsHref, HOME_HREF } from './router/routes.ts';

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
