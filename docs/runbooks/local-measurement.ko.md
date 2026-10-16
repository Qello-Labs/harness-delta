# 로컬 측정 사용 안내

기존 generic 파일 수집 경로입니다. 처음 배정된 A/B 작업은
[작업 절차](workflow-quickstart.ko.md)를 사용하세요.

0.158.0과 후속 후보 버전의 개발 검증은 [정확한 버전 admission](codex-version-admission.md)을 참고하세요.

브라우저 UI의 일반 Claude 관측은 정확한 원본·binary 조건에서 일반 사용이 허용되는
별도 경로이며, native 지원 검증은 대기 상태입니다. pilot 플래그는 필요하지 않습니다.
[Harness Connect](harness-connect.ko.md#일반-claude-관측-지원-검증-대기)를 참고하세요.
이 수집기의 버전, trust 상태와 제한은 바뀌지 않습니다.


[English](local-measurement.md)

Node.js 24 또는 26이 필요합니다. `npm ci && npm run build`로 빌드한 뒤 저장소에서
`node dist/cli.js`를 실행하세요. 로컬 패키지를 설치했다면 `hm`을 사용할 수도 있습니다.
설치만으로 수집이 시작되지는 않습니다. 현재 버전은 **부분 관측값**을 제공하며,
작업 전체 사용량이나 도입 여부를 판단할 수 있는 단계는 아닙니다.
자세한 범위는 [지원 현황과 제한](../decisions/001-adapter-capabilities.md)을 참고하세요.

## 프로젝트·작업 등록과 세션 연결

작업을 시작하기 전에 식별자와 고정된 완료 조건 ID를 정하세요. 식별자에는 개인 정보나
작업 내용을 넣지 마세요. 프로젝트 루트와 로그 파일 경로는 로컬 설정으로만 저장되며
보고서에는 포함되지 않습니다. 아래 경로, 모델, 세션 ID와 버전은 측정할 전용 세션의
실제 값으로 바꿔야 합니다.

```sh
node dist/cli.js --db local.db project add project1 --root /path/to/project
node dist/cli.js --db local.db task register task1 --project project1 --type feature --size small --assignee user1 --product codex --model MODEL_ID --criteria criterion1
node dist/cli.js --db local.db task start task1
node dist/cli.js --db local.db session link SESSION_ID --task task1 --source /path/to/exact-session.jsonl --product codex --version 0.156.1
node dist/cli.js --db local.db collect --task task1
```

`--version`에는 실제 제품 버전을 입력하세요. 등록된 정확한 버전 또는 해당 파일 원본의
명시된 호환성 범위 안에 있는 안정 릴리스를 사용할 수 있습니다. 조건부 재사용은
미검증 상태를 유지합니다. 아래 버전 제어 절차를 확인하세요.

등록된 프로젝트인지, 작업이 활성 상태인지 확인한 뒤 명시적으로 연결한 파일만 읽습니다.
전체 세션 로그를 자동으로 검색하지 않습니다. 첫 수집에서는 이후 측정을 위한 기준점을 잡습니다.
**수집을 시작한 다음 새 프롬프트 또는 턴을 시작하세요.** 수집 시작·재시작·재개 시점에
이미 진행 중이던 턴은 나중에 도착한 도구 완료 기록까지 포함해 집계에서 제외됩니다.

작업하는 동안 수집 명령을 실행 상태로 유지하세요. Ctrl-C 또는 SIGTERM으로 종료하면
백그라운드 수집도 남지 않습니다. `--once`는 기준점만 잡고 종료합니다. 이를 반복 실행해도
실행 사이에 발생한 사용량은 측정되지 않습니다.

다른 터미널에서 같은 DB를 지정해 일시정지하거나 재개할 수 있습니다.

```sh
node dist/cli.js --db local.db task pause task1
node dist/cli.js --db local.db task resume task1
```

재개 후 첫 수집에서 새 기준점을 잡습니다. 수집 중단이나 재시작으로 빠진 구간은
자동으로 보충하지 않습니다. 마지막 로그 이벤트가 도착하고 수집된 것을 확인한 뒤
작업 결과를 최종 확정하세요.

## 완료 평가·보고서·삭제

아래는 첫 완료 평가에서 실패한 뒤 재작업을 거쳐 최종 성공으로 확정하는 예입니다.

```sh
node dist/cli.js --db local.db task first-complete task1
node dist/cli.js --db local.db task assess-first task1 --result failed
node dist/cli.js --db local.db task rework task1
node dist/cli.js --db local.db task finalize task1 --outcome success --met criterion1
node dist/cli.js --db local.db report task task1 --cutoff 2030-01-02T12:00:00Z --format json
node dist/cli.js --db local.db delete task task1
```

`--cutoff`에는 예시 날짜 대신 실제 보고 기준시각을 UTC로 입력하세요.
사람이 결과와 완료 조건 충족 여부를 명시적으로 평가해야 합니다. 테스트 통과만으로
작업이 자동 확정되지는 않습니다. 최종 확정한 결과는 변경할 수 없으며, 새로운 요구사항은
새 작업으로 등록합니다.

보고서에는 관측된 토큰 구성과 부분 합계, 결과, 재작업, 경과시간·활성시간,
확인된 명령/Bash 실행이 표시됩니다. 캐시 입력은 정규화된 전체 입력에 이미 포함되어
있으므로 다시 더하지 마세요. 지원되지 않는 작업 전체 합계, 일반적인 도구 실패 수,
모델 실행시간, 비용, 검색·파일 읽기 분류, 중복 읽기, 컨텍스트 확장,
최초 편집·테스트·자동 성공 판정 시각은 `null`로 남습니다.
값이 없다는 뜻과 0은 다릅니다. 수집 범위에 속하는 첫 명시적 Codex 누적 0은
보존하지만, 값이 바뀌지 않은 누적 알림의 반복은 새 관측이 아닙니다. 기준점과
불확실한 구간의 제외 규칙은 그대로 적용됩니다. Claude 메시지가 재전송돼도
원래 귀속을 유지하며, 상충하는 메타데이터는 오류입니다.
로컬 수집기 인터페이스와 한계는
[진단 범주](../decisions/003-local-observation-contract.md#collector-failure-diagnostics)를 참고하세요.

보존 기간은 직접 설정해야 합니다. 다음 예는 최종 확정 후 30일이 지난 작업을 정리합니다.
활성 작업은 유지됩니다.

```sh
node dist/cli.js --db local.db retention set project1 --days 30
node dist/cli.js --db local.db retention apply project1
node dist/cli.js --db local.db delete project project1
```

마지막 명령은 프로젝트와 그 작업·관련 데이터를 삭제합니다. 삭제 표식(tombstone)이
남아 같은 식별자의 재사용을 막습니다. 이미 생성한 보고서 파일과 제품의 원본 세션 로그는
로컬 DB 삭제 대상이 아닙니다. 별도의 [합성 파일 교환](team-file-exchange.ko.md)은 삭제 통지와 tombstone을
사용합니다. 실제 데이터 공유와 중앙 동기화는 제공하지 않습니다.

## 관찰 기간 비교 사전 등록

[기간 설정 예제](../../examples/period.json)를 복사한 뒤 미래의 비교 기간과 모든 대상 조건을
설정하세요. 첫 번째 기간이 시작되기 전에 등록해야 합니다.

```sh
node dist/cli.js --db local.db period register --config period.json
node dist/cli.js --db local.db report period period1 --cutoff 2030-03-01T00:00:00Z --format markdown
```

설정에는 버전이 기록되며 등록 후 변경할 수 없습니다. 비교 대상은 완료일이 아니라
작업 시작시각이 `[start,end)`에 속하는지로 정합니다. 시작 경계는 포함하고 종료 경계는
제외합니다. 각 작업을 지정한 시간 동안 추적하며, 작업별 추적 종료 이후의 결과는 제외합니다.
두 번째 모집 기간과 추적 기간이 모두 끝나기 전까지 보고서는 잠정 결과입니다.

작업 구성과 모든 대상 작업의 결과를 함께 표시하며, 실패·중단·사용량 누락도 남깁니다.
관측이 부분적이면 전체 사용량 평균과 변화율은 제공하지 않습니다. 기간 차이만으로
인과관계나 절감 효과를 확정할 수 없습니다.

JSON과 Markdown에는 같은 데이터 스냅샷과 메타데이터만으로 계산한 지문이 담깁니다.
DB 데이터·설정·보고 기준시각이 같으면 같은 기간 보고서를 재현할 수 있습니다.
삭제나 새 데이터 입력 후에도 이전 결과가 필요하다면 생성한 보고서를 별도로 보관하세요.

## 버전, 적합성 확인, 업데이트 제어

2026-10-08 구현: [ADR 013](../decisions/013-forward-version-compatibility.md)에 따라
명시된 유한 범위의 안정 릴리스에 기존 파서를 자동으로 조건부 재사용합니다.
파일 수집은 Codex 0.158.0 이후 0.164.0 미만 버전에 0.158.0 파서를 사용하고,
Claude Code 2.1.283 이후 2.2.0 미만 버전에 2.1.283 파서를 사용합니다.
2026-10-16 UTC에 확인한 안정 버전 Codex CLI 0.163.0과 Claude Code 2.1.301은 기본적으로
`compatibility_unverified` 신뢰 상태로 등록됩니다. 등록된 정확한 버전은 검증 상태를
유지합니다. 사전 릴리스, 접미사, 등록되지 않은 이전 버전, 범위 밖 릴리스는
원본 접근 전에 거부됩니다.

이는 기존 파서 선택이며 새로운 정확 버전 admission이나 실제 바이너리 qualification이
아닙니다. Codex minor 전환과 Claude 수집 계약의 미확인 부분은 지원 확장 전에
대상 바이너리 적합성 검증이 필요합니다. 일반 세션 연결은 별도의 정확 버전 조건을
유지합니다. [Harness Connect](harness-connect.ko.md)를 확인하세요.

별도 Codex 0.163.0 제한 일반 binding profile은 2026-10-16 native 검증을 통과했습니다.
정확한 binding provenance로 이 파일·workflow 추정값이나 과거 관측을 승격하지 않으며,
수집과 비용은 여전히 부분 범위입니다.

Codex 0.163.0의 누적 합계에는 완료되지 않은 응답의 사용량도 포함될 수 있습니다.
대상 적합성 검증으로 변경된 집계 경계를 확인하기 전에는 이 미검증 추정값을
0.162.x 집단과 직접 비교하지 마세요.

사용량 기록은 실제 제품 버전, 파서/프로필, 규칙 리비전을 보존합니다.
작업 보고서는 미검증 토큰을 `usage.compatibility_unverified`에 표시합니다.
`usage.partial_tokens`에는 검증된 관측만 포함됩니다. 원본 출처 정보가 없는 과거
native 사용량은 `usage.legacy_unverified`에 표시됩니다. 비용 보고서는
`compatibility_unverified_partial_amount`와 `legacy_unverified_partial_amount`를
분리합니다. 모든 관측이 미검증인 작업의 검증된 합계는 0이 아닌 null입니다.
모든 데이터는 부분 관측을 유지합니다.

```sh
node dist/cli.js --db ./local.db compatibility status
node dist/cli.js --db ./local.db compatibility inspect --product codex --version 0.163.0 --source file
node dist/cli.js --db ./local.db compatibility inspect --product claude_code --version 2.1.301 --source file
node dist/cli.js --db ./local.db compatibility invalidate --product codex --version 0.163.0 --source file --reason semantic_incompatibility
```

예상 결과: inspect는 실제 버전, 선택된 파서, 신뢰 상태를 반환합니다. invalidate는
`invalidated`를 반환합니다. 필수 계약 검증에 실패하면 해당 버전/원본 집단을 차단하고,
추가 읽기를 중지하며, 이후 보고서와 가격 재평가에서 기존 추정값도 제외합니다.
차단은 재시작 후에도 유지됩니다. 진단에는 고정된 메타데이터 범주만 사용합니다.
영향을 받은 내보내기 스냅샷은 신뢰할 수 없는 상태로 보존하세요. 로컬 무효화는
외부 사본을 회수하지 못합니다. 차단을 해제하기 전에 합성 재현, 의미가 바뀐 경우
검토된 명명 파서 변형, 집중 테스트, 전체 검증이 필요합니다.
자동 또는 사용자용 차단 해제 단축 경로는 없습니다.

등록된 정확한 파일 어댑터도 부분 관측입니다. Codex CLI 0.156.1/0.158.0과
Claude Code 2.1.283이 해당됩니다. Codex 0.158.0은 M2 경계 안의 순차적 부분 사용량을
다룹니다. [ADR 007](../decisions/007-adapter-version-profiles.md)을 확인하세요.
파일 호환성은 native 실행을 허용하지 않습니다.
[native 작업 안내](task-native-workflow.md)의 별도 작업 흐름 범위를 사용하세요.

개발자 적합성 확인·정확한 버전 등록·native 업데이트 제어는
[admission 절차](codex-version-admission.md)를 사용하세요. 별도 승인이 필요한
수동 검증이며 설치나 수집 중 자동으로 실행되지 않습니다.

## 오류 복구와 제한

오류는 고정된 코드로 표시합니다. 원본 파일 식별 변경·잘림, 범위·버전 불일치,
상충하는 메타데이터, 카운터 초기화, 지원되지 않는 세션 관계가 발견되면 불확실한
수집 묶음을 제외합니다. Claude 파일이 안정된 상태에서 같은 크기로 수정된 경우,
검증한 측정 메타데이터가 같을 때만 기준점을 유지합니다. 사용량·출처·모델·시각·
인식된 도구 ID가 바뀌면 수집을 거부합니다. 이는 원본 내용 전체가 같다는 증거가 아닙니다.
이전 관측값은 부분 관측으로 남습니다.
명시적인 연결 정보를 바로잡고 다시 시작하면 새 기준점을 잡으며 과거 데이터를 가져오지 않습니다.

초기 구현은 16 MiB를 넘는 원본 파일을 지원하지 않습니다. 매 수집 주기마다 허용된 파일의
크기가 제한된 스냅샷을 읽는 방식이며, 무제한 크기의 운영 로그를 계속 추적하는 수집기는 아닙니다.

`npm run check`로 CLI 흐름, 민감 정보 대체 문자열의 유출 방지, 트랜잭션 롤백,
일시정지·재시작, 보고서에 대한 합성 인수 테스트를 실행할 수 있습니다.
이 일반 수집기의 검증 범위는 macOS arm64, Codex CLI 0.156.1/0.158.0, Claude Code 2.1.283입니다.
앱 세션, 부모·자식 세션의 완전한 합산, 0이 아닌 추론 토큰의 의미, 다른 버전과 플랫폼은
별도 검증이 필요합니다. 이 일반 수집기로 실제 실험이나 통계적 추론을 통한 도입 결정을 하지 마세요.

V2 자유 모델 workflow·명시적 가격·독립 게이트는 [작업 절차](workflow-quickstart.ko.md)를 참고하세요.
별도 Codex 0.160.0 workflow의 부분 수집 승인은 일반 수집기의 정확한 admission이나 조건부 파서 규칙을 바꾸지 않습니다.
전체 비용과 추론은 제공하지 않습니다.
