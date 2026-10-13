# Harness Connect 프로젝트 스킬

[English](harness-connect.md)

## 현재 구현

[공유 스킬](../../skills/harness-connect/SKILL.md), receipt API, 연결 저장/수집 계층,
Codex/Claude 메타데이터 hook/provider, UI 가족 표시가 구현되어 있습니다. 격리 synthetic
종단 테스트로 부모 한 번 연결, 자식 자동 수집과 부분 사용량 갱신을 검증합니다.
일반 native production source는 qualification 차단 상태입니다. Claude 호출 시
세션 hook 등록·receipt 조회·평탄화된 family 멤버의 합성 통합도 구현했습니다. provider 설정이나 스킬 설치만으로 production 경로가 열리지
않습니다. [설계와 실측 계획](../decisions/012-session-family-bindings.md)을 참고하세요.

먼저 UI에서 등록 프로젝트의 논리 작업과 A/B 배정을 준비합니다. 승인된 native
instrumentation이 있으면 평소처럼 연 부모가 신뢰 가능한 receipt를 전달하고,
서버가 현재 identity/source를 확인해 arm/가격 고정을 유지한 채 관측을 시작합니다.
검증된 자식 관계는 자동 추적하며 자식별 호출은 필요 없습니다. 재호출은 기존
연결을 확인하고 여러 작업이면 한 번 명시적으로 선택합니다. 같은 cwd, 모델 진술,
환경 힌트나 추측 UUID는 증거가 아닙니다.

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
아래 명령은 구현된 계약 예시이며 native production admission은 qualification까지
차단됩니다.

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
