import { type ReactNode, useState } from 'react';
import { Check, Copy, Pause, Play } from 'lucide-react';
import { Button } from './components/ui/button.js';
import { Badge } from './components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';
import { claudeConnectionBlocker, claudeConnectionStage, claudeConnectPrompt } from './claude-connection-state.js';
import type { Locale, Task } from './types.js';

export function ordinaryWindowReason(code: string, locale: Locale) {
  const labels: Readonly<Record<string, readonly [string, string]>> = {
    binding_window_activation_required: [
      'Separate product activation and native acceptance are required.',
      '별도 제품 활성화와 네이티브 acceptance가 필요합니다.'
    ],
    ordinary_window_collection_disabled: ['Window collection is disabled.', 'Window 수집은 비활성 상태입니다.'],
    binding_scope_revoked: ['Observation authority was revoked.', '관측 권한이 철회됐습니다.'],
    binding_scope_mismatch: ['The observation scope does not match.', '관측 범위가 일치하지 않습니다.'],
    binding_ordinary_assignment_conflict: ['Comparison assignment is not allowed for this window.', '이 window에서는 비교 배정을 허용하지 않습니다.'],
    compatibility_invalidated: ['Compatibility evidence was invalidated.', '호환성 증거가 무효화됐습니다.'],
    binding_window_trial_expired: ['The bounded trial has expired.', '제한된 trial이 만료됐습니다.'],
    binding_window_trial_budget_exhausted: ['The bounded trial budget is exhausted.', '제한된 trial 예산이 소진됐습니다.'],
    binding_fresh_root_required: ['A fresh root is required.', '새 루트가 필요합니다.'],
    binding_window_unavailable: ['The window is unavailable.', 'Window를 사용할 수 없습니다.'],
    binding_version_out_of_window: ['The declared version is outside the window.', '지정 버전이 window 범위 밖입니다.'],
    ordinary_project_setup_required: ['Save project settings first.', '프로젝트 설정을 먼저 저장하세요.'],
    ordinary_preparation_required: ['Prepare a new task first.', '새 작업을 먼저 준비하세요.'],
    ordinary_configuration_changed: ['Project configuration changed; prepare a new task.', '프로젝트 설정이 변경됐습니다. 새 작업을 준비하세요.'],
    installation_recovery_required: ['The interrupted installation needs review.', '중단된 설치를 검토해야 합니다.'],
    installation_preview_changed: ['Installation changed; review a new preview.', '설치 상태가 변경됐습니다. 새 미리보기를 검토하세요.'],
    ordinary_installation_in_use: ['The installed package is in use.', '설치된 패키지를 사용 중입니다.'],
    unsafe_path: ['A package path is unsafe.', '패키지 경로가 안전하지 않습니다.'],
    unsafe_project_root: ['The project root is unsafe.', '프로젝트 루트가 안전하지 않습니다.'],
    changed_path: ['A package path changed.', '패키지 경로가 변경됐습니다.'],
    unowned_directory: ['A directory is not owned by this package.', '이 패키지가 소유하지 않은 디렉토리입니다.'],
    package_invalid: ['The package is invalid.', '패키지가 올바르지 않습니다.'],
    metadata_unsafe: ['Package metadata permissions are unsafe.', '패키지 메타데이터 권한이 안전하지 않습니다.'],
    package_unowned: ['Existing package files are not owned.', '기존 패키지 파일의 소유권이 없습니다.'],
    manifest_unsafe: ['The installation manifest is unsafe.', '설치 manifest가 안전하지 않습니다.'],
    manifest_invalid: ['The installation manifest is invalid.', '설치 manifest가 올바르지 않습니다.'],
    changed_project_root: ['The project root changed.', '프로젝트 루트가 변경됐습니다.'],
    package_drift: ['Installed package files changed.', '설치된 패키지 파일이 변경됐습니다.'],
    installation_busy: ['The installer is busy.', '설치 작업이 진행 중입니다.'],
    package_source_unavailable: ['The package source is unavailable.', '패키지 원본을 사용할 수 없습니다.'],
    installation_preview_required: ['Review an installation preview first.', '설치 미리보기를 먼저 검토하세요.'],
    installation_cleanup_failed: ['Installation cleanup needs review.', '설치 정리 상태를 검토해야 합니다.'],
    installation_unavailable: ['Installation status is unavailable.', '설치 상태를 확인할 수 없습니다.']
  };
  const label = Object.hasOwn(labels, code) ? labels[code] : undefined;
  return label
    ? label[locale === 'ko' ? 1 : 0]
    : locale === 'ko'
      ? 'Window 상태를 확인할 수 없습니다. 수집은 비활성 상태입니다.'
      : 'Window status is unknown. Collection remains disabled.';
}

