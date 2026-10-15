import { useEffect, useState } from 'react';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js';
import { Badge } from './components/ui/badge.js';
import { Label } from './components/ui/label.js';
import { ClaudeConnection } from './ClaudeConnection.js';
import * as api from './api.js';
import type { Locale, OrdinarySetup, Task } from './types.js';

export function TaskAssignment({ task, locale }: { task: Task; locale: Locale }) {
 if (task.mode === 'ordinary') return null;
 return <div data-task-assignment="comparison"><dt className="text-muted-foreground">{locale === 'ko' ? '배정' : 'Assignment'}</dt><dd className="mt-1 break-all">{task.preparation.assigned_variant_id ?? '—'}</dd></div>;
}

export function OrdinaryCriteria({ selected, onChange, locale }: {
 selected: string[]; onChange: (value: string[]) => void; locale: Locale;
}) {
 return <fieldset className="space-y-2 rounded-lg border p-4" data-ordinary-criteria>
  <legend className="px-1 text-sm font-medium">{locale === 'ko' ? '생성 전에 완료 기준 선택' : 'Select completion criteria before creation'}</legend>
  <Label className="flex items-center"><input type="checkbox" name="criterion_ids" value="user_confirmed_completion" checked={selected.includes('user_confirmed_completion')} onChange={event => onChange(event.target.checked ? ['user_confirmed_completion'] : [])} />{locale === 'ko' ? '사용자가 원래 요청의 완료를 직접 확인' : 'User confirms completion of the original request'}</Label>
 </fieldset>;
}

