# 로컬 작업 비교 워크플로

[English](task-comparison.md)

첫 번째 구현 단계에서는 합성 작업을 사용해 구성 등록, 영구 배정,
수동 적용 증거와 사람이 평가한 결과를 검증할 수 있습니다.
**V1 실제 무작위 실험 배정은 비활성화되어 있습니다.** V2는 명시적 입력과
부분 사용량의 제한된 [native workflow 프로필](workflow-quickstart.ko.md)를 지원합니다.
전체 비용·추론·실제 팀 데이터 교환은 미지원입니다. 별도
[합성 파일 교환](team-file-exchange.ko.md)은 구현되어 있습니다.
기존 로컬 측정은 별도의 [실행 가이드](local-measurement.ko.md)를 따릅니다.
[ADR 008](../decisions/008-task-comparison-workflow.md)과
[요구사항 R09/R10](../requirements.md#r09---randomized-task-comparisons)을 참고하세요.

Node 24 또는 26에서 `npm ci`로 설치한 뒤 `npm run build`를 실행하세요.
아래 명령은 `node dist/cli.js`를 사용하며, 패키지를 설치했다면 `hm`을 사용합니다.
데이터베이스와 예제 입력 파일은 `.harness-delta/comparison-demo/`처럼 Git에서
제외되는 로컬 디렉터리에 저장하세요. 입력 파일을 작성하기 전에 디렉터리를 만드세요.
합성 검증 전용 저장소를 사용하세요. 제품 실행 파일, 서버, Docker, worktree,
모델 요청, 하네스 설치 또는 설정 변경은 필요하지 않습니다.

## 구성 등록

다음 **합성** 입력으로 `variant-a.json`을 작성하세요:

```json
{
  "schema_version": 1,
  "id": "variant-a",
  "harness_version": "a-v1",
  "instruction_manifest_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "product": "synthetic",
  "product_version": "1.0.0",
  "model": "synthetic-model",
  "reasoning_setting": "none",
  "policy_version": "synthetic-policy-v1",
  "policy_status": "eligible"
}
```

`variant-b.json`은 `id: variant-b`, `harness_version: b-v1`과 서로 다른
64자리 소문자 16진수 매니페스트 해시를 사용해 작성하세요. 런타임 설정은 동일하게 유지하세요.
이 인위적인 해시는 등록 기능을 검증하기 위한 값이며 실제 A/B 매니페스트가 아닙니다.

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite project add demo --root .
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite variant register --config .harness-delta/comparison-demo/variant-a.json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite variant register --config .harness-delta/comparison-demo/variant-b.json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite variant show variant-a
```

향후 실제 사용 시 A는 검토된 기존 하네스 버전이고, B는 검토된 탐색 지침 매니페스트입니다.
여기에는 메타데이터를 등록하고, Repo Map 인덱스와 탐색 도구는 해당 소스 프로젝트에 유지하세요.
지침, 소스 식별자, 프롬프트, 응답, 평가 기준 본문 또는 경로를 이 입력에 복사하지 마세요.
버전을 등록해도 사용량 어댑터가 등록되거나 실험이 활성화되지는 않습니다.

## 프로토콜 사전 등록 및 동결

다음 합성 계약 예제로 `protocol.json`을 작성하세요.
**등록 전에 모집 시작일과 종료일을 나타내는 두 UTC 날짜를 실제 검증 예정 기간으로 바꾸세요.**
시작 시각 전에 프로토콜을 동결하고, `[recruitment_start, recruitment_end)` 동안 배정하세요.
이 구간은 시작 시각을 포함하고 종료 시각은 포함하지 않습니다.
아래 지표, 표본 수, 허용 한계 값은 합성 입력이며 실제 실험에 대한 권장값이 아닙니다.
등록된 초안을 수정하려면 새 프로토콜 ID를 사용하세요.

```json
{
  "schema_version": 1,
  "id": "demo-comparison",
  "project_id": "demo",
  "team_id": "demo-team",
  "mode": "randomized_task",
  "purpose": "synthetic_validation",
  "protocol_version": "protocol-v1",
  "eligibility_version": "eligibility-v1",
  "classification_version": "classification-v1",
  "participants": ["user-1", "user-2"],
  "environment_ids": ["environment-1", "environment-2"],
  "variant_ids": ["variant-a", "variant-b"],
  "recruitment_start": "2030-01-01T00:00:00Z",
  "recruitment_end": "2030-01-02T00:00:00Z",
  "allocation_method": "balanced_blocks",
  "allocation_version": "balanced-blocks-v1",
  "allocation_ratio": [1, 1],
  "block_size": 4,
  "strata": [{
    "id": "stratum-1",
    "assignees": ["user-1", "user-2"],
    "types": ["feature"],
    "sizes": ["small"],
    "allocator_id": "allocator-1"
  }],
  "primary_metric": "input_total",
  "quality_metric": "criterion_fulfillment",
  "quality_margin": 0.05,
  "minimum_effect": 0.1,
  "sample_plan": {"target_tasks": 8, "planning_basis_id": "synthetic-basis"},
  "followup_seconds": 3600,
  "stopping_rule": {"kind": "fixed_recruitment", "version": "stopping-v1"},
  "missingness_policy": {
    "version": "missingness-v1",
    "max_usage_missing_rate": 0.1,
    "max_outcome_missing_rate": 0.1
  },
  "deviation_policy": {"mismatch": "continue", "unknown": "continue", "version_drift": "stop"},
  "confidence_level": 0.95,
  "analysis_plan_version": "synthetic-analysis-v1",
  "sensitivity_plan_ids": ["synthetic-sensitivity"]
}
```

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison register --config .harness-delta/comparison-demo/protocol.json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison freeze demo-comparison
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison show demo-comparison
```

필수 입력이 누락되면 동결할 수 없습니다. 잘못되거나 겹치는 층, 참여할 수 없는 참여자,
적격하지 않은 구성 및 일치하지 않는 런타임 설정은 검증에 실패합니다.
`real_experiment` 초안은 검토를 위해 등록하고 동결할 수 있지만, 배정은 항상 거부됩니다.
어떤 준비 상태 플래그도 R10을 우회할 수 없습니다.
이 작업은 분석 방법을 검증하거나 수집을 시작하지 않습니다.

## 작업 사전 등록 및 영구 배정 확인

실행 전에 `task.json`을 작성하세요:

```json
{
  "schema_version": 1,
  "protocol_id": "demo-comparison",
  "project_id": "demo",
  "logical_task_id": "logical-task-1",
  "task_id": "task-1",
  "alias_ids": ["known-alias-1"],
  "metadata": {
    "type": "feature",
    "expected_size": "small",
    "assignee": "user-1",
    "product": "synthetic",
    "model": "synthetic-model",
    "criterion_ids": ["criterion-1"]
  },
  "environment_id": "environment-1",
  "code_base_commit": "cccccccccccccccccccccccccccccccccccccccc",
  "allocator_id": "allocator-1"
}
```

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison assign --config .harness-delta/comparison-demo/task.json
```

예제의 코드 커밋 값은 합성 데이터입니다. 실제 등록에서는 하네스 매니페스트와 별개로
실제 코드 기준 커밋을 사용합니다. 배정은 작업 등록을 원자적으로 수행하거나,
이미 등록되었지만 시작하지 않은 동일한 작업에 연결할 수 있습니다.
배정 결과는 커밋 이후 출력되며, 배정된 구성 하나, 배정 ID와 고정된 마감 시각을 포함합니다.
같은 명령을 다시 실행하면 `reused: true`와 함께 기존 배정 결과를 반환합니다.

재시도와 재작업에는 이미 선언한 식별자를 재사용하세요.
알려진 별칭은 배정 전에 선언하세요. 별칭 등록은 대표 작업을 반환합니다.
새 요구사항에는 새 작업, 평가 기준 및 식별자가 필요합니다.
도구는 선언되지 않은 의미상 중복 작업을 감지할 수 없습니다.
각각 배정된 이후 충돌이 발견되면 관련 프로토콜의 배정이 차단됩니다.
SQLite 파일을 복사해 배정 권한을 가진 별도의 쓰기 주체를 만들지 마세요.

## 적용 확인 및 사람이 평가한 결과 기록

배정된 구성을 읽고 검토된 지침을 수동으로 적용한 뒤 새 작업 세션을 시작하세요.
이 합성 예제는 제품 세션 없이 선언을 검증합니다.
`confirmation.json`에는 **배정 결과에 표시된 구성**을 입력하세요.
발생 시각을 선택적으로 지정할 수 있으며, 배정 시각 이후 또는 같은 시각이어야 하고
현재 시각보다 늦어서는 안 됩니다. `occurred_at`을 생략하면 명령 호출 시각을 기록합니다:

```json
{
  "schema_version": 1,
  "id": "confirmation-1",
  "task_id": "task-1",
  "occurred_at": "2030-01-01T00:00:00Z",
  "evidence_method": "self_attested",
  "actual_variant_id": "variant-a",
  "product": "synthetic",
  "product_version": "1.0.0",
  "model": "synthetic-model",
  "reasoning_setting": "none",
  "environment_id": "environment-1"
}
```

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task confirm-config --config .harness-delta/comparison-demo/confirmation.json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task config-history task-1
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task start task-1
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task first-complete task-1
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task assess-first task-1 --result success
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task finalize task-1 --outcome success --met criterion-1
```

실제 구성을 알 수 없다는 사실을 명시하려면 null을 허용하는 실제 구성 필드에 null을 사용하세요.
새 확인 기록에는 새 ID를 사용하며, 이전 증거는 변경할 수 없습니다.
선언이 일치하면 `self_attested` 증거에 따른 `confirmed` 상태로 기록되지만,
기계적으로 검증된 것은 아닙니다. 다른 구성으로 전환해도 원래 배정은 유지됩니다.
동결된 불일치 및 미확인 정책에 따라 작업이 중단될 수 있습니다.
런타임 구성(제품, 제품 버전, 모델 또는 추론 설정)의 변경은 측정을 일시 중지하며
기존 작업을 자동으로 재배정할 수 없습니다.
`aborted`로 종료하면 배정을 유지한 채 취소에 따른 계획 이탈을 기록합니다.
완료 여부는 사람이 평가하며, CI만으로 작업을 최종 완료 처리할 수 없습니다.
필요에 따라 기존 `pause`, `resume`, `rework` 명령을 사용하세요.

선택한 파일을 해시로 검증하려면 `evidence_method: selected_artifact_hash`와
`--artifact instructions=path/to/instructions.md`를 사용하세요.
명시적으로 제공한 지침 파일만 읽습니다. 고유한 파일 ID는 1–256개이며,
각 파일 크기는 최대 1 MiB입니다. 경로와 내용은 저장하지 않습니다.
매니페스트는 `[{"artifact_id":"instructions","sha256":"<file-sha256>"}]` 형식의 배열을
파일 ID의 코드 포인트 순서로 정렬한 뒤, 공백 없는 JSON을 UTF-8로 인코딩하고
SHA-256을 적용한 값입니다. 소문자 16진수 해시를 사용하세요.
이 검사는 현재 파일에 대한 것이므로 `occurred_at`을 생략해 호출 시각을 검사 시각으로 기록하세요.
API로 시각을 제공한다면 `confirmConfiguration`의 타임스탬프와 같아야 합니다.
이전 발생 시각은 자기 확인 방식에서만 유효합니다.
제품, 모델 및 전역 설정은 여전히 선언에 의존합니다.

합성 CLI는 이 검증 저장소에서 합성 제품을 `session link`로 연결하거나 실제 세션을
읽을 수 없도록 되어 있습니다. 테스트 픽스처는 테스트에서만 합성 사용량을 주입합니다.
일반 Codex/Claude 수집은 별도로 유지됩니다. V2 native 경로는 `workflow codex` 또는
`workflow claude launch`를 사용하며, 각각의
[admission과 조건부 버전 경계](task-native-workflow.md)를 따릅니다.
일반 파일 경로는 정확한 프로필 또는 허용된 조건부 파서 재사용을 허용합니다.
조건부 추정치는 `compatibility_unverified`로 유지합니다. 명시적인 작업·세션·소스
매핑, 실행 중인 수집기와 확인 기록 연결(`session link --confirmation`)이 필요합니다.
배정이나 적용 확인은 세션 내용을 읽거나 이전 사용량을 소급 수집하지 않습니다.

## 합성 배정 보고서 생성

위의 합성 등록·배정 단계를 수행한 뒤 현재 시각보다 늦지 않은 cutoff를 선택하세요.
아래 날짜는 가상의 2030년 예제에 맞춘 값입니다. 조정한 검증 날짜에 맞춰 cutoff를
바꾸고 그 시각 이후에 실행하세요. 스냅샷 생성은 저장된 허용 목록의 메타데이터만
읽습니다. 사용량을 주입하지 않은 작업은 0이 아니라 누락입니다. CLI에는 합성
소스 읽기나 테스트 픽스처 주입 명령이 없습니다.

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison snapshot create demo-comparison --id demo-report-1 --cutoff 2030-01-02T02:00:00Z --reason initial
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison report demo-report-1 --format json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison report demo-report-1 --format markdown
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison report demo-report-1 --format markdown-readable
```

`json`이 기본값입니다. 기존 `json`·`markdown` 출력과 저장된 스냅샷 바이트는
바뀌지 않습니다. V1에서 `markdown-readable`을 선택하면 같은 고정 보고서의 원래
배정 그룹, 성분별 관측 작업 수와 분포, 추적 기간, 사람의 품질 평가, 재작업,
구성, 선언된 설정과 이탈을 표로 표시합니다. 관측 상태 표는 작업 수가 아니라
이벤트 수입니다. 프로젝트 등록 활동은 적격성 분모를 증명하지 않습니다.

부분 사용량이 있는 작업 수와 합산 토큰 값이 있는 작업 수는 다를 수 있으며,
입력·출력의 관측 작업 집합도 다를 수 있습니다. `unavailable`은 null을 유지하고
관측된 0은 0으로 표시합니다. 이 집합으로 전체 작업의 절감이나 실질적 동등성을
판단할 수 없습니다. 무효화 보고서는 제거된 합계를 재구성하지 않고 사유와
사용 불가한 원래 그룹을 표시합니다. 렌더링은 새 수집·추론·실제 실험을 허용하지 않습니다.

다음 절의 예제에서 **작업을 삭제하기 전에** 보고서를 생성하세요. 이미 삭제했다면
프로토콜이 무효화되어 스냅샷 생성이 거부됩니다. 같은 보고서 ID와 동일한 옵션으로
재시도하면 고정된 결과를 반환합니다. 같은 ID의 옵션을 바꾸면 충돌합니다.
이후 증거에는 새로운 ID를 사용하세요:

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison snapshot create demo-comparison --id demo-report-2 --cutoff 2030-01-02T02:00:00Z --supersedes demo-report-1 --reason evidence_updated
```

같은 cutoff에서 새로 수신된 관측에는 `late_arrival`, 그 밖의 새 증거에는
`evidence_updated`를 사용하세요. `cutoff_advanced`는 엄격히 더 늦은 cutoff를
요구합니다. 초기 버전 외에는 같은 프로토콜의 유효한 부모 보고서가 필요하며,
`initial`에는 부모를 지정할 수 없습니다. 평가 시각은 CLI가 기록합니다. 과거에
무엇을 알고 있었는지 나타내는 시각을 사용자가 지정할 수 없습니다. 이전 DB의
사용량 수신 시각은 마이그레이션에서 만들어 넣지 않고 미확인으로 유지합니다.

`total`, 원래 배정 기준 `arms`, `deadline_counts`, 작업 구성, 미완성 `blocks`와
보조 `actual_configuration_summary`를 확인하세요. 마감 내 성공률의 분모는
시작하지 않은 작업과 결과가 누락된 작업을 포함한 모든 배정 작업입니다.
하나라도 추적 기간이 남으면 성공률은 null입니다. 작업이 일찍 종료되어도 모집이나
추적 기간이 열려 있으면 잠정 보고서입니다. cutoff 또는 마감과 정확히 같은 시각의
이벤트·평가는 반개구간의 결과 지표에서 제외됩니다. 일시정지·재개·재작업은 마감을
바꾸지 않습니다. 원래 배정은 항상 유지되며 실제 A/B/다른 구성/혼합/미확인 기록은
보조 선언입니다. 런타임 불확실성·변경도 따로 표시합니다. 프로젝트 등록 건수는
맥락 정보이며, 적격성이나 무작위 실험 표본 수로 간주하지 않습니다.

부분 관측 분포는 관측된 작업의 분모를 명시합니다. 완전한 총량, 비용, 절감률,
신뢰구간, p-value와 도입 판단은 제공하지 않습니다. 합성 보고서 검사를 통과해도
`real_experiment` 배정이나 R10 분석 방법 검증을 충족하지 않습니다. 배정·확인·보고는
세션 읽기를 승인하지 않습니다. 일반 측정에는 정확한 소스 프로필 또는 허용된
조건부 파서 재사용, 등록된 프로젝트, 활성 작업, 명시적인 세션·소스 연결과 실행 중인
수집기가 계속 필요합니다. 조건부 추정치는 검증된 사용량과 분리합니다.

기여한 작업의 삭제, 설정된 보존 기간 정리, 프로젝트 삭제 또는 식별자 충돌은
관련 관리 스냅샷과 해시·의존성을 모두 제거합니다. 이전 ID는 무효화 응답을
반환하며 원래 그룹별 건수를 보존하거나 복원하지 않습니다. 미배정 등록 작업의
삭제도 보고서를 무효화할 수 있습니다. CLI는 제거 전에 관련 보고서 ID를 알리며
불투명한 삭제 표식만 남깁니다. 저장한 출력·백업은 이 삭제 범위 밖에 있습니다.
보고서 ID는 재사용할 수 없습니다. 스냅샷 가져오기나 합성 팀 교환으로 삭제된 범위를
복원할 수 없으며 삭제 표식이 재전송을 거부합니다. 배정 권한 우회는 제공하지 않습니다.
시간·버전·삭제 계약의 전체 내용은 ADR 008을 참고하세요.

## 조회 및 삭제

기존 작업 보고서는 계속 누락되거나 부분적으로 관측된 사용량을 표시하며,
완전한 무작위 비교 결과 지표나 도입 판단 결과를 제공하지 않습니다.
관측값을 주입하지 않은 합성 작업의 사용량은 0이 아니라 누락 상태입니다.
위 절의 합성 배정 보고서와 별도 합성 팀 교환은 지원됩니다. 실제 데이터 공유·
네트워크 전송·검증된 추론·V1 실제 배정은 제공하지 않습니다.

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite delete task task-1
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison show demo-comparison
```

삭제하면 실험이 무효화되고 새 배정이 중단되며, 관련 증거와 비공개 재생 큐가 제거됩니다.
알려진 식별자와 별칭의 삭제 표식은 재사용을 거부합니다.
남아 있는 작업은 일반적인 수명주기에 따라 완료할 수 있습니다.
프로젝트 삭제는 해당 비교 데이터를 제거합니다.
명시적으로 설정한 보존 기간 정책도 동일한 삭제 경로를 사용합니다.
삭제로 이미 내보낸 사본까지 지울 수는 없습니다. 별도 합성 교환 경로의 삭제 알림은
V1 예제에 실제 데이터 공유를 추가하지 않습니다.

자유 모델/effort의 V2 설정은 [flexible comparison](flexible-comparison.md),
정확한 admission과 조건부 버전은 [native workflow](task-native-workflow.md)를
참고하세요. 전체 비용과 추론은 미지원입니다.
