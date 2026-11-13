import type { FileEditorProps } from '../profiles/profile-editor.tsx';
import type { MachineView } from '../../../../contract/index.ts';
import type { LiveRuntimesClient } from '../../../lib/client.ts';

/**
 * What a tab of the Machines pages is handed: the client bound to the one machine it shows (a client is per daemon, so
 * there is no connection to pick and no factory to make one), that machine's name and its own view of itself.
 */
export interface MachineTabProps {
  readonly client: LiveRuntimesClient;
  readonly machineName: string;
  /** `null` while the machine read has not answered, or failed. */
  readonly machine: MachineView | null;
  readonly online: boolean;
  /** The machine read is in flight. */
  readonly checking: boolean;
  /** Read the machine again after a failed read. */
  readonly onRetry: () => void;
  /** Read the machine again after a change that moved what it says about itself (its default runtime). */
  readonly onRefresh?: () => void;
  /** The editor for a config file, drawn by whoever owns it; absent: a profile's file is named but not editable here. */
  readonly renderFileEditor?: (editor: FileEditorProps) => import('react').ReactNode;
}
