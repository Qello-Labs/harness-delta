export interface OrdinaryTaskInput {
 readonly mode: 'ordinary';
 readonly name: string;
 readonly project_id: string;
 readonly type?: string;
 readonly size?: string;
 readonly assignee?: string;
 readonly criterion_ids: string[];
}

export function ordinaryTaskInput(input: {
 name: string; projectId: string; criterionIds: readonly string[];
 type?: string; size?: string; assignee?: string;
}): OrdinaryTaskInput | null {
 if (!input.name.trim() || !input.projectId || input.criterionIds.length === 0) return null;
 return {
  mode: 'ordinary', name: input.name, project_id: input.projectId,
  criterion_ids: [...input.criterionIds],
  ...(input.type ? { type: input.type } : {}),
  ...(input.size ? { size: input.size } : {}),
  ...(input.assignee ? { assignee: input.assignee } : {}),
 };
}

export function ordinaryConnectCommand(projectId: string, taskId: string, origin: string): string {
 return `/harness-connect Connect this session to project ${projectId}, task ${taskId}, using ${origin} and its native receipt.`;
}
