import { CommanderError } from 'commander';
import { z } from 'zod';

// Internal failures use fixed snake_case codes. Anything else (filesystem,
// SQLite constraint, JSON or producer text) may carry paths or content and is
// replaced by the generic fallback.
const codePattern = /^[a-z][a-z0-9_]{1,63}$/;
// Schema keys are lowercase snake_case; anything else may be a user record key.
const keyPattern = /^[a-z][a-z0-9_]{0,63}$/;
const fallback = 'input_or_state_error';

/** One-line next actions for codes a first-time workflow user commonly meets. */
const hints: Record<string, string> = {
  application_preview_changed: 'run application preview again and review the current files before restoring',
  application_restore_conflict: 'preserve and review changed or unreported checkpoint files; no files were restored',
  application_restoration_required: 'finish restoration in the current workspace before reapplying or selecting another worktree',
  application_changes_staged: 'remove application edits and private records from the index, restage intended work, and rerun application check-staged',
  binary_mismatch: 'binary SHA-256 differs from execution.binary.sha256 or the pinned product hash; nothing was assigned or started',
  binary_unreadable: 'execution.binary.path must be an absolute canonical regular file; nothing was assigned or started',
  invalid_hook_recorder: 'execution.hook_recorder must be the unmodified start recorder from this checkout; see the workflow quickstart',
  invalid_prompt: 'execution.prompt_file must be a canonical UTF-8 file of at most 1 MiB without NUL bytes',
  unsafe_home: 'execution.codex_home must be an existing canonical directory',
  invalid_execution: 'execution file does not match the operation schema; see docs/runbooks/workflow-quickstart.md',
  config_file_unreadable: 'cannot read the --config file',
  config_file_invalid_json: 'the --config file is not valid JSON',
  runtime_file_unreadable: 'cannot read the --runtime file',
  runtime_file_invalid_json: 'the --runtime file is not valid JSON',
  execution_file_unreadable: 'cannot read the --execution file',
  execution_file_invalid_json: 'the --execution file is not valid JSON',
  workflow_operation_mismatch: 'execution.operation must match the subcommand (launch, resume, link or collect)',
  codex_workflow_source_unqualified: 'this product version/profile is not admitted for native execution',
  workflow_adapter_mismatch: 'the protocol source profile, product version and adapter do not match',
  real_experiment_disabled: 'the protocol is not frozen and ready for real allocation; check `workflow status <protocol-id>`',
  confirmation_conflict: 'confirmation_id was already used; pass --confirmation <new-id> or use a new ID in the config',
  workflow_run_active: 'another run for this task is still marked running; stop it, or recover it if its process is gone',
  workflow_manifest_mismatch: 'selected instruction files changed since the variant was registered',
  selected_artifact_error: 'selected instruction files must be canonical UTF-8 regular files within the size limits',
  invalid_transition: 'the task is not in a state that allows this command; check `workflow task <task-id>`',
  invalid_criteria: 'success requires every criterion ID in --met; other outcomes accept a subset',
  task_not_assigned: 'the task has no comparison assignment; start it with a workflow launch or begin',
  unknown_task: 'no task with this ID exists in the database',
  workflow_scope_revoked: 'the task was paused, finished, deleted or reconfigured while the run was in progress',
  workflow_adapter_failed: 'the adapter failed with an unlisted error; the task was paused if this run activated it',
  workflow_preflight_failed: 'local preflight failed with an unlisted error; nothing was assigned or started',
  codex_workflow_failed: 'see adapter_result.reason and diagnostic in the printed receipt',
  claude_workflow_failed: 'see adapter_result.reason in the printed receipt',
  workflow_run_not_running: 'only a run still marked running can be recovered',
  invalid_cutoff: 'the cutoff must be a UTC time no later than now',
  unknown_codex_workflow_run: 'no Codex run with this ID; check run IDs with `workflow task <task-id>`',
  claude_workflow_run_missing: 'no Claude run with this ID; check run IDs with `workflow task <task-id>`',
  claude_workflow_version_not_latest: 'a new non-synthetic protocol may list at most one entry per claude_code workflow source profile, at that profile\'s newest admitted version (none while no version is admitted); functional_pilot may instead use one own-trace version in its conditional window; a registered protocol keeps its version until retirement, then its tasks need a new protocol',
  claude_workflow_child_unadmitted: 'Claude child execution needs the exact direct-child admission of this version; remove child_runtime for a conditional or parent-only version',
  claude_workflow_child_read_only_required: 'a Claude child execution must use permissions "read-only"',
  claude_workflow_resume_unadmitted: 'keeping or resuming a Claude session needs the exactly admitted version; remove resumable or use launch for a conditional version',
  claude_workflow_resume_source_invalid: 'resume_run_id must name a finished, resumable, parent-only run of this task with the same Claude Code version, and the same workspace must still hold its run directory',
  claude_workflow_harness_inside_project: 'with workspace-edit, the workspace, harness-delta build, prompt, Claude binary and database must be verifiably outside the registered project root',
  claude_workflow_private_workspace_required: 'the Claude workspace must be a canonical directory with mode 0700',
};

function safePath(path: readonly PropertyKey[]): string {
  if (!path.length) return '(root)';
  return path.map(part => typeof part === 'number' ? `[${part}]` : typeof part === 'string' && keyPattern.test(part) ? part : '?').join('.');
}

/** Lines for stderr. Never includes input values, paths or producer messages. */
export function describeCliError(error: unknown): string[] {
  try {
    if (error instanceof CommanderError) {
      // Missing names come from command definitions; other usage errors may echo argv.
      const detail = ['commander.missingMandatoryOptionValue', 'commander.optionMissingArgument', 'commander.missingArgument'].includes(error.code)
        ? error.message.replace(/^error: /, '').trim() : error.code.replace(/^commander\./, '');
      return [`invalid_command: ${detail}`, 'hint: run the command with --help for usage'];
    }
    if (error instanceof z.ZodError) {
      return ['invalid_input', ...error.issues.slice(0, 5).map(issue => `  at ${safePath(issue.path)}: ${codePattern.test(issue.message) ? issue.message : issue.code}`)];
    }
    if (error instanceof Error && codePattern.test(error.message)) {
      const hint = hints[error.message];
      return hint ? [error.message, `hint: ${hint}`] : [error.message];
    }
  } catch { /* fall through to the generic code */ }
  return [fallback];
}
