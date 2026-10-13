# Harness Connect 프로젝트 스킬

[English](harness-connect.md)

## 현재 구현

[공유 스킬](../../skills/harness-connect/SKILL.md), receipt API, 연결 저장/수집 계층,
Codex/Claude 메타데이터 hook/provider, UI 가족 표시가 구현되어 있습니다. 격리 synthetic
종단 테스트로 부모 한 번 연결, 자식 자동 수집과 부분 사용량 갱신을 검증합니다.
아래의 Codex 0.162.1 제한 일반 profile은 2026-10-13에 실제 ordinary 경로의
native 검증과 독립 검토를 통과했으며, 다른 일반 native
production source는 qualification 차단 상태입니다. Claude 호출 시
세션 hook 등록·receipt 조회·평탄화된 family 멤버의 합성 통합도 구현했습니다. provider 설정이나 스킬 설치만으로 production 경로가 열리지
않습니다. [설계와 실측 계획](../decisions/012-session-family-bindings.md)을 참고하세요.

먼저 UI에서 등록 프로젝트의 논리 작업과 A/B 배정을 준비합니다. 승인된 native
instrumentation이 있으면 평소처럼 연 부모가 신뢰 가능한 receipt를 전달하고,
서버가 현재 identity/source를 확인해 arm/가격 고정을 유지한 채 관측을 시작합니다.
검증된 자식 관계는 자동 추적하며 자식별 호출은 필요 없습니다. 재호출은 기존
연결을 확인하고 여러 작업이면 한 번 명시적으로 선택합니다. 같은 cwd, 모델 진술,
환경 힌트나 추측 UUID는 증거가 아닙니다.

## Codex 0.162.1 제한 일반 profile

