import type { WindowImageIdentity, WindowTool } from './codex-window-containment.mjs';
import type { WindowQuotaFileSystem } from './codex-window-quota.mjs';

export interface WindowQuotaRecovery {
  readonly recovered: true;
  readonly detached: boolean;
  readonly image_deleted: boolean;
  readonly identity: WindowImageIdentity | null;
  readonly identity_source: 'journal' | 'root' | null;
  readonly journal: { readonly head: string; readonly entries: number; readonly last_phase: string | null };
  readonly actual_target_qualified: false;
}
export function recoverWindowQuota(
  root: string,
  options?: { readonly run?: WindowTool; readonly fs?: WindowQuotaFileSystem }
): Promise<WindowQuotaRecovery>;
