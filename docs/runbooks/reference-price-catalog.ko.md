# 기준가격 카탈로그 사용하기

[English](reference-price-catalog.md) · [비용 상태와 수집 범위](observed-cost.ko.md)

측정 작업과 같은 로컬 DB를 사용하세요. 사전 조건은 Node 24 또는 26으로 빌드한 CLI와
승인된 저장 관측값입니다. 이 명령은 로컬 메타데이터를 읽으며 모델 요청을 시작하지
않습니다. 표준화된 부분 추정은 청구액이나 실지출 절감액이 아닙니다.

## 1. 제공된 카탈로그 읽기

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table catalog-status
```

예상 결과: 카탈로그 ID/버전, 확인일, 마지막 확인/성공 시각, 갱신 상태입니다.
처음 사용하면 번들 카탈로그를 오프라인으로 불러옵니다. 2026-10-06에 확인한
Astra, Sol, Luna, Fable, Opus, Sonnet, Haiku 기준가격이 있습니다.
[출처 정책과 정확한 식별자](../decisions/reference-price-catalog.md)를 확인하세요.
3단계의 기본 공급원을 사용하면 `update_channel`은 `verified_https_manifest`입니다.
공급원을 명시적으로 미설정하면 `bundled_or_verified_local_artifact`입니다.
온라인 갱신은 자동으로 실행되지 않습니다.
오래되었거나 갱신에 실패한 상태는 마지막으로 승인된 카탈로그와 함께 표시해야 합니다. 확인 날짜는 가격 적용 시작 날짜를 입증하지 않습니다.

카탈로그 리비전은 불변이며 번들 v1 부트스트랩과 기존 고정 기준은 자동으로 바뀌지 않습니다.

| 카탈로그 | 상태와 클라이언트 요구사항 | 주요 단가 범위와 한계 |
| --- | --- | --- |
| v1 (2026-10-06) | 번들 오프라인 부트스트랩 | Astra, Sol, Luna, Fable, Opus, Sonnet, Haiku 기준 단가([출처 정책](../decisions/reference-price-catalog.md)). |
| v2 (2026-10-08) | 별도 배포; v2 이상 클라이언트 필요 | Sonnet 5.5 캐시 읽기를 백만 토큰당 $0.10으로 인하하고 Haiku 5.5 요청별 구간(캐시 읽기·쓰기 포함 총 프롬프트 100,000 이하/초과)을 추가합니다. 구간별 Haiku 계산에는 일치하는 입력 수와 연결된 요청 근거가 필요하며, TTL이 없으면 명시적 5분 기준을 쓰고 1시간·혼합 쓰기는 제외합니다([상세](../decisions/reference-price-catalog.md#october-2026-catalog-update)). |
| [v3](https://github.com/Qello-Labs/harness-delta/releases/tag/reference-prices-2026-10-08-v3) (2026-10-08) | 게시된 릴리스; `catalog-cache-ttl-v3` 필요 | `observed_ttl-v1` 아래에서 명시적이고 일치하는 TTL별 숫자가 있는 Claude 관측의 5분·1시간 캐시 쓰기(혼합 쓰기 포함)를 분리 계산합니다. 이전 클라이언트는 거부하고 캐시 가격을 유지합니다([한계](../decisions/reference-price-catalog.md#observed-cache-ttl-v3)). 새 TTL 메타데이터 기록 후 클라이언트를 다운그레이드하지 마세요. |
| v4 (2026-10-16) | **미게시 후보**(스키마 3, `catalog-cache-ttl-v3`) | 기존 단가 재확인 및 `gpt-5.6-sol`(별칭 `gpt-5.6`), `gpt-5.6-cyber`, `claude-mythos-5-1` 추가([후보 릴리스 안내](../release-notes/reference-prices-2026-10-16-v4.md)). Sol에는 **2026-11-21까지** 안내된 프로모션 단가가 기록되어 있고(`effective_until: null`) 해당 날짜가 지났으므로 게시·사용 전에 최신 단가를 재확인하고 프로모션 이후 단가는 새 카탈로그로 발행하세요. |

카탈로그 정책별 가격 조건 규칙:

- **Claude 캐시 쓰기 TTL:** **v1/v2**에서는 TTL이 없을 때 명시적인 5분 기준 추정치를 사용하며(실제 청구 TTL 확인이 아님), 확인된 1시간·혼합 쓰기만 제외합니다(관측 토큰은 보존하고 프롬프트 경계 합산에 포함). **v3/v4**(`observed_ttl-v1`)에서는 숫자 TTL 누락·오류, 과거 boolean-only 쓰기, 숫자 TTL이 없는 파일/OTel 관측의 Claude 캐시 쓰기 비용을 `unverified_condition`으로 남깁니다(`matches[].cache_ttl`이 매칭된 TTL 기간을 표시).
- **구간별 Haiku 5.5 단가(v2–v4):** 입력 수 누락·불일치나 연결된 요청 런타임 근거 누락 시 Haiku 구간 단가는 `unverified_condition`으로 남습니다(관측 토큰은 보존되며 다른 적격·단가 일치 성분으로 부분 추정 가능). 공통적으로 `missing_rate`는 관측 조건의 단가 부재, `unknown_model`은 미등록 모델을 뜻합니다.
- **미지원 청구 조건:** Fast/Ultrafast/Priority/Flex/Batch, 장문 컨텍스트 청구, 지역/boost 조건, 도구·미디어, 구독과 할인은 계산하지 않습니다. 매칭 결과는 Standard short-context/global 기준 추정일 뿐 실제 청구 조건을 입증하지 않습니다.
- **UI와 근거 경계:** UI는 부분 비용과 원본/호환성 미검증 참고 비용을 따로 표시하며, 단가 없는 사용량 안내에는 토큰이 관측됐지만 비용에서 제외한 캐시 쓰기가 포함될 수 있습니다. 가격 지원은 네이티브 원본·카운터를 검증하거나 전체 비용·통계적 추론을 활성화하지 않습니다.

## 2. 가격 파일을 선택하지 않고 추정하기

```sh
reportCutoff=$(node -p 'new Date().toISOString()')
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table estimate-task task-1 \
  --cutoff "$reportCutoff"
