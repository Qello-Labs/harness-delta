# Synthetic 메타데이터 파일 교환

기능 파일럿·실제 팀 데이터는 이 교환 경로에서 미지원입니다. 먼저 저장소를 빌드하세요.
아래 명령은 `node dist/cli.js`와 명시적 DB를 사용합니다.

[영문 절차](team-file-exchange.md), [공유 계약](../decisions/011-team-file-exchange.md),
[작업 비교 절차](task-comparison.ko.md)를 참고하세요. 오프라인 synthetic 검증이며,
실제 실험 활성화나 전체 사용량 측정을 뜻하지 않습니다.

1. 새 전용 저장소에 프로젝트와 완전한 synthetic 프로토콜을 등록·동결합니다.
   작업 생성 전에 아래 source.json 예시로 공유 설정을 등록합니다.

```json
{"schema_version":1,"namespace_id":"11111111-1111-4111-8111-111111111111","local_project_id":"project-1","shared_project_id":"22222222-2222-4222-8222-222222222222","protocol_id":"comparison-1","owned_strata":["stratum-1"]}
```

```sh
node dist/cli.js --db source.db exchange source register --config source.json
```

2. 기존 synthetic 작업 배정·평가 절차로 고정 스냅샷을 만들고 내보냅니다.

```sh
node dist/cli.js --db source.db exchange export --protocol comparison-1 --snapshot report-1 --id 33333333-3333-4333-8333-333333333333 --out package.json
```

재시도에는 같은 package UUID를 사용합니다. 다른 내용의 기존 파일은 덮어쓰지
않습니다. 최초 내보내기 뒤 alias 추가는 identity_sealed로 거부됩니다.
실제 identity 충돌은 계속 탐지하며 비교 전체를 무효화합니다.

3. 작업·프로젝트 삭제 또는 원본 identity 충돌 뒤 삭제 통지를 내보냅니다.

```sh
node dist/cli.js --db source.db exchange export-deletions --namespace 11111111-1111-4111-8111-111111111111 --id 44444444-4444-4444-8444-444444444444 --out deletion.json
```

프로젝트 삭제 뒤에도 가능합니다. 이전에 내보낸 파일을 원격으로 삭제하지 않으며,
자동 전송도 없습니다. 삭제 표식을 지우거나 새 namespace로 과거 자료를 복구하지
마세요. 원본 보존기간은 기존 retention 명령으로 명시적으로 설정해야 하며 기본값은 없습니다.

source_scope_not_empty는 과거 자료가 있는 저장소의 도입을 지원하지 않는다는 뜻입니다.
export_invalidated이면 새 자료 ID로 우회하지 말고 삭제 통지를 사용하세요.
invalid_exchange_package는 비공개·알 수 없는 필드나 잘못된 형식을 내용 노출 없이
거부합니다. 파일·DB 오류에도 실제 경로나 입력 내용은 출력하지 않습니다.

삭제 통지를 적용하기 전에 팀 보고서를 만드세요. 비교 무효화는 되돌릴 수 없습니다.

## 가져오기와 로컬 삭제

`node dist/cli.js --db team.db project add destination --root .`로 수신 프로젝트를 등록합니다.
검토한 프로토콜·variant와 예상 writer를 확인하고, 빌드된 저장소에서
네트워크 없이 다음 명령으로 canonical digest를 계산하세요.

```sh
node --input-type=module -e 'import {readExchangeFile} from "./dist/exchange/files.js"; import {parseExchangePackage,protocolDigest} from "./dist/exchange/contracts.js"; const p=parseExchangePackage(readExchangeFile("package.json")); if(p.kind!=="assignment_metadata")throw Error("data_required"); console.log(protocolDigest(p));'
```

다음 mapping.json의 `REPLACE_WITH_REVIEWED_DIGEST`를 실제 64자리 값으로 바꾸세요.

```json
{"schema_version":1,"shared_project_id":"22222222-2222-4222-8222-222222222222","local_project_id":"destination","protocol_id":"comparison-1","protocol_digest":"REPLACE_WITH_REVIEWED_DIGEST","writers":[{"namespace_id":"11111111-1111-4111-8111-111111111111","stratum_id":"stratum-1","allocator_id":"allocator-1"}]}
```

