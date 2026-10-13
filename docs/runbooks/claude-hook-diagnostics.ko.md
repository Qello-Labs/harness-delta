# Claude 훅 기록기 진단

[English](claude-hook-diagnostics.md)

선택적 진단 모드로 생명주기 입력 거절과 receipt 저장 실패를 구분합니다.
이 모드는 소스 허용, 훅 설치, 수집 시작 또는 자식의 종료·전체 카운터 전달을
입증하지 않습니다. 기본 훅 명령은 조용히 실행됩니다. 기존 receipt 스키마와
identity, 프로젝트, 프로세스, 소스 경로, 삭제 및 버전 검증을 유지합니다.

## 증거 범위

현재 [공식 훅 문서](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents)는
호출한 skill의 훅이 세션 동안 유지된다고 설명합니다.
[SubagentStop 입력](https://code.claude.com/docs/en/hooks#subagentstop-input)은
메인 세션과 자식 transcript 경로를 구분합니다.
[환경 변수 문서](https://code.claude.com/docs/en/env-vars)는 훅 명령의
`CLAUDE_PID`를 설명합니다. 이 문서는 기대 계약이며 정확한 버전의 native
검증 결과가 아닙니다. 종료 receipt 누락만으로 호출 누락, 입력 오류, 저장 실패,
관측 시점을 구분할 수 없습니다. 시작 receipt는 가족 발견에 사용될 수 있습니다.
종료 증거 부재는 사용량 0 또는 자식의 실행·실패·완료를 뜻하지 않습니다.

## 명시적 활성화 명령

실제 계측을 변경하기 전에 정확한 프로젝트, 새 활성 작업, 연결된 루트 세션,
설치된 훅 바이트와 제한된 native 행동을 승인받습니다. 완료된 시험과 receipt를
보존합니다. 설치, 재로드, trust/auth/전역 설정 변경, native 프로세스 시작 또는
종료를 자동으로 실행하지 않습니다. Node 24 또는 26을 선택합니다.

명시적으로 선택한 세션에 대해 승인된 훅 명령에 다음 옵션을 추가합니다.

```sh
node <skill-dir>/scripts/claude-session-hook.mjs record --diagnostics-session <selected-session-uuid>
```

유효한 다른 세션은 진단을 출력하지 않습니다. 잘못된 identity 또는 해석할 수
없는 stdin은 명시적으로 범위를 정한 호출에서 내용 없는 이유를 출력할 수
있습니다. 이 경우 세션 귀속은 확인할 수 없습니다. 선택하지 않은 이벤트와
관련 없는 Bash 명령은 조용히 실행됩니다. 잘못된 진단 세션 선택은 진단 출력을
비활성화합니다. 이 옵션은 진단만 필터링하며 일반 receipt 기록을 필터링하거나
확장하지 않습니다. 승인된 사용자 행동으로 native 시험을 제한하고 자동 시간
제한이나 kill을 사용하지 않습니다. stdin, 도구 payload 또는 native 디버그 로그를
리디렉션하거나 보관하지 않습니다.

stderr JSON 한 줄에는 `schema_version`, 고정 `kind`, `status`, `reason_code`만
포함합니다. 식별자, 경로, 시간, 프롬프트, 응답, 도구 명령, 카운터 또는 예외
상세를 포함하지 않습니다. stdout은 비어 있고 `record`는 0을 반환합니다. 예:

```json
{"schema_version":1,"kind":"subagent_stop","status":"rejected","reason_code":"agent_transcript_path_invalid"}
```

| 상태 | 의미 |
| --- | --- |
| `recorded` / `receipt_recorded` | 이번 호출이 receipt를 생성했습니다. 허용된 메타데이터를 별도로 확인합니다. |
| `ignored` / `receipt_exists` | 대상 경로가 이미 존재합니다. 내용 검증을 뜻하지 않습니다. |
| `ignored` / `session_forgotten` | 삭제 때문에 이벤트 기록을 억제했습니다. |
| `rejected` | 필수 입력이 잘못되어 receipt를 생성하지 않았습니다. |
| `error` / `receipt_write_failed` | receipt 저장에 실패했습니다. 원본 오류 상세는 출력하지 않습니다. |

거절 코드는 `session_id`, `claude_pid`, `transcript_path`, `cwd`, `tool_use_id`,
`agent_id`, `agent_transcript_path`에 `_invalid`를 붙입니다. 객체가 아닌 JSON은
`hook_input_invalid`, 잘못된 JSON은 `hook_input_invalid_json`, 4 MiB보다 큰
stdin은 `hook_input_too_large`입니다. 해석할 수 없는 stdin의 `kind`는 `null`입니다.
진단이 없으면 훅 로딩·호출과 명령 시작 여부는 여전히 확인되지 않습니다.
이 경계는 별도로 승인된 메타데이터 관측으로만 확인합니다.

## 비공개 자식 관계 거절 진단

별도로 승인된 Claude human-pilot 관측기는 이미 연결되어 관측 중인 시도의
자식 발견 또는 허용 검증이 실패하면 고정 진단을 남깁니다. 저장 파일은
`<private-ui-metadata-file>.family-diagnostics.jsonl`이며 측정 데이터, 공개 응답,
보고서와 내보내기에서 분리됩니다. 준비, 일반 모드, Codex 파일럿 또는 비활성·
미연결 시도에서는 기록하지 않습니다. 소스·provider 추가 읽기, 재실행, 자식
허용 또는 native 행동을 추가하지 않습니다.

Provider 사유를 공통 gap 코드로 합치기 전에 보존합니다. 공개 오류와 기존
자동 일시정지는 유지합니다. 일시정지 전에 선택한 프로젝트·태스크·루트와
generation의 적격성을 확인하고 해당 거절만 정지 후 기록할 수 있습니다.
저장 실패는 일시정지를 막거나 원래 거절을 바꾸거나 재시도를 발생시키지
않습니다. 과거 기록은 복원하지 않습니다.

엄격한 JSON 한 줄에는 버전, 서비스 단계, 정해진 사유 코드만 포함합니다.

```json
{"schema_version":1,"phase":"tick_discovery","reason_codes":["child_source_missing"]}
```

단계는 `baseline_discovery`, `baseline_relation`, `baseline_descendants`,
`tick_discovery`, `tick_relation`입니다. 사유 예시는 자식 receipt 불일치, 자식
소스 누락, 소유·관계 미확인과 기존 파일 생성 시각 검증의
`pilot_member_predates_root`입니다. 코드는 거절된 검증을 식별하며 근본 원인이나
Claude 내부 기능을 식별하지 않습니다. 알 수 없는 사유는 억제하고
`reason_codes: []`이면 원인은 미확인입니다. 식별자, 경로, 시간, 본문, 원본 오류
또는 환경 변수 덤프를 포함하지 않습니다. 누락은 사용량 0이나 허용 성공을
뜻하지 않습니다.

상위 디렉터리와 일반 파일은 소유자에게만 허용돼야 합니다. 심볼릭·하드 링크를
거절하며 협력하는 기록기는 최대 64줄·64 KiB로 제한됩니다. 전용 비공개
`.lock`의 배타적 생성으로 동시 기록의 한도 초과를 막습니다. 사용 중이거나
남아 있는 lock은 재시도 또는 다른 기록기의 lock 삭제 없이 기록을 건너뜁니다.
안전하지 않거나 손상·포화·사용 불가인 저장소도 조용히 건너뜁니다. 파일 부재는
거절이 없었다는 증거가 아닙니다. 이전 검증 기록을 보존하고 설치와 제한된
native 행동은 별도로 승인합니다. 오프라인 코드 검증은 기존 관측기 재시작,
재연결 또는 새 native 시험을 승인하지 않습니다.

## 제한된 Start 소스 준비 대기

유효한 Start receipt가 자식 transcript 생성보다 먼저 도착할 수 있습니다.
이미 승인된 Claude binding 작업에서는 연결된 루트 프로세스의 새 Start가
루트 identity 시각 이후에 기록된 경우, 예상 소스가 없거나 비어 있거나 완전한
행이 없으면 가족 전체의 측정을 보류할 수 있습니다. 이는 메타데이터 발견이며,
identity가 확인되지 않은 동안 사용량 본문 읽기나 cursor 저장은 수행하지
않습니다. 파일 존재만으로 대기를 해제하지 않습니다. 기존 경로, 소유권,
프로세스, 버전과 관계 검증을 통과해야 합니다.

대기는 원래 Start 시각부터 2초 후 만료됩니다. 가족 전체에 하나의 예산을
고정하고 단조 증가 시간으로 제한합니다. 반복 receipt, 추가로 대기하는 자식과
시계 역행은 제한을 늘리지 못합니다. 기한 이후 돌아온 검증 결과는 대기를
해제하지 못합니다. 안전하지 않거나 다른 세션의 증거, 오래되거나 미래인 증거,
다른 종결 gap과의 혼합, 소스가 없거나 확인되지 않은 Stop은 계속 거절하고
관측기를 일시정지합니다. `agent_type: null` 또는 파일 부재를 이유로 내부
이벤트를 제외하지 않습니다. 원인 미상 Stop의 기존 거절 정책을 유지합니다.

예산 안에 identity가 확인되면 가족의 모든 구성원에 대해 새 기준점을
설정합니다. 모든 기준점 갱신과 마지막 가족 검증이 끝난 뒤부터 측정을
진행합니다. 제외된 스냅샷은 `unobserved_interval`과 `incomplete` 관측 gap으로
표시하고 소급 수집하지 않습니다. 보수적인 gap이 이전 측정 행과 겹칠 수
있으며 기존 행은 보존합니다. 누락된 사용량은 누락 상태로 유지하고 비용
범위는 `partial`입니다. 연결, 재개와 tick은 순서대로 실행하며, 일시정지는
해당 generation에서 실행 중이거나 대기 중인 작업을 즉시 무효화합니다.
시간 만료는 고정 비공개 사유 `child_readiness_timeout`을 남길 수 있습니다.
이는 만료된 검증을 식별하며 Claude 내부 기능을 식별하지 않습니다.

이 동작은 synthetic 회귀 검사로 확인합니다. Native 버전 검증, 관측기 설치·
재시작, 중단된 시험 재개 또는 과거 Start/Stop 복원을 뜻하지 않습니다.
실제 적용과 새 사용자 실행 시험은 별도 작업입니다.

## 준비된 Start 대기 확인 계측

내부 `onChildReadiness`는 선택한 관측 중 Claude human pilot의 명시적 로컬 연결에만
적용됩니다. 일반 모드, 준비, Codex pilot, profile과 브라우저 요청은 활성화할 수
없습니다. 원래 가족 전체 대기에 진입한 뒤 `hold_entered`를 보내고, 모든 가족의
기준점·최종 검증·향후 gap과 경계 저장이 끝난 뒤에만 `rebaseline_complete`를
보냅니다. 같은 시도, 원래 receipt, 루트와 generation을 유지합니다. 진단 준비나
전달 실패는 미확인이며 원래 거절이나 수집 허용 조건을 바꾸지 않습니다.

`src/binding-readiness-probe.ts`의 `createReadinessProbeSink`와
`waitForReadinessProbeHold`는 선택적 비공개 제어 채널입니다. 정확히 하나의
Start를 위해 새 소유자 전용 디렉터리와 관측기 instance UUID를 사용합니다.
원래 receipt UUID, instance, 시도, generation과 원래 Start+2초 기한을 함께
확인합니다. 엄격한 marker에는 제어 토큰, generation, 단계, 경과·기한·경계
메타데이터만 있고 native 세션·자식 식별자, transcript 경로, 본문이나 사용량은
없습니다. 측정 데이터나 내보내기 진단이 아닙니다. 배타적 단일 사용 claim,
링크를 따르지 않는 소유자 전용 일반 파일·단일 hard link·디렉터리 신원 검사,
최대 8개 파일·파일당 2 KiB 한도로 재사용, 안전하지 않은 저장소와 다른 확인을
거절합니다. 이전 증거를 자동 삭제하거나 바꿔 재시도하지 않습니다.

자식 생명주기 이벤트에서 준비된 `scripts/claude-readiness-capture.mjs`는 stdin
전에 선택한 프로젝트·태스크와 관측 루트의 실제 프로세스 조상 관계 및 동일 generation을 검증하고,
일반 recorder 직전에도 재확인합니다. Connect는 등록·활성 프로젝트 조건을
사용합니다. 일반 recorder가 먼저 기록합니다. 새로
기록된 일치하는 Start만 확인을 기다리고 중복, Stop과 connect는 기다리지
않습니다. 매 확인에서 활성 태스크, generation, 동일한 루트 신원과 프로세스
조상 관계를 재검사합니다. 확인이 없거나 잘못되면 조용히 반환하고 고정
`hold_unverified` audit 코드를 남깁니다. 일치하는 대기는 `hold_acknowledged`입니다.
원문 stdin, 예외, 자식 stderr와 native debug를 보관하지 않습니다. 이는 wrapper의
조상 관계와 수집기 대기 진입 증거이며 native 훅 호출 자체의 인증은 아닙니다.

일반 recorder 반환부터 선택적 확인 작업 전체에 500ms 운영 기한을 적용합니다.
영수증·코드 검사, 모듈 로딩, 범위 재검사와 통신은 별도 소유 Node 확인 프로세스에서
실행합니다. 늦은 결과는 무시합니다. 기한이 지나면 이 확인 프로세스만 종료하고
종료 대기를 무한정 하지 않습니다. Claude나 연결된 루트에는 신호를 보내지
않습니다. 확인 프로세스의 출력은 제한되며 훅 stdout·stderr로 전달하지 않습니다.
시작, 일반 기록·허용 검사, OS 스케줄링과 커널 I/O까지 절대적 실시간 한도를
보장하지는 않습니다. Helper의 협력적 한도만으로 멈춘 callback을 제한할 수
없으므로 native 준비에는 격리한 adapter를 사용합니다.

운영자 설정은 선택 범위, 읽기 전용 메타데이터 DB, 일반 recorder와 비공개 audit
경로, 선택적 `readinessProbe` 디렉터리·instance UUID·generation·해시를 고정한
빌드 helper 모듈을 지정합니다. 활성화 전에 정확한 보호 설정과 관측기 연결을
준비하고 검토합니다. Adapter와 두 번째 Start recorder를 중복 등록하지 않습니다.
준비만으로 설치·활성화, 관측기 재시작이나 native 버전 검증이 되지 않습니다.
새 사용자 실행 시험은 별도 승인과 이전 정지 시험 보존이 필요합니다.

일치하는 대기와 저장 완료 증거는 의도적인 훅 시간 조정 아래 향후 기준점 복구를
검증합니다. 자연적인 파일 생성 빈도, 전체 2초 만료, 완전한 카운터와 관련 없는
Stop의 출처를 증명하지 않습니다. 원인 미상 Stop은 계속 수집을 정지합니다.
빈 agent type이나 파일 부재만으로 무시하지 않습니다.

## Synthetic 검증

Node 24 또는 26 checkout에서 실행합니다.

```sh
npm run build
npm test -- tests/claude-hook-diagnostics.test.ts tests/session-binding-claude.test.ts tests/session-binding-claude-api.test.ts
npm test -- tests/binding-readiness-probe.test.ts tests/claude-readiness-capture.test.ts
npm test -- tests/claude-family-diagnostics.test.ts tests/binding-family-diagnostic-sink.test.ts tests/session-binding-human-pilot.test.ts tests/claude-child-start-readiness.test.ts
node --test skills/harness-connect/tests/*.mjs
npm run check
```

이 검사는 synthetic 입력과 임시 receipt 디렉터리를 사용합니다. 기록기 동작,
개인정보 보호, 재실행·삭제 처리와 기존 binding 검증을 확인합니다. Claude 실행,
정확한 native 생명주기·카운터 검증, 누락된 종료 이벤트 복원 또는 과거 측정
변경은 수행하지 않습니다.