export function OrdinaryWindowStatus({ product, locale, reason }: { product: 'codex' | 'claude_code'; locale: Locale; reason?: string }) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  return (
    <div className="space-y-2 text-sm text-muted-foreground" role="status" data-window-collection="disabled">
      <p>
        {product === 'claude_code'
          ? t(
              'Publisher-verified local pin: disk identity only, not release verification or mapped-image proof.',
              'Publisher-verified local pin: 디스크 신원만 확인하며 릴리스 검증이나 매핑된 이미지 증명이 아닙니다.'
            )
          : t(
              'source_only: source evidence only, without publisher or native-image proof.',
              'source_only: 소스 증거만 사용하며 게시자나 네이티브 이미지 증명이 아닙니다.'
            )}
      </p>
      <p>
        {t(
          'Root source is not root-owned usage. Root ownership is unverified. Possible child contribution is unknown; children are never linked automatically.',
          '루트 소스는 루트 소유 사용량이 아닙니다. 루트 소유권은 미확인입니다. 자식 기여 가능성은 알 수 없으며 자식을 자동 연결하지 않습니다.'
        )}
      </p>
      <p>
        {product === 'claude_code'
          ? t(
              'Collection is disabled pending separate Claude activation and native acceptance. Saving settings, preparing a task or installing files does not activate collection.',
              '별도 Claude 활성화와 네이티브 acceptance 전까지 수집은 비활성입니다. 설정 저장·작업 준비·파일 설치는 수집을 활성화하지 않습니다.'
            )
          : t(
              'Collection is disabled pending separate Codex activation and native acceptance.',
              '별도 Codex 활성화와 네이티브 acceptance 전까지 수집은 비활성입니다.'
            )}
      </p>
      {reason && <p>{ordinaryWindowReason(reason, locale)}</p>}
    </div>
  );
}

type ClaudeConnectionProps = {
  task: Task;
  projectName: string;
  origin: string;
  locale: Locale;
  busy: boolean;
  online: boolean;
  onAction: (code: string) => void;
  reason: (code: string) => string;
  installation?: ReactNode;
};