파일이 아직 없는 writer를 포함해 모든 stratum의 writer를 선언하세요.
namespace는 발신자 인증 수단이 아니며 신뢰한 교환 경로의 파일만 받으세요.

```sh
node dist/cli.js --db team.db exchange mapping register --config mapping.json
node dist/cli.js --db team.db exchange import --file package.json --project destination
node dist/cli.js --db team.db exchange import --file package.json --project destination
```

두 번째 가져오기는 replayed이며 사용량을 더하지 않습니다. 삭제·identity 충돌은
해당 비교의 가져온 자료 전체와 보고서를 제거합니다. 남은 arm 합계도 복구하지 않습니다.
등록된 writer 누구나 해당 비교 무효화 또는 공유 프로젝트 삭제 통지를 보낼 수 있습니다.
오프라인 파일로 실제 발신자나 팀 완전성을 증명하지 않습니다.

유효한 삭제와 거부할 일반 자료가 섞이면 deletions_applied_data_rejected와 실패 종료 코드를
반환하지만 삭제는 적용됩니다. 저장소 쓰기 실패 시에는 전체 트랜잭션을 취소합니다.

```sh
node dist/cli.js --db team.db exchange delete-task --project destination --shared-project 22222222-2222-4222-8222-222222222222 --task task-1
node dist/cli.js --db team.db exchange retention set --project destination --shared-project 22222222-2222-4222-8222-222222222222 --days 30
node dist/cli.js --db team.db exchange retention apply --project destination --shared-project 22222222-2222-4222-8222-222222222222
```

가져온 자료의 보존기간은 원본과 별도로 명시합니다. 확인된 finalized_at이 기간을 넘으면
그 작업이 속한 비교 전체를 제거합니다. 누락·미완료 시각을 추정하여 만료시키지 않습니다.
로컬 수신 삭제는 원본 writer의 통지로 재전송되지 않습니다. 원본 삭제와 통지 전달은
별도로 수행하세요. 같은 ID의 원본 로컬 작업은 개별 imported 삭제의 대상이 아닙니다.
`delete project destination`은 연결된 imported 자료도 삭제합니다.

deleted_identifier를 새 package UUID로 우회하지 마세요. authority_conflict,
mapping_conflict, protocol_conflict, identity_conflict, assignment_conflict,
evidence_conflict, package_conflict, stale_revision은 원본·설정을 확인하거나 비교를
중단해야 한다는 뜻입니다. 강제 가져오기·writer 교체·삭제 표식 초기화 명령은 없습니다.

## 팀 보고서 고정과 조회

가능한 writer 파일을 가져온 다음 team-snapshot.json을 만듭니다.

```json
{"schema_version":1,"snapshot_id":"team-report-1","local_project_id":"destination","shared_project_id":"22222222-2222-4222-8222-222222222222","protocol_id":"comparison-1","cutoff":"2026-01-03T00:00:00.000Z","as_of":"2026-10-01T12:00:00.000Z","required_namespaces":["11111111-1111-4111-8111-111111111111"]}
```

cutoff는 모든 원본 파일의 공통 시각으로, as_of는 가져오기가 끝난 뒤부터 현재까지의
UTC 시각으로 바꾸세요. required_namespaces에는 파일이 아직 없는 writer도 포함해
mapping의 전체 목록을 넣습니다. 두 번째 stratum을 다른 원본이 맡으면 mapping과
이 목록에 writer를 추가합니다. 각 원본에는 자신이 맡은 strata만 등록하되,
전체 프로토콜·variant 설정과 검토한 digest는 동일해야 합니다.

```sh
node dist/cli.js --db team.db team snapshot create --config team-snapshot.json
node dist/cli.js --db team.db team report team-report-1 --format json
node dist/cli.js --db team.db team report team-report-1 --format markdown
node dist/cli.js --db team.db team report team-report-1 --format markdown-readable
```

