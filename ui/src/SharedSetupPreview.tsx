import { useState } from 'react';
import type { Locale } from './types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { LocalWebProfile } from '../../src/web/local-web-domain.js';
import type { PriceTable } from '../../src/flexible-contracts.js';
export interface SharedSetupImport {
  shared: true;
  token: string;
  projects: {
    project_id: string;
    name: string;
    pair: { id: string; name: string; arm_a: { version: string }; arm_b: { version: string }; settings_hash: string };
    original_tools: string[];
    templates: {
      id: string;
      name: string;
      blocker: string | null;
      runtime?: { model: string | null; effort: string | null };
      review?: { profile: LocalWebProfile; protocol: unknown; price_table: PriceTable };
    }[];
  }[];
}
export function SharedSetupPreview({
  value,
  locale,
  busy,
  onBind,
  onCancel
}: {
  value: SharedSetupImport;
  locale: Locale;
  busy: boolean;
  onBind: (project: string, template: string) => void;
  onCancel: () => void;
}) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const [project, setProject] = useState('');
  const [template, setTemplate] = useState('');
  const selected = value.projects.find(p => p.project_id === project);
  const choice = selected?.templates.find(p => p.id === template);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Connect this comparison on this PC', '이 PC에 비교 설정 연결')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>
          {t(
            'The file pins the harness pair. Select an existing local project and reviewed measurement settings. Execution support is checked separately.',
            '파일은 하네스 쌍을 고정합니다. 기존 로컬 프로젝트와 검토된 측정 기준을 선택하세요. 실행 지원은 별도로 확인합니다.'
          )}
        </p>
        <label htmlFor="shared-project">{t('Registered project', '등록된 프로젝트')}</label>
        <select
          id="shared-project"
          value={project}
          disabled={busy}
          onChange={event => {
            setProject(event.target.value);
            setTemplate('');
          }}
          className="w-full rounded border p-2"
        >
          <option value="">{t('Select explicitly', '직접 선택하세요')}</option>
          {value.projects.map(p => (
            <option key={p.project_id} value={p.project_id}>
              {p.name} · {p.project_id}
            </option>
          ))}
        </select>
        {selected && (
          <>
            <p>
              {selected.pair.name} · A: {selected.pair.arm_a.version} · B: {selected.pair.arm_b.version}
            </p>
            <p className="break-all text-xs">{selected.pair.settings_hash}</p>
            <p>
              {t('Snapshot integrity verified. Original tool files:', 'snapshot 무결성을 확인했습니다. 원본 도구 파일:')} A: {selected.original_tools[0]} · B:{' '}
              {selected.original_tools[1]}
            </p>
            <label htmlFor="shared-template">{t('Reviewed local measurement settings', '검토된 로컬 측정 기준')}</label>
            <select
              id="shared-template"
              value={template}
              disabled={busy}
              onChange={event => setTemplate(event.target.value)}
              className="w-full rounded border p-2"
            >
              <option value="">{t('Select explicitly', '직접 선택하세요')}</option>
              {selected.templates.map(p => (
                <option key={p.id} value={p.id} disabled={p.blocker !== null}>
                  {p.name} · {p.id}
                </option>
              ))}
            </select>
            {choice?.runtime && (
              <p>
                {t('Runtime', '실행 설정')}: {choice.runtime.model ?? t('Native model', '네이티브 모델')} /{' '}
                {choice.runtime.effort ?? t('Native effort', '네이티브 effort')}
              </p>
            )}
            {choice?.review && (
              <div className="space-y-2">
                <p>
                  {t('Criterion IDs', '완료 기준 ID')}: {choice.review.profile.setup.workflow.assignment.metadata.criterion_ids.join(', ')}
                </p>
                <p>
                  protocol: {choice.review.profile.setup.workflow.assignment.protocol_id} · price_table: {choice.review.price_table.id} /{' '}
                  {choice.review.price_table.version}
                </p>
                <details>
                  <summary>{t('Review configuration, source scope and frozen references', '구성·원본 범위·동결 참조 검토')}</summary>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(choice.review, null, 2)}</pre>
                </details>
              </div>
            )}
            {selected.templates
              .filter(p => p.blocker)
              .map(p => (
                <p key={p.id} role="status">
                  {p.name}: {p.blocker}
                </p>
              ))}
            {selected.templates.length === 0 && (
              <p role="status">
                {t(
                  'No reviewed local settings. Register the required project, variants and protocol through the reviewed workflow first. Import creates none of them.',
                  '검토된 로컬 기준이 없습니다. 검토 절차로 프로젝트·variant·protocol을 먼저 등록하세요. 불러오기는 이 항목을 만들지 않습니다.'
                )}
              </p>
            )}
          </>
        )}
        <p className="text-sm">
          {t(
            'Connection saves private settings under .harness-delta/setup. No task, script or agent starts. Original tools are rechecked for the assigned arm before use.',
            '연결 정보는 .harness-delta/setup에 비공개로 저장합니다. 작업·스크립트·에이전트를 시작하지 않습니다. 사용 전 배정된 arm의 원본 도구를 다시 확인합니다.'
          )}
        </p>
        <div className="flex gap-2">
          <Button disabled={busy || !choice || choice.blocker !== null} onClick={() => onBind(project, template)}>
            {t('Connect local settings', '로컬 설정 연결')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t('Cancel', '취소')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
