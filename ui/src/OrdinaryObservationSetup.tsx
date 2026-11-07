import { useEffect, useRef, useState } from 'react';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js';
import { Badge } from './components/ui/badge.js';
import { Label } from './components/ui/label.js';
import { Input } from './components/ui/input.js';
import { ClaudeConnection, ordinaryWindowReason, OrdinaryWindowStatus } from './ClaudeConnection.js';
import { OrdinaryWindowNotice } from './OrdinaryWindowNotice.js';
import * as api from './api.js';
import type { CodexSetup, Locale, OrdinarySetup, Task } from './types.js';

type SetupOperation = 'configure' | 'preview-install' | 'install' | 'preview-remove' | 'remove' | 'recover-lock';
type BundleMode = 'exact' | 'ordinary_window';
function ordinarySetupInput(operation: SetupOperation, status: OrdinarySetup | null, draft: { mode: BundleMode; version: string }) {
  return {
    operation,
    ...(operation === 'configure' ? { product_version: draft.version } : {}),
    ...(operation === 'configure' && draft.mode !== (status?.bundle_mode ?? 'exact') ? { bundle_mode: draft.mode } : {}),
    ...(operation === 'install' || operation === 'remove'
      ? {
          expected_package_hash: status?.installation.packageHash ?? null,
          expected_installed_hash: status?.installation.installedHash ?? null
        }
      : {})
  };
}

export function TaskAssignment({ task, locale }: { task: Task; locale: Locale }) {
  if (task.mode === 'ordinary') return null;
  return (
    <div data-task-assignment="comparison">
      <dt className="text-muted-foreground">{locale === 'ko' ? '배정' : 'Assignment'}</dt>
      <dd className="mt-1 break-all">{task.preparation.assigned_variant_id ?? '—'}</dd>
    </div>
  );
}

export function OrdinaryCriteria({ selected, onChange, locale }: { selected: string[]; onChange: (value: string[]) => void; locale: Locale }) {
  return (
    <fieldset className="space-y-2 rounded-lg border p-4" data-ordinary-criteria>
      <legend className="px-1 text-sm font-medium">{locale === 'ko' ? '생성 전에 완료 기준 선택' : 'Select completion criteria before creation'}</legend>
      <Label className="flex items-center">
        <input
          type="checkbox"
          name="criterion_ids"
          value="user_confirmed_completion"
          checked={selected.includes('user_confirmed_completion')}
          onChange={event => onChange(event.target.checked ? ['user_confirmed_completion'] : [])}
        />
        {locale === 'ko' ? '사용자가 원래 요청의 완료를 직접 확인' : 'User confirms completion of the original request'}
      </Label>
    </fieldset>
  );
}