export function ClaudeConnection(props: ClaudeConnectionProps) {
  const { task, locale } = props;
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  if (task.ordinary_window) {
    return (
      <Card data-ordinary-window-task={task.id}>
        <CardHeader>
          <CardTitle>
            {task.ordinary_window.product === 'claude_code'
              ? t('Claude ordinary window', 'Claude 일반 window')
              : t('Codex ordinary window', 'Codex 일반 window')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <OrdinaryWindowStatus product={task.ordinary_window.product} locale={locale} reason={task.ordinary_window.reason} />
        </CardContent>
      </Card>
    );
  }
  return <ExactClaudeConnection {...props} />;
}

function ExactClaudeConnection({ task, projectName, origin, locale, busy, online, onAction, reason, installation }: ClaudeConnectionProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const stage = claudeConnectionStage(task);
  const readiness = task.connection_readiness;
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  if (!stage || !readiness) return null;
  const ordinary = task.mode === 'ordinary';
  const linked = ordinary ? !!task.binding?.selected_root_id : (task.binding?.roots ?? 0) > 0;
  const observing = stage === 'measuring' || stage === 'starting';
  const prompt = claudeConnectPrompt(task, origin, locale);
  const reconnect =
    stage === 'paused' &&
    !task.actions.some(action => action.code === 'resume-binding' && action.enabled) &&
    readiness.skill.state === 'installed' &&
    task.actions.some(action => action.code === 'session-connect' && action.enabled);
  const copyText = stage === 'install' ? readiness.skill.install_command : stage === 'ready' || reconnect ? prompt : null;
  const control = observing ? 'pause' : stage === 'paused' && !reconnect ? 'resume-binding' : null;
  const controlOption = task.actions.find(action => action.code === control);
  const stop = task.actions.find(action => action.code === 'stop-observation');
  const blocker = claudeConnectionBlocker(task);
  const labels = {
    install: t('Installation needed', '설치 필요'),
    conflict: t('Existing files need review', '기존 파일 확인 필요'),
    unknown: t('Installation not confirmed', '설치 미확인'),
    blocked: t('Connection unavailable', '연결 불가'),
    ready: t('Waiting for connection', '연결 대기'),
    starting: t('Starting measurement', '측정 시작 중'),
    measuring: t('Measuring', '측정 중'),
    paused: t('Measurement paused', '일시중단'),
    revoked: t('Collection revoked', '관측 권한 철회됨'),
    ended: t('Measurement ended', '측정 종료')
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
    ended: t('Measurement has ended.', '측정이 종료됐습니다.')
  };
  const descriptions = {
    install: ordinary
      ? t(
          'Review the project-only package changes below before installing. Existing files and global settings are preserved.',
          '아래에서 프로젝트 전용 패키지 변경을 검토한 뒤 설치하세요. 기존 파일과 전역 설정은 보존합니다.'
        )
      : t(
          'Copy the project-only command and run it in your terminal. Existing files are not overwritten.',
          '설치 명령을 복사해 터미널에서 실행하세요. 기존 파일과 전역 설정은 변경하지 않습니다.'
        ),
    conflict: t(
      'Review the existing package before changing anything. No replacement command is provided.',
      '기존 패키지를 먼저 검토하세요. 파일을 덮어쓰는 명령은 제공하지 않습니다.'
    ),
    unknown: t(
      'Check access to this project and the bundled skill. Unknown is not installed.',
      '프로젝트와 제공된 스킬 패키지에 접근할 수 있는지 확인하세요. 미확인은 설치 완료가 아닙니다.'
    ),
    blocked: blocker
      ? reason(blocker)
      : t('Review the source support and this task’s observation authority.', '연결 경로의 지원 상태와 이 작업의 관측 권한을 확인하세요.'),
    ready: ordinary
      ? t(
          'Installation is confirmed. Invoke the skill in your current native parent. Earlier usage is excluded.',
          '설치는 확인됐습니다. 현재 네이티브 부모에서 skill을 호출하세요. 이전 사용량은 제외합니다.'
        )
      : t(
          'Installation is confirmed. Run the prompt in a separate fresh working session, not the application session.',
          '설치는 확인됐습니다. 적용 세션이 아닌 별도의 새 작업 세션에서 문구를 실행하세요.'
        ),
    starting: t(
      'Connection and active collection are separate facts. Start work only after the active state is confirmed.',
      '세션 연결과 수집 활성화는 별도 상태입니다. 측정 중 표시를 확인한 뒤 작업하세요.'
    ),
    measuring: t(
      'Continue in the connected Claude session. Only eligible new usage is collected.',
      '연결된 Claude 세션에서 계속 작업하세요. 관측 가능한 새 사용량만 수집합니다.'
    ),
    paused: t(
      'Claude and its metadata hooks may keep running. Paused usage is not backfilled.',
      'Claude와 세션 hook은 계속 실행될 수 있습니다. 중단 구간은 소급 수집하지 않습니다.'
    ),
    revoked: t(
      'Claude may keep running. This page cannot restore revoked authority.',
      'Claude는 계속 실행될 수 있습니다. 이 화면에서 철회된 권한을 복구할 수 없습니다.'
    ),
    ended: t('Review usage and record the task outcome separately.', '사용량을 검토하고 작업 결과는 별도로 판정하세요.')
  };
  async function copy(text: string) {
    setCopyStatus('idle');
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }
  return (
    <Card
      id="claude-connection"
      data-connection-stage={stage}
      data-ordinary-connection={ordinary ? task.id : undefined}
      data-observation-state={ordinary ? task.measurement.state : undefined}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t('Claude connection', 'Claude 연결')}</CardTitle>
          <Badge variant="secondary">{labels[stage]}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 pt-6">
        <ol aria-label={t('Connection progress', '연결 진행 상태')} className="flex items-center gap-3 text-sm">
          {[t('Check installation', '설치 확인'), t('Connect', '연결'), t('Measure', '측정')].map((label, index) => {
            const done = index === 0 ? readiness.skill.state === 'installed' : index === 1 ? linked : stage === 'measuring';
            const current =
              index === 0
                ? ['install', 'conflict', 'unknown'].includes(stage)
                : index === 1
                  ? ['ready', 'blocked'].includes(stage)
                  : observing || stage === 'paused';
            return (
              <li key={label} className="flex flex-1 items-center gap-2" aria-current={current ? 'step' : undefined}>
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
                    current ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {done ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
                </span>
                <span className={current ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
              </li>
            );
          })}
        </ol>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {ordinary
              ? t(
                  `Ordinary observation · all Claude-family models · family limit ${task.binding?.max_family_members ?? '—'}`,
                  `일반 관측 · 모든 Claude 계열 모델 허용 · 가족 한도 ${task.binding?.max_family_members ?? '—'}`
                )
              : t('Restricted pilot · not ordinary production support', '제한된 pilot · 일반 환경 지원 아님')}
          </p>
          <h2 className="text-xl font-semibold tracking-tight">{titles[stage]}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{descriptions[stage]}</p>
        </div>
        <dl className="flex flex-wrap gap-8 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">{t('Project', '프로젝트')}</dt>
            <dd className="mt-1">{projectName}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('Task', '연결할 작업')}</dt>
            <dd className="mt-1">{task.name}</dd>
          </div>
        </dl>
        {copyText && (
          <div className="space-y-3">
            {stage === 'install' ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">{t('View installation command', '터미널 설치 명령 보기')}</summary>
                <pre className="mt-3 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 font-mono text-xs">{copyText}</pre>
              </details>
            ) : (
              <pre data-connection-prompt="" className="whitespace-pre-wrap break-all rounded-lg bg-muted p-4 font-mono text-sm">
                {copyText}
              </pre>
            )}
            <Button
              data-connection-action="copy"
              disabled={busy || !online}
              onClick={() => {
                void copy(copyText);
              }}
            >
              <Copy />
              {stage === 'install' ? t('Copy installation command', '설치 명령 복사') : t('Copy connection prompt', '호출 문구 복사')}
            </Button>
            <p role="status" className="text-xs text-muted-foreground">
              {copyStatus === 'copied'
                ? t('Copied. Execute it, then check the server state here.', '복사했습니다. 실행한 뒤 이 화면에서 상태를 확인하세요.')
                : copyStatus === 'failed'
                  ? t('Select the text and copy it manually.', '문구를 펼쳐 선택한 뒤 직접 복사하세요.')
                  : stage === 'install'
                    ? t('Copying does not confirm installation or start collection.', '복사만으로 설치 완료 처리하거나 측정을 시작하지 않습니다.')
                    : t(
                        'Invocation registers this session’s hooks. Verified connection starts measurement when authorized.',
                        '호출하면 이 세션의 hook이 등록됩니다. 권한이 있는 연결이 확인되면 측정이 시작됩니다.'
                      )}
            </p>
          </div>
        )}
        {ordinary && ['install', 'conflict', 'unknown'].includes(stage) && installation}
        {control && (
          <div className="space-y-2">
            <Button
              data-connection-action={control}
              variant={observing ? 'outline' : 'default'}
              disabled={busy || !online || !controlOption?.enabled}
              onClick={() => onAction(control)}
            >
              {observing ? <Pause /> : <Play />}
              {observing ? t('Pause measurement', '측정 일시중단') : t('Resume measurement', '측정 재개')}
            </Button>
            {!controlOption?.enabled && controlOption?.reason && <p className="text-sm text-muted-foreground">{reason(controlOption.reason)}</p>}
          </div>
        )}
        {ordinary && !task.outcome && (linked || stop?.enabled) && (
          <div className="space-y-2 border-t pt-4">
            <Button
              data-task-action="stop-observation"
              data-connection-action="stop-observation"
              variant="outline"
              disabled={busy || !online || !stop?.enabled}
              onClick={() => onAction('stop-observation')}
            >
              {t('Stop observation · keep Claude running', '관측 종료 · Claude 유지')}
            </Button>
            {!stop?.enabled && stop?.reason && <p className="text-sm text-muted-foreground">{reason(stop.reason)}</p>}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(
                'Pause keeps the selected observation. Stop releases this task’s ownership so another task can connect the retained native root. Neither action exits Claude; excluded usage is not backfilled.',
                '일시중단은 선택된 관측을 유지합니다. 관측 종료는 작업 소유권을 해제해 다른 작업이 유지된 native root에 연결할 수 있게 합니다. 두 동작 모두 Claude를 종료하지 않으며 제외된 사용량은 소급 수집하지 않습니다.'
              )}
            </p>
          </div>
        )}
        {['blocked', 'conflict', 'unknown', 'revoked'].includes(stage) && (
          <Button data-connection-action="diagnostics" variant="outline" onClick={() => setDiagnosticsOpen(true)}>
            {t('Check connection requirements', '연결 조건 확인')}
          </Button>
        )}
        <p role="status" data-connection-status="" className="rounded-lg bg-muted/50 p-4 text-sm">
          {stage === 'ready'
            ? t(
                'Session confirmation is pending until invocation. This screen refreshes automatically.',
                '호출 전에는 세션 확인 대기 상태입니다. 호출 후 이 화면이 자동 갱신됩니다.'
              )
            : stage === 'measuring' && (task.binding?.requests ?? 0) === 0
              ? t('Measuring · waiting for first usage. Cost is unknown, not zero.', '측정 중 · 첫 사용량을 기다리는 중입니다. 비용은 0이 아닌 미확인입니다.')
              : labels[stage]}
        </p>
        <details open={diagnosticsOpen} onToggle={event => setDiagnosticsOpen(event.currentTarget.open)} className="border-t pt-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t('Installation and connection diagnostics', '설치·연결 진단 보기')}</summary>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            {[
              [t('Project skill', '프로젝트 스킬'), readiness.skill.state],
              [
                t('Current session', '현재 세션 확인'),
                linked ? t('Verified binding', '연결 신원 확인됨') : t('Pending native hook evidence', '호출 후 hook 기록 확인 대기')
              ],
              [t('Task binding', '작업 연결'), linked ? t('Confirmed', '확인됨') : t('Not connected', '미연결')],
              [t('Collection', '수집 상태'), labels[stage]],
              [t('Source trust', '연결 경로 신뢰 상태'), task.binding?.support ?? 'qualification_required']
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-all">{value}</dd>
              </div>
            ))}
          </dl>
          {blocker && (
            <p data-connection-blocker={blocker} className="mt-4">
              {reason(blocker)} <code className="text-xs">{blocker}</code>
            </p>
          )}
          {readiness.skill.reason && <p className="mt-2 text-xs text-muted-foreground">{readiness.skill.reason}</p>}
          {stage === 'blocked' && readiness.skill.install_command && (
            <pre className="mt-3 whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{readiness.skill.install_command}</pre>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            {t(
              'File installation, session hooks, source support and task authority are separate checks. This page grants no authority.',
              '파일 설치·세션 hook·연결 경로 지원·작업 관측 권한은 별도 조건입니다. 이 화면에서 권한을 부여하지 않습니다.'
            )}
          </p>
        </details>
        <p className="text-xs text-muted-foreground">
          {t(
            'Measurement data excludes conversation and source-code content. Costs are partial estimates, not bills.',
            '측정 데이터에 대화·코드 내용을 포함하지 않습니다. 비용은 부분 추정이며 청구액이 아닙니다.'
          )}
        </p>
      </CardContent>
    </Card>
  );
}
