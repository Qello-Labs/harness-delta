# 도구 업데이트 파이프라인: 탐색과 정적 평가

[English](tool-update-pipeline.md)

이 문서는 유지보수자용 도구 업데이트 파이프라인의 첫 번째 단계를 다룹니다. 공식 메타데이터에서
Codex CLI 또는 Claude Code의 현재 안정 릴리스를 찾고, 그 후보를 이 저장소가 선언한 경로와
비교합니다. 하는 일은 여기까지입니다. 후보는 지원이 아니고, 평가는 허용(admission)이 아니며,
어떤 레코드도 기본값을 바꾸지 않습니다.

## 이 단계가 하는 일

- `discover`는 한 제품의 공식 GitHub 릴리스와 npm 패키지 메타데이터를 읽습니다.
  변경 불가능한 관측(observation) 레코드를 쓰고, 성공하면 변경 불가능한 후보(candidate)
  레코드도 씁니다.
- `assess`는 후보, 그 후보를 만든 관측, 선택적 검토 기준선, 선택적 계약 검토 레코드를 몇 개든
  읽습니다. 현재 저장소 소스를 투영해 변경 불가능한 평가(assessment) 레코드를 씁니다.
- `record-review`는 사람이 작성한 계약 검토 레코드를 검증하고 게시합니다. 판단을 직접 만들어
  내지는 않습니다.

아무것도 설치하지 않고 벤더 바이너리도 실행하지 않습니다. 세션, 사용자 데이터베이스, 도구
설정을 읽지 않으며 허용, 기본값, CI, 추적 파일도 바꾸지 않습니다. 네트워크 요청은 `discover`만
보냅니다. 공식 GitHub와 npm 엔드포인트에 고정된 읽기 요청만 보내고, 비밀값이나 호출자가 지정한
URL 매개변수는 쓰지 않습니다.

도구는 계약 검토를 직접 수행하지 않습니다. 유지보수자가 수동으로 내린 판단을 기록하고 읽을 뿐입니다.
적합성, 회귀, 허용, 기본값 승격은 별도 단계이며 이번 단계에 포함되지 않습니다.
저장소 소유 [admitted Claude runner](tool-update-conformance.ko.md)는 합성 테스트 범위가
있지만 실제 바이너리 합격 검증과 실행 승인은 별개입니다.

## 사전 준비

