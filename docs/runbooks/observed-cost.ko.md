# 관측된 작업 비용 추정 읽기

[English](observed-cost.md) · [작업 절차](workflow-quickstart.ko.md)

이 보고서는 **저장된 적격 관측값**에 명시적 기준 가격을 적용합니다.
세션 파일이 아니라 DB 이벤트를 읽으며 제품·모델 요청을 시작하지 않습니다.
`complete_amount`는 항상 null입니다. 부분 추정은 청구액·절감액·도입 결과가 아닙니다.
연결된 루트/자식/재작업 이벤트는 소스와 구간이 적격일 때만 포함됩니다.
이 보고서는 소스를 승인하거나 부모/자식 카운터 중복이 없음을 입증하지 못합니다.

일반 흐름은 [제공된 기준가격 카탈로그](reference-price-catalog.ko.md)를 사용하세요.
`estimate-task`에 `--price-table`이 더는 필수가 아닙니다. 배정된 V2 작업은 고정된
비교 가격표를 유지하고 독립 작업은 현재 카탈로그를 사용합니다. 아래 절차는 과거 추정에도
계속 사용할 수 있는 고급 명시적 가격표 경로입니다.

## 1. 가격표 선택하기

측정 작업과 같은 DB를 사용하세요. 가격표를 명시적으로 선택하세요.
파일럿에 이미 `prices-1`을 등록했다면 아래 등록 예제는 건너뛰세요.

저장소의 [기준표](../../config/prices/openai-standard-short-2026-10-04.json)는 **2026-10-04**에 확인한 OpenAI API Standard·short-context 고정 스냅샷입니다.
단위는 토큰 1,000,000개당 USD입니다. `as_of`는 확인 날짜이며 가격 적용 시작 시각을 뜻하지 않습니다.

| 정확한 모델 | 일반 입력 | 캐시 읽기 | 캐시 쓰기 | 출력 |
| --- | ---: | ---: | ---: | ---: |
| gpt-6-astra | 10 | 1 | 12.5 | 50 |
| gpt-6.1-sol | 2 | 0.1 | 2.5 | 10 |