export function OrdinaryObservationSetup({ projectId, locale, busy, perform }: {
 projectId: string; locale: Locale; busy: boolean;
 perform: <T>(route: string, body: unknown) => Promise<T | null>;
}) {
 const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
 const [status, setStatus] = useState<OrdinarySetup | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [reading, setReading] = useState(false);
 const [preview, setPreview] = useState<'install' | 'remove' | null>(null);
 const route = `/api/projects/${encodeURIComponent(projectId)}/ordinary-setup`;
 useEffect(() => {
  const controller = new AbortController();
  void fetch(route, { cache: 'no-store', signal: controller.signal }).then(async reply => {
   if (!reply.ok) throw new api.LocalApiError('ordinary_setup_unavailable');
   const value = await reply.json() as OrdinarySetup;
   if (!controller.signal.aborted) setStatus(value);
  }).catch((failure: unknown) => {
   if (!controller.signal.aborted) setError(failure instanceof api.LocalApiError ? failure.code : 'local_operation_failed');
  });
  return () => controller.abort();
 }, [route]);
 async function operate(operation: 'configure' | 'preview-install' | 'install' | 'preview-remove' | 'remove' | 'recover-lock') {
  if (reading || busy) return;
  setReading(true); setPreview(null); setError(null);
  try {
   const value = await perform<OrdinarySetup>(route, { operation,
    ...(operation === 'configure' ? { product_version: status?.product_version } : {}),
    ...((operation === 'install' || operation === 'remove') ? {
     expected_package_hash: status?.installation.packageHash ?? null,
     expected_installed_hash: status?.installation.installedHash ?? null,
    } : {}),
   });
   if (value) {
    setStatus(value);
    if (operation === 'preview-install') setPreview('install');
    if (operation === 'preview-remove') setPreview('remove');
   } else setError('local_operation_failed');
  } finally { setReading(false); }
 }
 const disabled = busy || reading || !status;
 const blocked = !!status && (status.installation.state === 'blocked' || status.installation.blockers.length > 0);
 return <Card data-ordinary-setup={projectId}><CardHeader><CardTitle>{t('Claude connection setup', 'Claude 연결 설정')}</CardTitle><CardDescription>{t('Project-only package setup. No comparison assignment or native configuration changes.', '프로젝트 전용 패키지 설정입니다. 비교 배정이나 네이티브 설정 변경은 없습니다.')}</CardDescription></CardHeader><CardContent className="space-y-4">
  {error && <p role="alert" className="text-sm text-destructive">{t('Could not read or update setup. Refresh and review the saved state.', '설정을 읽거나 처리하지 못했습니다. 새로고침 후 저장 상태를 확인하세요.')} <code>{error}</code></p>}
  {!status && !error && <p role="status">{t('Reading setup…', '설정 확인 중…')}</p>}
  {status && <>
   <div className="flex flex-wrap gap-2"><Badge variant="secondary">{status.configured ? t('Configured', '설정됨') : t('Not configured', '설정 전')}</Badge><Badge variant="outline" data-installation-state={status.installation.state}>{t('Package', '패키지')}: {status.installation.state}</Badge><Badge variant="outline" data-admission={String(status.admission.admitted)}>{status.admission.admitted ? t('Ordinary connection allowed', '일반 연결 허용') : t('Connection unavailable', '연결 불가')}</Badge></div>
   <p className="text-sm">{t(`All Claude-family models are allowed at their observed effort. Family limit ${status.admission.max_family_members} members; cost remains partial.`, `모든 Claude 계열 모델과 관측된 effort를 허용합니다. 가족 한도 ${status.admission.max_family_members}개이며 비용은 부분 관측입니다.`)}</p>
   <p className="text-sm text-muted-foreground">{t('Copied package ≠ registered hook ≠ native receipt ≠ observing. Hook registration is unverified; invoke the skill in the native parent and check the connection state.', '패키지 복사 ≠ hook 등록 ≠ 네이티브 receipt ≠ 관측 중입니다. hook 등록은 미확인입니다. 네이티브 부모에서 skill을 호출하고 연결 상태를 확인하세요.')}</p>
   <dl className="grid gap-3 text-sm sm:grid-cols-2">{[[t('Package destination', '패키지 위치'), status.installation.destination], [t('Receipt directory', 'Receipt 디렉토리'), status.installation.receiptDirectory]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>)}</dl>
   {status.installation.blockers.length > 0 && <ul role="alert" className="list-disc pl-5 text-sm">{status.installation.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>}
   <p className="text-sm text-muted-foreground">{t('Edited or unowned files block changes. Status and preview do not write files; installation never creates a native receipt.', '수정되었거나 소유하지 않은 파일은 변경을 차단합니다. 상태 조회·미리보기는 파일을 쓰지 않으며 설치로 네이티브 receipt를 만들지 않습니다.')}</p>
  </>}
  <div className="flex flex-wrap gap-2">
   <Button variant="outline" disabled={disabled || status?.configured} onClick={() => { void operate('configure'); }}>{t('Configure Claude', 'Claude 설정')}</Button>
   <Button variant="outline" disabled={disabled || !status?.configured || status.installation.source !== 'available'} onClick={() => { void operate('preview-install'); }}>{t('Preview install / update', '설치·갱신 미리보기')}</Button>
   <Button variant="outline" disabled={disabled || !status?.installation.installedHash} onClick={() => { void operate('preview-remove'); }}>{t('Preview removal', '제거 미리보기')}</Button>
   {status?.installation.blockers.includes('installation_recovery_required') && <Button variant="outline" disabled={disabled} onClick={() => { void operate('recover-lock'); }}>{t('Recover stopped installer', '종료된 설치 잠금 복구')}</Button>}
  </div>
  {preview && status?.changes && <div className="space-y-3 rounded-lg border p-4" data-install-preview={preview}>
   <ul className="space-y-2 text-sm">{status.changes.map(change => <li key={change.path} className="break-all"><code>{change.path}</code> · {change.action}<div className="text-xs text-muted-foreground">{change.beforeHash ?? '—'} → {change.afterHash ?? '—'}</div></li>)}</ul>
   <p className="text-sm">{t('Review these relative package paths before choosing to change files.', '상대 패키지 경로를 검토한 뒤 파일 변경을 직접 선택하세요.')}</p>
   <div className="flex flex-wrap gap-2"><Button data-install-choice={preview} disabled={disabled || blocked || status.changes.length === 0} onClick={() => { void operate(preview); }}>{preview === 'install' ? t('Install / update reviewed package', '검토한 패키지 설치·갱신') : t('Remove reviewed package', '검토한 패키지 제거')}</Button><Button variant="outline" disabled={reading} onClick={() => setPreview(null)}>{t('Cancel', '취소')}</Button></div>
  </div>}
 </CardContent></Card>;
}

export function OrdinaryConnectionGuide({ task, locale, origin, busy, online, onAction, reason }: {
 task: Task; locale: Locale; origin: string; busy: boolean; online: boolean;
 onAction: (code: string) => void; reason: (code: string) => string;
}) {
 return <ClaudeConnection task={task} projectName={task.project_id} locale={locale} origin={origin}
  busy={busy} online={online} onAction={onAction} reason={reason} />;
}