- Node 24 또는 26을 쓰는 체크아웃. 명령이 Node를 설치하지는 않습니다.
- [CONTRIBUTING](../../CONTRIBUTING.md#development-environment)에 따라 `npm ci`로 의존성을 설치합니다.
- Git이 추적하지 않고 심볼릭 링크가 아닌 개인 로컬 출력 디렉터리. 레코드는 공유 산출물 밖인
  이곳에 둡니다.

상위 디렉터리의 심볼릭 링크도 거부합니다. macOS에서는 `/var` 또는 `/tmp` 아래 임시 경로를
전달하기 전에 실제 물리 경로로 정규화하세요.

`assess`는 기존 lockfile 의존성으로 현재 TypeScript 소스를 개인 임시 디렉터리에 컴파일합니다.
오래된 `dist` 빌드는 쓰지 않습니다.
명령형 코드에 있는 작업·토폴로지 규칙은 검토된 소스 다이제스트와 대조합니다. 해당 소스가
바뀌면 `source_scope_changed`로 멈추며, 유지보수자가 규칙을 다시 검토하기 전까지 과거 범위를
조용히 재사용하지 않습니다.

소스 다이제스트에는 `src/nested-candidate.ts`와 `src/codex-candidate-rollout.ts`도
해시 전용 입력으로 포함됩니다. 평가는 이 두 파일을 트랜스파일하거나 로드·실행하지 않고,
import도 따라가지 않습니다. 이 파일의 변경은 `source_scope_changed`가 아니라
`baseline_source_changed` 또는 `review_source_changed`로 나타납니다.
두 파일이 추가되면서 기존의 모든 기준선 행과 검토 레코드의 다이제스트가 오래된 값이 됩니다.
기존 레코드는 계속 읽을 수 있으며 다시 쓰지 않습니다. 과거 다이제스트로는 현재 계약 검토
게이트를 닫을 수 없습니다.

현재 중복 제거된 static-assessment-v3 정적 closure는 정확히 52개 경로이며 여유 항목은 없습니다. Codex window의
해시 전용 입력에는 `src/connect/codex-connect-installation.ts`,
`skills/harness-connect-window-codex/SKILL.md`,
`skills/harness-connect-window-codex/scripts/connect.mjs`가 포함됩니다. 범용 raw window
hook은 이미 입력이었습니다. 고정된 v2 집합에는 `src/claude-process-binary.ts`가 이미
포함되어 있습니다. v3는 독립적인 Claude 패키지의 해시 전용 입력 네 개만 추가합니다.
`src/connect/claude-connect-installation.ts`,
`skills/harness-connect-window-claude/SKILL.md`,
`skills/harness-connect-window-claude/scripts/connect.mjs`,
`skills/harness-connect-window-claude/scripts/claude-session-hook.mjs`를 추가합니다.
평가는 이 파일을 로드하거나 import를 따라가지 않고 해시만
계산하며, 설정·transport wrapper는 이 유한 투영에서 소비하지 않습니다. execution pin은
별도로 전체 source와 build 트리를 고정합니다. static-assessment-v2의 allowlist와 상한은
48개 경로로 고정되어 있습니다. schema 1-4 reader의 기존 32개 경로 상한과
256 KiB 레코드 제한은 그대로입니다. 입력 추가는 전역 source digest를 바꾸며 정확 지원이나
활성화를 바꾸지 않습니다. 과거 기준선·검토는 불변이며 오래된 digest로 새 gate를 닫을 수 없습니다.

## 후보 탐색

```sh
out="$HOME/tool-update-records/codex"
node scripts/tool-update.mjs discover --product codex --out "$out"
```

Claude Code는 `--product claude_code`를 씁니다. 검토 범위를 붙이려면
`--baseline "$baseline_file"`을 추가합니다([검토 기준선](#검토-기준선) 참고).

명령은 JSON 한 줄을 출력합니다.

```json
{"status":"metadata_reconciled","candidate_id":"<64 hex>","observation_id":"<64 hex>","heads":{"github":"<version>","npm_latest":"<version>","npm_stable":"<version>"}}
```

공식 저장소 이름과 숫자 ID를 먼저 확인한 뒤 GitHub가 지정한 `/releases/latest`를 npm의
`latest` 태그 및 가장 높은 안정 버전과 대조합니다. GitHub의 latest를 과거 전체 릴리스의
최대 semantic version이라고 간주하지 않습니다. 기준선이 없으면 이 대상만 고정합니다.
기준선이 있으면 가장 이른 명시적 기준선부터 대상까지 양 끝을 포함한 npm 안정 버전들이 검토
범위입니다. 선택한 각 버전은 GitHub의 공개된 안정 릴리스 및 정확한 태그 커밋과 일치해야 합니다.
태그 조회는 현재 GitHub latest 태그와 같은 접두사 표기를 사용합니다.
다른 태그 표기는 조회하거나 충돌 여부를 검사하지 않습니다.
GitHub에만 존재하는 중간 릴리스나 GitHub 전체 이력은 검증하지 않습니다. 과거 릴리스 목록의
페이지를 요청하거나 따라가지 않습니다. 끝내기 전에 조회한 모든 리소스를 ETag나 반복
다이제스트로 다시 검증합니다. 변경이 감지되거나 예산이
바닥나면 성공이 아니라 `discovery_incomplete`입니다. 이 검사가 주는 것은 제한된 조회 일관성입니다.
GitHub와 npm에 걸친 원자적 스냅샷이 아니므로 그렇게 설명하지 마세요.

탐색이 실패해도 저장소를 쓸 수 있으면 정리된 관측 레코드를 씁니다. 이때 `candidate_id`는
`null`이고 종료 코드는 2입니다. 예전에 성공한 관측이 실패한 관측을 대신하는 일은 없습니다.

이번 단계는 인증 없는 공개 요청을 사용합니다. GitHub의 기본 한도는
[출발 IP별 시간당 60회](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)이며,
재검증과 태그 해석도 요청을 소비합니다. 로컬의 512개 응답 상한이 업스트림 할당량을 늘리지는
않습니다. `rate_limited`이면 탐색은 불완전하게 남으며 자동 재시도나 토큰 로딩은 하지 않습니다.
검토 버전 하나마다 재검증을 포함해 여러 GitHub 요청이 필요합니다. 오래된 기준선은 로컬 상한에
훨씬 못 미쳐도 업스트림 할당량을 소진할 수 있습니다. 기준선은 제한을 우회하기 위해서가 아니라
실제 계약 검토를 마친 뒤에만 앞으로 옮기세요.

압축 해제 후 응답 상한은 릴리스 객체 64MiB, npm 32MiB, 나머지 GitHub 응답 4MiB입니다.
최초 조회와 재검증은 총 512MiB 예산을 공유하며, 120초 기한은 유지합니다. 큰 릴리스 첨부파일
메타데이터는 필요한 필드만 투영한 뒤 버리고 레코드에 저장하지 않습니다.
2026-10-29 과거 전체 이력 방식은 Codex의 처음 1000개를 넘자 HTTP 422에 걸렸습니다.
새 방식은 전체 목록 조회를 피하며, 처음 1000개를 완전한 이력으로 재해석하지 않습니다.

새 관측은 `schema_version: 2`와 `inventory_scope: "latest_and_npm_review_range"`를 씁니다.
검토 레코드가 없는 평가는 schema 5로 관측의 범위를 전달하며, schema-1 입력에는 `legacy_full_inventory`를
표시합니다. 기존 schema-1 관측과 평가는 다시 쓰지 않고 계속 읽을 수 있습니다. legacy 범위 표시는
과거 레코드 형식을 나타낼 뿐 검증 범위에 대한 인증된 증거는 아닙니다. 후보의
schema와 식별자는 바뀌지 않습니다. `metadata_reconciled`는 표시된 범위만 증명하며 전체
과거 이력이나 실제 실행 호환성을 증명하지 않습니다.

## 후보 평가

```sh
candidate_id="<id from discover>"
observation_id="<id from discover>"
node scripts/tool-update.mjs assess \
  --manifest "$out/candidates/$candidate_id.json" \
  --observation "$out/observations/$observation_id.json" \
  --out "$out"
```

계약 검토 레코드마다 `--review "$review_file"`을 하나씩 추가할 수 있습니다([계약 검토 레코드](#계약-검토-레코드)
참고).

따옴표 안의 자리표시자는 `discover`가 출력한 ID로 바꿉니다. `--out`을 빼면 평가는 manifest
파일에서 두 단계 위인 레코드 루트에 저장됩니다. 탐색에 기준선을 썼다면 같은
`--baseline "$baseline_file"`을 넘깁니다. 성공하면
`{"status":"assessment_created","assessment_id":"..."}`를 출력하고 0으로 종료합니다.

## 레코드와 식별자

| 디렉터리 | 레코드 | 식별자 |
| --- | --- | --- |
| `observations/` | 한 번의 조회: UTC 확인 시각, 출처 ID, 응답 다이제스트와 검증자, 완전성, 고정 결과 코드 | 시각을 포함하므로 실제 재조회마다 새 ID |
| `candidates/` | 제품, 정확한 안정 버전, 태그와 커밋, npm 버전과 무결성 | 정규 릴리스 필드만 쓰므로 같은 릴리스는 같은 ID |
| `reviews/` | 한 레인과 한 릴리스 간선에 대한 수동 계약 검토 하나: 고정 코드와 다이제스트만 포함 | 정규 레코드 필드만 쓰므로 같은 검토는 같은 ID |
| `assessments/` | 후보 ID, 관측 ID, 기준선 다이제스트 또는 누락 상태, 소스 다이제스트, 규칙 개정판, 레인 결과, (schema 3과 4) 제공된 검토 ID와 미사용 검토 ID | 이 입력 중 하나라도 바뀌면 달라짐 |

각 파일 이름은 정규 JSON에 대한 `<sha256>.json`입니다. 레코드는 한 번만 씁니다. 같은 바이트를
다시 쓰면 성공하고, 기존 ID에 다른 바이트를 쓰면 `record_conflict`로 실패합니다. 바뀌는 `latest`
별칭이나 `candidate.json`은 없습니다. 실행에서 출력된 ID로 레코드를 고르세요. 더 새 릴리스는
새 후보가 되며 예전 후보를 다른 대상으로 바꾸지 않습니다.

응답 검사마다 최초 `queried_at`과 마지막 성공 확인 `checked_at`을 따로 유지합니다.
실패 관측에는 일부만 재검증된 검사 기록이 들어갈 수 있습니다.

## 평가 읽기

결과는 코드가 소유한 모든 프로필에 대해 제품, 경로, 프로필, 작업, 토폴로지를 명시한 키로
나뉩니다. 정확 버전 전용 프로필과 미지원 프로필도 그대로 표시됩니다.

모든 레인은 정적입니다.

- 실제 실행 차원(invalidation, binary, permissions, config, authentication)은
  `not_assessed`입니다.
- 소비 계약 체크리스트는 모든 계약이 `unknown`인 상태로 시작합니다. 일치하는 검토 레코드만
  이를 바꿉니다.
- `contracts_reviewed`는 검토 레코드로 확정되지 않으면 `unknown`입니다(아래 참고). 적합성, 회귀,
  구현 검토, 허용, 기본값 승격은 항상 `not_assessed`입니다.

레인에 기준선 행이 있으면 범위는 `review_required`, 없으면 `baseline_missing`입니다. 어느 값도
릴리스가 동작한다는 뜻은 아닙니다.
`review_sources`는 허용 목록의 업스트림 소스·스키마 또는 changelog 경로를 각 릴리스 커밋에
연결합니다. availability는 `not_assessed`이며, 파일을 가져왔거나 계약을 검증했다는 주장이
아니라 검토할 항목입니다.
이 소스 경로는 검토 시작점이며 업스트림에서 이동할 수 있습니다. 검토 증거로 사용하기 전에
고정된 커밋에서 각 경로의 존재를 확인하세요.

### 선택 정책

검토 레코드가 있으면 schema 6은 모든 레인에 엄격한 `selection_policy` 객체를 포함합니다.

```json
{
  "parser_base_transition": "none | minor | major | null",
  "baseline_transition": "none | minor | major | null",
  "next_step": "<code>"
}
```

`parser_base_transition`은 파서 기준 버전과 대상을 비교하고, `baseline_transition`은 기준선 행의
`last_reviewed_version`과 대상을 비교합니다. 주 버전 번호가 다르면 `major`, 부 버전 번호가
다르면 `minor`, 패치 변경을 포함한 나머지는 `none`입니다. 파서 기준 버전이나 기준선 행이 없으면
문자열 `"null"`이 아닌 JSON `null`을 씁니다. 두 비교를 분리해서 보여 주며 기존의 통합 전이 사유는
그대로 유지합니다.

`next_step`은 기존 선택 경로를 설명합니다. 처음 일치하는 행을 적용합니다.

| 코드 | 조건 |
| --- | --- |
| `operation_unsupported` | 작업이 허용되지 않음 |
| `retired` | `retired` 사유가 있음 |
| `selected_exact` | 호환성이 결정되었고 파서 버전이 대상과 같음 |
| `selected_window` | 창(window)을 통해 호환성이 결정됨 |
| `exact_admission_required` | 아무것도 선택되지 않았고 `exact_only` 사유가 있음 |
| `older_version_unsupported` | 아무것도 선택되지 않았고 대상이 기존 창의 기준 버전 이하임 |
| `window_extension_required` | 창이 있고 대상이 상한 이상임 |
| `window_rule_required` | 창이 없고 정확 버전 전용 레인이 아님 |

어떤 `next_step` 값도 지원, 검증, 허용을 뜻하지 않습니다. `selected_*`는 파서 선택만 설명합니다.
소스 검토만으로 `exact_only`나 `no_window`를 해제할 수 없습니다.
[ADR 013](../decisions/013-forward-version-compatibility.md)에 따라 정확 프로필이 없는 이전 버전은
계속 미지원이며 `older_version_unsupported`에는 승격 경로가 없습니다. 이 설명은 사유, 호환성,
창, 검토 범위, 게이트, 실제 실행 검사를 바꾸지 않습니다.
어느 상태에도 해당하지 않으면 경로를 추측하지 않고 `invalid_record`로 실패합니다.
평가 레코드의 크기 제한은 256 KiB 그대로입니다.

`static-assessment-v3` writer는 schema 5(검토 없음) 또는 6(검토 포함)을 출력합니다.
reader는 `static-assessment-v1`의 schema 1–4와 명시된 `static-assessment-v2` 또는
`static-assessment-v3` 리비전의 schema 5/6을 계속 읽습니다. 두 root 정책 ID는 v3에서만
허용하며 v2 레코드를 다시 쓰지 않습니다. v3 schema는 일반 root 참조 정책 레인 두 개,
`codex-binding-root-window-v1`과 `claude-binding-root-window-v1`을 추가합니다. 규칙 리비전은
`codex-ordinary-root-window-v1`과 `claude-ordinary-root-window-v1`입니다. 각 레인은 root만
다룹니다. link, collect, restart만 있고 `exact_only:false`, 깊이 0, 멤버 하나이며 launch, resume,
family 레인은 없습니다. 이 유한 정책 레인은 정확 admission 레인과 다릅니다. 정적 선택은 활성화
상태를 읽지 않고, 기존 레인의 `exact_only`를 해제하지 않으며, 릴리스를 사용 가능하게 만들지
않습니다. 정책 레인의 `selected_window`는 선택만 설명합니다. 기존 레인 값은 새 schema에서도 그대로입니다.
두 정책은 오프라인 검증용으로 구현되었으며, 일반 창(window) 수집은 별도 제품 활성화와 native
검증 전까지 비활성 상태입니다.

별도로 제공하는 Codex 패키지·설정은 검증된 root 자체 사용량이 아닌 `source_only` root
참조를 사용합니다. 별도 활성화가 있고 명시적으로 활성화된 고정 window 작업만 안정 버전
`0.163.0 < v < 0.170.0`에서 대상별 심층 적합성 검증보다 먼저 이 참조를 사용할 수 있습니다.
window 전용 대상의 정확 row는 추가하지 않습니다. 이 제한적 예외는 자식, 정확 지원, 상한 변경,
승격을 포함하지 않으며 이들은 심층 검증 gate를 유지합니다. 필수 계약 실패·모순·권한 철회·
비호환 버전은 계속 관측을 중단합니다. 구현 제공, 설치나 정적 선택은 활성화나 native 검증을
충족하지 않습니다. [ADR 013](../decisions/013-forward-version-compatibility.md#codex-root-reference-exception)과
[canonical 검증 경계](../../.claude/skills/tool-version-update/references/verification.md#closed-codex-root-reference-boundary)를 참고하세요.

window pin 검증은 별도 `ordinary_window_execution_pins` kind와 자체 namespace의 schema 1,
`pin_scheme_revision: ordinary-window-execution-v1`을 사용합니다.
`snapshotWindowPins` / `assertWindowPins`는 코드 소유 Codex raw producer·선택 skill·
instrument 입력, source/build 트리, 일치하는 built 사본, runtime·package·lock을 source와
built 선택별로 독립 고정합니다. packet은 runner나 실행·활성화 승인이 아니며 기존 정확 pin
함수와 approval schema 1의 의미는 그대로입니다. 검증으로 native·target·backend 실행,
새 예산, publisher·variant 변경, 상한 갱신이나 후속 레코드를 만들지 않습니다.

## 기계 차이 판단 레코드

별도 schema-1 kind 세 가지로 기계의 주장을 표현합니다. `difference_job`은 후보, 관측,
레인, null을 허용하는 기준선, 파서 기준, 목록, 고정 정책을 연결합니다.
`difference_evidence`는 유한한 방법, 양 끝의 해시, 구조화된 발견을 연결하며,
`difference_judgment`는 필수 facet과 비교를 소비 계약 여덟 그룹으로 축약합니다.
엄격한 재귀 schema, 256 KiB 제한, canonical JSON, SHA-256 ID, 덮어쓰기 없는 게시를
유지합니다. 폴더는 `difference-jobs/`, `difference-evidence/`, `difference-judgments/`입니다.
본문, 자유 텍스트, URL, 로컬 경로, 승인 필드는 거부합니다. 엔진 identity는 평가
source digest와 별도로 명시적인 버전 파일 목록을 사용합니다.

기준선과 대상이 같아도 기준선 및 파서 기준의 인접 간선과 누적 파서 비교가 필요합니다.
누락되거나 오래되거나 불완전한 증명은 unknown이며, 적용 가능한 확정 모순은 통과한
fixture보다 우선합니다. 소스 해시 변경만으로 영향을 확정하지 않습니다.
창이 닫힌 상태에서 native/backend/실제 세션 검증은 대기로 남습니다. 정적 작업은
build/native/artifact 다이제스트에 `not_applicable`과 null을 사용합니다. 이 보수적 map에서는
필수 native/backend facet이 없는 Codex 그룹만 완전한 불변 client-source 증명으로
`ready_for_scoped_review`가 될 수 있습니다. Claude 문서나 합성 replay만으로는 업스트림
동작의 불변성을 확정할 수 없습니다. 전체 레인의 운영 준비가 완료되지는 않습니다.
이 레코드는 권한을 부여하거나 수동 검토가 되지 않으며, 아직 어떤 명령이나 평가도 소비하지 않습니다.

Codex 소스 라이브러리는 주입된 transport, 작업에 고정된 commit과 정확한
`rust-v<version>` 태그, 코드가 소유한 경로만 사용합니다. Map v2는 직렬화, 생산자,
변환, hook, 호출 입력을 포함하는 전체 Cargo workspace, 설정, patch, vendored 입력의
tree identity를 비교합니다. 변경되거나 불완전한 closure는 unknown입니다.
저장소의 draft-07 설정 schema로 소비하는 model, effort, sandbox의 알려진
필드/type/enum 변경을 확인할 수 있지만, rollout, hook, 전체 그룹의 직렬화 계약이
불변임을 확정할 수는 없습니다. 호스트는 `api.github.com`뿐이며 같은 origin/resource의
수동 redirect만 허용합니다. 제한은 문서당 decoded 4 MiB, identity 재검증을 포함한
작업당 16 MiB, 응답 128개, redirect 5회, 120초입니다. 실패, 잘림, drift, 제한 소진은
부분 성공이 아닌 사용할 수 없는 증거가 됩니다. 본문은 일시적으로만 보관하고 레코드에는
해시와 유한한 발견만 남깁니다. client-source identity는 패키징, native 실행, 전달,
backend 의미를 확정하지 않습니다.

Claude 문서 라이브러리는 같은 제한과 호스트를 사용하며 `anthropics/claude-code`를 인증하고,
정확한 `v<version>` 태그를 작업의 commit으로 확인한 뒤 `CHANGELOG.md` blob을 재검증합니다.
비교 구간에 속한 정확한 버전 섹션만 검사합니다. 유한한 키워드 표는 해당 범위의 검사를
요구하며, 소비하는 보장을 위반하는 완전한 매핑 문장만 affected로 판단할 수 있습니다.
변경 언급이 없거나 문서가 없거나 지원하지 않는 형식이면 `unaffected`를 확정하지 않습니다.
버전 없는 문서는 참고 자료뿐입니다. receipt에 본문 해시, 가져온 시간, `release: null`,
`unversioned_doc`을 남기며 릴리스 증거의 본문 해시는 null이고 사용할 수 없는 상태입니다.
문서 호스트를 추가하지 않습니다.

합성 replay 라이브러리는 독립적인 수치·소유권 원장을 parser/provider 또는 합성 client 결과와
비교합니다. terminal replay, 부분 finality, 누락과 관측된 0의 차이를 보존합니다.
test/harness 및 fixture/input 해시는 engine digest와 별도로 연결합니다.
기존 Claude stub/oracle을 포함한 이 fixture는 실행하지 않은 릴리스를 시험하거나 backend
counter의 의미를 확정하지 않습니다. native, backend, 실제 세션 검증은 대기로 남습니다.
두 라이브러리는 명령이나 `assess` 입력 없이 라이브러리로만 제공됩니다.

## 계약 검토 레코드

계약 검토 레코드는 유지보수자의 수동 주장입니다. "이 레인과 이 릴리스 간선에서 소비하는 계약은
영향 없음(unaffected), 영향 있음(affected), 알 수 없음(unknown)이다"라는 내용입니다. 도구는
레코드의 형태와 관측된 릴리스 및 현재 소스와의 일치만 확인합니다. 검토가 실제로 이루어졌는지,
판단이 옳은지는 확인하지 않습니다. 레인이 `closed`라는 것은 제공된 주장이 모든 계약을
`unaffected`로 판단했다는 뜻일 뿐 지원이 아닙니다. 적합성, 회귀, 구현 검토, 허용, 기본값 승격은
`not_assessed`로 남습니다.

레코드는 엄격한 객체입니다. 자유 텍스트, 이름, 타임스탬프, 경로는 없습니다.

```json
{
  "schema_version": 1,
  "kind": "contract_review",
  "product": "codex",
  "route": "<route>",
  "profile_id": "<profile_id>",
  "operation": "<operation>",
  "topology": "<topology>",
  "contract_revision": "consumed-v1",
  "from": { "version": "<version>", "commit": "<40 hex>" },
  "to": { "version": "<version>", "commit": "<40 hex>" },
  "contracts": [
    { "contract_id": "identity_source_mapping", "judgment": "unaffected | affected | unknown" }
  ],
  "evidence_ids": ["<64 hex>"],
  "source_digest": "<64 hex>"
}
```

형태만 보여 주는 예입니다. `contracts`에는 소비 계약 여덟 개를 `consumedContracts` 순서대로 한 번씩
모두 적어야 하며, 예시는 항목 하나만 보여 줍니다. `evidence_ids`는 중복 없는 64자 16진수 ID를 정렬한
비어 있지 않은 목록입니다. `from.version`은 `to.version`보다 낮아야 합니다. `source_digest`는 검토한
기준이 된 평가의 소스 다이제스트입니다.

### 작업 순서

1. 릴리스 간선을 직접 검토하고 레코드 파일을 작성합니다.
2. 게시합니다.

   ```sh
   node scripts/tool-update.mjs record-review --input "$review_file" --out "$out"
   ```

   `{"status":"review_recorded","review_id":"<64 hex>"}`를 출력하며 파일은
   `reviews/<review_id>.json`에 저장됩니다.
3. 레코드마다 `--review "$out/reviews/<review_id>.json"`을 하나씩 붙여 `assess`를 실행합니다.
   옵션 순서는 결과에 영향을 주지 않습니다.

기준선이 이미 대상 버전을 다루는 경우(릴리스 간선이 없음)에는, 제공된 레코드가 `to.version`이 대상과
같고 현재 소스 다이제스트와 일치하며 여덟 계약을 모두 `unaffected`로 판단하고 그 검토 ID가 해당 기준선
행의 `evidence_ids`에 있을 때만 레인이 닫힙니다. 사람이 승인한 기준선이 묶지 않은 레인은 레코드
하나만으로 닫히지 않습니다. `baseline_missing` 레인은 무엇을 제공해도 `unknown`으로 남습니다.

### assess가 레코드를 적용하는 방식

`--review`가 하나 이상이면 평가는 `schema_version: 6`으로 쓰이며 정렬된 `review_ids`,
`unused_review_ids`와 각 레인의 `selection_policy`를 포함합니다.
`--review`가 없으면 출력은 `schema_version: 5`이며 `selection_policy`가 없습니다.
소스 다이제스트를 포함해 입력이 바뀌면 바이트와 ID도 함께 바뀝니다.
schema 1–6 평가를 계속 읽을 수 있고 기존 레코드를 다시 쓰지 않습니다.

- 레코드는 레인 키, `contract_revision`, `from`·`to`의 버전과 커밋이 모두 관측과 일치하고
  `source_digest`가 현재 스냅샷 다이제스트와 같을 때만 레인 간선에 적용됩니다. 아니면 그 간선은
  `unknown`으로 남습니다.
- `source_digest`만 다르고 나머지가 모두 일치하면 간선은 `unknown`으로 남고 레인에
  `review_source_changed` 사유가 붙습니다. 오류가 아닙니다.
- `unused_review_ids`에는 평가에서 읽지 않은 레코드만 나열됩니다. 파서 비교 체인이 읽은 것도
  사용으로 셉니다. 간선이 없는 레인에서 기준선에 묶이지 않은 레코드라도 체인이 읽으면 이 목록에
  들어가지 않지만, 기준선 연결 없이는 `contracts_reviewed`가 `unknown`으로 남습니다.
- `review.contracts`는 구간 전체에서 계약별 최악값이며 우선순위는 `affected`, `unknown`,
  `unaffected` 순입니다. `contracts_reviewed`는 모든 계약이 `unaffected`일 때만 `closed`, 하나라도
  `affected`이면 `affected`(사유 `contracts_affected`), 그 밖에는 `unknown`입니다.
  `contracts_unknown`은 `closed`일 때만 제거합니다. `exact_only`, `no_window`, `minor_transition` 같은
  다른 사유는 모두 유지되며 실제 실행 필드, 다른 게이트, `review_sources`는 바뀌지 않습니다.
- `parser_comparison`은 파서 기준 버전에서 대상까지 일치하는 레코드가 끊김 없이 이어질 때만 `unknown`을
  벗어납니다. 모든 인접 릴리스와 양 끝 커밋이 관측에 고정되어 있어야 합니다. 파서 기준 버전이
  없거나 관측된 릴리스를 건너뛰거나 커밋 연결이 끊기면 비교는 `unknown`으로 남습니다.

## 검토 기준선

기준선은 선택 사항이며 사람이 직접 검토합니다. 없으면 탐색은 여전히 안정 헤드를 맞춰 보지만,
검토 범위는 `baseline_missing`으로 불완전하게 남습니다. 도구는 파서 기준 버전이나 현재 기본값에서
기준선을 추론하지 않습니다.

파일은 엄격한 객체입니다.

```json
{
  "schema_version": 1,
  "kind": "baseline",
  "rows": [
    {
      "product": "codex",
      "route": "<route>",
      "profile_id": "<profile_id>",
      "operation": "<operation>",
      "topology": "<topology>",
      "last_reviewed_version": "<version>",
      "contract_revision": "consumed-v1",
      "evidence_ids": ["<64 hex>"],
      "source_digest": "<64 hex>"
    }
  ]
}
```

이것은 형태일 뿐이며 그대로 쓸 수 있는 입력이 아닙니다. 모든 값은 실제로 사람이 검토한 기록에서
와야 합니다. 실제로 검토한 릴리스, 그 검토의 증거 ID, 검토한 소스의 다이제스트가 그것입니다.
`evidence_ids`는 중복 없는 64자 16진수 ID로 된 비어 있지 않은 목록이어야 합니다. 중복 키, 알 수
없는 키, 잘못된 행은 `invalid_baseline`으로 거부됩니다. 대상보다 새 버전은 `baseline_ahead`로
실패합니다. 어느 명령도 기준선을 갱신하지 않습니다.

## 상태 코드와 종료 동작

모든 실행은 고정 코드와 안전한 ID만 담은 JSON 상태 줄을 정확히 한 줄 출력합니다. 버전은 정규화된
형태로 나올 수 있습니다. 원본 응답 본문, 오류 메시지, 로컬 경로는 출력하지 않습니다.

| 종료 | 상태 | 의미 |
| --- | --- | --- |
| 0 | `metadata_reconciled` | 탐색이 끝나고 후보를 씀 |
| 0 | `assessment_created` | 정적 평가를 씀 |
| 0 | `review_recorded` | 계약 검토 레코드를 게시함 |
| 2 | `release_mismatch` | GitHub와 npm 안정 헤드, 또는 npm `latest`와 안정 최댓값이 다름 |
| 2 | `discovery_incomplete` | 선택한 릴리스 누락, 예산 소진, 재검증 중 변경 |
| 2 | `metadata_conflict` | 릴리스 식별, 태그 해석, 무결성이 서로 충돌 |
| 2 | `invalid_arguments` | 알 수 없는 명령 또는 누락된 옵션 |
| 2 | `invalid_record`, `record_too_large`, `record_conflict`, `record_read_failed`, `record_write_failed`, `unsafe_output` | 로컬 레코드 입력 또는 저장 실패 |
| 2 | `invalid_baseline`, `baseline_ahead` | 기준선 거부 |
| 2 | `invalid_review` | 검토 레코드가 잘못되었거나 고정 규칙을 어김 |
| 2 | `review_conflict` | 서로 다른 두 레코드가 같은 레인과 릴리스 간선을 다룸 |
| 2 | `review_commit_conflict` | 레코드의 커밋이 해당 버전의 관측 커밋과 다름 |
| 2 | `source_snapshot_unavailable`, `source_scope_changed`, `source_drift`, `observation_mismatch` | 소스 투영 실패, 검토된 범위 변경, 또는 입력이 서로 맞지 않음 |
| 2 | `internal_error` | 예기치 않은 로컬 실패이며 원문 예외는 출력하지 않음 |

`discover`에서 대상보다 새 기준선은 실패 관측의 reasons에 `baseline_ahead`로 남고, stdout은
`discovery_incomplete`를 보고합니다. `assess`는 `baseline_ahead`를 직접 반환합니다.

원인을 고친 뒤 다시 실행하세요. 레코드를 손으로 고치지 마세요.

## 한계

- 로컬 과거 소스 창(window)은 저장소의 선언입니다. 최신 업스트림 릴리스에 대한 주장이 아닙니다.
- CLI 테스트는 합성 메타데이터만 씁니다. localhost에서 벤더 바이너리로 실제 도구를 돌리는 일은
  별도 실행 승인이 필요한 이후 단계입니다.
- 지원, 자격(qualification), 허용, 기본값 변경은 여전히 [개발 워크플로](workflow.md)와 제품
  요구사항을 따릅니다.
- 승인된 순서는 registry, 닫힌 일반 창, 차이 판단, 선택적 승격입니다. 이후의 native, 승격,
  게시 게이트는 모두 그대로 적용됩니다.

## 공식 메타데이터 계약

- [GitHub 최신 릴리스](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- [GitHub 정확한 태그 릴리스](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)
- [GitHub 정확한 참조](https://docs.github.com/en/rest/git/refs#get-a-reference)
- [npm 패키지 메타데이터](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)
