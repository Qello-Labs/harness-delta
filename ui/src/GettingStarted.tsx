import { ArrowDown, ArrowRight, Check, ClipboardCheck, Files, FolderOpen, GitBranch, GitCompareArrows, Link, ListTodo, Pause, Play, Settings, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SupportGuidance } from './SupportGuidance';
import type { Locale, Setup } from './types';

export function GettingStarted({ locale, setups, onNavigate }: {
  readonly locale: Locale;
  readonly setups: readonly Setup[];
  readonly onNavigate: (screen: 'setup' | 'tasks') => void;
}) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  const steps = [
    { id: 'setup', icon: Settings, title: t('Set up criteria', '측정 기준 준비'), place: t('Settings', '설정') },
    { id: 'task', icon: ListTodo, title: t('Create a task', '새 작업 생성'), place: t('Tasks', '작업') },
    { id: 'apply', icon: GitBranch, title: t('Apply the harness', '하네스 적용'), place: t('Task + agent', '작업 + 에이전트') },
    { id: 'connect', icon: Link, title: t('Connect a session', '작업 세션 연결'), place: t('Fresh agent session', '새 에이전트 세션') },
    { id: 'measure', icon: Play, title: t('Measure and work', '측정 시작·작업'), place: t('Task + agent', '작업 + 에이전트') },
    { id: 'decide', icon: ClipboardCheck, title: t('Decide the result', '결과 판정'), place: t('Task details', '작업 상세') },
  ] as const;
  const taskSteps = [
    { id: 'task', title: t('Create a task and check its assignment', '새 작업을 만들고 배정을 확인하세요.'),
      description: t('In Tasks, choose New task. Enter a name and select the project and reviewed measurement criteria, then choose Prepare measurement. A/B is assigned automatically; you do not choose the arm.',
        '작업에서 새 작업을 여세요. 작업명·프로젝트·검토된 측정 기준을 선택하고 측정 준비를 누르세요. A/B는 자동 배정되므로 직접 고르지 않습니다.') },
    { id: 'apply', title: t('Prepare the assigned harness', '배정된 하네스를 준비하세요.'),
      description: t('Follow the next action in task details. For agent application, check the workspace, choose Apply, and review the changed files. This prepares the harness; it does not start measurement.',
        '작업 상세의 다음 동작을 따르세요. 에이전트 적용 방식이면 작업 공간을 확인하고 적용한 뒤 변경 파일을 검토하세요. 하네스 준비 단계이며 측정은 시작하지 않습니다.') },
    { id: 'connect', title: t('Connect a separate fresh working session', '별도의 새 작업 세션을 연결하세요.'),
      description: t('Review measurement support and source authorization first. Follow the task’s session guidance; use harness-connect for the ordinary-session route. The application session is not the working session. A blocked route must be resolved before continuing.',
        '측정 지원 상태와 원본 관측 권한부터 확인하세요. 작업의 세션 안내를 따르고, 일반 세션 경로에서는 harness-connect를 사용하세요. 적용 세션을 작업 세션으로 연결하지 마세요. 연결이 막혔다면 표시된 조건부터 해결하세요.') },
    { id: 'measure', title: t('Check that measurement is active, then work', '측정 중 표시를 확인한 뒤 작업하세요.'),
      description: t('Check Measuring after connecting. A family connection starts authorized observation; other routes show Start measurement when needed. Pause measurement and Resume measurement control collection, not the AI process.',
        '연결 후 측정 중 표시를 확인하세요. 가족 연결은 허용된 관측을 시작하며 다른 경로에서 필요하면 측정 시작을 표시합니다. 측정 일시중단·측정 재개는 수집을 제어하며 AI 실행·종료와는 별개입니다.') },
    { id: 'decide', title: t('Review the result and record your decision', '결과를 검토하고 직접 판정하세요.'),
      description: t('Use Complete successfully, Continue rework, or End task. Rework keeps the same assignment and earlier usage. Added requirements belong in a new task; leaving the page or exiting the agent does not mark success.',
        '성공으로 완료·재작업 계속·작업 종료 중 선택하세요. 재작업은 배정과 이전 사용량을 유지합니다. 요구사항을 추가했다면 새 작업으로 시작하세요. 화면 이탈이나 에이전트 종료만으로 성공이 확정되지는 않습니다.') },
  ] as const;

  return <div data-getting-started="" className="space-y-8 break-keep">
    <section className="flex flex-wrap items-end justify-between gap-6" aria-labelledby="getting-started-title">
      <div className="max-w-2xl space-y-3">
        <Badge variant="secondary">{t('Getting started', '시작 안내')}</Badge>
        <h1 id="getting-started-title" className="text-balance text-3xl font-semibold leading-tight">{t('Set up once. Follow the same flow for every task.', '설정은 한 번, 작업은 이 순서로.')}</h1>
        <p className="text-pretty leading-relaxed text-muted-foreground">{t('Compare two harness versions while working in your usual agent. Prepare and review here; run the agent and judge the result yourself.',
          '두 하네스 버전을 비교하며 평소 에이전트에서 작업하세요. 이곳에서 준비와 측정 상태를 확인하고, 에이전트 실행과 결과 판정은 직접 합니다.')}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button data-guide-link="setup" onClick={() => onNavigate('setup')}><Settings aria-hidden="true" />{t('Open settings', '설정 열기')}<ArrowRight aria-hidden="true" /></Button>
        <Button data-guide-link="tasks" variant="outline" onClick={() => onNavigate('tasks')}><ListTodo aria-hidden="true" />{t('Go to tasks', '작업 목록으로')}</Button>
      </div>
    </section>

    <section aria-labelledby="workflow-title" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="workflow-title" className="text-lg font-semibold">{t('The flow at a glance', '한눈에 보는 사용 순서')}</h2>
        <p className="text-sm text-muted-foreground">{t('Step 1 first · repeat steps 2–6 for each task', '처음에는 1번부터 · 이후에는 2~6번을 반복')}</p>
      </div>
      <ol aria-label={t('Setup-to-result workflow', '설정부터 결과 판정까지')} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {steps.map((step, index) => <li key={step.id} data-guide-stage={step.id} className="relative rounded-lg bg-muted/60 p-4">
          <div className="mb-4 flex items-center justify-between"><step.icon className="size-5" aria-hidden="true" /><span className="text-sm font-medium tabular-nums text-muted-foreground">0{index + 1}</span></div>
          <p className="font-medium">{step.title}</p><p className="mt-1 text-sm text-muted-foreground">{step.place}</p>
          {index < steps.length - 1 && <ArrowRight className="absolute -right-4 top-6 hidden size-4 text-muted-foreground lg:block" aria-hidden="true" />}
        </li>)}
      </ol>
      <p className="text-sm leading-relaxed text-muted-foreground">{t('Connection and measurement require a supported, authorized source route. Synthetic validation stops at preparation checks; it does not enable real measurement.',
        '세션 연결·측정은 지원 조건과 원본 관측 권한을 확인한 경로에서만 진행합니다. 합성 검증 설정에서는 준비 상태만 확인하며 실측하지 않습니다.')}</p>
    </section>

    <div className="grid items-start gap-6 lg:grid-cols-3">
      <div className="space-y-6">
        <Card>
          <CardHeader><div className="flex items-center gap-3"><FolderOpen className="size-5" aria-hidden="true" /><h2 className="text-lg font-semibold">{t('1. Prepare in Settings', '1. 설정에서 처음 준비')}</h2></div>
            <p className="text-sm leading-relaxed text-muted-foreground">{t('Connect the Git project directory, then prepare the baseline A and modified B harnesses.', 'Git 프로젝트 디렉토리를 연결하고, 기준 A와 수정 B 하네스를 준비하세요.')}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="space-y-4 text-sm">
              <li className="flex gap-3"><Files className="mt-1 size-4 shrink-0" aria-hidden="true" /><div className="space-y-1"><h3 className="font-medium">{t('Register both versions', '두 버전 등록')}</h3><code>harness-register</code><p className="leading-relaxed text-muted-foreground">{t('Save only the selected instructions and tools as separate versions.', '선택한 지침·도구만 각각 다른 버전으로 저장합니다.')}</p></div></li>
              <li className="flex gap-3"><GitCompareArrows className="mt-1 size-4 shrink-0" aria-hidden="true" /><div className="space-y-1"><h3 className="font-medium">{t('Create the comparison file', '비교 파일 생성')}</h3><code className="break-all">harness-compare-config</code><p className="leading-relaxed text-muted-foreground">{t('Combine A/B into the comparison JSON. Copy the requests from Settings into your agent.', 'A/B를 비교 JSON으로 묶습니다. 설정 화면의 요청문을 복사해 에이전트에 붙여넣으세요.')}</p></div></li>
              <li className="flex gap-3"><ClipboardCheck className="mt-1 size-4 shrink-0" aria-hidden="true" /><div className="space-y-1"><h3 className="font-medium">{t('Review and connect', '검토 후 연결')}</h3><p className="leading-relaxed text-muted-foreground">{t('Paste the file path, reuse reviewed measurement inputs or supply the missing ones, then review, save and connect local settings.', '파일 경로를 붙여넣고 검토된 측정 입력을 재사용하거나 빠진 입력을 제공하세요. 검토·저장 후 로컬 설정을 연결합니다.')}</p></div></li>
            </ol>
            <p className="border-t pt-4 text-sm leading-relaxed text-muted-foreground">{t('Already have reviewed settings? Import them instead. Saving settings does not run an agent or start collection.', '검토된 설정 파일이 있다면 바로 불러오세요. 설정을 저장해도 에이전트 실행이나 수집은 시작되지 않습니다.')}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div className="flex items-center gap-3"><Terminal className="size-5" aria-hidden="true" /><h2 className="text-lg font-semibold">{t('Keep the two sessions separate', '적용 세션과 작업 세션 분리')}</h2></div>
            <p className="text-sm leading-relaxed text-muted-foreground">{t('For agent-applied harnesses, prepare first and work in a separate fresh session.', '에이전트 적용 방식에서는 준비를 마친 뒤 별도의 새 세션에서 작업합니다.')}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg bg-muted/60 p-4 text-sm"><h3 className="mb-2 flex items-center gap-2 font-medium"><GitBranch className="size-4" aria-hidden="true" />{t('Application session', '적용 세션')}</h3><p className="leading-relaxed text-muted-foreground">{t('Apply the harness → review file changes', '하네스 적용 → 변경 파일 확인')}</p><p className="mt-2 font-medium">{t('Not connected for measurement', '측정에 연결하지 않음')}</p></div>
            <ArrowDown className="mx-auto size-4 text-muted-foreground" aria-hidden="true" />
            <div className="rounded-lg bg-muted/60 p-4 text-sm"><h3 className="mb-2 flex items-center gap-2 font-medium"><Link className="size-4" aria-hidden="true" />{t('Fresh working session', '새 작업 세션')}</h3><p className="leading-relaxed text-muted-foreground">{t('Connection guidance → authorized connection → measurement → work', '세션 안내 → 권한 확인·연결 → 측정 → 작업')}</p></div>
            <p className="text-sm leading-relaxed text-muted-foreground">{t('Choose the model and effort in your agent. A window-open request or copied guidance is not proof of startup.', '모델과 effort는 에이전트에서 선택합니다. 창 열기 요청이나 안내 복사만으로 실행이 확인되지는 않습니다.')}</p>
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="task-flow-title" className="space-y-5 lg:col-span-2">
        <div><h2 id="task-flow-title" className="text-lg font-semibold">{t('2–6. Follow each task through', '2~6. 작업마다 이 순서로')}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('Stay with the same task. Its detail view shows the next available action and any unmet conditions.', '같은 작업의 상세 화면을 따라가세요. 다음 동작과 아직 충족하지 않은 조건이 표시됩니다.')}</p></div>
        <ol start={2} className="divide-y rounded-xl border bg-card px-6 shadow-sm">
          {taskSteps.map((step, index) => <li key={step.id} className="flex gap-4 py-5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold tabular-nums">{index + 2}</span>
            <div className="space-y-2"><h3 className="font-semibold">{step.title}</h3><p className="text-pretty text-sm leading-relaxed text-muted-foreground">{step.description}</p></div>
          </li>)}
        </ol>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 rounded-lg bg-muted/60 p-4"><h3 className="flex items-center gap-2 font-medium"><Pause className="size-4" aria-hidden="true" />{t('Pause is not AI shutdown', '일시중단 ≠ AI 종료')}</h3><p className="text-sm leading-relaxed text-muted-foreground">{t('The agent may keep running. Paused usage is excluded and is not backfilled on resume.', '에이전트는 계속 실행될 수 있습니다. 중단 구간의 사용량은 제외하며 재개 후에도 채우지 않습니다.')}</p></div>
          <div className="space-y-2 rounded-lg bg-muted/60 p-4"><h3 className="flex items-center gap-2 font-medium"><Check className="size-4" aria-hidden="true" />{t('Cost is an observed portion', '비용은 관측된 일부')}</h3><p className="text-sm leading-relaxed text-muted-foreground">{t('Missing usage or prices are unknown, not zero. Partial estimates are not a bill or an adoption verdict.', '누락된 사용량·단가는 0이 아닌 미확인입니다. 부분 추정은 청구액이나 도입 판정이 아닙니다.')}</p></div>
        </div>
      </section>
    </div>

    <section aria-labelledby="support-title" className="space-y-4 border-t pt-6">
      <div className="max-w-2xl space-y-2"><h2 id="support-title" className="text-lg font-semibold">{t('Check before connecting', '연결 전에 확인할 것')}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{t('Support depends on the configured product, version and connection route. The entries below describe configured settings, not detection of the installed agent. Follow the task’s support status; do not bypass a blocked connection.', '지원 여부는 설정된 제품·버전·연결 경로마다 다릅니다. 아래는 구성된 설정의 상태이며 설치된 에이전트를 탐지한 결과가 아닙니다. 작업의 측정 지원 상태를 따르고 차단된 연결을 우회하지 마세요.')}</p>
      </div>
      {setups.length === 0 && <p className="rounded-lg bg-muted/60 p-4 text-sm">{t('No reviewed criteria connected yet. Open Settings to connect a project and review your inputs.', '아직 연결된 측정 기준이 없습니다. 설정에서 프로젝트와 검토된 입력을 연결하세요.')}</p>}
      {setups.map(setup => setup.support_details && <Card key={setup.id}><CardContent className="space-y-3"><h3 className="font-medium">{setup.name}</h3><SupportGuidance support={setup.support_details} locale={locale} compact /></CardContent></Card>)}
      <p className="text-sm leading-relaxed text-muted-foreground">{t('Measurement excludes prompt, response and source-code contents. Collection requires a registered project, an active task and an authorized linked session.', '측정 데이터에는 프롬프트·응답·소스 코드 내용을 포함하지 않습니다. 수집은 등록된 프로젝트·활성 작업·관측 권한을 확인한 연결 세션 범위에서만 진행합니다.')}</p>
    </section>
  </div>;
}
