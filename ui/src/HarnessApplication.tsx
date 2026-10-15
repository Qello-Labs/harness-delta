import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Dialog,DialogContent,DialogFooter,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import type {Task,Locale} from './types';
import type {ApplicationChoice} from './application-actions';
interface Review {jobId:string;changes:{path:string;baseline:string;before:string|null;after:string|null;verified:boolean}[];checks:{check_id:string;outcome:string;evidence:'agent_reported'}[];workspace:{root:string;branch:string;head:string};scope:string}
interface Target {root:string;branch:string;head:string;digest:string}
type WorkspaceInspection={state:'checking'|'idle'|'error'}|{state:'ready';directory:string;target:Target};
interface Launch {prompt:string;workspace:string;product:string}
interface Handoff {guidance:string;readiness:string;variant_id:string;workspace:string;connect_context:{origin:string;task_id:string;product:string}}
export function HarnessApplication({task,locale,busy,onAction,onApply,shownHandoffs}:{task:Task;locale:Locale;busy:boolean;onAction:(action:string,input?:unknown)=>Promise<void>;onApply:(choice:ApplicationChoice)=>Promise<void>;shownHandoffs:Set<string>}){
 const app=task.application!;const t=(en:string,ko:string)=>locale==='ko'?ko:en;
 const [workspaceSelection,setWorkspaceSelection]=useState<{directory:string}|null>(null);const workspace=workspaceSelection?.directory??app.workspace??'';
 const [workspaceDraft,setWorkspaceDraft]=useState('');const [changingWorkspace,setChangingWorkspace]=useState(false);
 const [workspaceInspection,setWorkspaceInspection]=useState<WorkspaceInspection>({state:'checking'});const target=workspaceInspection.state==='ready'&&workspaceInspection.directory===workspace?workspaceInspection.target:null;
 const [product,setProduct]=useState(app.product??'codex');
 const [review,setReview]=useState<Review|null>(null);const [launch,setLaunch]=useState<Launch|null>(null);const [handoff,setHandoff]=useState<Handoff|null>(null);const [error,setError]=useState<string|null>(null);const [open,setOpen]=useState(false);
 const [confirmApply,setConfirmApply]=useState(false);
 const canPrepare=task.actions.find(action=>action.code==='application-prepare')?.enabled===true;
 const canUseApplyingContext=['awaiting_session','applying'].includes(app.state);
 const canRetryPreparation=task.actions.find(action=>action.code==='prepare')?.enabled===true;
 const capability=app.capabilities.find(c=>c.id===product);
 const agentName=(id:string)=>id==='codex'?'Codex':id==='claude_code'?'Claude Code':id;
 const measured=task.support_details?.context==='synthetic_validation_only'?null:task.support_details?.product??null;
 const applicationStates:Record<string,string>={
  awaiting_application:t('Application preparation','적용 준비'),
  awaiting_session:t('Waiting for application session','적용 세션 대기'),
  applying:t('Applying harness','하네스 적용 중'),
  applied:t('Files verified','파일 검증 완료'),
  blocked_configuration:t('Configuration needs attention','구성 확인 필요'),
  abandoned:t('New context needed','새 적용 문맥 필요'),
  failed:t('Application needs attention','적용 결과 확인 필요'),
 };
 const handoffReasons:Record<string,string>={
  application_identity_unavailable:t('Files are verified, but the applying session has no trusted identity receipt. Review instrumentation and trust before a new application attempt.','파일 검증은 완료됐지만 적용 세션의 신원 증명이 없습니다. 검토된 계측·신뢰 설정을 준비하고 새 적용 시도에서 신원을 확인해야 합니다.'),
  native_loading_and_source_qualification_required:t('The application session is told apart from the measured session (its identity is recorded, or a different agent applied). Ordinary measurement still requires instruction-loading and source qualification; a local pilot needs separate authorization.','적용 세션은 측정 세션과 구분됩니다(신원이 기록됐거나 다른 에이전트로 적용). 일반 실측에는 지침 로딩·원본 지원 검증이 더 필요하며, 제한적 로컬 pilot는 별도 활성화가 필요합니다.'),
 };
 useEffect(()=>{const controller=new AbortController();const refresh=async()=>{
  setReview(null);setLaunch(null);setHandoff(null);
  if(!app.jobId)return;
  const read=async<T,>(endpoint:string):Promise<T|null>=>{const response=await fetch(`/api/tasks/${task.id}/${endpoint}`,{cache:'no-store',signal:controller.signal});return response.ok?await response.json() as T:null;};
  try{const [nextLaunch,nextReview,nextHandoff]=await Promise.all([canUseApplyingContext?read<Launch>('application-launch-context'):Promise.resolve(null),read<Review>('application-review'),read<Handoff>('application-handoff')]);if(!controller.signal.aborted){setLaunch(nextLaunch);setReview(nextReview);setHandoff(nextHandoff);if(app.state==='applied'&&nextHandoff&&!shownHandoffs.has(app.jobId)){shownHandoffs.add(app.jobId);setOpen(true);}}}catch{if(!controller.signal.aborted)setError(t('Could not read application details. Return to this task to check again.','적용 상세를 읽지 못했습니다. 이 작업으로 돌아와 다시 확인하세요.'));}
 };const timer=setTimeout(()=>{void refresh();},0);return()=>{controller.abort();clearTimeout(timer);};},[task.id,task.version,app.jobId,app.state,locale,canUseApplyingContext,shownHandoffs]);
 useEffect(()=>{
  if(!canPrepare||!workspace){setWorkspaceInspection({state:'idle'});return;}
  const controller=new AbortController();setWorkspaceInspection({state:'checking'});
  void fetch(`/api/tasks/${task.id}/application-workspace?directory=${encodeURIComponent(workspace)}`,{cache:'no-store',signal:controller.signal}).then(async response=>{
   if(!response.ok)throw new Error('application_workspace_mismatch');
   const value=await response.json() as Target;
   if(!controller.signal.aborted)setWorkspaceInspection({state:'ready',directory:workspace,target:value});
  }).catch(()=>{if(!controller.signal.aborted)setWorkspaceInspection({state:'error'});});
  return()=>controller.abort();
 },[task.id,canPrepare,workspace,workspaceSelection]);
 const copy=(text:string)=>{void navigator.clipboard.writeText(text).catch(()=>setError(t('Select and copy the text manually.','텍스트를 선택하여 직접 복사하세요.')));};
 return <Card id="harness-application"><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>{t('Apply harness','하네스 적용')}</CardTitle><Badge variant={app.state==='applied'?'secondary':'outline'} role="status">{applicationStates[app.state]??app.state}</Badge></div><p className="text-sm text-muted-foreground">{t('Assigned harness','배정된 하네스')}: <span className="font-medium text-foreground">{task.preparation.assigned_variant_id??t('Assignment pending','배정 대기')}</span></p></CardHeader><CardContent className="space-y-5">
 <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
  <li>{t('A fresh application session edits the selected workspace.','새 적용 세션에서 선택한 작업 공간을 직접 수정합니다.')}</li>
  <li>{t('Approve file and command permissions in the native window.','파일·명령 권한은 네이티브 창에서 결정하세요.')}</li>
 </ul>
 {app.workspace&&!canPrepare&&<div className="rounded-lg bg-muted/40 p-3"><p className="mb-1 text-xs text-muted-foreground">{t('Workspace','작업 공간')}</p><p className="break-all text-sm">{app.workspace}</p></div>}
 {app.state==='blocked_configuration'&&<div className="space-y-3"><p>{t('Resolve the configuration blocker, then retry preparation for this same task. Native application becomes available after preparation; no legacy configuration is applied here.','구성 문제를 해결한 뒤 같은 작업의 준비를 재시도하세요. 준비가 완료되면 네이티브 적용을 진행할 수 있습니다.')}</p><Button variant="outline" disabled={busy||!canRetryPreparation} onClick={()=>{void onAction('prepare');}}>{t('Retry same task preparation','같은 작업 준비 재시도')}</Button></div>}
 {app.state==='abandoned'&&<p>{t('This applying context has expired. Inspect the target and prepare a new context to retry. Existing edits remain.','이 적용 문맥은 만료되었습니다. 대상을 확인하고 새 문맥을 준비해 재시도하세요. 기존 변경은 유지됩니다.')}</p>}
 {canPrepare&&<div className="space-y-4 rounded-lg border p-4"><div className="space-y-3" data-workspace-state={workspaceInspection.state}>
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{t('1. Workspace','1. 작업 공간')}</h3><Button data-workspace-action="change" variant="outline" disabled={busy||changingWorkspace} onClick={()=>{setWorkspaceDraft(workspace);setChangingWorkspace(true);}}>{t('Change workspace','작업 공간 변경')}</Button></div>
  {!target&&<p className="break-all text-sm">{workspace}</p>}
  {workspaceInspection.state==='checking'&&<p role="status" className="text-sm text-muted-foreground">{t('Checking the workspace and current branch…','작업 공간과 현재 브랜치를 확인하는 중입니다…')}</p>}
  {workspaceInspection.state==='error'&&<div role="alert" className="space-y-2"><p className="text-sm">{t('Could not check this workspace. Check the directory and repository, or choose another checkout/worktree.','작업 공간을 확인하지 못했습니다. 디렉토리와 저장소 상태를 확인하거나 다른 checkout/worktree를 선택하세요.')}</p><Button data-workspace-action="retry" variant="outline" disabled={busy} onClick={()=>{setWorkspaceInspection({state:'checking'});setWorkspaceSelection({directory:workspace});}}>{t('Check again','다시 확인')}</Button></div>}
 {target&&<div role="status" className="space-y-3 rounded-lg bg-muted/40 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{t('Current branch/worktree','현재 브랜치/worktree')}</h3><Badge variant="secondary">{t('Checked','확인 완료')}</Badge></div><dl className="space-y-3 text-sm"><div><dt className="text-muted-foreground">{t('Branch','브랜치')}</dt><dd className="mt-1 font-medium">{target.branch||t('Detached HEAD','분리된 HEAD')}</dd></div><div><dt className="text-muted-foreground">worktree</dt><dd className="mt-1 break-all">{target.root}</dd></div></dl><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('Commit (HEAD)','커밋 (HEAD)')}</summary><code className="mt-2 block break-all">{target.head}</code></details></div>}
  {changingWorkspace&&<div className="space-y-3 rounded-lg border p-4"><Label htmlFor="application-target">{t('Checkout / worktree directory','Checkout / worktree 디렉토리')}</Label><Input id="application-target" aria-describedby="application-target-help" value={workspaceDraft} disabled={busy} onChange={event=>setWorkspaceDraft(event.target.value)} placeholder="/path/to/project"/><p id="application-target-help" className="text-sm text-muted-foreground">{t('Enter the full directory path, not a branch name. The registered project is used by default.','브랜치명이 아닌 디렉토리 전체 경로를 입력하세요. 기본 작업 공간은 등록된 프로젝트입니다.')}</p><div className="flex flex-wrap gap-2"><Button data-workspace-action="use" disabled={busy||!workspaceDraft.trim()} onClick={()=>{setWorkspaceInspection({state:'checking'});setWorkspaceSelection({directory:workspaceDraft.trim()});setChangingWorkspace(false);}}>{t('Use this workspace','이 작업 공간 사용')}</Button><Button data-workspace-action="cancel" variant="outline" disabled={busy} onClick={()=>setChangingWorkspace(false)}>{t('Cancel','취소')}</Button></div></div>}
 </div>
 <div className="space-y-2"><Label htmlFor="application-product">{t('2. Agent','2. 에이전트')}</Label><select id="application-product" className="native-select" value={product} disabled={busy} onChange={event=>setProduct(event.target.value)}>{app.capabilities.map(c=><option key={c.id} value={c.id}>{c.product==='codex'?'Codex':c.product==='claude_code'?'Claude Code':c.product}{c.available?'':t(' · copy guidance',' · 복사 안내')}</option>)}</select>
 <p className="text-sm text-muted-foreground">{t('Any installed agent can apply the harness.','설치된 어떤 에이전트로도 하네스를 적용할 수 있습니다.')}{measured&&t(` The measured working session is connected separately with ${agentName(measured)}.`,` 측정할 작업 세션은 별도로 ${agentName(measured)}로 연결합니다.`)}</p>
 {measured&&product!==measured&&<p role="status" data-application-agent-differs="" className="text-sm">{t(`This agent differs from the measured agent, so the application session can never be the measured session and its identity is not required. Only a new ${agentName(measured)} session opened after the application can be connected.`,`측정 에이전트와 다른 에이전트입니다. 적용 세션이 측정 세션이 될 수 없으므로 적용 세션 신원 확인은 요구하지 않습니다. 적용이 끝난 뒤 새로 연 ${agentName(measured)} 세션만 연결할 수 있습니다.`)}</p>}</div>

 <Button data-application-action="apply" disabled={busy||changingWorkspace||!target} onClick={()=>setConfirmApply(true)}>{t('Apply','적용하기')}</Button></div>}
 {canUseApplyingContext&&launch&&<div className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">{app.state==='applying'?t('Application session context','현재 적용 세션 문맥'):t('Next: open an application session','다음 단계 · 새 적용 세션 열기')}</h3><p className="text-sm text-muted-foreground">{t('Installed CLI required for macOS Terminal opening. Native acceptance is unverified; an opening response does not prove agent startup.','macOS Terminal 열기에는 CLI 설치가 필요합니다. 네이티브 수용은 미검증이며, 열기 응답만으로 에이전트 시작을 확인할 수 없습니다.')}</p>
 {app.state==='awaiting_session'&&<Button disabled={busy||!app.capabilities.find(c=>c.id===launch.product)?.available||app.launchState!=='not_requested'} onClick={()=>{void onAction('application-open');}}>{t('Open fresh native session','새 네이티브 세션 열기')}</Button>}
 <p className="break-all text-xs text-muted-foreground">{app.launchState} · {capability?.reason}</p>
 <div className="border-t pt-3"><p className="mb-3 text-sm">{t('Or open a fresh session in the target and paste this context. Keep the saved assignment.','직접 새 세션을 열어 문맥을 붙여넣어도 됩니다. 저장된 배정은 유지하세요.')}</p><Button variant="outline" onClick={()=>copy(launch.prompt)}>{t('Copy application context','적용 문맥 복사')}</Button></div>
 <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">{t('View application context','적용 문맥 보기')}</summary><textarea readOnly aria-label={t('Application context','적용 문맥')} className="mt-3 w-full rounded border p-3 font-mono text-xs" rows={5} value={launch.prompt}/></details></div>}
 {review&&<div className="space-y-3"><h3>{t('Actual file changes after application','적용 후 실제 파일 변경')}</h3><p>{t('Only reported files are verified. Commands and scripts are agent reported, not independently observed.','보고된 파일만 검증합니다. 명령·스크립트 결과는 에이전트 보고이며 독립적으로 관찰한 실행 증거가 아닙니다.')}</p>{review.checks.length?review.checks.map(check=><p key={check.check_id}>{check.check_id} · {check.outcome} · {check.evidence}</p>):<p>{t('Verification checks missing','검사 결과 없음')}</p>}
 {review.changes.map(change=><details key={change.path} className="rounded border p-3"><summary>{change.path} · {change.verified?t('hash verified','해시 검증됨'):t('file drift','파일 변경됨')} · {change.baseline}</summary><div className="grid gap-3 md:grid-cols-2"><pre className="overflow-auto whitespace-pre-wrap text-xs">{change.before??t('(absent, binary, or missing baseline)','(기존 파일 없음·바이너리·기준 없음)')}</pre><pre className="overflow-auto whitespace-pre-wrap text-xs">{change.after??t('(absent or binary)','(파일 없음·바이너리)')}</pre></div></details>)}</div>}
 {app.jobId&&['awaiting_session','applying','applied','failed'].includes(app.state)&&<div className="space-y-2 border-t pt-4"><Button variant="outline" disabled={busy} onClick={()=>{void onAction('application-cancel');}}>{t('Abandon attempt','적용 시도 포기')}</Button><p className="text-xs text-muted-foreground">{t('Invalidates this attempt; edits remain. Stop the external agent in its native window.','이 시도는 무효화되며 변경 파일은 유지됩니다. 외부 에이전트는 네이티브 창에서 중지하세요.')}</p></div>}
 {app.state==='applied'&&handoff&&<Button variant="outline" onClick={()=>setOpen(true)}>{t('New working-session guidance','새 실제 작업 세션 안내')}</Button>}
 {app.reason&&<p>{app.reason}</p>}{error&&<p role="alert">{error}</p>}
 <Dialog open={confirmApply} onOpenChange={value=>{if(!busy)setConfirmApply(value);}}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>{t('Apply this harness?','이 하네스를 적용할까요?')}</DialogTitle><DialogDescription>{capability?.available?t('Start an application agent in the branch/worktree below. File and command permissions are decided in the agent window.','아래 브랜치/worktree에서 적용 에이전트를 시작합니다. 파일·명령 권한은 에이전트 창에서 결정하세요.'):t('Automatic opening is unavailable. Prepare the application context, then open the agent yourself and paste it.','자동 열기를 사용할 수 없습니다. 적용 문맥을 준비한 뒤 에이전트를 직접 열어 붙여넣으세요.')}</DialogDescription></DialogHeader>
 <dl className="space-y-4 rounded-lg bg-muted/40 p-4 text-sm"><div><dt className="text-muted-foreground">{t('Branch','브랜치')}</dt><dd className="mt-1 font-medium">{target?.branch||t('Detached HEAD','분리된 HEAD')}</dd></div><div><dt className="text-muted-foreground">worktree</dt><dd className="mt-1 break-all">{target?.root}</dd></div><div><dt className="text-muted-foreground">{t('Harness','하네스')}</dt><dd className="mt-1 break-all font-medium">{task.preparation.assigned_variant_id??t('Assignment pending','배정 대기')}</dd></div><div><dt className="text-muted-foreground">{t('Agent','에이전트')}</dt><dd className="mt-1">{product==='codex'?'Codex':product==='claude_code'?'Claude Code':product}</dd></div></dl>
 <p className="text-xs text-muted-foreground">{t('This starts application, not measurement. Opening alone does not prove completed file changes.','하네스 적용을 시작하며 측정은 시작하지 않습니다. 세션 열기만으로 파일 적용 완료가 확인되지는 않습니다.')}</p>
 <DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setConfirmApply(false)}>{t('Cancel','취소')}</Button><Button data-application-action="confirm" disabled={busy||changingWorkspace||!canPrepare||!target} onClick={()=>{if(target){setConfirmApply(false);void onApply({workspace:target.root,workspaceDigest:target.digest,product});}}}>{t('Apply','적용하기')}</Button></DialogFooter></DialogContent></Dialog>
 <Dialog open={open&&app.state==='applied'&&!!handoff} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{t('Start a separate working session','별도 실제 작업 세션 시작')}</DialogTitle><DialogDescription>{t('File verification, instruction loading, and measurement readiness are separate facts.','파일 검증·지침 로딩·측정 준비 상태는 별도 사실입니다.')}</DialogDescription></DialogHeader>{handoff&&<><p className="break-all">{handoff.variant_id} · {handoff.workspace}</p><p className="text-sm">{handoffReasons[handoff.readiness]??handoff.readiness}</p><textarea readOnly aria-label={t('Working-session handoff','작업 세션 전달 안내')} className="w-full rounded border p-3 text-xs" rows={6} value={handoff.guidance}/><Button onClick={()=>copy(handoff.guidance)}>{t('Copy working-session guidance','작업 세션 안내 복사')}</Button></>}</DialogContent></Dialog>
 </CardContent></Card>;
}
