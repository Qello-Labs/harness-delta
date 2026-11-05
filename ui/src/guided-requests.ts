import type { ApplicationMode } from './application-mode';
import type { InspectedComparison, Locale, Project } from './types';

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

export function buildSetupRequest(
  locale: Locale,
  project: Project | null,
  instruction: string,
  supporting: string,
  readme: string,
  mode: ApplicationMode | ''
): string | null {
  const relative = (value: string) => !!value && !/^(?:[\\/]|[A-Za-z]:)/.test(value) && !value.split(/[\\/]/).includes('..') && !/[\r\n]/.test(value);
  const primary = instruction.trim();
  const supportingPaths = supporting
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
  const readmePath = readme.trim();
  if (!project || !mode || !relative(primary) || !supportingPaths.every(relative) || (readmePath && !relative(readmePath))) return null;
  const inputs = JSON.stringify(
    {
      project: { directory: project.directory, id: project.id, name: project.name },
      candidate: { instruction: primary, supporting: supportingPaths, readme: readmePath || null },
      application_mode: mode
    },
    null,
    2
  );
  const context = '\n\n' + '\x60\x60\x60json\n' + inputs + '\n\x60\x60\x60\n\n';
  return (
    (locale === 'ko'
      ? '선택한 프로젝트의 현재 적용 하네스 A와 사용자가 준비한 개선 후보 B를 등록하고 비교 JSON을 준비해줘.'
      : 'Prepare registration and one comparison JSON for the selected project’s currently applied harness A and user-prepared improvement candidate B.') +
    context +
    (locale === 'ko'
      ? '설치된 harness-register와 harness-compare-config 스킬을 찾아 지침을 읽어줘. 찾을 수 없으면 검증 가능한 빌드된 Harness Delta checkout 경로를 나에게 물어보고 확인해줘. 도구 위치나 ID를 추측하지 마.\n' +
        '먼저 실제 적용 중인 구성과 후보 지침·적용 절차 및 선택한 참고 파일을 확인해줘. A는 현재 실제 적용 상태에서 명시적으로 선택한 artifact snapshot이며 전체 저장소 snapshot이 아니야. 후보 파일이 존재해도 적용된 것은 아니야. B는 공통 정책을 보존한 준비된 개선안이야. 적용 상태가 불명확하면 질문하고, 기준 하네스를 합성하거나 no-op 후보를 만들지 마.\n' +
        '하네스 ID, A/B 버전, 정책 버전, README 원본과 포함할 파일 목록, 새 비교 ID·이름을 제안해줘. 적용 방식은 내가 UI에서 고른 application_mode를 그대로 사용해줘. selected_markdown_only는 지침만 전달하는 방식이고, agent_applied는 에이전트가 적용 절차를 수행해 프로젝트 파일을 바꾸는 방식이야. 후보 파일이 고른 방식과 맞지 않으면(예: agent_applied인데 실제 적용 절차가 없음, 지침만 전달인데 설치·설정·파일 변경이 필요함) 방식을 임의로 바꾸지 말고 이유를 설명한 뒤 나에게 확인받아줘. 모르는 항목과 참조 파일 추가 여부는 한 번에 묶어 질문하고 등록 전에 명시적으로 확인받아줘. 원본 수정·후보 생성·하네스 적용은 별도 승인이 필요해.\n' +
        '확인된 선택 파일만 등록하고 검증된 manifest로 비교를 만들어줘. 기존 버전·비교·관측 이력을 보존하고 덮어쓰지 마. selected_markdown_only는 format 1, agent_applied는 format 2와 application=agent_applied를 사용해줘. 실제 ID·경로·해시와 검증 결과를 알려주고 비교 JSON의 실제 절대경로 한 줄을 코드블록으로 보여줘. JSON 내부 참조는 상대경로로 유지해줘.\n' +
        '측정 설정·날짜·완료 기준·가격·실행 기본값은 만들지 마. 빠진 입력은 질문하고 UI 입력 검토·확인·저장과 원본 지원 검증 gate를 유지해줘. 등록·비교 생성은 에이전트 실행이나 측정 시작이 아니야.\n' +
        '채택은 별도 인간 결정과 실제 적용이야. 최신 bundle·작업 성공·비용만으로 자동 채택하지 마. 사람이 개선안을 채택하고 실제 적용한 뒤 다음 비교에서는 그 현재 적용 상태가 A가 되고 새 후보 C가 역할 B가 돼. 채택 DB 기능을 만들지 마.'
      : 'Locate installed harness-register and harness-compare-config skills and read their instructions. If unavailable, ask me for a verifiable built Harness Delta tool checkout path and verify it. Never guess tool locations or IDs.\n' +
        'Inspect the actually applied configuration and the candidate instruction/application procedure and selected supporting files first. A is an explicitly selected artifact snapshot of the currently applied configuration, not the whole repository. An existing candidate file does not mean it is applied. B is the prepared improvement preserving common policies. Ask when applied state is unclear; do not synthesize a baseline or create a no-op candidate.\n' +
        'Propose the harness ID, A/B versions, policy versions, README sources, selected files, and new comparison ID/name. Use the application_mode I selected in the UI as given. selected_markdown_only delivers instructions only; agent_applied means an agent performs an application procedure that changes project files. If the candidate files do not fit the selected mode (for example agent_applied without a real application procedure, or instructions only although installation, configuration or file changes are needed), do not switch modes yourself: explain why and ask me. Group missing-input and referenced-file questions and obtain explicit confirmation before registering. Source edits, candidate creation and harness application need separate approval.\n' +
        'Register only confirmed selected files and create the comparison from verified manifests. Preserve existing versions, comparisons and observation history; never overwrite them. Use format 1 for selected_markdown_only, or format 2 with application=agent_applied. Report actual IDs, paths, hashes and verification, then show the actual comparison JSON absolute path alone in a code block. Keep JSON references relative.\n' +
        'Do not invent measurement settings, dates, criteria, prices or runtime defaults. Ask for missing inputs and retain UI review/confirmation/save and source support gates. Registration and comparison creation do not launch an agent or start measurement.\n' +
        'Adoption is a separate human decision followed by real application. Never auto-adopt from the latest bundle, task success or cost. After human adoption and actual application, the next comparison uses that current applied state as A and a new candidate C in role B. Do not implement an adoption database feature.')
  );
}