`json`이 기본값입니다. 기존 `json`·`markdown` 출력과 고정 스냅샷 바이트는
바뀌지 않습니다. V1의 `markdown-readable`은 기존 스냅샷의 원래 가져온 그룹,
성분별 관측 작업 수, 품질, 재작업, 추적 기간, 설정 이탈과 source revision vector를
표로 표시합니다. 추가 측정이나 집계를 하지 않습니다. 관측 상태 수는 이벤트 수이며,
성분별 관측 수는 해당 값이 관측된 작업 수입니다. V2 `markdown-readable`은
현재 이 표 대신 보고서를 JSON 블록으로 표시합니다.

같은 ID·요청은 같은 고정 결과를 반환합니다. 갱신된 자료에는 새 snapshot ID가 필요합니다.
cutoff_mismatch이면 원본에서 공통 cutoff로 다시 스냅샷을 만드세요.
snapshot_as_of_unavailable은 현재 자료가 as_of 뒤에 도착했다는 뜻입니다. 더 늦은
시각을 지정하거나 이전에 저장한 보고서를 읽으세요. 버린 과거 상태를 재구성하지 않습니다.
missing_exchange_data이면 writer 파일이 하나 이상 필요합니다. 과제가 0개인 파일은 가능합니다.
report_conflict는 같은 ID의 요청이 다르다는 뜻이고 invalidated_report는 초기화할 수 없습니다.

source_vector와 원본 평가·identity 포착 시각, received_at, cutoff, as_of, merged revision을
함께 확인하세요. 선언한 writer가 모두 도착해도 팀 완전성은 unverified입니다.
누락 writer를 과제 0개로 계산하지 않고 전체 팀 분모는 null로 둡니다. 기술통계에는
미시작·추적 대기 과제를 포함한 모든 가져온 원래 배정이 들어갑니다. 관측된 0과
missing·excluded·error·unmeasurable을 구별하며 cached/reasoning 부분집합을 다시 더하지 않습니다.
부분 토큰 분포는 별도의 관측 분모를 가지며 전체 비용·절감을 추정하지 않습니다.
미배정 등록 활동은 공유하지 않아 집계할 수 없고 추론·채택 판단은 활성화되지 않습니다.

삭제 뒤에는 통지를 직접 전달하고 가져오세요.

```sh
node dist/cli.js --db team.db exchange import --file deletion.json --project destination
node dist/cli.js --db team.db team report team-report-1 --format json
```

보고서는 과거 과제·합계·입력·hash·출처를 제거한 무효화 표식만 반환합니다.
비교에 속한 모든 writer가 대상입니다. 수신 측 개별 삭제·보존기간·프로젝트 삭제도
같은 경로를 사용하며 오래된 파일이나 새 package/snapshot ID로 복구할 수 없습니다.

## 재현 가능한 오프라인 검증

Node 24 또는 26 저장소에서 npm ci를 실행한 뒤:

```sh
npm test -- tests/exchange-boundaries.test.ts tests/team-report.test.ts tests/team-snapshot.test.ts tests/team-deletion.test.ts tests/team-exchange-cli.test.ts
npm run check
```

테스트 전용 tests/helpers/team-fixture.ts는 서로 다른 참여자·환경·stratum의 합성 원본
두 개와 A/B 과제 8개를 등록합니다. 기존 API로 설정 확인·작업 시작·사람의 결과 평가를
수행합니다. 합성 session 연결과 usage는 저장소 테스트 경계에서만 삽입합니다.
실제 session 파일을 읽거나 collector를 실행하지 않으며 일반 주입 CLI나 실험 우회는 없습니다.
공개 CLI 테스트는 내보내기·가져오기·재시도·스냅샷·JSON/Markdown·삭제·재시작·오래된 파일
거부를 검사합니다. 별도 테스트로 원본 충돌 전파, 프로젝트 삭제, 보존기간 경계,
rollback과 SQLite 두 연결 경쟁을 확인합니다.

기대값은 전체 8개(arm별 4개), 성공 3·실패 2·중단 1·미시작 1·결과 누락 1입니다.
부분 사용량 과제 6개, 사용량 누락 2개이며 입력+출력이 모두 관측된 부분 합은
[0, 2, 4, 10], 평균 4입니다. 합성 검증값이며 개선 효과나 추론 결과가 아닙니다.
기존 로컬 보고서의 저장 출력 호환성도 유지합니다.