```

예상 결과: `price_selection`, 가격표 출처,
`partial_amount`, null인 `complete_amount`, 사유와 구간/수집 범위 근거입니다.
카탈로그 기반 결과에는 카탈로그 출처와 정확한 토큰 범주 매칭도 포함됩니다.
명시적 가격표 결과는 명시적 가격표 보고서 형식을 유지합니다.
`compatibility_unverified_partial_amount`와 `legacy_unverified_partial_amount`는
verified `partial_amount`와 구분해서 읽으세요. [source 신뢰와 관측 범위](observed-cost.ko.md#4-금액누락관측-범위를-따로-읽기)를 참고하세요.
일반 관측 작업은 생성 시점의 불변 가격 고정값(`ordinary_task_pin`)을 사용하며,
비교 기준보다 먼저 선택합니다. 배정된 V2 작업은 고정된 비교 기준
(`frozen_comparison`)을 사용합니다. 기존 독립 작업 등 두 고정값이 모두 없는 작업만
현재 카탈로그(`current_catalog`)를 사용합니다. 카탈로그 갱신은 일반 작업의 가격
고정값이나 동결된 비교 기준을 바꾸지 않습니다.
과거의 명시적 비교 가격표도 계속 사용할 수 있습니다. 새 V2 비교 CLI 설정은
`price_table_id`를 생략할 수 있으며 등록 시 한 번 채웁니다. 갱신은 등록된 기준을
바꾸지 않습니다. 고급 `--price-table`은 [기존 명시적 절차](observed-cost.ko.md#1-가격표-선택하기)를 유지합니다.

기존 V1 `--input-basis` 선택(`output-only-v1`, `cache-read-remainder-ordinary-v1`)은
[관측 비용](observed-cost.ko.md#3-의도된-경우에만-기존-입력-가정-선택하기)을 참고하세요.
effort에 가격 배수를 적용하지 않으며 추론 토큰은 출력에 이미 포함됩니다. 사용량 누락은
그대로 남기며, 알 수 없는 모델·단가는 유사 매칭이나 대체 가격 없이 계산 불가로 표시합니다.

## 3. 승인된 카탈로그 갱신하기

도구 업데이트 후 번들을 다시 불러오세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table refresh-catalog
```

