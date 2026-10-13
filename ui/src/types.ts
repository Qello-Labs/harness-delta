import type { AgentDisplayMetadata } from './session-labels.js';
import type { localWebSupport } from '../../src/local-web-domain.js';
export type SupportDetails = ReturnType<typeof localWebSupport>;
export type Locale = 'ko' | 'en';
export interface Project { id: string; name: string; directory: string; baseline: string | null; setup_ids: string[] }
export interface Setup { id: string; name: string; project_id: string; arm_a: string; arm_b: string; types: string[]; sizes: string[]; support: string; support_details?: SupportDetails; shared?: {revision_id:string;template_id:string;template_name:string;runtime:{model:string|null;effort:string|null}} }
export interface TaskAction { code: string; enabled: boolean; reason: string | null }
export interface BindingReading {status: 'observed'|'partial'|'missing';value:number|null;statuses:string[];reasons:string[]}
export interface CostAmounts { partial_amount:string|null;currency:string|null;compatibility_unverified_partial_amount?:string|null;legacy_unverified_partial_amount?:string|null;compatibility?:{invalidated_events:number}|null }
export interface BindingSummary extends CostAmounts {requests:number|null;input_total:BindingReading;output_total:BindingReading;unpriced_events:number;price_table_id:string|null;complete_cost:null}
export interface Task {
 connection_readiness?: {
  skill: { state: 'installed' | 'missing' | 'conflict' | 'unavailable'; reason: string | null; install_command: string | null };
  configured_version: string; installed_version: string | null; collection_revoked: boolean;
 };
 support_details?: SupportDetails;
 application?:{product?:string|null;launchState:string;identity:string;state:string;jobId:string|null;epoch:number;reason:string|null;workspace:string|null;baseline:string;capabilities:{id:string;product:string;available:boolean;reason:string|null}[]};
 id: string; name: string; project_id: string; setup_id: string; version: string; state: string; status: string;
 measurement: { end_condition?: 'explicit_stop' | 'followup_deadline'; state: string; active_ms: number | null; requests: number | null; window: { started_at: string | null; ends_at: string | null } };
 outcome: { status: string; assessed_at: string } | null; attempt: number;
 preparation: { state: string; configuration_evidence: string; native_context_evidence: string; freshness_evidence: string; tool_use_evidence: string; assigned_variant_id: string | null };
 price: CostAmounts & { currency: string; unpriced_events: number; basis: string | null };
 actions: TaskAction[]; startup: { start_command: string; ticket_id: string } | null;
 criteria: string[]; source: { handle: string; label: string } | null; reason: string | null;
 binding?: { product?: 'codex'|'claude_code'; state: string; roots: number; children: number; requests: number | null; gaps: string[]; cost_coverage: 'partial'; support: string; sessions: (BindingSummary & {session_id:string;parent_session_id:string|null;agent_metadata?:AgentDisplayMetadata|null;models?:string[]})[];summary:BindingSummary };
}
export interface Catalog { status: string; catalog_version: number | null; verified_at: string | null; verification_age_days?: number | null;
 online_source?: { status: string; publisher_id: string | null }; reason: string | null; can_attempt_online_refresh?: boolean }
export interface Snapshot { projects: Project[]; setups: Setup[]; tasks: Task[]; catalog: Catalog | null }
