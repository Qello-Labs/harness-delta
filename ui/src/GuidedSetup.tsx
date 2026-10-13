import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Files } from 'lucide-react';
import type { SetupReviewResult, SetupSaveResult } from '../../src/local-web-setup-review.js';
import { SetupBundleSchema } from './setup-bundle';
import { MeasurementReview } from './MeasurementReview';
import { applicationModes, applicationModeText, type ApplicationMode } from './application-mode';
import type { Locale, Project, Setup } from './types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function measurementSettingIdentifier(selected: string, profileDocument: string | undefined): string {
  if (selected) return selected;
  if (!profileDocument?.trim()) return '';
  try {
    const profile: unknown = JSON.parse(profileDocument);
    return typeof profile === 'object' && profile !== null && 'id' in profile && typeof profile.id === 'string' ? profile.id : '';
  } catch (error) {
    if (error instanceof SyntaxError) return '';
    throw error;
  }
}

export function buildSetupRequest(locale: Locale, project: Project | null, instruction: string, supporting: string, readme: string, mode: ApplicationMode | ''): string | null {
  const relative = (value: string) => !!value && !/^(?:[\\/]|[A-Za-z]:)/.test(value) && !value.split(/[\\/]/).includes('..') && !/[\r\n]/.test(value);
  const primary = instruction.trim();
  const supportingPaths = supporting.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const readmePath = readme.trim();
  if (!project || !mode || !relative(primary) || !supportingPaths.every(relative) || (readmePath && !relative(readmePath))) return null;
  const inputs = JSON.stringify({ project: { directory: project.directory, id: project.id, name: project.name }, candidate: { instruction: primary, supporting: supportingPaths, readme: readmePath || null }, application_mode: mode }, null, 2);
  const context = '\n\n' + '\x60\x60\x60json\n' + inputs + '\n\x60\x60\x60\n\n';
  return (locale === 'ko' ? '선택한 프로젝트의 현재 적용 하네스 A와 사용자가 준비한 개선 후보 B를 등록하고 비교 JSON을 준비해줘.' : 'Prepare registration and one comparison JSON for the selected project’s currently applied harness A and user-prepared improvement candidate B.') + context + (locale === 'ko' ?
    '설치된 harness-register와 harness-compare-config 스킬을 찾아 지침을 읽어줘. 찾을 수 없으면 검증 가능한 빌드된 Harness Delta checkout 경로를 나에게 물어보고 확인해줘. 도구 위치나 ID를 추측하지 마.\n' +
    '먼저 실제 적용 중인 구성과 후보 지침·적용 절차 및 선택한 참고 파일을 확인해줘. A는 현재 실제 적용 상태에서 명시적으로 선택한 artifact snapshot이며 전체 저장소 snapshot이 아니야. 후보 파일이 존재해도 적용된 것은 아니야. B는 공통 정책을 보존한 준비된 개선안이야. 적용 상태가 불명확하면 질문하고, 기준 하네스를 합성하거나 no-op 후보를 만들지 마.\n' +
    '하네스 ID, A/B 버전, 정책 버전, README 원본과 포함할 파일 목록, 새 비교 ID·이름을 제안해줘. 적용 방식은 내가 UI에서 고른 application_mode를 그대로 사용해줘. selected_markdown_only는 지침만 전달하는 방식이고, agent_applied는 에이전트가 적용 절차를 수행해 프로젝트 파일을 바꾸는 방식이야. 후보 파일이 고른 방식과 맞지 않으면(예: agent_applied인데 실제 적용 절차가 없음, 지침만 전달인데 설치·설정·파일 변경이 필요함) 방식을 임의로 바꾸지 말고 이유를 설명한 뒤 나에게 확인받아줘. 모르는 항목과 참조 파일 추가 여부는 한 번에 묶어 질문하고 등록 전에 명시적으로 확인받아줘. 원본 수정·후보 생성·하네스 적용은 별도 승인이 필요해.\n' +
    '확인된 선택 파일만 등록하고 검증된 manifest로 비교를 만들어줘. 기존 버전·비교·관측 이력을 보존하고 덮어쓰지 마. selected_markdown_only는 format 1, agent_applied는 format 2와 application=agent_applied를 사용해줘. 실제 ID·경로·해시와 검증 결과를 알려주고 비교 JSON의 실제 절대경로 한 줄을 코드블록으로 보여줘. JSON 내부 참조는 상대경로로 유지해줘.\n' +
    '측정 설정·날짜·완료 기준·가격·실행 기본값은 만들지 마. 빠진 입력은 질문하고 UI 입력 검토·확인·저장과 원본 지원 검증 gate를 유지해줘. 등록·비교 생성은 에이전트 실행이나 측정 시작이 아니야.\n' +
    '채택은 별도 인간 결정과 실제 적용이야. 최신 bundle·작업 성공·비용만으로 자동 채택하지 마. 사람이 개선안을 채택하고 실제 적용한 뒤 다음 비교에서는 그 현재 적용 상태가 A가 되고 새 후보 C가 역할 B가 돼. 채택 DB 기능을 만들지 마.' :
    'Locate installed harness-register and harness-compare-config skills and read their instructions. If unavailable, ask me for a verifiable built Harness Delta tool checkout path and verify it. Never guess tool locations or IDs.\n' +
    'Inspect the actually applied configuration and the candidate instruction/application procedure and selected supporting files first. A is an explicitly selected artifact snapshot of the currently applied configuration, not the whole repository. An existing candidate file does not mean it is applied. B is the prepared improvement preserving common policies. Ask when applied state is unclear; do not synthesize a baseline or create a no-op candidate.\n' +
    'Propose the harness ID, A/B versions, policy versions, README sources, selected files, and new comparison ID/name. Use the application_mode I selected in the UI as given. selected_markdown_only delivers instructions only; agent_applied means an agent performs an application procedure that changes project files. If the candidate files do not fit the selected mode (for example agent_applied without a real application procedure, or instructions only although installation, configuration or file changes are needed), do not switch modes yourself: explain why and ask me. Group missing-input and referenced-file questions and obtain explicit confirmation before registering. Source edits, candidate creation and harness application need separate approval.\n' +
    'Register only confirmed selected files and create the comparison from verified manifests. Preserve existing versions, comparisons and observation history; never overwrite them. Use format 1 for selected_markdown_only, or format 2 with application=agent_applied. Report actual IDs, paths, hashes and verification, then show the actual comparison JSON absolute path alone in a code block. Keep JSON references relative.\n' +
    'Do not invent measurement settings, dates, criteria, prices or runtime defaults. Ask for missing inputs and retain UI review/confirmation/save and source support gates. Registration and comparison creation do not launch an agent or start measurement.\n' +
    'Adoption is a separate human decision followed by real application. Never auto-adopt from the latest bundle, task success or cost. After human adoption and actual application, the next comparison uses that current applied state as A and a new candidate C in role B. Do not implement an adoption database feature.');
}