출처는 [공식 API 가격표](https://developers.openai.com/api/docs/pricing)의 Flagship models / Standard / Short context입니다.
[Astra 발표](https://openai.com/index/gpt-6-astra/)는 일반 입력/출력 가격을 확인합니다.
[Sol 발표](https://openai.com/index/introducing-gpt-6-1-sol/)는 캐시 입력 가격도 확인합니다.
캐시 쓰기 가격의 출처는 가격표입니다.
[Astra 모델 안내](https://developers.openai.com/api/docs/models/gpt-6-astra)와 [Sol 모델 안내](https://developers.openai.com/api/docs/models/gpt-6.1-sol)는 입력 272K 초과를 long context로 구분합니다.
이 스냅샷은 해당 경계 이하의 기준 가격을 사용합니다.

**가격 주의:** 가격표 선택은 관측 요청의 서비스 등급·context 범위를 입증하지 않습니다.
Fast/Ultrafast, Batch/Flex, long-context, 지역별 가격은 자동 선택하지 않습니다.
API 추정은 구독 청구액이나 구독 한도 사용량을 측정하지 않습니다.
모델 별칭이나 가격 대체를 적용하지 않습니다.

1. 이 표가 합의된 기준이면 등록하세요.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table register \
     --config config/prices/openai-standard-short-2026-10-04.json
   ```

2. 등록된 내용을 확인하세요.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table show openai-standard-short-2026-10-04
   ```

예상 결과: 변경할 수 없는 가격과 선택한 출처/버전.
같은 내용의 재등록은 같은 결과를 냅니다. 같은 ID의 변경 내용은 거부합니다.
다른 가격은 새 ID/버전을 이후에 선택하세요. 동결된 프로토콜은 원래 가격표를 유지합니다.

다른 모델은 명시적으로 선택한 가격을 제공하거나 모델 항목을 생략하세요.
완전한 `prices.json` 예제에 새 ID/버전/출처/날짜, 통화 하나, `unit_tokens`, 표시 정책, 정확한 성분 가격을 넣으세요.
로컬 설정 옆에 출처 URL·등급/context 범위·확인 날짜를 기록하세요.
사용자 기준 가격은 공식 제공자 가격이 아닙니다.
없는 모델은 unavailable로 남기며 다른 모델 가격을 쓰지 마세요.
저장소의 제한된 표에는 `gpt-6-sol`과 다른 모델을 의도적으로 넣지 않았습니다.

## 2. 추정 생성하기

사전 조건: 이 DB에 승인된 작업 관측값이 이미 있습니다.
파일럿의 작업/가격표 ID가 다르면 교체하세요.
포함할 관측 이후의 UTC cutoff를 저장하세요.

```sh
reportCutoff=$(node -p 'new Date().toISOString()')
```

기존 출력만 계산하는 기본 가정으로 추정하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table estimate-task task-1 \
  --price-table prices-1 --cutoff "$reportCutoff" --input-basis output-only-v1
```

저장소 기준표를 선택했다면 `prices-1`을 `openai-standard-short-2026-10-04`로 교체하세요.
이 동작은 기존 데이터를 추정하며 추가 사용량 수집이나 인증 조회를 하지 않습니다.

예상 결과: `partial_amount`, null `complete_amount`, 명시적 이유, 관측 구간 근거.
작업이 삭제되었으면 추정은 실패합니다. 삭제가 이전 이벤트를 복구하지는 않습니다.
[workflow 비교 보고서](workflow-quickstart.ko.md)는 자체 배정/판정 기간 구간을 고정합니다.
이 작업 추정은 작업 시작/활성 구간과 cutoff/최종 판정을 사용합니다.
두 보고서가 같은 시간 구간을 포함한다고 가정하지 마세요.

## 3. 의도된 경우에만 기존 입력 가정 선택하기

| 가정 | 효과 |
| --- | --- |
| `output-only-v1` | 알려진 기존 출력 계산; 기존 입력 분리는 unavailable |
| `cache-read-remainder-ordinary-v1` | 전체 입력에서 캐시 입력을 뺀 값을 일반 입력으로 가정; 캐시 입력은 캐시 읽기 가격 적용 |

V1 이벤트는 검증된 일반 입력/캐시 쓰기 분리를 기록하지 않습니다.
remainder 가정은 나머지에 별도 청구되는 캐시 쓰기가 없다고 가정합니다.
관측되지 않은 캐시 쓰기는 **0으로 검증되지 않았습니다**.
전체/캐시 카운터가 없으면 입력 추정을 보류하며 캐시가 전체보다 크면 실패합니다.
reasoning output은 total output에 이미 포함됩니다. 다시 더하지 마세요.
V2 이벤트는 어느 기존 가정을 선택해도 기록된 분리 성분과 귀속을 유지합니다.

가정에 합의했다면 명시적으로 요청하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table estimate-task task-1 \
  --price-table prices-1 --cutoff "$reportCutoff" --input-basis cache-read-remainder-ordinary-v1
```

예상 결과: 보고서가 가정 이름과 입력 가정을 적용한 이벤트 수를 표시합니다.
가격·성분 관측 범위·입력 가정·시간 구간이 비교 가능할 때만 추정값을 비교하세요.
출력만 계산한 추정은 입력 가격을 가정한 추정과 같지 않습니다.

## 4. 금액·누락·관측 범위를 따로 읽기

| 필드/상태 | 뜻 |
| --- | --- |
| `partial_amount` | source 신뢰가 verified인 적격 가격 성분; 명시적 입력 가정을 포함할 수 있음 |
| `compatibility_unverified_partial_amount` | 조건부 파서/프로필 재사용의 별도 추정액 |
| `legacy_unverified_partial_amount` | source 출처 없는 과거 native 사용량의 별도 추정액 |
| `compatibility` | 금액에서 제외한 invalidated 이벤트를 포함한 source/버전/파서 출처와 신뢰별 개수 |
| `partial_amount: "0"` | 적격 verified 가격 관측의 합계가 0 |
| `partial_amount: null` | 적격 verified 가격 금액 없음; 미검증 추정액은 있을 수 있음 |
| `complete_amount: null` | 작업 전체 비용 제공 불가 |
| `unpriced_events` | 단가 누락 또는 필요한 가격 조건 증거의 부재·미지원으로 가격 계산에서 제외한 성분이 있는 이벤트 |
| `unavailable_events` | 부분 가격 금액을 계산할 수 없는 이벤트 |
| `excluded_event_count` | 관측 구간 정책으로 제외한 저장 후보 수 |
| Missing / error / excluded / unmeasurable | 서로 다른 관측 상태이며 관측된 0이 아님 |
| `observed_components_priced: true` | 적격 관측 성분에 가격 적용 가능; 작업 전체 관측 범위는 여전히 미확정 |

신뢰별 금액과 이유를 함께 읽으세요. 모든 관측이 미검증이면 미검증 추정액이 있어도
`partial_amount`는 null입니다. 비었거나 가격을 계산할 수 없는 범주의 금액은 0이 아닌
null입니다. 과거 고정 보고서는 원래 형식을 유지하며, 누락된 출처를 verified로 자동 승격하지 않습니다.
사용량 부재·알 수 없는 귀속/성분·가격 누락을 표시해야 합니다.
cached/reasoning 부분집합을 다시 더하거나 집계로 부모/자식 완전성을 추론하지 마세요.

cutoff는 해당 시각을 제외합니다. 작업 시작 전·최종 판정 시각 이상의 이벤트는 포함하지 않습니다.
기록된 활성 구간만 포함합니다. paused·미관측 구간은 backfill하지 않습니다.
명시적 손실/오류/제외 구간은 작업 전체에서 이벤트를 보수적으로 제외합니다.
일반 incomplete/unavailable 관측 범위는 독립 관측된 적격 이벤트를 유지하지만 완전하게 만들지는 않습니다.
후보 Claude의 구간 밖 span은 listener 구간을 offline으로 표시해 동반 이벤트를 보수적으로 제외할 수 있습니다.

`coverage`는 감시된 범위/identity 사실·미확정 사실·부적격 판정을 표시합니다.
source 변경 실패는 identity 위반을 유지합니다.
cutoff 뒤에 끝난 journal은 이전 관측 범위를 입증하지 못합니다.
빈 구간의 coverage 근거는 null이고 판정은 부적격입니다.
가격 적용 가능은 요청 전체 집합이나 마지막 전달 완료를 입증하지 않습니다.

## 5. 별도로 봉인된 계측 구간 읽기

별도 계측 receiver는 요청 전 dispatch·terminal 기록과 불변 seal snapshot을 제공합니다.
production 적격성에는 코드가 소유한 정확한 producer 검증과 인증된 소유 launch가
필요하며, caller가 만든 profile이나 launch row만으로는 충분하지 않습니다.
발급·launch chain 없이 수행한 conformance는
`source_unverified_partial_amount`로 유지됩니다.
일반 Codex 로그나 과거 관측값을 이 경로로 승격하지 않습니다.
첫 프로필은 HTTP Responses, `gpt-6.1-sol` / `high`, 새 root 하나와 실행 전체에서
최대 두 개의 새 direct child로 제한됩니다. 미검증 WebSocket, Guardian, 보조 작업,
tool/extension 또는 알 수 없는 작업이 있으면 partial을 유지하며,
기존 승인·안전 동작은 계속 활성화되어야 합니다.
검토한 자식 경로는 `fork_turns: "none"`인 직접 V2
`collaboration.spawn_agent` 호출입니다. code-mode 실행, 이력 fork, 재개된 member는
partial로 남으며 모델의 기본 도구 모드가 이 경로를 검증하지는 않습니다.
누락된 token detail은 0이 아니며, 정산되지 않은 dispatch 시도는 unresolved로 남습니다.

소유 launcher는 등록된 미사용 작업을 직접 시작합니다. 이미 active인 작업의
launch는 작업 구간만 만듭니다. 성공한 프로세스 retirement가 작업을 최종 판정하지는
않으며, 이후 snapshot에서 작업 전체 범위를 입증하려면 사람이 최종 판정해야 합니다.
계측 실행은 builtin OpenAI provider를 override하지 않고 HTTP를 선택하며
다른 transport는 미검증 상태로 유지합니다.
native analytics와 log/trace/metrics exporter는 해당 실행에만 비활성화합니다.
전역 설정과 기존 승인·sandbox 정책은 변경하지 않습니다.

### 정확한 build 검증과 launch

Node 24, macOS arm64, 정확히 인정된 Rust 1.95.0 toolchain과 다운로드·Git object가
채워진 Cargo cache를 사용합니다. local checkout은 profile이 고정한 commit에
배포된 `native/instrumented-codex-01621.patch`를 적용한 상태여야 하며 다른 변경은
허용하지 않습니다. qualifier는 source를 직접 재구성하고 새로운 locked offline build를
소유하며, caller의 profile·판정·실행 파일 hash 주장을 받지 않습니다.
실행 전 compiler bytes를 인증하고 상위 디렉터리의 Cargo 설정을 거부하며,
receiver·build 입력이 바뀌면 identity를 발급하지 않습니다.

합성 경로를 교체하여 location만 담은 JSON 파일을 만드세요.

```json
{
  "checkout_path": "/absolute/reviewed/codex-source",
  "toolchain_path": "/absolute/reviewed/rust-1.95.0-aarch64-apple-darwin",
  "cargo_home_path": "/absolute/reviewed/cargo-cache",
  "build_root_path": "/private/tmp"
}
```

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite instrumented-codex qualify \
  --locations locations.json
```

qualification은 loopback networking만 허용한 통제된 합성 native 시나리오를 실행한 뒤
불변 build identity를 저장하고 정확한 binary 경로를 출력합니다.
유료 모델 요청은 하지 않습니다. 중단 시 소유 process group을 종료하고 실패한
임시 build를 제거합니다.

launch 전에 프로젝트·작업을 등록하고 필요한 작업 설정을 확인하세요.
발급된 identity·경로와 작업의 현재 generation을 사용합니다.

```json
{
  "schema_version": 1,
  "run_id": "instrumented-run-1",
  "project_id": "synthetic-project",
  "task_id": "synthetic-task",
  "task_generation": 0,
  "build_identity_id": "issued-build-identity",
  "binary_path": "/absolute/issued/build/codex",
  "price_table_id": "registered-prices",
  "duration_ms": 900000,
  "termination_grace_ms": 1000
}
```

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite instrumented-codex launch \
  --execution execution.json
```

이 command는 소유 native 모델 실행을 시작하며 stdin/stdout을 그대로 연결합니다.
fd3의 metadata만 측정 저장소에 들어갑니다. 실제 실행 파일을 다시 hashing하며,
무관한 binary·변경된 파일·일반 binding qualification은 이 gate를 통과하지 못합니다.
실행 시간은 종료 제한이지 청구액의 hard bound가 아닙니다.
누락 counter·미검증 작업·불완전한 가격 coverage가 있으면 완전한 금액을 제공하지
않습니다. 가격은 표준화된 추정이며 vendor 청구의 증명이 아닙니다.

receiver가 family seal을 확정한 뒤 `run-1`을 해당 run ID로 교체하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table snapshot-instrumented run-1 \
  --id instrumented-input-1 --valuation-id instrumented-value-1 --cutoff "$reportCutoff"
```

이 command는 정확한 seal·metadata를 고정하고 run의 원래 불변 가격 pin으로 계산합니다.
모델 요청을 시작하지 않습니다. seal의 영속 commit보다 이른 cutoff는
그 seal을 이전 시점의 증거로 사용할 수 없습니다.
검증된 launcher 증거가 없으면 `source_unverified_partial_amount`를 따로 표시하고
`partial_amount`, `complete_window_amount`, `complete_amount`는 null로 유지합니다.

| 필드 | 뜻 |
| --- | --- |
| `coverage_scope: work_window` | 논리 작업 전체가 아닌 봉인된 정산 구간 |
| `complete_window_amount` | 필요한 사용량·가격 사실을 모두 입증했을 때만 제공 |
| `complete_amount` | 작업 전체 범위, 소유 producer의 retirement와 사람의 최종 판정이 있어야 제공 |
| `source_snapshot_hash` | 재평가에서도 유지되는 불변 seal·metadata 식별값 |

깨끗하게 끝난 turn이나 완전한 여러 구간의 합계로 이전 작업·제외 공백을 지울 수 없습니다.
functional pilot은 여전히 추론적 도입 결과를 제공하지 않습니다.
같은 저장 증거를 정확히 재평가하려면 이미 등록된 새 가격표를 선택하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table reprice-instrumented instrumented-input-1 \
  --id instrumented-value-2 --price-table prices-2
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table instrumented-valuation instrumented-value-1
```

원래 가격표·snapshot·평가 결과는 그대로 유지합니다. 새 가격으로 사용량 누락을
고치거나 실제 청구를 입증할 수 없습니다. 삭제는 종속 snapshot·평가 결과를 제거하고
다시 복구되지 않도록 막습니다.

## 출처와 검증 참조

JSON은 가격표 내용/hash, 중복 제거된 사용량 hash, 공식 `decimal160-disjoint-v1`, 보고서 버전 `observed-cost-v1`, 입력 가정을 포함합니다.
경계·이벤트/세션 수·가정 입력 수·누락/미가격 이유도 포함합니다.
금액은 decimal 문자열이며 반올림은 표시에만 적용합니다.
관측 테이블·공백 이유·버전 구간 정책은 observation-window hash에 포함됩니다.
coverage hash는 적격 이벤트·journal 메타데이터·가격·가정을 묶으며 source 경로를 반환하지 않습니다.

개발자 산술/보고서 검증은 [CONTRIBUTING](../../CONTRIBUTING.md#observed-cost-verification)에 있습니다.
합성 fixture 검증이며 production 완전성이나 실제 실험 효과를 입증하지 않습니다.