예상 결과: `unchanged` 또는 `updated`입니다. 번들이 승인된 로컬 카탈로그보다 오래되면
`catalog_rollback`으로 실패하고 더 최신인 캐시를 유지합니다.
신뢰하는 배포자가 제공한 새 릴리스 파일을 사용하려면 파일과 별도로 검증한 SHA-256을
지정하세요. 아래 두 자리표시자를 실제 값으로 바꾸세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table refresh-catalog \
  --artifact /path/to/reviewed-catalog.json --sha256 'TRUSTED_64_CHARACTER_SHA256'
```

예상 결과: `updated`/`unchanged`, 또는 정제된 실패 사유와 종료 코드 2입니다.
이후 `catalog-status`를 확인하세요. 해시는 파일 내용을 확인하며 배포자의 신뢰성을
입증하지 않습니다. 잘못된 파일, 시간 초과, 해시 불일치, ID 충돌, 오래된 버전은
마지막 승인 가격을 유지합니다. 갱신은 향후 기본 준비에만 반영됩니다.
일반 추정 흐름에서 사용자가 모델별 단가를 편집/등록하지 않습니다.
도구의 승인된 공개 공급원에서 검토된 릴리스를 요청하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table refresh-catalog --online
```

예상 결과: `updated`/`unchanged`, 또는 승인 캐시를 유지하는 안전한 실패입니다.
기본 공급원은 승인된 `Qello-Labs/harness-delta` GitHub 최신 릴리스입니다.
저장소 이전 뒤에는 기존 클라이언트를 이 주소로 갱신하세요. 이전 소유자의
리디렉션은 고정된 다운로드 정책에 없는 경유를 추가합니다. 발행자 ID
`harness-delta`, 릴리스 파일 내용과 기존 작업의 가격 기준은 유지합니다.
첫 가격 릴리스는 2026-10-06에 실제 다운로드/갱신 검증을 통과했습니다.
향후 최신 릴리스에도 manifest와 카탈로그 파일이 있어야 합니다. 파일이 없으면
갱신은 실패하고 캐시 가격을 유지합니다. 서버에서 공급원을 명시적으로 미설정하면
`catalog_source_not_configured`와 종료 코드 2를 반환합니다.
`online_source.status: configured`와 `can_attempt_online_refresh: true`는 공급원 설정을
뜻하며 연결 가능성이나 최신성 검증을 뜻하지 않습니다. `verification_age_days`는
보존 카탈로그의 확인일을 나타냅니다. 브라우저는 모델별 가격 JSON이나 임의 공급원
URL을 요구하지 않습니다.

## 4. 고정 결과를 보존하고 재계산하기

메타데이터를 삭제하기 전에 작업 입력을 보존하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table snapshot-task task-1 \
  --id cost-input-1 --cutoff "$reportCutoff"
```

기존 V2 비교 보고서는 고정 보고서에서 양군을 함께 보존하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table snapshot-comparison report-1 \
  --id comparison-cost-input-1
```

예상 결과: 작업 입력 보존은 `input_id`, `snapshot_hash`, `original_table_id`,
`cutoff`를 반환하고, 비교 입력 보존은 `input_id`, `snapshot_hash`,
`base_report_id`, `cutoff`를 반환합니다. 작업과 비교의 구간은 다를 수
있으므로 해당 입력을 선택하세요. 두 명령 모두 세션 내용을 읽지 않습니다.
승인된 갱신 후 해당 입력에서 별도 결과를 만드세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table reprice comparison-cost-input-1 \
  --id repriced-1
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table revaluation repriced-1
```

예상 결과: 원래 작업/양군 모두에 적용되는 하나의 새 카탈로그 기준, 동일한 사용량/구간
해시, 별도 결과 ID, null인 전체 비용입니다. 원래 보고서는 그대로 남습니다.
이 결과는 기술적 재평가이며 도입이나 상대 변화 판정을 제공하지 않습니다.
작업 입력에는 `comparison-cost-input-1` 대신 `cost-input-1`을 사용하세요. 새로 단가가
생긴 모델은 부분 계산이 가능해질 수 있으나 사용량 누락은 여전히 누락입니다. 종속
작업/프로젝트 삭제나 기준 보고서 무효화는 보존 입력/결과를 제거하고 복원을 막습니다.