type InspectedComparison = Extract<SetupReviewResult, { comparison: unknown }>['comparison'];

export function buildMeasurementRequest(
  locale: Locale, project: Project | null, comparisonPath: string, comparison: InspectedComparison | null,
  identifier: string, policyStatus: { arm_a: string | null; arm_b: string | null },
): string | null {
  if (!project || !comparison || !comparisonPath.trim()) return null;
  const inputs = JSON.stringify({
    project: { directory: project.directory, id: project.id, name: project.name },
    comparison: { path: comparisonPath.trim(), ...comparison },
    proposed_profile_id: identifier || comparison.proposed_profile_id,
    policy_status: policyStatus,
  }, null, 2);
  const context = '\n\n' + '\x60\x60\x60json\n' + inputs + '\n\x60\x60\x60\n\n';
  return (locale === 'ko'
    ? '이 프로젝트의 첫 측정 설정에 필요한 검토 자료를 준비해줘. 아래는 UI가 확인한 기술 참조와, 선택했다면 A/B 정책 적격성이다. 다른 측정 결정은 아직 확인되지 않았어.'
    : 'Prepare reviewed inputs for this project’s first measurement setting. The UI verified these technical references; any selected A/B eligibility is a human decision, while other measurement choices remain unconfirmed.') + context + (locale === 'ko'
    ? '현재 Harness Delta checkout의 AGENTS.md와 production 측정 schema, 요구사항 R09, 로컬 UI 안내를 읽어줘. 스킬 설치를 전제하지 말고 checkout 위치가 불명확할 때만 질문해줘. 비교 파일·등록 프로젝트·A/B manifest를 다시 확인하고, 이미 등록된 검토 자료가 있으면 재사용해줘.\n'
    + '목적(functional_pilot 또는 real_experiment), A/B 정책 적격성, 허용 작업·완료 기준, 참가자와 모집 기간·표본·추적·중단·누락 규칙, 검증된 에이전트/원본/실행 범위, 가격 근거 중 확인되지 않은 결정만 묶어서 질문해줘. 이미 답한 항목은 다시 묻지 말고 제안값은 승인받아줘. 기술 ID·버전·해시는 검증된 입력에서 가져오고 추측하지 마.\n'
    + '승인된 값으로 비공개 설정 묶음 JSON 파일 하나를 만들어줘. 형식은 {"kind":"harness-delta.measurement-setup","schema_version":1,"input":{...}}이고 input은 src/local-web-setup-review.ts의 SetupReviewInputSchema야. 확인한 comparison_path·project_id, private profile, 완전한 schema-2 protocol, 승인된 policy_status 또는 variants 중 하나, 필요할 때만 price_table을 넣어줘. application_mode에는 위 comparison.application_mode 값을 그대로 넣고 바꾸지 마. 기존 등록값은 재사용해줘. functional_pilot에는 효과·품질 마진·신뢰수준을 넣지 마. 가격이나 원본 지원을 추정하거나 세션 내용을 읽거나 측정을 시작하지 마.\n'
    + 'freeze_at은 묶음 파일에서 허용하지 않아. 사용자가 UI에서 최종 확인하고 저장할 때 서버 시각으로 확정하며 모집 시작 전이어야 해. 과거 모집 날짜는 몰래 바꾸지 말고 필요한 수정만 질문해줘. 파일은 Harness Delta checkout의 .harness-delta/setup-drafts/ 아래 Git 제외 여부를 확인하고 보관해줘. 파일 경로와 미결정 사항을 알려줘. 나는 요청문 바로 아래에서 묶음 파일 하나를 불러와 요약을 확인하고 저장할 거야. DB 등록·동결·저장은 대신하지 마.'
    : 'Read AGENTS.md, the production measurement schemas, requirement R09, and the local UI guide in the current Harness Delta checkout. Do not require an installed skill; ask for the checkout location only if unknown. Recheck the comparison, registered project, and ordered manifests; reuse already reviewed registrations.\n'
    + 'Group only unknown human choices: purpose (functional_pilot or real_experiment), A/B eligibility, eligible work and completion criteria, participants, recruitment/sample/follow-up/stopping/missingness, qualified product/source/runtime scope, and the reviewed price basis. Do not ask again for answers already supplied. Confirm proposals. Derive technical IDs, versions, and hashes only from verified inputs.\n'
    + 'Create one private JSON setup bundle from approved values: {"kind":"harness-delta.measurement-setup","schema_version":1,"input":{...}}. Its input follows SetupReviewInputSchema in src/local-web-setup-review.ts: verified comparison_path and project_id, private profile, complete schema-2 protocol, approved policy_status OR variants, and price_table only when needed. Copy comparison.application_mode above into application_mode unchanged. Reuse existing registrations. A functional_pilot has no effect threshold, quality margin or confidence level. Do not guess rates or source support, read sessions or start measurement.\n'
    + 'Bundles must not contain freeze_at. The server records the final save-confirmation time, which must precede recruitment. Ask only for necessary corrections to past recruitment dates; never change them silently. Store the file under .harness-delta/setup-drafts/ in the Harness Delta checkout after verifying Git ignores it. Report the bundle path and unresolved decisions. I will load the one file directly below this request, review the summary and confirm saving. Do not register, freeze or save to the DB yourself.');
}

