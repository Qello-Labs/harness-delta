import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { IdSchema } from './contracts.js';

const invalid = (): never => { throw new Error('claude_probe_hook_invalid'); };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (value: unknown): string => { const result = IdSchema.safeParse(value); return result.success ? result.data : invalid(); };
const events = ['SessionStart', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'SessionEnd'];
/** Strip native prompt/tool input, response and transcript fields before transport. */
export function projectClaudeProbeHook(input: unknown): Record<string, unknown> {
  if (!object(input) || typeof input.hook_event_name !== 'string' || !events.includes(input.hook_event_name)) return invalid();
  const result: Record<string, unknown> = { hook_event_name: input.hook_event_name, session_id: field(input.session_id) };
  // Observed 2.1.288 and 2.1.291 print-mode SessionStart carry no model; a present value is still validated.
  if (input.hook_event_name === 'SessionStart') { result.source = field(input.source); if (input.model !== undefined) result.model = field(input.model); }
  if (input.hook_event_name === 'SubagentStart' || input.hook_event_name === 'SubagentStop') {
    result.agent_id = field(input.agent_id); result.agent_type = field(input.agent_type);
  }
  if (input.hook_event_name === 'PreToolUse') {
    const toolInput = input.tool_input;
    if (!object(toolInput)) return invalid();
    result.tool_name = field(input.tool_name); result.tool_use_id = field(input.tool_use_id);
    const control: Record<string, unknown> = { subagent_type: field(toolInput.subagent_type) };
    if (toolInput.model !== undefined) control.model = field(toolInput.model);
    // 2.1.292 added effort and 2.1.296 exposes isolation on the Agent tool input.
    if (toolInput.effort !== undefined) control.effort = field(toolInput.effort);
    if (toolInput.resume !== undefined) control.resume = true; // Presence rejects resume; no private value is forwarded.
    if (toolInput.isolation !== undefined) control.isolation = true; // Presence rejects another working directory.
    if (toolInput.run_in_background !== undefined) {
      if (typeof toolInput.run_in_background !== 'boolean') invalid(); control.run_in_background = toolInput.run_in_background;
    }
    result.tool_input = control;
  }
  return result;
}
function checkedEndpoint(endpoint: string): void {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(endpoint);
  if (!match || Number(match[1]) > 65535) invalid();
}
function readCredential(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 512) invalid();
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) invalid(); offset += count; }
    const token = bytes.toString('utf8'); if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) invalid(); return token;
  } finally { closeSync(fd); }
}
/** Creates only caller-owned ephemeral credential material; never user credentials.
 * `mediatorPath` must name the built module, and no hook or product is executed.
 */
export async function prepareClaudeProbeHookMediator(workspace: string, endpoint: string, headers: Readonly<Record<string, string>>,
  mediatorPath: string, nodeExecutable = process.execPath) {
  checkedEndpoint(endpoint); const token = headers['x-harness-delta-token'];
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(token)) return invalid();
  const directory = await mkdtemp(join(workspace, 'hook-ephemeral-')); const credentialPath = join(directory, 'process-token');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try { await writeFile(credentialPath, token, { mode: 0o600, flag: 'wx' }); }
  catch { await dispose(); throw new Error('claude_probe_hook_prepare_failed'); }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return { credentialPath, hookCommand: [nodeExecutable, mediatorPath, endpoint, credentialPath].map(quote).join(' '), dispose };
}

/** A native hook calls this built module with endpoint + own process-token path.
 * Input is transient and bounded, output is a fixed decision without raw errors.
 */
export async function runClaudeProbeHookMediator(argv: readonly string[]): Promise<number> {
  let event: string | undefined;
  try {
    if (argv.length !== 2) invalid(); const endpoint = argv[0]!; checkedEndpoint(endpoint);
    const token = readCredential(argv[1]!); const chunks: Buffer[] = []; let size = 0;
    for await (const raw of process.stdin) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)); size += chunk.length;
      if (size > 65536) invalid(); chunks.push(chunk);
    }
    const metadata = projectClaudeProbeHook(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); chunks.length = 0;
    event = metadata.hook_event_name as string;
    const body = JSON.stringify(metadata);
    await new Promise<void>((resolve, reject) => {
      const req = request(endpoint + '/v1/hooks', { method: 'POST', headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-harness-delta-token': token,
      } }, response => {
        response.resume(); response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('rejected')));
      });
      const timeout = setTimeout(() => { req.destroy(new Error('timeout')); }, 1500);
      req.once('close', () => clearTimeout(timeout)); req.once('error', reject); req.end(body);
    });
    process.stdout.write('{}\n'); return 0;
  } catch {
    process.stdout.write(JSON.stringify({ continue: false, stopReason: 'claude_probe_hook_rejected',
      ...(event === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'claude_probe_hook_rejected' } } : {}) }) + '\n');
    return 2;
  }
}
function isMain(path: string | undefined): boolean {
  try { return path !== undefined && realpathSync(path) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isMain(process.argv[1])) process.exitCode = await runClaudeProbeHookMediator(process.argv.slice(2));