export function OrdinaryObservationSetup({
  projectId,
  locale,
  busy,
  perform
}: {
  projectId: string;
  locale: Locale;
  busy: boolean;
  perform: <T>(route: string, body: unknown) => Promise<T | null>;
}) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const [status, setStatus] = useState<OrdinarySetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<'install' | 'remove' | null>(null);
  const [selectedMode, setSelectedMode] = useState<BundleMode | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  const generation = useRef(0);
  if (projectId !== prevProjectId) {
    generation.current++;
    setPrevProjectId(projectId);
    setStatus(null);
    setError(null);
    setReading(false);
    setPreview(null);
    setSelectedMode(null);
    setSelectedVersion(null);
  }
  const mode = selectedMode ?? status?.bundle_mode ?? 'exact';
  const modeChanged = mode !== (status?.bundle_mode ?? 'exact');
  const windowMode = mode === 'ordinary_window';
  const windowContext = windowMode || status?.bundle_mode === 'ordinary_window';
  const version = selectedVersion ?? (modeChanged ? '' : (status?.product_version ?? ''));
  const unsaved = modeChanged || (selectedVersion !== null && selectedVersion !== status?.product_version);
  const invalidVersion = (windowMode || modeChanged) && !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(version);
  const route = `/api/projects/${encodeURIComponent(projectId)}/ordinary-setup`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(route, { cache: 'no-store', signal: controller.signal })
      .then(async reply => {
        if (!reply.ok) {
          throw new api.LocalApiError('ordinary_setup_unavailable');
        }
        const value = (await reply.json()) as OrdinarySetup;
        if (!controller.signal.aborted) {
          setStatus(value);
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure instanceof api.LocalApiError ? failure.code : 'local_operation_failed');
        }
      });
    return () => controller.abort();
  }, [route]);
  async function operate(operation: SetupOperation) {
    if (reading || busy) return;
    const started = generation.current;
    setReading(true);
    setPreview(null);
    setError(null);
    try {
      const value = await perform<OrdinarySetup>(route, ordinarySetupInput(operation, status, { mode, version }));
      if (started !== generation.current) return;
      if (value) {
        setStatus(value);
        if (operation === 'configure') {
          setSelectedMode(null);
          setSelectedVersion(null);
        }
        if (operation === 'preview-install') setPreview('install');
        if (operation === 'preview-remove') setPreview('remove');
      } else setError('local_operation_failed');
    } finally {
      if (started === generation.current) setReading(false);
    }
  }
  const disabled = busy || reading || !status;
  return (
    <Card data-ordinary-setup={projectId}>
      <CardHeader>
        <CardTitle>{t('Claude connection setup', 'Claude 연결 설정')}</CardTitle>
        <CardDescription>
          {t(
            'Project-only package setup. No comparison assignment or native configuration changes.',
            '프로젝트 전용 패키지 설정입니다. 비교 배정이나 네이티브 설정 변경은 없습니다.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!windowContext && <OrdinaryWindowNotice product="claude_code" locale={locale} />}
        <CodexModeSetup
          product="claude_code"
          mode={mode}
          version={version}
          disabled={disabled}
          locale={locale}
          requireVersion={modeChanged}
          onModeChange={choice => {
            if (choice === mode) return;
            setSelectedMode(choice);
            setSelectedVersion(null);
            setPreview(null);
          }}
          onVersionChange={value => {
            setSelectedVersion(value);
            setPreview(null);
          }}
        />
        {windowContext && <OrdinaryWindowStatus product="claude_code" locale={locale} {...(status?.window ? { reason: status.window.reason } : {})} />}
        {error && (
          <div className="text-sm">
            <p role="alert" className="text-destructive">
              {t(
                'Could not read or update setup. Refresh and review the saved state.',
                '설정을 읽거나 처리하지 못했습니다. 새로고침 후 저장 상태를 확인하세요.'
              )}
            </p>
            {!windowContext && (
              <details className="mt-2">
                <summary className="cursor-pointer text-muted-foreground">{t('Error diagnostics', '오류 진단 보기')}</summary>
                <code>{error}</code>
              </details>
            )}
          </div>
        )}
        {!status && !error && <p role="status">{t('Reading setup…', '설정 확인 중…')}</p>}
        {status && <ClaudeSetupStatus status={status} locale={locale} windowContext={windowContext} />}
        <ClaudeSetupControls
          status={status}
          locale={locale}
          disabled={disabled}
          invalidVersion={invalidVersion}
          modeChanged={modeChanged}
          selectedVersion={selectedVersion}
          unsaved={unsaved}
          reading={reading}
          preview={preview}
          onOperate={operation => {
            void operate(operation);
          }}
          onCancel={() => setPreview(null)}
        />
      </CardContent>
    </Card>
  );
}

function ClaudeSetupControls({
  status,
  locale,
  disabled,
  invalidVersion,
  modeChanged,
  selectedVersion,
  unsaved,
  reading,
  preview,
  onOperate,
  onCancel
}: {
  status: OrdinarySetup | null;
  locale: Locale;
  disabled: boolean;
  invalidVersion: boolean;
  modeChanged: boolean;
  selectedVersion: string | null;
  unsaved: boolean;
  reading: boolean;
  preview: 'install' | 'remove' | null;
  onOperate: (operation: SetupOperation) => void;
  onCancel: () => void;
}) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const blocked = !!status && (status.installation.state === 'blocked' || status.installation.blockers.length > 0);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          data-claude-action="configure"
          disabled={disabled || invalidVersion || (modeChanged && selectedVersion === null) || (!!status?.configured && !unsaved)}
          onClick={() => {
            void onOperate('configure');
          }}
        >
          {t('Configure Claude', 'Claude 설정')}
        </Button>
        <Button
          variant="outline"
          data-claude-action="preview-install"
          disabled={disabled || unsaved || !status?.configured || status.installation.source !== 'available'}
          onClick={() => {
            void onOperate('preview-install');
          }}
        >
          {t('Preview install / update', '설치·갱신 미리보기')}
        </Button>
        <Button
          variant="outline"
          data-claude-action="preview-remove"
          disabled={disabled || unsaved || !status?.installation.installedHash}
          onClick={() => {
            void onOperate('preview-remove');
          }}
        >
          {t('Preview removal', '제거 미리보기')}
        </Button>
        {status?.installation.blockers.includes('installation_recovery_required') && (
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              void onOperate('recover-lock');
            }}
          >
            {t('Recover stopped installer', '종료된 설치 잠금 복구')}
          </Button>
        )}
      </div>
      {preview && status?.changes && (
        <div className="space-y-3 rounded-lg border p-4" data-install-preview={preview}>
          <ul className="space-y-2 text-sm">
            {status.changes.map(change => (
              <li key={change.path} className="break-all">
                <code>{change.path}</code> ·{' '}
                {change.action === 'create' ? t('Create', '생성') : change.action === 'update' ? t('Update', '갱신') : t('Remove', '제거')}
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">{t('File diagnostics', '파일 진단 보기')}</summary>
                  <p>
                    {change.action} · {change.beforeHash ?? '—'} → {change.afterHash ?? '—'}
                  </p>
                </details>
              </li>
            ))}
          </ul>
          <p className="text-sm">
            {t('Review these relative package paths before choosing to change files.', '상대 패키지 경로를 검토한 뒤 파일 변경을 직접 선택하세요.')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              data-install-choice={preview}
              disabled={disabled || unsaved || blocked || status.changes.length === 0}
              onClick={() => {
                void onOperate(preview);
              }}
            >
              {preview === 'install' ? t('Install / update reviewed package', '검토한 패키지 설치·갱신') : t('Remove reviewed package', '검토한 패키지 제거')}
            </Button>
            <Button variant="outline" disabled={reading} onClick={() => onCancel()}>
              {t('Cancel', '취소')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function ClaudeSetupStatus({ status, locale, windowContext }: { status: OrdinarySetup; locale: Locale; windowContext: boolean }) {
  const blocked = status.installation.state === 'blocked' || status.installation.blockers.length > 0;
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const installationLabels = {
    absent: t('Installation needed', '설치 필요'),
    installed: t('Installed', '설치됨'),
    update_available: t('Update available', '갱신 가능'),
    blocked: t('Existing files need review', '기존 파일 확인 필요')
  };
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary" data-claude-configured={String(status.configured)}>
          {status.configured ? t('Configured', '설정됨') : t('Not configured', '설정 전')}
        </Badge>
        <Badge variant="outline" data-installation-state={status.installation.state}>
          {installationLabels[status.installation.state]}
        </Badge>
        {!windowContext && (
          <Badge variant="outline" data-admission={String(status.admission.admitted)}>
            {status.admission.admitted ? t('Ordinary connection allowed', '일반 연결 허용') : t('Connection unavailable', '연결 불가')}
          </Badge>
        )}
      </div>
      {!windowContext && (
        <>
          <p className="text-sm">
            {t(
              `All Claude-family models are allowed at their observed effort. Family limit ${status.admission.max_family_members} members; cost remains partial.`,
              `모든 Claude 계열 모델과 관측된 effort를 허용합니다. 가족 한도 ${status.admission.max_family_members}개이며 비용은 부분 관측입니다.`
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(
              'After installation, invoke harness-connect in the native parent and check the connection state. Installation alone does not start observation.',
              '설치 후 네이티브 부모에서 harness-connect를 호출하고 연결 상태를 확인하세요. 설치만으로 관측을 시작하지 않습니다.'
            )}
          </p>
        </>
      )}
      {blocked && (
        <p role="alert" className="text-sm">
          {t(
            'Installation changes are blocked. Review the diagnostics below; existing files are preserved.',
            '설치 변경이 차단됐습니다. 아래 진단을 확인하세요. 기존 파일은 보존합니다.'
          )}
        </p>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">{t('Installation diagnostics', '설치 진단 보기')}</summary>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {[
            [t('Package state', '패키지 상태'), status.installation.state],
            [t('Package destination', '패키지 위치'), status.installation.destination],
            [t('Receipt directory', 'Receipt 디렉토리'), status.installation.receiptDirectory],
            [t('Hook registration', 'Hook 등록'), status.installation.hookRegistration]
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
        {status.installation.blockers.length > 0 && (
          <ul className="mt-3 list-disc pl-5">
            {status.installation.blockers.map(blocker => (
              <li key={blocker}>{windowContext ? ordinaryWindowReason(blocker, locale) : <code>{blocker}</code>}</li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-muted-foreground">
          {t(
            'Copied package ≠ registered hook ≠ native receipt ≠ observing. Edited or unowned files block changes. Status and preview do not write files; installation never creates a native receipt.',
            '패키지 복사 ≠ hook 등록 ≠ 네이티브 receipt ≠ 관측 중입니다. 수정되었거나 소유하지 않은 파일은 변경을 차단합니다. 상태 조회·미리보기는 파일을 쓰지 않으며 설치로 네이티브 receipt를 만들지 않습니다.'
          )}
        </p>
      </details>
    </>
  );
}

export function OrdinaryConnectionGuide({
  task,
  locale,
  origin,
  busy,
  online,
  onAction,
  reason
}: {
  task: Task;
  locale: Locale;
  origin: string;
  busy: boolean;
  online: boolean;
  onAction: (code: string) => void;
  reason: (code: string) => string;
}) {
  return (
    <ClaudeConnection
      task={task}
      projectName={task.project_id}
      locale={locale}
      origin={origin}
      busy={busy}
      online={online}
      onAction={onAction}
      reason={reason}
    />
  );
}

export function CodexExactVersionSetup({
  status,
  locale,
  disabled,
  version,
  requireVersion,
  showCandidateNotice,
  onChange
}: {
  status: CodexSetup;
  locale: Locale;
  disabled: boolean;
  version: string;
  requireVersion: boolean;
  showCandidateNotice: boolean;
  onChange: (version: string) => void;
}) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  return (
    <>
      <label className="block space-y-2 text-sm">
        <span>{t('Codex version', 'Codex 버전')}</span>
        <select className="native-select min-h-11" disabled={disabled} value={version} onChange={event => onChange(event.target.value)}>
          {requireVersion && version === '' && (
            <option value="" disabled>
              {t('Select an explicit version', '버전을 직접 선택하세요')}
            </option>
          )}
          {!status.available_versions.includes(status.product_version) && (
            <option value={status.product_version} disabled>
              {status.product_version}
            </option>
          )}
          {status.available_versions.map(candidate => (
            <option key={candidate} value={candidate}>
              {candidate}
              {status.unqualified_versions.includes(candidate) ? t(' (unqualified candidate)', ' (미검증 후보)') : ''}
            </option>
          ))}
        </select>
      </label>
      {showCandidateNotice && status.unqualified_versions.includes(version) && (
        <p className="text-sm text-muted-foreground">
          {t(
            'Unqualified candidate: qualified support is pending. Usage is labeled compatibility-unverified.',
            '미검증 후보: 지원 검증이 아직 끝나지 않았습니다. 사용량은 호환성 미검증으로 표시됩니다.'
          )}
        </p>
      )}
    </>
  );
}

export function CodexModeSetup({
  product = 'codex',
  requireVersion = false,
  mode,
  version,
  disabled,
  locale,
  onModeChange,
  onVersionChange
}: {
  product?: 'codex' | 'claude_code';
  requireVersion?: boolean;
  mode: 'exact' | 'ordinary_window';
  version: string;
  disabled: boolean;
  locale: Locale;
  onModeChange: (mode: 'exact' | 'ordinary_window') => void;
  onVersionChange: (version: string) => void;
}) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label={product === 'codex' ? t('Codex mode', 'Codex 모드') : t('Claude mode', 'Claude 모드')}>
        {(['exact', 'ordinary_window'] as const).map(choice => (
          <Button
            key={choice}
            className="min-h-11"
            variant={mode === choice ? 'default' : 'outline'}
            aria-pressed={mode === choice}
            {...(product === 'codex' ? { 'data-codex-mode': choice } : { 'data-claude-mode': choice })}
            disabled={disabled}
            onClick={() => onModeChange(choice)}
          >
            {choice === 'exact' ? t('Exact version', '정확 버전') : t('Ordinary window', '일반 window')}
          </Button>
        ))}
      </div>
      {(mode === 'ordinary_window' || requireVersion) && (
        <>
          <label className="block space-y-2 text-sm">
            <span>
              {product === 'codex'
                ? t('Declared stable Codex version', '직접 지정한 Codex 안정 버전')
                : mode === 'ordinary_window'
                  ? t('Declared stable Claude version', '직접 지정한 Claude 안정 버전')
                  : t('Explicit exact Claude version', '직접 지정한 Claude 정확 버전')}
            </span>
            <Input
              className="min-h-11"
              type="text"
              {...(product === 'codex' ? { 'data-codex-version': mode } : { 'data-claude-version': mode })}
              value={version}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              onChange={event => onVersionChange(event.target.value)}
            />
          </label>
          {product === 'codex' && (
            <div className="space-y-2 text-sm text-muted-foreground" role="status" data-codex-window-collection="disabled">
              <p>
                {t(
                  'source_only: the root source is not root-owned usage. Possible child contribution is unknown; children are never connected automatically.',
                  'source_only: 루트 소스는 루트 소유 사용량이 아닙니다. 자식 기여 가능성은 알 수 없으며 자식을 자동 연결하지 않습니다.'
                )}
              </p>
              <p>
                {t(
                  'Implemented for offline acceptance. Ordinary-window collection is disabled pending separate product activation and native acceptance. Saving this preference or installing the package does not activate collection.',
                  '오프라인 acceptance용 구현입니다. 별도 제품 활성화와 네이티브 acceptance 전까지 일반 window 수집은 비활성 상태입니다. 설정 저장이나 패키지 설치는 수집을 활성화하지 않습니다.'
                )}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
