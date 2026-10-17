import type { Locale, SupportDetails } from './types';

export function SupportGuidance({ support, locale, compact = false }: { support: SupportDetails; locale: Locale; compact?: boolean }) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  if (compact && support.context === 'synthetic_validation_only') return <section data-support-context={support.context} className="space-y-3 border-t pt-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">{t('Measurement support', '측정 지원 상태')}</h4>
      <span className="text-muted-foreground">{support.product === 'claude_code' ? 'Claude Code' : `${support.product} ${support.product_version} · ${t('Configured version', '설정 버전')}`}</span>
    </div>
    <p className="font-medium">{t('Synthetic validation only · no real measurement', '합성 검증 전용 · 실측 불가')}</p>
    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
      <li>{t('Do not launch or connect a native agent.', '네이티브 에이전트를 실행하거나 연결하지 마세요.')}</li>
      <li>{t('Unobserved usage and cost are unknown, not zero.', '미관측 사용량·비용은 0이 아닌 미확인입니다.')}</li>
    </ul>
    <details>
      <summary className="cursor-pointer text-muted-foreground">{t('Support conditions and technical details', '지원 조건·기술 상세')}</summary>
      <div className="mt-3"><SupportGuidance support={support} locale={locale} /></div>
    </details>
  </section>;
  if (support.context === 'synthetic_validation_only') return <div data-support-context={support.context} className="space-y-2 text-sm">
    <p>{t('Synthetic validation only. Prepare and inspect this fixture; do not launch or connect a native agent for it.', '합성 검증 전용입니다. 이 fixture의 준비 상태를 확인하세요. 네이티브 에이전트를 실행하거나 연결하지 마세요.')}</p>
    <p>{t('No native collection is qualified by this task. Unobserved usage and cost remain unavailable, not zero. Use a separately reviewed real protocol and route for actual work.', '이 작업은 네이티브 수집 지원을 검증하지 않습니다. 미관측 사용량과 비용은 0이 아닌 미확인으로 유지합니다. 실제 작업에는 별도로 검토된 실측 protocol과 경로를 사용하세요.')}</p>
  </div>;
  const trust = (state: string) => ({
    verified: t('Verified exact source boundary', '정확한 버전의 원본 경계 검증됨'),
    compatibility_unverified: t('Compatibility-unverified reference only', '호환 미검증 기준 추정 전용'),
    invalidated: t('Invalidated; observation blocked', '무효화됨 · 관측 차단'),
    unsupported: t('Unsupported for these settings', '이 설정에서는 미지원'),
  })[state] ?? t('Unverified', '미검증');
  if (compact) return <section data-support-context={support.context} className="space-y-3 border-t pt-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">{t('Measurement support', '측정 지원 상태')}</h4>
      <span className="text-muted-foreground">{support.product === 'claude_code' ? 'Claude Code' : `${support.product} ${support.product_version} · ${t('Configured version', '설정 버전')}`}</span>
    </div>
    <dl className="grid gap-3 sm:grid-cols-2">
      <div data-support-route="family">
        <dt className="text-muted-foreground">{t('Session connection', '세션 연결')}</dt>
        <dd className="mt-1 font-medium">{support.family === 'candidate_root_pilot'
          ? t('Pilot · one root only', '실험용 · root 1개만')
          : support.family === 'verified_bounded_family' ? t('Verified · one root and two direct children', '검증됨 · root 1개와 직접 자식 2개')
          : support.family === 'candidate_pilot' ? t('Pilot · approval required', '실험용 · 별도 승인 필요')
          : t('Source verification required', '원본 지원 검증 필요')}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t('Cost coverage', '비용 범위')}</dt>
        <dd className="mt-1 font-medium">{t('Partial estimate · not a bill', '부분 추정 · 청구액 아님')}</dd>
      </div>
      <div data-support-route="launch">
        <dt className="text-muted-foreground">{t('Launch workflow', '실행 workflow')}</dt>
        <dd className="mt-1">{support.launch.map(source => <p key={source.profile_id}>{trust(source.state)}</p>)}</dd>
      </div>
      <div data-support-route="ticket">
        <dt className="text-muted-foreground">{t('Ticket connection', 'ticket 연결')}</dt>
        <dd className="mt-1">{support.ticket === 'exact_version_only'
          ? t('Codex 0.160.0 · fresh CLI root only', 'Codex 0.160.0 · 새 CLI root 전용')
          : t('Unsupported', '미지원')}</dd>
      </div>
    </dl>
    {support.family === 'candidate_root_pilot' && <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
      <li>{t('Child sessions are unsupported.', '자식 세션은 측정 미지원입니다.')}</li>
      <li>{t('Approve instrumentation and source scope before connecting.', '연결 전 계측·원본 범위 승인이 필요합니다.')}</li>
      <li>{t('Use separate application and working sessions.', '하네스 적용과 작업 세션을 분리하세요.')}</li>
    </ul>}
    {support.family_parser_compatibility && <p className="text-muted-foreground">{t('Usage parser', '사용량 파서')}: {trust(support.family_parser_compatibility.state)}</p>}
    <details>
      <summary className="cursor-pointer text-muted-foreground">{t('Support conditions and technical details', '지원 조건·기술 상세')}</summary>
      <div className="mt-3"><SupportGuidance support={support} locale={locale} /></div>
    </details>
  </section>;
  if (support.family === 'verified_bounded_family') return <div data-support-context={support.context} className="space-y-3 text-sm">
    <p>{t(`Codex ${support.product_version} ordinary family: one fresh root and up to two fresh direct children. All GPT-family models are allowed; model and effort are recorded as observed.`, `Codex ${support.product_version} 일반 가족: 새 root 1개와 새 직접 자식 최대 2개입니다. 모든 GPT 계열 모델을 허용하며 모델과 effort는 관측값 그대로 기록합니다.`)}</p>
    <p>{t('Usage parser', '사용량 파서')}: {trust(support.family_parser_compatibility?.state ?? 'unsupported')}</p>
    <p>{t('Reviewed hooks, explicit project/task/source scope and a fresh working session are required. Unadmitted versions, nested children and non-GPT models are unsupported.', '검토된 hook, 명시적 프로젝트·작업·원본 범위와 새 작업 세션이 필요합니다. 미승인 버전·중첩 자식·GPT 계열이 아닌 모델은 미지원입니다.')}</p>
    <p className="text-muted-foreground">{t('Cost remains partial, not complete task cost or an actual bill. Paused and setup intervals are not backfilled.', '비용은 부분 관측이며 전체 작업 비용이나 실제 청구액이 아닙니다. 중단·준비 구간은 소급 수집하지 않습니다.')}</p>
  </div>;
  return <div data-support-context={support.context} className="space-y-3 text-sm">
    <p>{support.product === 'claude_code' ? 'Claude Code' : <>{t('Configured product/version (not installed-version detection): ', '설정된 제품·버전(설치 버전 탐지가 아님): ')}{support.product} {support.product_version}</>}</p>
    <dl className="space-y-2">
      <div data-support-route="launch"><dt className="font-medium">{t('Native launch workflow', '네이티브 launch workflow')}</dt><dd>{support.launch.map(source => <p key={source.profile_id}>{source.profile_id}: {trust(source.state)}</p>)}{t('Use workflow status with reviewed inputs. File/parser compatibility does not authorize other routes.', '검토된 입력으로 workflow status를 확인하세요. 파일·parser 호환성은 다른 경로를 허용하지 않습니다.')}</dd></div>
      <div data-support-route="ticket"><dt className="font-medium">{t('Exact external ticket connection', '정확한 외부 ticket 연결')}</dt><dd>{support.ticket === 'exact_version_only' ? t('Codex 0.160.0 fresh CLI root only; reviewed canonical binary/hash and current one-use ticket required. Claude and IDE ticket connections are unsupported.', 'Codex 0.160.0의 새 CLI root 전용입니다. 검토된 정규 바이너리·해시와 현재 일회용 ticket이 필요합니다. Claude·IDE ticket 연결은 미지원입니다.') : t('Unsupported for this configured product/version.', '이 설정의 제품·버전에서는 미지원입니다.')}</dd></div>
      <div data-support-route="family"><dt className="font-medium">{t('Ordinary-session family', '일반 세션 가족')}</dt><dd>{support.family === 'candidate_root_pilot' ? t('Codex 0.162.0 local candidate pilot: one fresh root only; child sessions are unsupported. Reviewed instrumentation and explicit task/source authorization are required. Application and working sessions must be separate.', 'Codex 0.162.0 로컬 후보 pilot: 새 root 1개 전용이며 자식 세션은 미지원입니다. 검토된 계측과 명시적 작업·원본 권한이 필요합니다. 적용 세션과 작업 세션을 분리하세요.') : support.family === 'candidate_pilot' ? t('Candidate pilot only, not production admission. Separate reviewed instrumentation and exact local pilot/source authorization are required before harness-connect.', '후보 pilot 전용이며 제품 지원 판정이 아닙니다. harness-connect 전에 별도 검토된 계측과 정확한 로컬 pilot·원본 권한이 필요합니다.') : t('Native source qualification is required; a launch or ticket admission does not qualify families.', '네이티브 원본 지원 검증이 필요합니다. launch·ticket 지원이 가족 지원을 검증하지는 않습니다.')}{support.family_parser_compatibility && <p>{support.family_parser_compatibility.parser_revision} ({support.family_parser_compatibility.parser_version}): {trust(support.family_parser_compatibility.state)}</p>}</dd></div>
    </dl>
    <p className="text-muted-foreground">{t('All shown costs are partial. Complete task cost, actual billing and inferential adoption conclusions are unavailable. Preparation and native input evidence do not prove actual tool use.', '표시 비용은 모두 부분 추정입니다. 전체 작업 비용·청구액·통계적 도입 판정은 제공하지 않습니다. 준비와 네이티브 입력 근거는 도구 실제 사용을 증명하지 않습니다.')}</p>
  </div>;
}
