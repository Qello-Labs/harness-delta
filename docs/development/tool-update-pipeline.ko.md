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
- `assess`는 후보, 그 후보를 만든 관측, 선택적 검토 기준선을 읽습니다. 현재 저장소 소스를
  투영해 변경 불가능한 평가(assessment) 레코드를 씁니다.

아무것도 설치하지 않고 벤더 바이너리도 실행하지 않습니다. 세션, 사용자 데이터베이스, 도구
설정을 읽지 않으며 허용, 기본값, CI, 추적 파일도 바꾸지 않습니다. 네트워크 요청은 `discover`만
보냅니다. 공식 GitHub와 npm 엔드포인트에 고정된 읽기 요청만 보내고, 비밀값이나 호출자가 지정한
URL 매개변수는 쓰지 않습니다.

계약 검토, 적합성, 회귀, 허용, 기본값 승격은 별도 단계이며 이번 단계에 포함되지 않습니다.
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
새 평가는 schema 2로 관측의 범위를 전달하며, schema-1 입력에는 `legacy_full_inventory`를
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

따옴표 안의 자리표시자는 `discover`가 출력한 ID로 바꿉니다. `--out`을 빼면 평가는 manifest
파일에서 두 단계 위인 레코드 루트에 저장됩니다. 탐색에 기준선을 썼다면 같은
`--baseline "$baseline_file"`을 넘깁니다. 성공하면
`{"status":"assessment_created","assessment_id":"..."}`를 출력하고 0으로 종료합니다.

## 레코드와 식별자

| 디렉터리 | 레코드 | 식별자 |
| --- | --- | --- |
| `observations/` | 한 번의 조회: UTC 확인 시각, 출처 ID, 응답 다이제스트와 검증자, 완전성, 고정 결과 코드 | 시각을 포함하므로 실제 재조회마다 새 ID |
| `candidates/` | 제품, 정확한 안정 버전, 태그와 커밋, npm 버전과 무결성 | 정규 릴리스 필드만 쓰므로 같은 릴리스는 같은 ID |
| `assessments/` | 후보 ID, 관측 ID, 기준선 다이제스트 또는 누락 상태, 소스 다이제스트, 규칙 개정판, 레인 결과 | 이 입력 중 하나라도 바뀌면 달라짐 |

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
- 소비 계약 체크리스트는 모든 계약이 `unknown`인 상태로 시작합니다.
- `contracts_reviewed`는 `unknown`입니다. 적합성, 회귀, 구현 검토, 허용, 기본값 승격은
  `not_assessed`입니다.

레인에 기준선 행이 있으면 범위는 `review_required`, 없으면 `baseline_missing`입니다. 어느 값도
릴리스가 동작한다는 뜻은 아닙니다.
`review_sources`는 허용 목록의 업스트림 소스·스키마 또는 changelog 경로를 각 릴리스 커밋에
연결합니다. availability는 `not_assessed`이며, 파일을 가져왔거나 계약을 검증했다는 주장이
아니라 검토할 항목입니다.
이 소스 경로는 검토 시작점이며 업스트림에서 이동할 수 있습니다. 검토 증거로 사용하기 전에
고정된 커밋에서 각 경로의 존재를 확인하세요.

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
| 2 | `release_mismatch` | GitHub와 npm 안정 헤드, 또는 npm `latest`와 안정 최댓값이 다름 |
| 2 | `discovery_incomplete` | 선택한 릴리스 누락, 예산 소진, 재검증 중 변경 |
| 2 | `metadata_conflict` | 릴리스 식별, 태그 해석, 무결성이 서로 충돌 |
| 2 | `invalid_arguments` | 알 수 없는 명령 또는 누락된 옵션 |
| 2 | `invalid_record`, `record_too_large`, `record_conflict`, `record_read_failed`, `record_write_failed`, `unsafe_output` | 로컬 레코드 입력 또는 저장 실패 |
| 2 | `invalid_baseline`, `baseline_ahead` | 기준선 거부 |
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

## 공식 메타데이터 계약

- [GitHub 최신 릴리스](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- [GitHub 정확한 태그 릴리스](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)
- [GitHub 정확한 참조](https://docs.github.com/en/rest/git/refs#get-a-reference)
- [npm 패키지 메타데이터](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)