export function GuidedSetup({ locale, project, setups, busy, perform, onSaved }: {
  locale: Locale; project: Project | null; setups: Setup[]; busy: boolean;
  perform: <T>(route: string, input: unknown) => Promise<T | null>;
  onSaved: (value: SetupSaveResult) => void;
}) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  const [path, setPath] = useState('');
  const [template, setTemplate] = useState('');
  const [documents, setDocuments] = useState<Record<string, string>>({});
  const [inspected, setInspected] = useState<InspectedComparison | null>(null);
  const [suggestedIdentifier, setSuggestedIdentifier] = useState('');
  const [freezeAt, setFreezeAt] = useState('');
  const [review, setReview] = useState<SetupReviewResult | null>(null);
  const [inputError, setInputError] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [bundleName, setBundleName] = useState('');
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [mode, setMode] = useState<ApplicationMode | ''>('');
  const inputRevision = useRef(0);
  const [copying, setCopying] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<{ kind: string; text: string } | null>(null);
  const selectedTemplate = setups.find(setup => !setup.shared && setup.project_id === project?.id && setup.id === template);
  const identifier = selectedTemplate?.id ?? (documents.identifier?.trim() || measurementSettingIdentifier('', documents.profile) || suggestedIdentifier);
  const measurementPrompt = !selectedTemplate && buildMeasurementRequest(locale, project, path, inspected, identifier, {
    arm_a: documents.arm_a_status || null, arm_b: documents.arm_b_status || null,
  });
  const [instruction, setInstruction] = useState('');
  const [supporting, setSupporting] = useState('');
  const [readme, setReadme] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; inputRevision.current++; }; }, []);
  const prompt = buildSetupRequest(locale, project, instruction, supporting, readme, mode);
  const fileMode = review?.ready ? review.application_mode : inspected?.application_mode;
  const modeMismatch = !!mode && !!fileMode && mode !== fileMode;
  async function copyRequest(skill: string, prompt: string) {
    setCopying(skill);
    setCopied(null);
    setManualPrompt(null);
    try {
      await navigator.clipboard.writeText(prompt);
      if (active.current) setCopied(skill);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (active.current) setManualPrompt({ kind: skill, text: prompt });
    } finally { if (active.current) setCopying(null); }
  }
  const change = () => { inputRevision.current++; setReview(null); setConfirmed(false); setInputError(false); setBundleError(null); setLoadingBundle(false); };
  async function loadBundle(file: File) {
    change(); setLoadingBundle(true);
    const revision = inputRevision.current;
    try {
      const parsed = SetupBundleSchema.safeParse(JSON.parse(await file.text()) as unknown);
      if (!active.current || revision !== inputRevision.current) return;
      if (!parsed.success) { setBundleError(t('Choose the measurement setup bundle created by your agent.', '에이전트가 만든 측정 설정 묶음 파일을 선택하세요.')); return; }
      const { input } = parsed.data;
      if (input.project_id !== project?.id) { setBundleError(t('This bundle belongs to another project. Select its registered project first.', '다른 프로젝트의 설정입니다. 해당 등록 프로젝트를 먼저 선택하세요.')); return; }
      const next: Record<string, string> = {};
      for (const key of ['profile', 'protocol', 'variants', 'price_table'] as const)
        if (input[key] !== undefined) next[key] = JSON.stringify(input[key], null, 2);
      if (input.policy_status) { next.arm_a_status = input.policy_status.arm_a; next.arm_b_status = input.policy_status.arm_b; }
      if (input.template_id) next.identifier = input.template_id;
      setPath(input.comparison_path); setTemplate(input.profile ? '' : input.template_id ?? '');
      setDocuments(next); setFreezeAt(''); setInspected(null); setSuggestedIdentifier('');
      setBundleName(file.name); setCopied(null); setManualPrompt(null);
      const result = await perform<SetupReviewResult>('/api/setup-review', input.application_mode || !mode ? input : { ...input, application_mode: mode });
      if (active.current && revision === inputRevision.current) {
        setReview(result);
        if (result && !result.ready && 'comparison' in result) { setInspected(result.comparison); setSuggestedIdentifier(result.comparison.proposed_profile_id); }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (active.current && revision === inputRevision.current) setBundleError(t('Could not read this JSON file. Check the file and select it again.', 'JSON 파일을 읽지 못했습니다. 파일을 확인하고 다시 선택하세요.'));
    } finally { if (active.current && revision === inputRevision.current) setLoadingBundle(false); }
  }
  async function inspect() {
    setInputError(false);
    let input: Record<string, unknown>;
    try {
      input = { comparison_path: path, project_id: project?.id };
      if ((selectedTemplate || documents.profile?.trim()) && identifier) input.template_id = identifier;
      if (!selectedTemplate && !documents.variants?.trim() && documents.arm_a_status && documents.arm_b_status)
        input.policy_status = { arm_a: documents.arm_a_status, arm_b: documents.arm_b_status };
      for (const [key, value] of Object.entries(documents)) {
        if (['identifier', 'arm_a_status', 'arm_b_status'].includes(key) || key === 'profile' && selectedTemplate) continue;
        if (value.trim()) {
          const parsed: unknown = JSON.parse(value);
          if (key === 'profile' && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('id' in parsed) && identifier) {
            input[key] = { ...parsed, id: identifier };
          } else input[key] = parsed;
        }
      }
      if (freezeAt) input.freeze_at = freezeAt;
      if (mode) input.application_mode = mode;
    } catch { setInputError(true); return; }
    setConfirmed(false);
    const revision = inputRevision.current;
    const result = await perform<SetupReviewResult>('/api/setup-review', input);
    if (active.current && inputRevision.current === revision) {
      if (result && !result.ready && 'comparison' in result) {
        setInspected(result.comparison);
        setSuggestedIdentifier(result.comparison.proposed_profile_id);
      } else if (!result) setInspected(null);
      setReview(result);
    }
  }
  return <Card data-guided-setup=""><CardHeader><CardTitle>{t('2. Prepare comparison settings', '2. 비교·측정 설정 준비')}</CardTitle>
    <CardDescription>{t('Prepare with your agent, load one setup bundle and confirm the summary.', '에이전트와 준비하고, 설정 파일 하나를 불러와 요약을 확인하세요.')}</CardDescription></CardHeader>
    <CardContent className="space-y-5">
      <fieldset className="space-y-3 rounded-lg border p-4 break-keep" data-application-mode-choice={mode || 'unselected'}>
        <legend className="px-1 font-medium">{t('How is the harness applied?', '하네스를 어떻게 적용하나요?')}</legend>
        <p className="text-sm text-muted-foreground">{t('This is separate from A/B assignment. It decides what happens after a harness is assigned to a task, so choose it before preparing the comparison.', 'A/B 배정과는 별개입니다. 작업에 하네스가 배정된 뒤 무엇을 할지 정하므로, 비교를 준비하기 전에 선택하세요.')}</p>
        <div className="grid gap-3 sm:grid-cols-2">{applicationModes.map(value => { const text = applicationModeText(value, locale); return <label key={value} htmlFor={`guided-mode-${value}`} className="flex items-start gap-3 rounded-lg border p-3 has-[:checked]:bg-muted/60">
          <input type="radio" name="guided-application-mode" id={`guided-mode-${value}`} value={value} checked={mode === value} disabled={busy || !project} className="mt-1" onChange={() => { if (!review?.ready) change(); setMode(value); setCopied(null); setManualPrompt(null); }} />
          <span className="min-w-0"><span className="block font-medium">{text.choice}</span><span className="mt-1 block text-sm text-muted-foreground">{text.description}</span></span>
        </label>; })}</div>
        {!mode && fileMode && <p role="status" className="text-sm">{t('This comparison file uses: ', '이 비교 파일의 적용 방식: ')}<span className="font-medium">{applicationModeText(fileMode, locale).title}</span>{t('. Select the same method above to confirm it.', '. 위에서 같은 방식을 선택해 확인하세요.')}</p>}
        {modeMismatch && fileMode && <p role="alert" data-application-mode-mismatch="" className="text-sm">{t('Your selection differs from the comparison file, which uses: ', '선택한 방식이 비교 파일과 다릅니다. 비교 파일의 방식: ')}<span className="font-medium">{applicationModeText(fileMode, locale).title}</span>{t('. Change the selection, or prepare a new comparison with the method you want. Nothing can be saved until they match.', '. 선택을 바꾸거나, 원하는 방식으로 새 비교 파일을 준비하세요. 일치하기 전에는 저장할 수 없습니다.')}</p>}
      </fieldset>
      <details open={!inspected && !bundleName}><summary className="cursor-pointer font-medium">{t('Prepare a harness comparison first', '하네스 비교 파일부터 준비하기')}</summary>
      <div className="mt-4 grid min-w-0 gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <div className="rounded-lg bg-muted/40 p-4"><p className="font-medium">{project?.name ?? t('Select a registered project above', '위에서 등록된 프로젝트를 선택하세요')}</p>{project && <><p className="break-all text-sm text-muted-foreground">{project.directory}</p><p className="break-all text-xs text-muted-foreground">{project.id}</p></>}</div>
          <div className="space-y-2"><Label htmlFor="guided-instruction">{mode === 'agent_applied' ? t('Application procedure for the candidate (required)', '후보 적용 절차 (필수)') : mode === 'selected_markdown_only' ? t('Candidate instruction (required)', '후보 지침 (필수)') : t('Candidate instruction or application procedure (required)', '후보 지침 또는 적용 절차 (필수)')}</Label><Input id="guided-instruction" value={instruction} disabled={!project} placeholder="harness/candidate.md" onChange={event => { setInstruction(event.target.value); setCopied(null); setManualPrompt(null); }} /><p className="text-sm text-muted-foreground">{t('Provide a user-prepared file path relative to the selected project. An existing file is not evidence of application.', '선택한 프로젝트 기준으로 사용자가 준비한 파일의 상대경로를 입력하세요. 파일 존재는 적용 근거가 아닙니다.')}</p></div>
          <div className="space-y-2"><Label htmlFor="guided-supporting">{t('Supporting scripts or documents (optional, one relative path per line)', '참고 스크립트·문서 (선택, 한 줄에 상대경로 하나)')}</Label><textarea id="guided-supporting" value={supporting} disabled={!project} rows={3} className="w-full rounded border bg-background p-3 text-sm" onChange={event => { setSupporting(event.target.value); setCopied(null); setManualPrompt(null); }} /></div>
          <div className="space-y-2"><Label htmlFor="guided-readme">{t('README source (optional relative path)', 'README 원본 (선택 상대경로)')}</Label><Input id="guided-readme" value={readme} disabled={!project} onChange={event => { setReadme(event.target.value); setCopied(null); setManualPrompt(null); }} /></div>
          <Button disabled={!prompt || copying !== null} data-copy-skill="harness-register+harness-compare-config" onClick={() => { if (prompt) void copyRequest('setup', prompt); }}>{copied === 'setup' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied === 'setup' ? t('Copied', '복사됨') : t('Copy agent request', '에이전트 요청문 복사')}</Button>
          {copied === 'setup' && <p role="status" className="text-sm">{t('Paste into your agent. Confirm its proposal before registration.', '에이전트에 붙여넣고 등록 전에 제안을 확인하세요.')}</p>}
        </div>
        <aside className="min-w-0 space-y-4 rounded-lg bg-muted/30 p-4 text-sm">
          <h3 className="flex items-center gap-2 font-medium"><Files className="size-4" aria-hidden="true" />{t('Current A → prepared B', '현재 A → 준비한 B')}</h3>
          <p>{t('A is what is actually applied now. B is your prepared improvement with common policies preserved. The agent inspects both, groups questions and asks you to confirm IDs, versions, mode and selected files.', 'A는 지금 실제 적용 중인 구성입니다. B는 공통 정책을 보존한 준비된 개선안입니다. 에이전트가 둘을 확인하고 ID·버전·방식·선택 파일에 관한 질문을 묶어 확인받습니다.')}</p>
          <p>{t('Human adoption and real application are separate. Once adopted and applied, that current state becomes A; the next candidate C takes role B. Latest bundles, success and cost never auto-adopt.', '사람의 채택 결정과 실제 적용은 별도입니다. 채택하고 적용한 현재 상태가 다음 A가 되며 새 후보 C가 B 역할을 맡습니다. 최신 bundle·성공·비용으로 자동 채택하지 않습니다.')}</p>
          <details><summary className="cursor-pointer text-muted-foreground">{t('View combined request', '통합 요청문 보기')}</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{prompt ?? t('Select a project and enter valid relative file paths to prepare the request.', '프로젝트를 선택하고 유효한 상대경로를 입력하면 요청문이 준비됩니다.')}</pre></details>
        </aside>
      </div>
      {manualPrompt?.kind === 'setup' && <div className="space-y-2"><p role="alert" className="text-sm">{t('Clipboard access failed. Select and copy the request below.', '복사하지 못했습니다. 아래 요청문을 직접 복사하세요.')}</p>
        <textarea aria-label={t('Request to copy manually', '직접 복사할 요청문')} readOnly rows={4} value={manualPrompt.text} onFocus={event => event.currentTarget.select()} className="w-full rounded border bg-background p-3 text-sm" /></div>}
      </details>
      <div className="space-y-2"><Label htmlFor="guided-comparison">{t('Comparison JSON file path', '비교 JSON 파일 경로')}</Label>
        <Input id="guided-comparison" value={path} placeholder="/path/to/project/harness-config/comparisons/comparison.json" disabled={busy || !project} onChange={event => { change(); setPath(event.target.value); setInspected(null); setSuggestedIdentifier(''); setDocuments(old => ({ ...old, arm_a_status: '', arm_b_status: '' })); }} />
        {(!project || !path.trim()) && <p className="text-sm text-muted-foreground">{project
          ? t('Enter the comparison JSON path to enable file checking.', '비교 JSON 경로를 입력하면 파일 확인 버튼이 활성화됩니다.')
          : t('Select a registered project above before entering its comparison path.', '위에서 등록된 프로젝트를 선택한 뒤 비교 경로를 입력하세요.')}</p>}</div>
      <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">{t('What happens after checking the comparison?', '비교 파일을 확인한 뒤에는?')}</summary>
        <div className="mt-3 space-y-2 text-muted-foreground">
          <p>{t('Ask your agent for one setup bundle, load it below, then confirm the summary. Saving also connects the comparison.', '에이전트에게 설정 묶음 하나를 받아 아래에서 불러온 뒤 요약을 확인하세요. 저장하면 비교 설정까지 연결됩니다.')}</p>
          <p>{t('Setup does not start an agent or measurement. harness-apply and harness-connect are later steps with separate support requirements.', '설정만으로 에이전트나 측정이 시작되지는 않습니다. harness-apply와 harness-connect는 이후 단계이며 별도 지원 조건이 있습니다.')}</p>
        </div>
      </details>
      <div className="space-y-2"><Label htmlFor="guided-template">{t('Reuse registered measurement settings', '등록된 측정 설정 재사용')}</Label>
        <select id="guided-template" className="w-full rounded border bg-background p-2" disabled={busy} value={selectedTemplate?.id ?? ''} onChange={event => { change(); setTemplate(event.target.value); }}>
          <option value="">{t('Provide new measurement settings', '새 측정 설정 제공')}</option>
          {setups.filter(setup => !setup.shared && setup.project_id === project?.id).map(setup => <option key={setup.id} value={setup.id}>{setup.name} · {setup.id}</option>)}
        </select>
</div>
      <Button disabled={busy || !project || !path.trim()} onClick={() => { void inspect(); }}>{selectedTemplate || Object.keys(documents).some(key => !['identifier', 'arm_a_status', 'arm_b_status'].includes(key) && !!documents[key]?.trim()) || freezeAt ? t('Review inputs without saving', '저장 없이 입력 검토') : t('Check comparison file', '비교 파일 확인')}</Button>
      {inputError && <p role="alert">{t('Invalid JSON. Correct the selected input; nothing was saved.', 'JSON이 올바르지 않습니다. 해당 입력을 수정하세요. 저장하지 않았습니다.')}</p>}
      {inspected && <div data-comparison-inspected="" className="space-y-2 rounded-lg border p-4 text-sm">
        <p className="font-medium">{review?.ready
          ? t('Comparison reviewed · ready to save', '비교 검토됨 · 저장 준비 완료')
          : review && !review.ready && 'comparison' in review
            ? t('Comparison file verified · not saved yet', '비교 파일 확인됨 · 아직 저장 전')
            : t('Previously checked comparison · verify again before saving', '이전에 확인한 비교 · 저장 전 다시 확인 필요')}</p>
        <p>A: {inspected.arm_a.version} → B: {inspected.arm_b.version}</p>
        <p data-comparison-application-mode={inspected.application_mode}>{t('How the harness is applied: ', '하네스 적용 방식: ')}{applicationModeText(inspected.application_mode, locale).title}</p>
        <p className="text-muted-foreground">{t('The project and ordered manifests were checked. This does not prove that B is applied or that measurement is supported.', '프로젝트와 순서가 있는 manifest를 확인했습니다. B의 실제 적용이나 측정 지원을 뜻하지는 않습니다.')}</p>
        <details><summary>{t('Verified file references', '확인된 파일 정보')}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(inspected, null, 2)}</pre></details>
      </div>}
      {measurementPrompt && <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm" data-measurement-request="">
        <p className="font-medium">{t('Ask your agent to prepare measurement settings', '에이전트에게 측정 설정 준비 요청')}</p>
        <p className="text-muted-foreground">{t('Send this request to your agent. Answer its missing questions, then load the single setup bundle below.', '에이전트에게 요청문을 보내고 필요한 질문에 답하세요. 받은 설정 묶음 파일 하나를 바로 아래에서 불러오면 됩니다.')}</p>
        <Button variant="outline" data-copy-skill="measurement-request" disabled={copying !== null} onClick={() => { void copyRequest('measurement', measurementPrompt); }}>
          {copied === 'measurement' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied === 'measurement' ? t('Copied', '복사됨') : t('Copy measurement request', '측정 설정 요청문 복사')}
        </Button>
        {copied === 'measurement' && <p role="status">{t('Paste into your agent. You confirm the generated files before saving.', '에이전트에 붙여넣으세요. 생성된 파일은 저장 전에 직접 확인합니다.')}</p>}
        {manualPrompt?.kind === 'measurement' && <div className="space-y-2"><p role="alert">{t('Clipboard access failed. Select and copy the request below.', '복사하지 못했습니다. 아래 요청문을 직접 복사하세요.')}</p>
          <textarea aria-label={t('Measurement request to copy manually', '직접 복사할 측정 설정 요청문')} readOnly rows={4} value={manualPrompt.text} onFocus={event => event.currentTarget.select()} className="w-full rounded border bg-background p-3 text-xs" /></div>}
        <details><summary className="cursor-pointer text-muted-foreground">{t('View measurement request', '측정 설정 요청문 보기')}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{measurementPrompt}</pre></details>
      </div>}
      <section className="space-y-3 rounded-lg bg-muted/30 p-4" aria-labelledby="guided-bundle-label">
        <Label id="guided-bundle-label" htmlFor="guided-bundle">{t('Load prepared settings', '준비된 설정 불러오기')}</Label>
        <p className="break-keep text-sm text-muted-foreground">{t('Choose the one setup bundle from your agent. Its contents are checked without saving.', '에이전트가 만든 설정 묶음 파일 하나를 선택하세요. 저장하지 않고 내용을 확인합니다.')}</p>
        <input id="guided-bundle" type="file" accept=".json,application/json" className="block w-full min-w-0 text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-4 file:py-3" disabled={busy || loadingBundle || !project} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void loadBundle(file); }} />
        {loadingBundle && <p role="status" className="text-sm">{t('Reading and checking settings…', '설정을 읽고 확인하는 중…')}</p>}
        {bundleName && <p className="break-all text-sm">{bundleName}</p>}
        {bundleError && <p role="alert" className="break-keep text-sm">{bundleError}</p>}
      </section>
      {inspected && !selectedTemplate && !documents.variants?.trim() && <details open={!(documents.arm_a_status && documents.arm_b_status)}>
        <summary className="cursor-pointer text-sm font-medium">{documents.arm_a_status && documents.arm_b_status ? t('Policy choices recorded · review or change', '정책 적격성 확인됨 · 확인하거나 변경') : t('Confirm remaining policy choices', '미결정 정책 적격성 확인')}</summary>
        <fieldset className="mt-3 space-y-3 rounded-lg border p-4 text-sm">
        <legend className="px-1 font-medium">{t('Confirm A/B policy eligibility', 'A/B 정책 적격성 확인')}</legend>
        <p className="text-muted-foreground">{t('The manifests prove identity, not eligibility. After you explicitly decide both statuses, variant IDs and verified hash references are generated without filling in experimental criteria.', 'manifest는 구성을 식별하지만 적격성까지 보증하지 않습니다. A/B 상태를 직접 결정하면 variant ID와 확인된 해시 참조를 자동 생성합니다. 완료 기준은 임의로 채우지 않습니다.')}</p>
        {(['arm_a', 'arm_b'] as const).map((arm, index) => <div key={arm} className="space-y-1">
          <Label htmlFor={`guided-${arm}-status`}>{index === 0 ? `A · ${inspected.arm_a.version}` : `B · ${inspected.arm_b.version}`}</Label>
          <select id={`guided-${arm}-status`} className="native-select" value={documents[`${arm}_status`] ?? ''} disabled={busy} onChange={event => { change(); setDocuments(old => ({ ...old, [`${arm}_status`]: event.target.value })); }}>
            <option value="">{t('Choose after review', '검토 후 선택')}</option>
            <option value="eligible">{t('Eligible', '적격 확인')}</option>
            <option value="ineligible">{t('Ineligible', '부적격')}</option>
          </select>
        </div>)}
      </fieldset></details>}
      {review && !review.ready && <div role="status" data-setup-review="blocked" className="space-y-2 break-keep rounded-lg bg-muted/40 p-4 text-sm">
        <p className="font-medium">{inspected ? t('Review these items before saving', '저장 전에 아래 항목을 확인하세요') : t('Check the inputs and comparison path', '입력과 비교 경로를 확인하세요')}</p>
        {inspected && <p>{t('Reuse an existing registered setting above, or provide reviewed decisions for a new setting. Technical IDs and verified A/B references are suggested automatically.', '위에서 등록된 설정을 재사용하거나 새 설정에 필요한 검토된 결정을 제공하세요. 기술 식별자와 확인된 A/B 참조는 자동 제안합니다.')}</p>}
        <ul className="list-disc space-y-1 pl-5">
          {review.issues.some(issue => issue.code === 'registration_too_late') && <li>{t('Recruitment has already started. Ask your agent to correct the recruitment dates with your approval, then load the revised bundle. Nothing was saved.', '모집 시작일이 이미 지났습니다. 에이전트와 새 모집 날짜를 확인한 뒤 수정한 묶음을 불러오세요. 저장하지 않았습니다.')}</li>}
          {review.issues.some(issue => issue.code === 'ineligible_variant') && <li>{t('Both harnesses must be eligible before this comparison can be saved. Review the policy decision with your agent.', '비교를 저장하려면 두 하네스 모두 정책 적격성이 확인되어야 합니다. 에이전트와 정책 결정을 다시 검토하세요.')}</li>}
          {review.issues.some(issue => issue.code === 'application_mode_mismatch') && <li>{t('The selected application method differs from the comparison file. Select the matching method above or prepare a new comparison. Nothing was saved.', '선택한 적용 방식이 비교 파일과 다릅니다. 위에서 같은 방식을 선택하거나 새 비교 파일을 준비하세요. 저장하지 않았습니다.')}</li>}
          {review.issues.some(issue => issue.field === 'profile') && <li>{t('Reviewed measurement settings', '검토된 측정 설정')}</li>}
          {review.issues.some(issue => issue.field.includes('criterion_ids')) && <li>{t('Task completion criteria and allowed work', '작업 완료 기준과 대상 작업')}</li>}
          {review.issues.some(issue => issue.field.includes('policy_status')) && <li>{t('A/B policy eligibility approval', 'A/B 정책 적격성 확인')}</li>}
          {review.issues.some(issue => issue.field.startsWith('protocol')) && <li>{t('Comparison purpose, recruitment period, sample and source rules', '비교 목적·모집 기간·표본·원본 규칙')}</li>}
          {review.issues.some(issue => issue.field.includes('execution')) && <li>{t('Agent product, installation and execution scope', '에이전트 제품·설치·실행 범위')}</li>}
          {review.issues.some(issue => issue.field.startsWith('price_table')) && <li>{t('Reviewed price basis', '검토된 가격 기준')}</li>}
        </ul>
        <details><summary className="cursor-pointer">{t('Technical missing-field details', '누락 항목 상세')}</summary><ul className="mt-2 list-disc pl-5">{review.issues.map((issue, index) => <li key={index} className="break-all">{issue.field || 'input'}: {issue.code}</li>)}</ul></details>
      </div>}
      {review?.ready && review.profile.setup.workflow.assignment.project_id !== project?.id && <p role="alert">{t('Reviewed inputs belong to a different project. Select matching inputs and review again.', '검토 입력이 다른 프로젝트에 속합니다. 일치하는 입력으로 다시 검토하세요.')}</p>}
      {review?.ready && review.profile.setup.workflow.assignment.project_id === project?.id && <div className="space-y-3 break-keep rounded-lg border p-4" data-setup-review="ready">
        <MeasurementReview review={review} projectName={project?.name ?? ''} locale={locale} />
        {mode !== review.application_mode && <p role="status" data-application-mode-required="" className="text-sm">{t('To save, select the application method this comparison uses in the first step above.', '저장하려면 맨 위 ‘적용 방식’에서 이 비교와 같은 방식을 선택하세요.')}</p>}
        <label className="flex items-start gap-2"><input id="guided-confirm" type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t('I confirm these conditions for new tasks.', '새 작업에 사용할 위 조건을 확인했습니다.')}</label>
        <div className="flex flex-wrap gap-2"><Button data-setup-save="" disabled={busy || !confirmed || mode !== review.application_mode} onClick={() => {
          const revision = inputRevision.current; void perform<SetupSaveResult>('/api/setup-save-reviewed', { token: review.token }).then(value => { if (value && active.current && inputRevision.current === revision) { change(); onSaved(value); } });
        }}>{t('Confirm and save settings', '이 내용으로 확정하고 저장')}</Button><Button variant="outline" disabled={busy} onClick={change}>{t('Cancel review', '검토 취소')}</Button></div>
      </div>}
      <details><summary className="cursor-pointer font-medium">{t('Advanced: individual files and technical values', '고급: 개별 파일·기술 값 직접 입력')}</summary>
        <Label htmlFor="guided-template-id">{t('Settings identifier (editable suggestion)', '설정 식별자 (자동 제안·직접 수정 가능)')}</Label>
        <Input id="guided-template-id" value={identifier} readOnly={!!selectedTemplate} disabled={busy} aria-describedby="guided-identifier-help" onChange={event => { change(); setDocuments(old => ({ ...old, identifier: event.target.value })); }} />
        <p id="guided-identifier-help" role="status" className="break-keep text-sm text-muted-foreground">{selectedTemplate
          ? t('This is the selected registered setting’s identifier. Its existing profile is reused.', '선택한 등록 설정의 식별자입니다. 기존 profile을 재사용합니다.')
          : suggestedIdentifier
            ? t('Suggested from the verified comparison. You may edit it; if you provide a profile JSON with an id, the two must match.', '확인된 비교에서 자동 제안했습니다. 수정할 수 있으며, profile JSON에 id가 있으면 서로 같아야 합니다.')
            : t('Check the comparison path first. An identifier will be suggested automatically; you can also enter one yourself.', '먼저 비교 경로를 확인하세요. 식별자가 자동 제안되며 직접 입력할 수도 있습니다.')}</p>
        <p className="my-3 break-keep text-pretty text-sm">{t('The comparison path can be checked without these files. For a first-time measurement setting, provide only the reviewed decisions not already registered; no criteria, source support or prices are invented.', '비교 경로 확인에는 아래 파일이 필요하지 않습니다. 처음 등록할 때는 이미 등록되지 않은 검토된 결정만 제공하세요. 완료 기준·원본 지원·가격은 만들어 넣지 않습니다.')}</p>
        <p className="mb-3 break-keep text-sm">{t('If you already have reviewed profile, variant, protocol or price JSON, add it here. Missing human decisions are listed after checking the comparison. An omitted profile id uses the suggested identifier.', '검토된 profile·variant·protocol·가격 JSON이 이미 있다면 여기에 넣으세요. 사람의 결정이 필요한 항목은 비교 확인 후 표시됩니다. profile의 id를 생략하면 제안된 식별자를 사용합니다.')}</p>
        <div className="space-y-4">{(['profile', 'variants', 'protocol', 'price_table'] as const).map(key => <div key={key} className="space-y-2">
          <Label htmlFor={`guided-${key}`}>{key} JSON</Label>
          <input type="file" accept=".json,application/json" disabled={busy || (key === 'profile' && !!selectedTemplate)} aria-label={`${key} JSON file`} onChange={event => {
            const file = event.target.files?.[0]; if (!file) return;
            change(); const revision = inputRevision.current; void file.text().then(value => { if (!active.current || inputRevision.current !== revision) return; change(); setDocuments(old => ({ ...old, [key]: value })); });
          }} />
          <textarea id={`guided-${key}`} className="min-h-32 w-full rounded border bg-background p-3 font-mono text-xs" value={documents[key] ?? ''} disabled={busy || (key === 'profile' && !!selectedTemplate)} onChange={event => { change(); setDocuments(old => ({ ...old, [key]: event.target.value })); }} />
        </div>)}</div>
        <div className="mt-4 space-y-2"><Label htmlFor="guided-freeze">{t('Override confirmation time (optional)', '확정 시각 직접 지정 (선택)')}</Label>
          <Input id="guided-freeze" value={freezeAt} disabled={busy} onChange={event => { change(); setFreezeAt(event.target.value); }} /></div>
        <p className="mt-2 text-sm text-muted-foreground">{t('Leave the time blank to record server time when you confirm and save.', '비워두면 최종 확인하고 저장하는 서버 시각을 기록합니다.')}</p>
        <Button className="mt-4" variant="outline" disabled={busy || !project || !path.trim()} onClick={() => { void inspect(); }}>{t('Review edited inputs', '수정한 입력 검토')}</Button>
      </details>
    </CardContent></Card>;
}