새 `ordinary_admission` 실행과 독립 검토로 이 정확한 제한 경로를 검증했습니다.
[날짜별 승인 증거](../validation/codex-ordinary-binding-qualification.md#2026-10-13-ordinary-route-acceptance)를 참고하세요.
기존 lease 기반 관측과 synthetic fixture는 별도 증거이며,
다른 일반 경로를 검증한 것은 아닙니다.

고정된 `functional_pilot` protocol에 코드 소유 source profile
`codex-binding-01621-direct-family-v1`, 정확한 버전 `0.162.1`, 등록 작업의
초기 모델 `gpt-6.1-sol`을 사용합니다. 이 기능 protocol은 도입 실험을 허용하지
않습니다. `session_binding`에는 검토된 Codex receipt 디렉터리, 허용 source
root와 등록 프로젝트를 설정합니다. Qualification lease, `native-pilot` 명령,
브라우저 지원 플래그가 admission을 부여하지 않습니다.

지원 native 증거는 검토된 read-only·no-daemon 실행의 새 CLI root와 새 직접
자식 2개, `gpt-6.1-sol/high`입니다. 일반 coordinator는 root 최대 1개·직접
자식 최대 2개와 native 모델·effort 메타데이터를 확인합니다. 미지원 runtime,
source 교체, ancestry, 세 번째·중첩 멤버, 다른 정확 버전은 차단합니다.
하네스 적용과 작업 세션을 분리합니다. 재시작·일시중단 후에는 새 baseline을
잡으며 제외된 준비·오프라인 사용량은 소급 수집하지 않습니다.

구현은 새 관측에 `source: codex_binding`과 해당 ordinary 실행에서 검증한
정확한 parser provenance를 고정합니다.
파일·도구 소유 launch 경로는 기존 호환 미검증 상태를 유지하고,
과거 관측은 새 trust로 승격되지 않습니다. 일반 수집은 사용자 native
프로세스를 제어하거나 qualification runner의 요청·토큰·실행 시간 안전
예산을 강제하지 않습니다.

적격 관측 요청과 가격이 확인된 구성 요소만 부분 비용에 반영합니다.
응답 기록과 정상 종료는 모든 시도 요청·마지막 usage의 영구 전달을 입증하지
못하므로 전체 작업 비용은 미지원입니다. 기준 가격 정책의 매칭은 실제 청구
증거가 아닙니다.

## 프로젝트 설치 경계

아래는 수동 예시이며 자동 설치가 아닙니다. 대상을 선택하고 패키지를 검토하세요.
기존 목적지가 있으면 복사하지 않습니다. portable helper에는 Node 24와 내장
라이브러리만 필요합니다. 스킬 복사는 전역 설정, AGENTS, 인증을 바꾸지
않습니다. Claude에서 명시적 호출하면 세션 hooks가 등록되므로 패키지와 trust를
설치·호출 전에 검토해야 합니다.

```sh
skillSource="$PWD/skills/harness-connect"
projectRoot="/path/to/your/project"
```

Codex:

```sh
mkdir -p "$projectRoot/.agents/skills"
test ! -e "$projectRoot/.agents/skills/harness-connect" && test ! -L "$projectRoot/.agents/skills/harness-connect" && cp -R "$skillSource" "$projectRoot/.agents/skills/harness-connect"
```

Claude Code:

```sh
mkdir -p "$projectRoot/.claude/skills"
test ! -e "$projectRoot/.claude/skills/harness-connect" && test ! -L "$projectRoot/.claude/skills/harness-connect" && cp -R "$skillSource" "$projectRoot/.claude/skills/harness-connect"
```

Codex의 별도 startup hook 제안은 기존 hook, 정확한 script, receipt 디렉터리, 허용 source와
trust 검토가 필요합니다. 설치/trust와 실제 native qualification은 승인이 필요합니다.
Codex는 이후 native startup 경계에서 새 세션을 열거나 재개합니다. Claude는
호출 시 세션 hooks 등록 경로를 사용하며 실제 로딩·reload는 검증하지 않았습니다. trust를 우회하거나
모델/effort를 강제하지 않습니다. 스킬은 특정 제품 버전 설치를 요구하지 않으며
source 지원 판단은 서버에 있습니다. [공식 Codex hooks](https://learn.chatgpt.com/docs/hooks)는
메타데이터와 trust를 설명하지만 transcript 형식은 안정 인터페이스가 아닙니다.
실제 세션의 스킬 발견은 아직 검증하지 않았습니다.


Codex 고정 공식 소스에서 자식 start hook은 자신의 rollout path를 materialization 시도 후
전달합니다. 실제 파일 존재와 identity/envelope는 recorder/provider가 검증합니다. 공통 session_id는 직접 부모가 아닌 family root ID입니다. Provider는
승인된 정확한 파일의 첫 metadata envelope에서 own ID/root ID/직접 부모/depth를
확인한 뒤 자식·지원되는 하위 멤버를 자동 연결합니다. History directory를 검색하거나
경로를 추측하지 않습니다. 이 연결 경로의 코드와 합성 fixture는 검증했으며,
실제 hook 로딩·source/counter conformance와 production admission은 아직 대기합니다.

## 한 번 연결하고 확인

로컬 UI origin과 명시적 project/task를 지정하고 현재 native hook이 전달한 opaque
receipt를 사용합니다. receipt를 만들거나 transcript 디렉터리를 검색하지 않습니다.
아래 명령은 구현된 계약 예시입니다. Native production admission은 위의
정확한 제한 profile을 요구하며 다른 candidate는 차단됩니다.

```text
Codex: $harness-connect Connect this session to project PROJECT_ID, task TASK_ID, using http://127.0.0.1:PORT and its native receipt.
Claude: /harness-connect Connect this session to project PROJECT_ID, task TASK_ID, using http://127.0.0.1:PORT and its native receipt.
```

```sh
node .agents/skills/harness-connect/scripts/connect.mjs inspect --origin http://127.0.0.1:PORT --product codex
node .agents/skills/harness-connect/scripts/connect.mjs connect --origin http://127.0.0.1:PORT --product codex --project PROJECT_ID --task TASK_ID --receipt NATIVE_RECEIPT
```

helper는 Origin/CSRF/version을 확인하고 session-connect를 호출한 뒤 저장된 배정과
native 연결을 다시 읽습니다. 안전한 ID, arm, 증거, 수집 활성 여부와 자식 자동 지원을
보고합니다. instrumentation 미설치, 미지원 source, identity 충돌은 고정 blocker와
exit 1을 반환합니다. 읽기 전용 inspect는 연결 성공이 아닙니다. 서버에 지원 Claude
provider가 있을 때만 `claude_code`와 `.claude/skills`를 사용합니다. 기본
Claude candidate는 qualification 차단 상태입니다. 승인된 프로젝트 로컬 Claude
설치에서는 connect 명령에 receipt 인수를 넣지 않습니다. PreToolUse hook이 현재
metadata를 기록하며 helper는 같은 Bash 호출의 OS process ancestry로 receipt를
찾습니다. `${CLAUDE_SKILL_DIR}`의 hook 명령 치환은 문서화되어 있지 않으므로
패키지 hooks는 `CLAUDE_PROJECT_DIR`의 프로젝트 설치 경로를 사용합니다.
승인된 설정에서 receipt 디렉토리를 명시적으로 선택하고 서버 설정과 일치시키세요.
없거나 모호한 receipt는 차단하며 source 조회 범위를 넓히지 않습니다.
[Claude skill hooks](https://code.claude.com/docs/en/skills)와
[hook 환경](https://code.claude.com/docs/en/hooks)의 공식 경계를 따릅니다.

```sh
node .claude/skills/harness-connect/scripts/connect.mjs inspect --origin http://127.0.0.1:PORT --product claude_code
node .claude/skills/harness-connect/scripts/connect.mjs connect --origin http://127.0.0.1:PORT --product claude_code --project PROJECT_ID --task TASK_ID
```

Claude는 SubagentStart/Stop hooks로 이후 멤버를 기록하고 각 transcript의 소유권을
검증합니다. 공식 fields로 중첩 멤버의 직접 부모를 증명할 수 없어 확인된 모든
멤버를 root 아래에 평탄화합니다. 자식 재호출은 활성 family에서 독립적으로
발견된 연결만 확인합니다. 중지된 family는 아래의 코드 소유 사용자 UI pilot
권한으로 같은 살아 있는 부모를 재개할 수 있으면 UI 재개를 사용하고,
그 외에는 부모에서 다시 연결해야 합니다. Native profile·counter·source 형식의
interactive qualification은 아직 완료되지 않았습니다. 아래에서 설명하는 제한된 print-mode
qualification은 2.1.296에만 해당하며 나머지 나열된 버전은 candidate 상태입니다.
model이나 effort 설정은 강제하지 않습니다.

UI는 가족 수와 부분 사용량을 갱신합니다. pause/서버 재시작은 수집을 멈춥니다.
같은 살아 있는 부모의 허용된 UI 재개 또는 부모에서 다시 한 번 호출하면 새
baseline을 잡습니다. 새 부모도 기존 open task의 arm/가격을 유지할 수 있습니다.
이전/미관측 구간은 소급 수집하지 않습니다. 뒤늦게 발견된 멤버는
`late_linked_member`를 기록합니다. 미지원 descendants와 누락 사용량은 zero가
아닌 gap입니다. 전체 비용과 추론은 사용할 수 없습니다. Pause 중에도 metadata
hooks는 계속될 수 있지만 transcript 수집은 하지 않습니다. 삭제 시 durable queue가
metadata receipt만 잊고 서버 재시작 후에도 해당 family의 이후 receipt를 차단합니다.
Native transcript는 삭제하지 않습니다. 수집 완료와 hook 제거는 별개이며,
완료는 사람이 결과를 확인해야 합니다.

## 기존 ticket 호환 경로

기존 경로는 UI startup ticket으로 연 정확한 root용입니다. 그 native context가 없는
일반 세션을 이 경로로 연결하지 않습니다.

```sh
node .agents/skills/harness-connect/scripts/connect.mjs connect --origin http://127.0.0.1:PORT --product codex --project PROJECT_ID --task TASK_ID --session SESSION_UUID
```

확인한 정확한 source를 native picker에서 선택합니다. helper는 source, context,
freshness, window 증거를 다시 읽습니다. 최근 선택 source만 확인하며 UI에서 별도로
관측을 시작합니다. 이 legacy 경로는 가족 자동 상속을 지원하지 않습니다.
[수동 UI](local-browser-ui.ko.md)와 [native workflow gates](task-native-workflow.md)를 참고하세요.
세션을 임의로 다시 열거나 과거 harness 적용을 주장하지 않습니다.

## 로컬 검증

Node 24와 기존 의존성을 사용합니다. `npm run check`의 build 이후 transport test가
빌드 asset을 읽습니다.

```sh
node --check skills/harness-connect/scripts/connect.mjs
npm run check
node --test skills/harness-connect/tests/*.mjs
```

테스트는 격리 fixture DB와 synthetic hook/source 기록을 사용합니다. native 모델을
호출하거나 사용자 기록/DB를 읽거나 실제 hook trust/source qualification을 수행하지
않습니다. 집중/전체 로컬 검사와 독립 리뷰는 remote CI와 구분해 보고합니다. 정확한
adapter 계약은 [session-binding-contract.ts](../../src/session-binding-contract.ts)입니다.

Claude 기준선의 제외 own request ID는 실시간 replay 목록과 별도로 최대 1,024개를
보존합니다. 한도 초과(`claude_baseline_limit`)나 부분/해석 불가능한 기준선
(`claude_baseline_incomplete`)은 연결을 차단하며 제외 ID를 버리지 않습니다.
이미 관측한 요청의 counter 충돌도 수집을 중단합니다.

격리된 일반 Codex CLI qualification 실행기와 실제 호출 승인 범위는 [qualification 절차](../validation/codex-ordinary-binding-qualification.md)를 참고하세요. 준비와 Node fixture 검증만으로 production 지원이 열리지는 않습니다.
실행기에 별도 정확 버전 0.162.1 후보가 있으며 `--product-version 0.162.1`로
선택합니다. 일반 `--no-daemon` TUI에서 기존 부모 하나·새 직접 자식 둘의 topology를
유지합니다. 정확한 실행 파일 고정, intent별 승인과 소유 실행의 안전 검증은
일반 provider 설정과 별개입니다. 기본 qualification 경로는 source lease를
사용하고, `ordinary_admission`은 별도로 검증된 일반 source 권한을 사용합니다.
세션 한정 `projects` 인라인 테이블은 새 임시
프로젝트만 신뢰하며 사용자 설정을 저장하거나 sandbox·승인 권한을 넓히지 않습니다.
새 0.162.1 계획은 기본 비활성·`UnderDevelopment`인 `exec_permission_approvals`
feature를 이번 세션에만 별도로 켭니다. 검토된 helper 실행 1회에 inspect/connect를
묶고 명시적인 network-only 명령 승인을 받으며 기존 파일 권한은 유지합니다.
이 권한은 host/port 한정이 아니며 managed proxy가 loopback 접근을 계속 차단할
수 있습니다. prefix/turn/session grant, sandbox 밖 escalation, 영구 정책 변경은
허용하지 않습니다. inspect·연결·승인이 차단되면 재시도하거나 자식을 만들지 않고
중단합니다. 검토된 정지 기준은 root8/child1each/total10입니다.
자동 시작은 연결만 수행합니다. 연결과 해당 턴이 끝난 뒤 intent에 고정한
`post_connect_input`을 별도 TUI 턴으로 한 번만 제출하세요.
제출 키 없이 붙여넣고(지원하면 bracketed paste 사용) 입력창의 초안을 확인한 뒤
Enter를 별도 동작으로 누르세요. 입력창에 붙여넣은 문구만으로 제출을 판단하지 말고,
전송된 턴과 실제 작업 시작을 확인한 뒤 완료를 기다리세요.
루트는 턴마다 최대 3회, 자식은 각 1회 요청을 계획합니다. 제외된 연결 요청도
안전 한도에는 포함하지만 측정 사용량에는 포함하지 않습니다. 세 세션의 사용량을
수집하고 작업 턴이 끝나면 대기 중인 TUI를 정상 종료하세요.
종료 명령 입력과 제출 키도 별도 동작으로 보내세요.
기존 0.160.0은 root4/child1each/total6을 유지합니다.
0.162.1의 토큰 정지 한도는 200000이며 0.160.0은 100000을 유지합니다.
0.162.1의 시간 한도는 900초이며 0.160.0은 120초를 유지합니다.
target의 연결 기준 수집 창도 900초이며 기존 수집 창은 180초를 유지합니다.
수집 창이 더 늦게 끝나더라도 native 시작 기준 900초 마감은 실행을 종료합니다.
권한 모드와 한도는 새 intent에 고정하며
준비 자체는 native 실행 승인이 아닙니다. 추가 동의 필드는 qualification 절차를
참고하세요.
connector 경로/SHA를 고정하며 inspect가 성공한 뒤에만 connect를 실행합니다.
현재 receipt를 쓰는 고정 Node 명령만 승인하고 다른 명령을 연결하면 안 됩니다.
두 번째 또는 더 넓은 권한 요청은 사람이 거부하며, 연결 차단 후 작업이 계속되면
소유 실행을 중단해야 합니다. 미연결 활동은 source ledger가 감시하지 못합니다.
새 0.162.1 계획은 자동 시작만 허용하며 수동 모드는 기존 0.160.0에만 남습니다.
승인 요청과 agent-turn-complete를 OSC9로 알리고 `notification_condition="always"`로 고정합니다.
실행 전에 private `native-attention.json` 생성을 구독하고, 각 알림 뒤에는 변경을
구독하세요. 해당 경로가 이미 있으면 예약을 소비하기 전에 실행을 거부합니다.
raw PTY framing으로 줄바꿈을 기다리지 않고 digest/count만 알리며
메시지 본문은 보관하지 않습니다. 현재 화면을 확인해 정확한 명령의 승인을
사람에게 받아야 합니다. 알림 자체는 권한을 주거나 고정된 시간 한도를 연장하지 않습니다.
완료 알림에서도 끝난 턴과 비어 있는 입력창을 확인한 뒤에만 고정된 후속 입력이나
정상 종료를 제출하세요. 알림 자체는 사용량 수집의 증거가 아니므로 정상 종료 전에
연결된 세 세션의 사용량을 별도로 확인하세요.
Node 전용 전달 검증은 target binary의 실제 알림 동작을 검증한 것이 아닙니다.
고정된 0.162.1 ordinary 경로는 위 제한 profile에서 실제 native 알림,
명령 권한과 가족 conformance를 검증했습니다. 다른 일반 경로, 버전,
runtime과 더 넓은 topology는 미검증입니다.
source를 읽지 않는 작업 준비는 정확한 버전과 단일 own-response profile의
functional-pilot protocol도 허용하지만 binding·ticket 수집 권한을 주지는 않습니다.
qualification은 각 정확한 source를 검증된 자체 조상 관계로만 투영하고, 별도 lease가
전체 가족 한도를 제한합니다. 형제 thread를 가리키는 row는 차단하며 일반 경로의
더 넓은 topology를 지원한다는 뜻이 아닙니다.

격리 qualification UI는 부모·자식별 자체 요청, 입력·출력, 부분 비용과 관측 합계를 표시합니다. 같은 살아 있는 부모의 측정 재개와 소유 AI 긴급 중단을 분리하며, 기존 기한·안전 카운터는 초기화하지 않습니다. pause 중 원본 카운터는 미확인입니다. [제한된 실행 절차](../validation/codex-ordinary-binding-qualification.md)를 참조하세요.

## Codex 0.162.0 일반 root 로컬 pilot

검토된 `functional_pilot`에서 정확한
`codex-01620-ordinary-root-human-pilot` source profile만 사용합니다.
일반 서버는 계속 차단됩니다. 운영자가 정확한 작업을 지정하고 관측을 별도로
승인해야 합니다.

```sh
npm start -- --db "$DB" ui --pilot-task "$TASK_ID" --pilot-observe --pilot-until-stop
```

provider와 검토된 SessionStart hook 제안에는 독립적으로 확인한 제품 버전
`0.162.0` 또는 `0.162.1`을 동일하게 지정합니다. 작업의 workflow와 동결한
protocol에도 실제 버전을 동일하게 넣으세요. 기존 profile ID는 0.162.1 후보에도
사용하지만 executable이나 receipt의 버전을 0.162.0으로 바꾸지는 않습니다.
metadata-only 적용 신원은 transcript 읽기
권한이 아닙니다. native 시작 전에 프로젝트 로컬 hook 설치/trust와 정확한
receipt/source 디렉터리를 검토합니다. receipt를 임의로 만들면 안 됩니다.
새 root 하나만 허용하며 자식 세션은 미지원입니다.

`agent_applied`라면 먼저 별도 적용 세션을 완료하고 실제 파일과 검사를 검토한 뒤,
선택한 checkout의 새 작업 root에서 `harness-connect`를 호출합니다.
적용 세션 신원 재사용, 미완료 적용, 파일 변경, 이전 root는 계속 차단됩니다.

자체 응답 관측은 0.160.0 파서를 재사용하며 immutable `codex_workflow` parser
lineage와 `compatibility_unverified`를 표시합니다. 이 표시는 launch 권한이나
production admission이 아닙니다. 계약 실패는 다음 source 읽기 전에 공통
parser tuple을 무효화합니다. 비용은 부분 기준가격 추정이며 전체 합계,
native 지침 로딩 증명이나 추론이 아닙니다.
[ADR 013](../decisions/013-forward-version-compatibility.md)을 참고하세요.

[0.162.1 릴리스](https://github.com/openai/codex/releases/tag/rust-v0.162.1)는
TUI 질문과 시작 시 feature 호환성을 수정합니다. 합성 검사는 버전별 receipt,
선택 checkout의 적용 신원, root-only 관측, pause/resume과 계약 무효화를 다룹니다.
native hook 로딩이나 최신 counter 의미를 검증하지는 않으며 별도로 승인된
native 시험이 계속 필요합니다.

## Claude 사용자 조작 UI pilot

로컬 운영자는 ordinary provider에 나열된 정확한 버전(현재 2.1.291,
2.1.293, 2.1.294 또는 2.1.296)과 `claude-ordinary-human-pilot` source profile을 사용한 준비된
`functional_pilot` 작업 하나를 선택할 수 있습니다. 기존 file·실행 workflow의
버전 호환성은 일반 가족 원본의 지원 검증이 아닙니다. 설치·실제 관측 전에
profile, binary 버전, 프로젝트 원본 디렉터리와 receipt 디렉터리를 검토하세요.
브라우저나 manifest는 수집 권한을 부여할 수 없습니다. 기존 로컬
`ui --pilot-task` 명령은 두 제품을 준비합니다. `--pilot-observe --pilot-until-stop`은
선택된 작업의 명시적 중단 관측만 추가로 허용합니다. 에이전트를 실행하지 않습니다.

관측기가 준비되면 사용자가 새 Claude terminal을 열고 부모에서
`/harness-connect`를 한 번 호출한 뒤 새 가족 구성원을 최대 두 개 만듭니다.
자식의 별도 호출이나 고정 model·effort·자식 종류는 필요하지 않습니다.
구성원별 자체 요청과 부분 추정치를 나누어 표시하고 관측 합계를 보여 줍니다.
Claude 구성원은 root 아래로 평탄화합니다. 중첩 구성원의 직접 부모는 증명하지
못합니다. 미지원 구성원과 구간은 명시적 gap으로 남깁니다.

pause·완료·권한 철회는 Claude를 종료하지 않고 수집만 멈춥니다.
수집에는 경과 시간 제한이 없고 고정된 비교 follow-up은 별도로 유지합니다.
UI 재개는 원래 receipt가 오래되었어도 저장된 정확한 live root binding,
프로젝트, preparation, source identity, 프로세스, 삭제·철회 상태를 재검증합니다.
재시작 상태는 paused입니다. 재개 시 새 기준점을 만들고 pause·offline 요청은
backfill 없이 제외합니다.

새 연결에는 여전히 신선한 receipt가 필요합니다. 오래된 receipt만으로 새 root,
프로젝트나 작업을 선택할 수 없으며 history 탐색 권한도 생기지 않습니다.
보존된 프로세스 증거가 없는 legacy binding은 차단합니다. 기존 저장 identity를
교체하지 않고 별도로 준비한 작업과 새 Claude root가 필요합니다.
native 프로세스 종료·재실행은 측정 재개와 별도 경계입니다. 수집 pause 중에도
skill metadata hook은 계속될 수 있습니다. receipt 수명은 hook timeout이나
helper의 신선한 receipt 탐색 구간과 별개입니다.

[2.1.294 변경 기록](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21294)은
`prompt`와 `agent` hook 판단 수정을 설명합니다. native transcript 필드,
command hook 로딩이나 counter 호환성을 증명하지 않습니다. ordinary parser는
변경하지 않았으며, 2.1.294 후보는 연결, 가족 usage, pause/resume과 사용자 완료의
합성 검증 범위를 갖습니다.

[2.1.296 변경 기록](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21296)은
managed hook과 token count 수정을 포함하지만 변경 기록만으로 일반 원본을 검증하지는 않습니다.
변경하지 않은 파서는 2.1.296 신원, 자체 요청 replay, 기준선 제외, 가족 수 한도와
pilot gate의 합성 검증 범위를 갖습니다.

2.1.296 transcript profile의 qualified 상태는 제한된 native print-mode 증거만 뜻하며,
대화형 검증이나 제품 수집 허용이 아닙니다. 오프라인 실제 바이너리 리허설과 native print-mode
pilot 한 번으로 skill 로딩, receipt, 가족 구성원과 자체 counter를 확인했습니다.
[검증 기록](../validation/claude-ordinary-binding-02196-qualification.md)을 참고하세요.
그 관측에서 skill 범위의 `SubagentStop` hook은 receipt를 남기지 않았고, 구성원 탐색은 여기에 의존하지 않습니다.
나머지 나열된 버전은 합성 증거만 갖습니다. 실제 2.1.291, 2.1.293 또는 2.1.294 skill 로딩, 가족 counter,
pause/resume과 사용자 완료는 별도로 승인된 native 시험이 필요합니다.
qualified인 2.1.296을 포함한 모든 ordinary Claude profile에는
`allowCandidateProfiles: true`가 필요합니다. 기본 provider 거부와 ordinary service
수집 gate는 계속 닫혀 있습니다. 현재 label인 `native_unverified_pilot`,
`legacy_unverified`, `candidate_pilot`은 유지됩니다.
일반 제품 수집 지원, 전체 작업 비용과 추론 결정은 아직 사용할 수 없습니다.
