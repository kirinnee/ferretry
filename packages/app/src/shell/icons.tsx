import {
  Activity,
  Archive,
  ArrowLeftRight,
  Bot,
  Boxes,
  ChartColumn,
  CodeXml,
  Coins,
  Columns3,
  Copy,
  Cpu,
  Download,
  FileCog,
  Folder,
  Gauge,
  GitPullRequest,
  GraduationCap,
  Globe,
  IdCard,
  Inbox,
  KeyRound,
  Layers,
  LayoutDashboard,
  List,
  Lock,
  LogIn,
  type LucideIcon,
  MessagesSquare,
  Mic,
  Monitor,
  PlugZap,
  Rocket,
  ScrollText,
  Server,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Stethoscope,
  Tag,
  Terminal,
  UserRound,
  Users,
  Wallet,
  WandSparkles,
  Wifi,
  Zap,
} from 'lucide-react';
import type { NavEntry } from '../layout/engine.ts';

/**
 * THE ONE ICON SET (lucide, already the app's), by the names manifests use. A settings tab (`settingsTab(…, { icon })`) and a
 * screen's nav entry (`screen(…, { nav: { icon } })`) each name one of these; the shell draws it beside the label, so every
 * destination and every Settings item reads the same size and weight. A name nothing here answers to draws nothing (the
 * label still stands), and `icons.test.ts` fails a declaration whose name is missing, so that never reaches a person.
 */
export const ICONS: Readonly<Record<string, LucideIcon>> = {
  // destinations (nav targets)
  list: List,
  inbox: Inbox,
  columns: Columns3,
  folder: Folder,
  'git-pull-request': GitPullRequest,
  chart: ChartColumn,
  messages: MessagesSquare,
  'share-2': Share2,
  'graduation-cap': GraduationCap,
  shield: Shield,
  settings: Settings,
  server: Server,
  // settings tabs
  activity: Activity,
  archive: Archive,
  'arrow-left-right': ArrowLeftRight,
  bot: Bot,
  boxes: Boxes,
  coins: Coins,
  'code-xml': CodeXml,
  copy: Copy,
  cpu: Cpu,
  download: Download,
  'file-cog': FileCog,
  gauge: Gauge,
  globe: Globe,
  'id-card': IdCard,
  'key-round': KeyRound,
  layers: Layers,
  'layout-dashboard': LayoutDashboard,
  lock: Lock,
  'log-in': LogIn,
  mic: Mic,
  monitor: Monitor,
  'plug-zap': PlugZap,
  rocket: Rocket,
  'scroll-text': ScrollText,
  'shield-check': ShieldCheck,
  smartphone: Smartphone,
  sparkles: Sparkles,
  stethoscope: Stethoscope,
  tag: Tag,
  terminal: Terminal,
  'user-round': UserRound,
  users: Users,
  wallet: Wallet,
  'wand-sparkles': WandSparkles,
  wifi: Wifi,
  zap: Zap,
};

/** The icon the shell's own nav items carry (they are not plugin screens, so no manifest names one). */
const SHELL_ITEM_ICON: Readonly<Record<string, string>> = { settings: 'settings', daemons: 'server' };

/** The icon name a nav entry declares: the screen's `nav.icon`, or the shell item's own. */
export const navIconName = (entry: NavEntry): string | undefined =>
  entry.kind === 'screen' ? entry.screen.icon : SHELL_ITEM_ICON[entry.item];

/** One icon at the one size and weight, hidden from assistive tech (the label beside it names the item). */
export function Icon({ name, className }: { readonly name: string | undefined; readonly className?: string }) {
  const Glyph = name === undefined ? undefined : ICONS[name];
  if (Glyph === undefined) return null;
  return <Glyph aria-hidden="true" focusable="false" size={16} strokeWidth={1.75} className={className ?? 'fy-icon'} />;
}
