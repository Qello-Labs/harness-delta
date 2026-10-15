import { useEffect, useRef, useState } from 'react';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js';
import { Badge } from './components/ui/badge.js';
import { RefreshCw } from 'lucide-react';
import { OrdinaryObservationSetup } from './OrdinaryObservationSetup.js';
import * as api from './api.js';
import type { CodexSetup, Locale } from './types.js';

type Product = 'codex' | 'claude_code';

const reasonLabels: Record<string, (t: (en: string, ko: string) => string) => string> = {
 receipt_directory_missing: t => t('Receipt directory does not exist yet.', 'Receipt 디렉토리가 아직 없습니다.'),
 receipt_directory_unsafe: t => t('Receipt directory has unsafe permissions.', 'Receipt 디렉토리 권한이 안전하지 않습니다.'),
 codex_connect_not_configured: t => t('Codex connection is not configured. Run configure first.', 'Codex 연결이 설정되지 않았습니다. 먼저 설정을 실행하세요.'),
 codex_connect_package_missing: t => t('Codex connection package is not installed.', 'Codex 연결 패키지가 설치되지 않았습니다.'),
 codex_connect_source_missing: t => t('Codex connection source is not available.', 'Codex 연결 원본을 사용할 수 없습니다.'),
 codex_connect_source_root_missing: t => t('The configured Codex session directory is missing. Check the source root, then refresh setup.', '설정된 Codex 세션 디렉터리가 없습니다. 소스 루트를 확인하고 새로고침하세요.'),
 codex_connect_installation_busy: t => t('An installation lock exists. Recovery is allowed only after its owner has stopped and no transaction remains.', '설치 잠금이 있습니다. 소유 프로세스가 종료되고 남은 트랜잭션이 없을 때만 복구할 수 있습니다.'),
 codex_connect_installation_recovery_required: t => t('The interrupted installation needs manual review of its saved transaction before recovery.', '중단된 설치의 저장 트랜잭션을 검토한 뒤 복구해야 합니다.'),
};

function readinessReason(code: string | null, t: (en: string, ko: string) => string): string | null {
 if (!code) return null;
 const label = reasonLabels[code];
 if (label) return label(t);
 return code;
}

async function readSetup(route: string, signal?: AbortSignal): Promise<CodexSetup> {
 const reply = await fetch(route, { cache: 'no-store', ...(signal ? { signal } : {}) });
 const value: unknown = await reply.json();
 if (!reply.ok) throw new api.LocalApiError(
  typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
   ? value.error : 'codex_setup_unavailable');
 return value as CodexSetup;
}