export function buildMeasurementRequest(
  locale: Locale,
  project: Project | null,
  comparisonPath: string,
  comparison: InspectedComparison | null,
  identifier: string,
  policyStatus: { arm_a: string | null; arm_b: string | null }
): string | null {
  if (!project || !comparison || !comparisonPath.trim()) return null;
  const inputs = JSON.stringify(
    {
      project: { directory: project.directory, id: project.id, name: project.name },
      comparison: { path: comparisonPath.trim(), ...comparison },
      proposed_profile_id: identifier || comparison.proposed_profile_id,
      policy_status: policyStatus
    },
    null,
    2
  );
  const context = '\n\n' + '\x60\x60\x60json\n' + inputs + '\n\x60\x60\x60\n\n';
  return (
    (locale === 'ko'
      ? '이 프로젝트의 첫 측정 설정에 필요한 검토 자료를 준비해줘. 아래는 UI가 확인한 기술 참조와, 선택했다면 A/B 정책 적격성이다. 다른 측정 결정은 아직 확인되지 않았어.'
      : 'Prepare reviewed inputs for this project’s first measurement setting. The UI verified these technical references; any selected A/B eligibility is a human decision, while other measurement choices remain unconfirmed.') +
    context +
    (locale === 'ko'
      ? '현재 Harness Delta checkout의 AGENTS.md와 production 측정 schema, 요구사항 R09, 로컬 UI 안내를 읽어줘. 스킬 설치를 전제하지 말고 checkout 위치가 불명확할 때만 질문해줘. 비교 파일·등록 프로젝트·A/B manifest를 다시 확인하고, 이미 등록된 검토 자료가 있으면 재사용해줘.\n' +
        '목적(functional_pilot 또는 real_experiment), A/B 정책 적격성, 허용 작업·완료 기준, 참가자와 모집 기간·표본·추적·중단·누락 규칙, 검증된 에이전트/원본/실행 범위, 가격 근거 중 확인되지 않은 결정만 묶어서 질문해줘. 이미 답한 항목은 다시 묻지 말고 제안값은 승인받아줘. 기술 ID·버전·해시는 검증된 입력에서 가져오고 추측하지 마.\n' +
        '승인된 값으로 비공개 설정 묶음 JSON 파일 하나를 만들어줘. 형식은 {"kind":"harness-delta.measurement-setup","schema_version":1,"input":{...}}이고 input은 src/web/local-web-setup-review.ts의 SetupReviewInputSchema야. 확인한 comparison_path·project_id, private profile, 완전한 schema-2 protocol, 승인된 policy_status 또는 variants 중 하나, 필요할 때만 price_table을 넣어줘. application_mode에는 위 comparison.application_mode 값을 그대로 넣고 바꾸지 마. 기존 등록값은 재사용해줘. functional_pilot에는 효과·품질 마진·신뢰수준을 넣지 마. 가격이나 원본 지원을 추정하거나 세션 내용을 읽거나 측정을 시작하지 마.\n' +
        'freeze_at은 묶음 파일에서 허용하지 않아. 사용자가 UI에서 최종 확인하고 저장할 때 서버 시각으로 확정하며 모집 시작 전이어야 해. 과거 모집 날짜는 몰래 바꾸지 말고 필요한 수정만 질문해줘. 파일은 Harness Delta checkout의 .harness-delta/setup-drafts/ 아래 Git 제외 여부를 확인하고 보관해줘. 파일 경로와 미결정 사항을 알려줘. 나는 요청문 바로 아래에서 묶음 파일 하나를 불러와 요약을 확인하고 저장할 거야. DB 등록·동결·저장은 대신하지 마.'
      : 'Read AGENTS.md, the production measurement schemas, requirement R09, and the local UI guide in the current Harness Delta checkout. Do not require an installed skill; ask for the checkout location only if unknown. Recheck the comparison, registered project, and ordered manifests; reuse already reviewed registrations.\n' +
        'Group only unknown human choices: purpose (functional_pilot or real_experiment), A/B eligibility, eligible work and completion criteria, participants, recruitment/sample/follow-up/stopping/missingness, qualified product/source/runtime scope, and the reviewed price basis. Do not ask again for answers already supplied. Confirm proposals. Derive technical IDs, versions, and hashes only from verified inputs.\n' +
        'Create one private JSON setup bundle from approved values: {"kind":"harness-delta.measurement-setup","schema_version":1,"input":{...}}. Its input follows SetupReviewInputSchema in src/web/local-web-setup-review.ts: verified comparison_path and project_id, private profile, complete schema-2 protocol, approved policy_status OR variants, and price_table only when needed. Copy comparison.application_mode above into application_mode unchanged. Reuse existing registrations. A functional_pilot has no effect threshold, quality margin or confidence level. Do not guess rates or source support, read sessions or start measurement.\n' +
        'Bundles must not contain freeze_at. The server records the final save-confirmation time, which must precede recruitment. Ask only for necessary corrections to past recruitment dates; never change them silently. Store the file under .harness-delta/setup-drafts/ in the Harness Delta checkout after verifying Git ignores it. Report the bundle path and unresolved decisions. I will load the one file directly below this request, review the summary and confirm saving. Do not register, freeze or save to the DB yourself.')
  );
}
