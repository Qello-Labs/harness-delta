import {queueApplicationCleanup,flushApplicationCleanup,assertApplicationCleanupDone} from './harness-application-cleanup.js';
import { deleteMappedProject } from './exchange/invalidation.js';
import { recordSourceTaskDeletion, recordSourceProjectDeletion } from './exchange/deletion.js';
import { z } from 'zod';
import { affectedComparisonProtocols, invalidateComparisonSnapshots } from './reports/comparison-invalidation.js';
import { IdSchema, TimestampSchema } from './contracts.js';
import { utcNow, type Clock } from './lifecycle.js';
import type { Store } from './store.js';
import { assertWebMetadataCleanupDone, flushWebMetadataCleanup, queueWebMetadataCleanup } from './local-web-metadata.js';

export class Deletion {
  private deletionDepth=0;
  constructor(private readonly store: Store, private readonly clock: Clock = utcNow, private readonly discloseReports: (ids: readonly string[]) => void = () => {}) {}

  isDeleted(kind: 'task' | 'project' | 'session', id: string): boolean {
    return Boolean(this.store.get('SELECT id FROM tombstones WHERE kind = ? AND id = ?', [kind, id]));
  }

  deleteTask(taskId: string): void {
    IdSchema.parse(taskId);
    this.deletionDepth++;
    try{this.store.immediateTransaction(() => {
      if (this.isDeleted('task', taskId)) return;
      const task = this.store.get<{ project_id: string }>(
        'SELECT project_id FROM tasks WHERE id=? UNION ALL SELECT project_id FROM shared_configuration_tasks WHERE task_id=?',
        [taskId, taskId]);
      if (!task) throw new Error('unknown_task');
      queueWebMetadataCleanup(this.store, 'task', taskId, task.project_id);
      queueApplicationCleanup(this.store,taskId);
      recordSourceTaskDeletion(this.store, taskId, TimestampSchema.parse(this.clock()));
      this.deleteComparisonData(taskId);
      for (const session of this.store.all<{ id: string }>('SELECT id FROM sessions WHERE task_id = ?', [taskId])) this.tombstone('session', session.id);
      this.tombstone('task', taskId);
      this.store.execute('DELETE FROM tasks WHERE id = ?', [taskId]);
      this.store.execute('DELETE FROM shared_configuration_tasks WHERE task_id=?', [taskId]);
    });}finally{this.deletionDepth--;}
    if(this.deletionDepth===0){flushApplicationCleanup(this.store);flushWebMetadataCleanup(this.store);assertApplicationCleanupDone(this.store,taskId);assertWebMetadataCleanupDone(this.store,'task',taskId);}
  }

  deleteProject(projectId: string): void {
    IdSchema.parse(projectId);
    const cleanupTasks=this.store.all<{id:string}>('SELECT id FROM tasks WHERE project_id=? UNION SELECT task_id AS id FROM harness_application_cleanup WHERE project_id=?',[projectId,projectId]).map(row=>row.id);
    this.deletionDepth++;
    try{this.store.immediateTransaction(() => {
      if (this.isDeleted('project', projectId)) return;
      if (!this.store.get('SELECT id FROM projects WHERE id = ?', [projectId])) throw new Error('unknown_project');
      queueWebMetadataCleanup(this.store, 'project', projectId, projectId);
      deleteMappedProject(this.store, projectId, TimestampSchema.parse(this.clock()));
      recordSourceProjectDeletion(this.store, projectId, TimestampSchema.parse(this.clock()));
      for (const protocol of this.store.all<{ id: string }>('SELECT id FROM comparison_protocols WHERE project_id=?', [projectId])) {
        const ids = this.store.all<{ report_id: string }>('SELECT report_id FROM comparison_report_snapshots WHERE protocol_id=? UNION ALL SELECT report_id FROM flexible_report_snapshots WHERE protocol_id=? ORDER BY report_id', [protocol.id,protocol.id]).map(row => row.report_id);
        if (ids.length) this.discloseReports(ids);
        invalidateComparisonSnapshots(this.store, protocol.id, 'deletion', TimestampSchema.parse(this.clock()));
      }
      for (const task of this.store.all<{ id: string }>(
        'SELECT id FROM tasks WHERE project_id=? UNION SELECT task_id AS id FROM shared_configuration_tasks WHERE project_id=?',
        [projectId, projectId])) this.deleteTask(task.id);
      this.tombstone('project', projectId);
      this.store.execute('DELETE FROM projects WHERE id = ?', [projectId]);
    });}finally{this.deletionDepth--;}
    if(this.deletionDepth===0){flushApplicationCleanup(this.store);flushWebMetadataCleanup(this.store);for(const taskId of cleanupTasks)assertApplicationCleanupDone(this.store,taskId);assertWebMetadataCleanupDone(this.store,'project',projectId);}
  }