export function AgentConnectionSetup({ projectId, locale, busy, perform }: {
 projectId: string; locale: Locale; busy: boolean;
 perform: <T>(route: string, body: unknown) => Promise<T | null>;
}) {
 const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
 const [product, setProduct] = useState<Product>('codex');
 const [status, setStatus] = useState<CodexSetup | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [reading, setReading] = useState(false);
 const [preview, setPreview] = useState<'install' | 'remove' | null>(null);
 const [prevProjectId, setPrevProjectId] = useState(projectId);
 const generation = useRef(0);

 if (projectId !== prevProjectId) {
  generation.current++;
  setPrevProjectId(projectId);
  setStatus(null);
  setError(null);
  setPreview(null);
  setReading(false);
 }

 const route = `/api/projects/${encodeURIComponent(projectId)}/codex-setup`;

 useEffect(() => {
  if (product !== 'codex') return;
  const controller = new AbortController();
  void readSetup(route, controller.signal).then(value => {
   if (!controller.signal.aborted) { setStatus(value); setError(null); }
  }).catch((failure: unknown) => {
   if (!controller.signal.aborted) setError(failure instanceof api.LocalApiError ? failure.code : 'local_operation_failed');
  });
  return () => controller.abort();
 }, [route, product]);

 async function operate(operation: 'configure' | 'preview-install' | 'install' | 'preview-remove' | 'remove' | 'recover-lock') {
  if (reading || busy) return;
  const started = generation.current;
  setReading(true); setPreview(null); setError(null);
  try {
   const value = await perform<CodexSetup>(route, { operation,
    ...(operation === 'configure' ? { product_version: status?.product_version, source_roots: status?.source_roots } : {}),
    ...((operation === 'install' || operation === 'remove') ? {
     expected_package_hash: status?.installation.packageHash ?? null,
     expected_installed_hash: status?.installation.installedHash ?? null,
    } : {}),
   });
   if (started !== generation.current) return;
   if (value) {
    setStatus(value);
    if (operation === 'preview-install') setPreview('install');
    if (operation === 'preview-remove') setPreview('remove');
   } else setError('local_operation_failed');
  } finally { if (started === generation.current) setReading(false); }
 }

 function refresh() {
  if (reading || busy) return;
  const started = generation.current;
  setReading(true); setError(null); setPreview(null);
  void readSetup(route).then(value => {
   if (started === generation.current) setStatus(value);
  }).catch((failure: unknown) => {
   if (started === generation.current) setError(failure instanceof api.LocalApiError ? failure.code : 'local_operation_failed');
  }).finally(() => { if (started === generation.current) setReading(false); });
 }

 const disabled = busy || reading || !status;
 const blocked = !!status && (status.installation.state === 'blocked' || status.installation.blockers.length > 0);

 return <Card className="break-keep" data-agent-setup={projectId}><CardHeader><CardTitle>{t('Agent connection setup', '에이전트 연결 설정')}</CardTitle><CardDescription>{t('Select a product and configure its connection for this project.', '제품을 선택하고 이 프로젝트의 연결을 설정하세요.')}</CardDescription></CardHeader><CardContent className="space-y-4">
  <div className="flex gap-2" role="group" aria-label={t('Agent product', '에이전트 제품')}>
   <Button className="min-h-11" variant={product === 'codex' ? 'default' : 'outline'} aria-pressed={product === 'codex'} data-product="codex" onClick={() => setProduct('codex')}>{t('Codex', 'Codex')}</Button>
   <Button className="min-h-11" variant={product === 'claude_code' ? 'default' : 'outline'} aria-pressed={product === 'claude_code'} data-product="claude_code" onClick={() => setProduct('claude_code')}>{t('Claude Code', 'Claude Code')}</Button>
  </div>
  {product === 'claude_code' && <OrdinaryObservationSetup projectId={projectId} locale={locale} busy={busy} perform={perform} />}
  {product === 'codex' && <>
   {error && <p role="alert" className="text-sm text-destructive">{t('Could not read or update Codex setup. Refresh and review the saved state.', 'Codex 설정을 읽거나 처리하지 못했습니다. 새로고침 후 저장 상태를 확인하세요.')} <code>{error}</code></p>}
   {!status && !error && <p role="status">{t('Reading Codex setup…', 'Codex 설정 확인 중…')}</p>}
   {status && <>
    <div className="flex flex-wrap gap-2">
     <Badge variant="secondary" data-codex-configured={String(status.configured)}>{status.configured ? t('Settings saved', '설정 저장됨') : t('Not configured', '설정 전')}</Badge>
     <Badge variant="outline" data-installation-state={status.installation.state}>{t('Files', '파일')}: {status.installation.state}</Badge>
     <Badge variant="outline" data-hook-trust={status.readiness.hook_trust}>{t('Hook trust', 'Hook 신뢰')}: {t('unverified', '미확인')}</Badge>
     <Badge variant="outline" data-roots-linked={String(status.connection.roots)}>{t('Linked roots', '연결된 루트')}: {status.connection.roots}</Badge>
    </div>

    <p className="text-sm text-muted-foreground">{t(
     'Codex startup hook requires user review and trust, and a new or resumed session, before the first connect request. Configured files alone do not prove native connection or support.',
     'Codex 시작 hook은 첫 연결 요청 전에 사용자의 검토·신뢰 확인과 새 세션 또는 재개된 세션이 필요합니다. 설정 파일만으로는 네이티브 연결이나 지원을 증명하지 않습니다.'
    )}</p>
    <p className="text-sm">{t('Configured Codex version', '설정할 Codex 버전')}: <code>{status.product_version}</code></p>

    {status.readiness.reason && <p className="text-sm" role="status" data-readiness-reason={status.readiness.reason}>{readinessReason(status.readiness.reason, t)}</p>}

    <dl className="grid gap-3 text-sm sm:grid-cols-2">
     <div><dt className="text-muted-foreground">{t('Receipt directory', 'Receipt 디렉토리')}</dt><dd className="break-all select-all">{status.installation.receiptDirectory}</dd></div>
     <div><dt className="text-muted-foreground">{t('Package destination', '패키지 위치')}</dt><dd className="break-all select-all">{status.installation.destination}</dd></div>
    </dl>

    {status.source_roots.length > 0 && <div className="space-y-1">
     <p className="text-sm font-medium">{t('Source roots', '소스 루트')}</p>
     <ul className="space-y-1 text-sm">{status.source_roots.map(root => <li key={root} className="break-all select-all">{root}</li>)}</ul>
    </div>}

    {status.installation.blockers.length > 0 && <ul role="alert" className="list-disc pl-5 text-sm">{status.installation.blockers.map(blocker => <li key={blocker}>{readinessReason(blocker, t)} <code>{blocker}</code></li>)}</ul>}
   </>}

   <div className="flex flex-wrap gap-2">
    <Button variant="outline" data-codex-action="configure" disabled={disabled || status?.configured} onClick={() => { void operate('configure'); }}>{t('Configure Codex', 'Codex 설정')}</Button>
    <Button variant="outline" data-codex-action="preview-install" disabled={disabled || !status?.configured || status.installation.source !== 'available'} onClick={() => { void operate('preview-install'); }}>{t('Preview install', '설치 미리보기')}</Button>
    <Button variant="outline" data-codex-action="preview-remove" disabled={disabled || !status?.installation.installedHash} onClick={() => { void operate('preview-remove'); }}>{t('Preview removal', '제거 미리보기')}</Button>
    <Button variant="outline" data-codex-action="refresh" disabled={busy || reading} onClick={refresh}><RefreshCw className="size-4" />{t('Refresh status', '상태 새로고침')}</Button>
    {status?.installation.blockers.includes('codex_connect_installation_busy') && <Button variant="outline" data-codex-action="recover-lock" disabled={disabled} onClick={() => { void operate('recover-lock'); }}>{t('Recover stopped installer', '종료된 설치 잠금 복구')}</Button>}
   </div>

   {preview && status?.changes && <div className="space-y-3 rounded-lg border p-4" data-codex-preview={preview}>
    <ul className="space-y-2 text-sm">{status.changes.map(change => <li key={change.path} className="break-all"><code>{change.path}</code> · {change.action}<div className="text-xs text-muted-foreground">{change.beforeHash ?? '—'} → {change.afterHash ?? '—'}</div></li>)}</ul>
    {preview === 'remove' && <p className="text-sm text-muted-foreground">{t('Owned hooks and skill files are removed. Existing receipts are kept.', '소유한 hook·skill 파일을 제거합니다. 기존 receipt는 유지합니다.')}</p>}
    <p className="text-sm">{t('Review these relative package paths before choosing to change files.', '상대 패키지 경로를 검토한 뒤 파일 변경을 직접 선택하세요.')}</p>
    <div className="flex flex-wrap gap-2">
     <Button variant={preview === 'remove' ? 'destructive' : 'default'} data-codex-choice={preview} disabled={disabled || blocked || status.changes.length === 0} onClick={() => { void operate(preview); }}>{preview === 'install' ? t('Install reviewed package', '검토한 패키지 설치') : t('Remove reviewed package', '검토한 패키지 제거')}</Button>
     <Button variant="outline" data-codex-action="cancel-preview" disabled={reading} onClick={() => setPreview(null)}>{t('Cancel', '취소')}</Button>
    </div>
   </div>}
  </>}
 </CardContent></Card>;
}
