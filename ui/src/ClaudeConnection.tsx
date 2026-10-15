import { useState, type ReactNode } from 'react';
import { Check, Copy, Pause, Play } from 'lucide-react';
import { Button } from './components/ui/button.js';
import { Badge } from './components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';
import { claudeConnectionBlocker, claudeConnectionStage, claudeConnectPrompt } from './claude-connection-state.js';
import type { Locale, Task } from './types.js';

export function ClaudeConnection({ task, projectName, origin, locale, busy, online, onAction, reason, installation }: {
  task: Task; projectName: string; origin: string; locale: Locale; busy: boolean; online: boolean;
  onAction: (code: string) => void; reason: (code: string) => string;
  installation?: ReactNode;
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const stage = claudeConnectionStage(task);
  const readiness = task.connection_readiness;
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  if (!stage || !readiness) return null;
  const ordinary = task.mode === 'ordinary';
  const linked = ordinary ? !!task.binding?.selected_root_id : (task.binding?.roots ?? 0) > 0;
  const observing = stage === 'measuring' || stage === 'starting';
  const prompt = claudeConnectPrompt(task, origin, locale);
  const reconnect = stage === 'paused' && !task.actions.some(action => action.code === 'resume-binding' && action.enabled)
    && readiness.skill.state === 'installed' && task.actions.some(action => action.code === 'session-connect' && action.enabled);
  const copyText = stage === 'install' ? readiness.skill.install_command : stage === 'ready' || reconnect ? prompt : null;
  const control = observing ? 'pause' : stage === 'paused' && !reconnect ? 'resume-binding' : null;
  const controlOption = task.actions.find(action => action.code === control);
  const stop = task.actions.find(action => action.code === 'stop-observation');
  const blocker = claudeConnectionBlocker(task);
  const labels = {
    install: t('Installation needed', '설치 필요'), conflict: t('Existing files need review', '기존 파일 확인 필요'),
    unknown: t('Installation not confirmed', '설치 미확인'), blocked: t('Connection unavailable', '연결 불가'),
    ready: t('Waiting for connection', '연결 대기'), starting: t('Starting measurement', '측정 시작 중'),
    measuring: t('Measuring', '측정 중'), paused: t('Measurement paused', '일시중단'),
    revoked: t('Collection revoked', '관측 권한 철회됨'), ended: t('Measurement ended', '측정 종료'),
  };
  const titles = {
    install: t('This project needs the connection skill.', '이 프로젝트에 연결 도구가 필요합니다.'),
    conflict: t('Your existing connection files were preserved.', '기존 연결 파일을 보존했습니다.'),
    unknown: t('Installation could not be confirmed.', '설치 상태를 확인하지 못했습니다.'),
    blocked: t('This environment cannot connect yet.', '아직 이 환경에서 연결할 수 없습니다.'),
    ready: t('Paste once in Claude.', 'Claude에 한 번 붙여넣으세요.'),
    starting: t('Wait for measurement to become active.', '측정 중으로 바뀌면 작업을 시작하세요.'),
    measuring: t('Connected. Continue your work.', '연결됐습니다. 작업을 시작하세요.'),
    paused: t('Measurement is paused.', '측정이 일시중단됐습니다.'),
    revoked: t('Collection has stopped permanently for this task.', '이 작업의 수집이 영구 중단됐습니다.'),
    ended: t('Measurement has ended.', '측정이 종료됐습니다.'),
  };
  const descriptions = {
    install: ordinary ? t('Review the project-only package changes below before installing. Existing files and global settings are preserved.',
      '아래에서 프로젝트 전용 패키지 변경을 검토한 뒤 설치하세요. 기존 파일과 전역 설정은 보존합니다.') : t('Copy the project-only command and run it in your terminal. Existing files are not overwritten.',
      '설치 명령을 복사해 터미널에서 실행하세요. 기존 파일과 전역 설정은 변경하지 않습니다.'),
    conflict: t('Review the existing package before changing anything. No replacement command is provided.',
      '기존 패키지를 먼저 검토하세요. 파일을 덮어쓰는 명령은 제공하지 않습니다.'),
    unknown: t('Check access to this project and the bundled skill. Unknown is not installed.',
      '프로젝트와 제공된 스킬 패키지에 접근할 수 있는지 확인하세요. 미확인은 설치 완료가 아닙니다.'),
    blocked: blocker ? reason(blocker) : t('Review the source support and this task’s observation authority.',
      '연결 경로의 지원 상태와 이 작업의 관측 권한을 확인하세요.'),
    ready: ordinary ? t('Installation is confirmed. Invoke the skill in your current native parent. Earlier usage is excluded.',
      '설치는 확인됐습니다. 현재 네이티브 부모에서 skill을 호출하세요. 이전 사용량은 제외합니다.') : t('Installation is confirmed. Run the prompt in a separate fresh working session, not the application session.',
      '설치는 확인됐습니다. 적용 세션이 아닌 별도의 새 작업 세션에서 문구를 실행하세요.'),
    starting: t('Connection and active collection are separate facts. Start work only after the active state is confirmed.',
      '세션 연결과 수집 활성화는 별도 상태입니다. 측정 중 표시를 확인한 뒤 작업하세요.'),
    measuring: t('Continue in the connected Claude session. Only eligible new usage is collected.',
      '연결된 Claude 세션에서 계속 작업하세요. 관측 가능한 새 사용량만 수집합니다.'),
    paused: t('Claude and its metadata hooks may keep running. Paused usage is not backfilled.',
      'Claude와 세션 hook은 계속 실행될 수 있습니다. 중단 구간은 소급 수집하지 않습니다.'),
    revoked: t('Claude may keep running. This page cannot restore revoked authority.',
      'Claude는 계속 실행될 수 있습니다. 이 화면에서 철회된 권한을 복구할 수 없습니다.'),
    ended: t('Review usage and record the task outcome separately.', '사용량을 검토하고 작업 결과는 별도로 판정하세요.'),
  };
  async function copy(text: string) {
    setCopyStatus('idle');
    try { await navigator.clipboard.writeText(text); setCopyStatus('copied'); }
    catch { setCopyStatus('failed'); }
  }
  return <Card id="claude-connection" data-connection-stage={stage}
    data-ordinary-connection={ordinary ? task.id : undefined} data-observation-state={ordinary ? task.measurement.state : undefined}>
    <CardHeader>
      <div className="flex items-center justify-between gap-3"><CardTitle>{t('Claude connection', 'Claude 연결')}</CardTitle><Badge variant="secondary">{labels[stage]}</Badge></div>
    </CardHeader>
    <CardContent className="space-y-6 pt-6">
      <ol aria-label={t('Connection progress', '연결 진행 상태')} className="flex items-center gap-3 text-sm">
        {[t('Check installation', '설치 확인'), t('Connect', '연결'), t('Measure', '측정')].map((label, index) => {
          const done = index === 0 ? readiness.skill.state === 'installed' : index === 1 ? linked : stage === 'measuring';
          const current = index === 0 ? ['install', 'conflict', 'unknown'].includes(stage) : index === 1 ? ['ready', 'blocked'].includes(stage) : observing || stage === 'paused';
          return <li key={label} className="flex flex-1 items-center gap-2" aria-current={current ? 'step' : undefined}>
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${current ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
              {done ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
            </span><span className={current ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
          </li>;
        })}
      </ol>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{ordinary
          ? t(`Ordinary observation · all Claude-family models · family limit ${task.binding?.max_family_members ?? '—'}`,
            `일반 관측 · 모든 Claude 계열 모델 허용 · 가족 한도 ${task.binding?.max_family_members ?? '—'}`)
          : t('Restricted pilot · not ordinary production support', '제한된 pilot · 일반 환경 지원 아님')}</p>
        <h2 className="text-xl font-semibold tracking-tight">{titles[stage]}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{descriptions[stage]}</p>
      </div>
      <dl className="flex flex-wrap gap-8 text-sm"><div><dt className="text-xs text-muted-foreground">{t('Project', '프로젝트')}</dt><dd className="mt-1">{projectName}</dd></div><div><dt className="text-xs text-muted-foreground">{t('Task', '연결할 작업')}</dt><dd className="mt-1">{task.name}</dd></div></dl>
      {copyText && <div className="space-y-3">
        {stage === 'install' ? <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">{t('View installation command', '터미널 설치 명령 보기')}</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 font-mono text-xs">{copyText}</pre></details>
          : <pre data-connection-prompt="" className="whitespace-pre-wrap break-all rounded-lg bg-muted p-4 font-mono text-sm">{copyText}</pre>}
        <Button data-connection-action="copy" disabled={busy || !online} onClick={() => { void copy(copyText); }}><Copy />{stage === 'install' ? t('Copy installation command', '설치 명령 복사') : t('Copy connection prompt', '호출 문구 복사')}</Button>
        <p role="status" className="text-xs text-muted-foreground">{copyStatus === 'copied' ? t('Copied. Execute it, then check the server state here.', '복사했습니다. 실행한 뒤 이 화면에서 상태를 확인하세요.')
          : copyStatus === 'failed' ? t('Select the text and copy it manually.', '문구를 펼쳐 선택한 뒤 직접 복사하세요.')
            : stage === 'install' ? t('Copying does not confirm installation or start collection.', '복사만으로 설치 완료 처리하거나 측정을 시작하지 않습니다.')
              : t('Invocation registers this session’s hooks. Verified connection starts measurement when authorized.', '호출하면 이 세션의 hook이 등록됩니다. 권한이 있는 연결이 확인되면 측정이 시작됩니다.')}</p>
      </div>}
      {ordinary && ['install', 'conflict', 'unknown'].includes(stage) && installation}
      {control && <div className="space-y-2">
        <Button data-connection-action={control} variant={observing ? 'outline' : 'default'} disabled={busy || !online || !controlOption?.enabled} onClick={() => onAction(control)}>
          {observing ? <Pause /> : <Play />}{observing ? t('Pause measurement', '측정 일시중단') : t('Resume measurement', '측정 재개')}
        </Button>
        {!controlOption?.enabled && controlOption?.reason && <p className="text-sm text-muted-foreground">{reason(controlOption.reason)}</p>}
      </div>}
      {ordinary && !task.outcome && (linked || stop?.enabled) && <div className="space-y-2 border-t pt-4">
        <Button data-task-action="stop-observation" data-connection-action="stop-observation" variant="outline"
          disabled={busy || !online || !stop?.enabled} onClick={() => onAction('stop-observation')}>
          {t('Stop observation · keep Claude running', '관측 종료 · Claude 유지')}
        </Button>
        {!stop?.enabled && stop?.reason && <p className="text-sm text-muted-foreground">{reason(stop.reason)}</p>}
        <p className="text-xs leading-relaxed text-muted-foreground">{t('Pause keeps the selected observation. Stop releases this task’s ownership so another task can connect the retained native root. Neither action exits Claude; excluded usage is not backfilled.',
          '일시중단은 선택된 관측을 유지합니다. 관측 종료는 작업 소유권을 해제해 다른 작업이 유지된 native root에 연결할 수 있게 합니다. 두 동작 모두 Claude를 종료하지 않으며 제외된 사용량은 소급 수집하지 않습니다.')}</p>
      </div>}
      {['blocked', 'conflict', 'unknown', 'revoked'].includes(stage) && <Button data-connection-action="diagnostics" variant="outline" onClick={() => setDiagnosticsOpen(true)}>
        {t('Check connection requirements', '연결 조건 확인')}
      </Button>}
      <p role="status" data-connection-status="" className="rounded-lg bg-muted/50 p-4 text-sm">
        {stage === 'ready' ? t('Session confirmation is pending until invocation. This screen refreshes automatically.', '호출 전에는 세션 확인 대기 상태입니다. 호출 후 이 화면이 자동 갱신됩니다.')
          : stage === 'measuring' && (task.binding?.requests ?? 0) === 0 ? t('Measuring · waiting for first usage. Cost is unknown, not zero.', '측정 중 · 첫 사용량을 기다리는 중입니다. 비용은 0이 아닌 미확인입니다.')
            : labels[stage]}
      </p>
      <details open={diagnosticsOpen} onToggle={event => setDiagnosticsOpen(event.currentTarget.open)} className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">{t('Installation and connection diagnostics', '설치·연결 진단 보기')}</summary>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          {[
            [t('Project skill', '프로젝트 스킬'), readiness.skill.state],
            [t('Current session', '현재 세션 확인'), linked ? t('Verified binding', '연결 신원 확인됨') : t('Pending native hook evidence', '호출 후 hook 기록 확인 대기')],
            [t('Task binding', '작업 연결'), linked ? t('Confirmed', '확인됨') : t('Not connected', '미연결')],
            [t('Collection', '수집 상태'), labels[stage]],
            [t('Source trust', '연결 경로 신뢰 상태'), task.binding?.support ?? 'qualification_required'],
          ].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-all">{value}</dd></div>)}
        </dl>
        {blocker && <p data-connection-blocker={blocker} className="mt-4">{reason(blocker)} <code className="text-xs">{blocker}</code></p>}
        {readiness.skill.reason && <p className="mt-2 text-xs text-muted-foreground">{readiness.skill.reason}</p>}
        {stage === 'blocked' && readiness.skill.install_command && <pre className="mt-3 whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{readiness.skill.install_command}</pre>}
        <p className="mt-4 text-xs text-muted-foreground">{t('File installation, session hooks, source support and task authority are separate checks. This page grants no authority.',
          '파일 설치·세션 hook·연결 경로 지원·작업 관측 권한은 별도 조건입니다. 이 화면에서 권한을 부여하지 않습니다.')}</p>
      </details>
      <p className="text-xs text-muted-foreground">{t('Measurement data excludes conversation and source-code content. Costs are partial estimates, not bills.',
        '측정 데이터에 대화·코드 내용을 포함하지 않습니다. 비용은 부분 추정이며 청구액이 아닙니다.')}</p>
    </CardContent>
  </Card>;
}