  configureRetention(projectId: string, days: number): void {
    IdSchema.parse(projectId); z.number().int().min(1).max(365000).parse(days);
    if (!this.store.get('SELECT id FROM projects WHERE id = ?', [projectId])) throw new Error('unknown_project');
    this.store.execute('UPDATE projects SET retention_days = ? WHERE id = ?', [days, projectId]);
  }

  applyRetention(projectId: string, now: string): number {
    IdSchema.parse(projectId); TimestampSchema.parse(now);
    const cleanupTasks:string[]=[];this.deletionDepth++;let deleted:number;
    try{deleted=this.store.immediateTransaction(() => {
      const project = this.store.get<{ retention_days: number | null }>('SELECT retention_days FROM projects WHERE id = ?', [projectId]);
      if (!project) throw new Error('unknown_project');
      if (project.retention_days === null) throw new Error('retention_not_configured');
      const cutoff = Date.parse(now) - project.retention_days * 86400000;
      const tasks = this.store.all<{ id: string; finalized_at: string }>("SELECT id,finalized_at FROM tasks WHERE project_id = ? AND state = 'finalized'", [projectId])
        .filter(task => Date.parse(task.finalized_at) <= cutoff);
      for (const task of tasks) {this.deleteTask(task.id);cleanupTasks.push(task.id);}
      return tasks.length;
    });}finally{this.deletionDepth--;}
    flushApplicationCleanup(this.store);flushWebMetadataCleanup(this.store);for(const taskId of cleanupTasks)assertApplicationCleanupDone(this.store,taskId);assertWebMetadataCleanupDone(this.store,'project',projectId);return deleted;
  }

  private deleteComparisonData(taskId: string): void {
    const now = TimestampSchema.parse(this.clock());
    for (const key of this.store.all<{ project_id: string; key_id: string }>(
      'SELECT project_id,key_id FROM comparison_identity_keys WHERE task_id = ?', [taskId])) {
      this.store.execute('INSERT OR IGNORE INTO comparison_identity_tombstones(project_id,key_id,deleted_at) VALUES (?,?,?)', [key.project_id, key.key_id, now]);
    }
    for (const protocolId of affectedComparisonProtocols(this.store, taskId)) {
      this.store.execute("UPDATE comparison_protocols SET status = 'invalidated_by_deletion', invalidated_reason = 'deletion', data_revision = data_revision + 1 WHERE id = ?", [protocolId]);
      const ids = this.store.all<{ report_id: string }>('SELECT report_id FROM comparison_report_snapshots WHERE protocol_id=? UNION ALL SELECT report_id FROM flexible_report_snapshots WHERE protocol_id=? ORDER BY report_id', [protocolId,protocolId]).map(row => row.report_id);
      if (ids.length) this.discloseReports(ids);
      invalidateComparisonSnapshots(this.store, protocolId, 'deletion', now);
      // Purge private shuffled queues and replay positions for the entire affected experiment.
      // Retained assignments may still support their ordinary scoped task lifecycle.
      this.store.execute('DELETE FROM comparison_allocation_state WHERE protocol_id = ?', [protocolId]);
    }
    // Task-scoped identity, assignment, confirmation and deviation rows cascade with tasks.
    // Snapshots, hashes, lineage and dependency mappings have been purged above.
  }

  private tombstone(kind: string, id: string): void {
    this.store.execute('INSERT OR IGNORE INTO tombstones(kind,id,deleted_at) VALUES (?,?,?)', [kind, id, TimestampSchema.parse(this.clock())]);
  }
}
