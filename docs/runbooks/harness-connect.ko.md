# Harness Connect 프로젝트 스킬

[English](harness-connect.md)

## 현재 구현

[생성된 지원 매트릭스](../support-matrix.ko.md#정확한-경로)에서 현재 버전, 정확 경로,
profile ID와 qualification 표시를 확인하세요. [범례](../support-matrix.ko.md#범례와-제한)는
admission, transcript conformance와 일반 native qualification을 구분합니다.
조건부 file/workflow 재사용과 ordinary binding 근거는 서로의 신뢰 상태를 승격하지 않습니다.
정확 profile에 맞는 아래 절차를 사용하세요. 저장 설정과 고정 작업은 자동 갱신하지 않습니다.

Codex 0.163.0은 [제한된 qualification 절차](../validation/codex-ordinary-binding-qualification.ko.md)에서
`--product-version 0.163.0 --route qualification`으로 별도 준비할 수 있습니다.
Codex 실행 파일 옆에 같은 릴리스의 고정된 `codex-code-mode-host`가 필요하며,
Codex 단독 아카이브만으로는 부족합니다. 준비와 실행 시 두 파일의 pin을 검사합니다.
이후 별도의 `--route ordinary_admission` 시험도 qualification 수집 권한 없이 통과했습니다.
새 프로젝트 설정의 기본값은 이제 Codex 0.163.0이며 버전 선택기에는 Codex 0.162.1도 남아 있습니다.
저장된 버전은 자동으로 올리지 않습니다. 새 정확한 binding profile만
검증 provenance를 얻으며, 과거 미검증 관측은 그대로 유지합니다.

버전 선택기에는 정확한 Codex 0.166.0도 **UNQUALIFIED CANDIDATE**
(`qualified:false`), profile `codex-binding-01660-direct-family-v1`로 표시됩니다.
검증된 지원은 대기 중입니다. 기록 자체에는 `evidenceId`나 `evidenceIntentSha256`가 없고
`productionSourceEvidence`에 기여하지 않습니다. 별도의 native intent와 결과는
[2026-11-03 후보 시험](../validation/codex-ordinary-binding-qualification.ko.md#2026-11-03-candidate-trials)에
기록되어 있으며 후보의 지원 검증을 완료하지는 않습니다. 기본값은 0.163.0을 유지합니다.
[후보 절차](../validation/codex-ordinary-binding-qualification.ko.md#01660-unqualified-ordinary-candidate)는
`--route ordinary_admission`과 명시적인
`--scenario root_normal_observer_restart`(자식 없음) 또는
`--scenario family_normal_observer_restart`(새 직계 자식 두 개)가 필요합니다.
native 실행에는 정확한 intent별 별도 동의가 필요합니다.
H4 host-spawn/Detached와 H5 environment-hook null-transcript 경로는 제외되며,
file/workflow fallback과 native resume은 제공하지 않습니다.

[공유 스킬](../../skills/harness-connect/SKILL.md), receipt API, 연결 저장/수집 계층,
Codex/Claude 메타데이터 hook/provider, UI 가족 표시가 구현되어 있습니다. 격리 synthetic
종단 테스트로 부모 한 번 연결, 자식 자동 수집과 부분 사용량 갱신을 검증합니다.
아래의 Codex 0.162.1 제한 일반 profile은 2026-10-13에 실제 ordinary 경로의
native 검증과 독립 검토를 통과했고 Codex 0.163.0은 아래의 별도 검증 근거를 갖습니다. 다른 일반 native
production source는 qualification 차단 상태입니다. Claude 호출 시
세션 hook 등록·receipt 조회·평탄화된 family 멤버의 합성 통합도 구현했습니다. provider 설정이나 스킬 설치만으로 production 경로가 열리지
않습니다. [설계와 실측 계획](../decisions/012-session-family-bindings.md)을 참고하세요.
A/B 배정이 없는 작업을 위한 일반 Claude 관측은 설정된 profile의 정확한 버전과
binary에서 [일반 사용](#일반-claude-관측-지원-검증-대기)이 허용됩니다. 새 프로젝트 설정은
Claude Code 2.1.306을 사용하고, 저장된 Claude Code 2.1.296 또는 2.1.301 설정은 그대로 씁니다.

먼저 UI에서 등록 프로젝트의 논리 작업과 A/B 배정을 준비합니다. 승인된 native
instrumentation이 있으면 평소처럼 연 부모가 신뢰 가능한 receipt를 전달하고,
서버가 현재 identity/source를 확인해 arm/가격 고정을 유지한 채 관측을 시작합니다.
검증된 자식 관계는 자동 추적하며 자식별 호출은 필요 없습니다. 재호출은 기존
연결을 확인하고 여러 작업이면 한 번 명시적으로 선택합니다. 같은 cwd, 모델 진술,
환경 힌트나 추측 UUID는 증거가 아닙니다.

일반 root 참조 정책 `codex-binding-root-window-v1`(Codex `>0.163.0`, `<0.172.0`)과
`claude-binding-root-window-v1`(Claude Code `>2.1.306`, `<2.2.0`)은 오프라인 검증용으로
구현되었으며, 일반 창(window) 수집은 별도 제품 활성화와 native 검증 전까지 비활성 상태입니다.
정확 admission이 아니며 지원 버전 목록에도 없습니다. 독립적인 Codex와 Claude window 패키지,
helper와 닫힌 설정 절차를 아래에서 제공합니다. 설정을 저장하거나
패키지를 설치해도 window가 활성화되지는 않습니다. root 소스 참조는 root 자체
사용량이 아닙니다. 소유는 미검증으로 남고 자식 관측 범위와 비용은 null입니다.
[ADR 013](../decisions/013-forward-version-compatibility.md#profile-selection-and-scope)을 참고하세요.

## 프로젝트 에이전트 연결 설정

로컬 설정에서 등록 프로젝트를 선택하고 **에이전트 연결 설정**을 엽니다.
**Codex** 또는 **Claude Code**를 선택합니다. 설정 저장, 파일 설치, native hook
신뢰와 세션 연결은 서로 다른 상태입니다.

Codex의 **정확 버전** 모드에서는 정확한 버전과 허용 source root를 검토한 뒤 설정을 저장합니다.
설치 미리보기를 확인하고 적용합니다. 검토한 설치는 소유한 skill과 recorder를
복사하고, 프로젝트의 `.codex/hooks.json`에 hook 항목을 병합하며,
`.harness-delta/codex-connect/receipts`를 비공개 권한으로 생성합니다.
기존의 다른 hook은 보존합니다. 설치는 native 신뢰를 부여하거나 Codex를
실행하거나 receipt를 만들지 않습니다. Native hook을 검토하고 신뢰한 뒤,
작업 세션을 새로 시작하거나 재개하고 `harness-connect`를 호출합니다.

프로젝트 Codex 연결 설정은 해당 프로젝트의 Codex 작업에 receipt/source 위치를
제공하며, 고정된 작업 버전과 source admission 조건은 계속 적용됩니다.
Codex 연결을 관측 중이면 설정 변경이나 제거를 차단합니다. 제거는 receipt와
다른 hook을 보존합니다. Claude 패널은 기존 프로젝트 전용 패키지 흐름과
아래의 원본 및 가족 범위 한도를 유지합니다.

설정을 새로고침하여 receipt 디렉터리 누락·안전하지 않은 권한과 provider
초기화 상태를 확인합니다. Provider 준비는 환경 검사이며 현재 세션이 신뢰한
hook을 로드했다는 증거가 아닙니다. 실제 세션 연결은 작업 상세에서 확인합니다.
설치로 A/B 배정 없는 일반 Codex 작업을 허용하거나 제한 source profile을
확장하지 않습니다.

이후 receipt 디렉터리가 삭제되면 설치를 다시 미리보고 적용하여 변경되지 않은
hook이나 skill 파일을 교체하지 않고 복구합니다. Node runtime을 업그레이드했다면
새로고침하고 고정 실행 파일 경로가 변경된 경우 갱신을 미리봅니다.
**종료된 설치 잠금 복구**는 소유 프로세스의 종료가 확인되고 남은 트랜잭션이
없을 때만 사용합니다. 소유 기록이 없거나 `transaction-*` 증거가 남아 있으면
수동 검토가 필요합니다. 복구는 해당 증거를 버리거나 살아 있는 잠금을 해제하지 않습니다.

## Codex 일반 window 설정 (수집 비활성)

이 별도 경로는 오프라인 검증용으로 구현되었으며, 일반 window 수집은 별도 제품 활성화와
native 검증 전까지 비활성 상태입니다. 활성 지원 항목이나 정확 admission이 아니며 native
시험 실행 권한도 아닙니다. 위의 정확 버전 절차와 저장된 기본값은 바뀌지 않습니다.

1. **에이전트 연결 설정**에서 **Codex**, **일반 window**를 선택합니다.
   `0.163.0 < v < 0.172.0` 안의 안정 버전을 직접 입력하고 허용 source root를 검토합니다.
   양 경계와 같은 버전, prerelease와 build suffix는 거부하며 상한 갱신에는 별도 결정이 필요합니다.
2. 명시한 설정을 저장하고 설치 미리보기의 소유 상대 경로를 검토한 뒤 적용합니다.
   window 모드로 한 번 명시적으로 옮기는 절차이며 기존 정확 설정이나 작업의 자동 변환이 아닙니다.
   편집되거나 소유하지 않은 파일, 안전하지 않은 경로, 오래된 미리보기, 다른 hook과의 충돌,
   사용 중인 root는 계속 변경을 차단합니다.
3. 설정을 새로고침합니다. 수집은 여전히 비활성입니다. 설정 저장, 파일 복사, hook 신뢰,
   pending receipt 메타데이터와 허가된 연결은 서로 다릅니다. 설치는 작업을 준비하거나 시작하지
   않으며 emission control도 만들지 않습니다.

소유 manifest `.harness-delta/codex-connect/installation.json`에는 schema 2,
`bundle_mode: ordinary_window`와 `codex-window-bundle-v1`을 기록합니다. 설치기는
`skills/harness-connect-window-codex`를 선택하며 기존 정확 helper
`.agents/skills/harness-connect/scripts/connect.mjs`를 유지하고 window helper를 그 옆의
`scripts/connect-window.mjs`로 설치합니다. 소유한 기존 정확 hook 명령과 다른 hook을
보존합니다. 범용 window recorder는 `.harness-delta/window-receipts`를 사용하며 native
원본을 탐색하거나 릴리스별 버전 literal을 포함하지 않습니다. 정확 schema 1은 그대로입니다.

window 작업은 A/B 배정 작업이 아닌 별도
`POST /api/projects/:id/codex-window-prepare-v1` API로 준비하며 지정 버전, 정책,
프로젝트 root와 가격표를 고정합니다. 연결에는 명시적으로 활성화된 준비 작업, 별도의 유효한
기록된 결정, 적격한 새 startup root와 opaque pending receipt가 필요합니다. helper는
직접 받은 origin·프로젝트·작업·receipt ID만 사용하며 파일, 환경 힌트나 프로세스 ancestry로
작업이나 receipt를 찾지 않습니다. 버전이 지정된 작업 화면을 읽고 같은 origin의
CSRF·version·idempotency 보호 요청을 보낸 뒤 유효한 root 연결을 다시 검사합니다.
성공 응답은 `automatic_children:false`이며 활성화 route나 암묵적 작업 시작은 추가하지 않았습니다.

별도 승인된 Codex trial에서는 준비한 작업을 시작하고
`compatibility ordinary-window arm <task-id> --duration-ms 60000`을 사용한 다음,
프롬프트 없이 새 root를 실행하세요. 설치된 hook의 pending receipt에서 native root를
확인한 뒤 기존 trial activation packet을 기록하세요. arming은 receipt 메타데이터만
발행하며 connect나 collect를 허용하지 않습니다. `status <task-id> --arming`으로
확인하거나 `disarm <task-id>`로 취소하세요. 전체 순서와 만료·철회 제한은
[로컬 측정](local-measurement.ko.md)을 따르세요.

`source_only` provider는 지정 버전과 root 생성 header를 비교합니다. 이 header는 현재
writer, 실행 파일, publisher나 프로세스를 검증하지 않습니다. native asset 검사는 사전 조건이
아니며 선택적 파일 assurance는 구현하지 않았습니다. root 소스 사용량은 root 자체 사용량이
아닙니다. 소유는 미검증이고 자식 기여 가능성은 알 수 없으며 자식 사용량·비용은 미관측 null로
남고 0이 아닙니다. 참조값은 `compatibility_unverified`와 부분 비용을 유지하며 추론, 배정,
launch, resume이나 자식 확장을 제공하지 않습니다.

일시정지나 observer 재시작 뒤에는 새 적격 startup root/segment와 기준점이 필요하며 기존
root는 재사용할 수 없습니다. resume·fork·compaction이나 미지원 lifecycle 근거는 정확
helper로 fallback하지 않고 이전 연결을 차단합니다. 버전/header 불일치, 권한 상실이나 원본의
모순은 해당 관측을 중단합니다. 범위 안 N -> N+1 업그레이드에는 새 지정 버전을 명시적으로
저장하고 새 root로 새 작업을 준비합니다. 고정 작업·가격 pin·과거 관측은 옮기지 않습니다.
범용 helper는 patch마다 다시 쓸 필요가 없고 누락·오프라인 구간도 backfill하지 않습니다.
[ADR 016](../decisions/016-ordinary-observation.md#codex-ordinary-window-addendum-collection-disabled)과
[버전 정책](../decisions/013-forward-version-compatibility.md#codex-root-reference-exception)을 참고하세요.

## Claude 일반 window 설정 (수집 비활성)

이 독립 경로는 오프라인 검증용으로 구현되었으며, 일반 window 수집은 별도 제품 활성화와
native 검증 전까지 비활성 상태입니다. 지원 검증 완료나 정확 admission이 아니며 native
시험 실행 권한도 아닙니다. 아래의 정확 Claude 기본값·저장 작업·절차는 바뀌지 않습니다.

1. **에이전트 연결 설정**에서 **Claude Code**, **일반 window**를 선택합니다.
   `2.1.306 < v < 2.2.0` 안의 안정 버전을 직접 지정하고 프로젝트와 허용 Claude source
   디렉터리를 검토합니다. 양 경계, prerelease와 build suffix는 거부합니다. 어느 모드로든
   전환하려면 적격 버전을 명시해야 하며, 모드를 생략하면 저장된 선택을 유지합니다.
2. 저장 후 설치 미리보기에서 소유 파일의 상대 경로 변경과 프로젝트
   `.claude/settings.local.json`에 계획된 별도 SessionStart 등록을 검토하고 해당 미리보기를 적용합니다.
   window 모드로 한 번 명시적으로 이전하는 절차이며 정확 모드의 자동 변환이 아닙니다.
   편집되거나 소유하지 않은 파일, 안전하지 않은 경로, 오래된 미리보기, 다른 hook과의 충돌은
   계속 변경을 차단합니다. 활성 Claude 작업이나 열린 binding도 migration을 차단하며,
   staging 중 교체 전에 활성화되는 작업도 포함합니다.
3. 카드에 갱신된 상태를 확인하고 수집은 비활성 상태로 유지합니다. 설정, 설치 파일, hook 전달·신뢰,
   pending 메타데이터와 유효한 권한으로 연결된 상태는 서로 다릅니다. 설치는 작업을
   시작하거나 emission control을 만들지 않습니다.

소유 manifest `.harness-delta/claude-connect/installation.json`에는 schema 2,
`bundle_mode: ordinary_window`와 `claude-window-bundle-v1`을 기록합니다. 설치기는
`skills/harness-connect-window-claude`를 선택하며 `.claude/skills/harness-connect` 아래의
정확 `scripts/connect.mjs`와 `scripts/claude-session-hook.mjs`를 유지하고
`scripts/connect-window.mjs`와 `scripts/claude-window-session-hook.mjs`를 추가합니다.
window recorder는 `.harness-delta/claude-window-receipts`를 사용하며 정확 모드 schema 1의
의미와 다른 설정은 바꾸지 않습니다.

`ordinary_window` 모드에서만 설치기는 프로젝트 `.claude/settings.local.json`의
SessionStart command group 정확히 하나를 추가로 소유합니다. 명령은 설치기를 실행한
Node 실행 파일의 따옴표로 감싼 절대 경로, 설치된
`.claude/skills/harness-connect/scripts/claude-window-session-hook.mjs` 경로와
`record`이며 `timeout: 10`을 씁니다. manifest가 이 항목을 기록합니다. 미리보기는 이를
별도의 계획된 변경으로 보여 주고, 명시적 apply만 소유 파일과 같은 검토·오래된 미리보기·lock
규칙 아래에서 씁니다. 파일의 나머지 바이트는 그대로 유지됩니다. 파일이 없으면 설치기가
만듭니다. Claude Code는 trust, MCP, 권한 선택을 저장하면서 이 파일을 직접 다시 쓸 수
있습니다. status, arm, connect, 제거는 서식, key 순서, 무관한 추가 내용을 허용합니다.
소유 group은 여전히 내용으로 일치해야 합니다. 명령, type, timeout, key 집합이 같아야 하고
다른 hook이 더 있으면 안 됩니다. 중복되었거나 외부의 harness hook은 계속 차단합니다.
미리보기와 apply 사이에 바이트가 하나라도 바뀌면 그 미리보기는 계속 무효가 됩니다.
제거는 소유 항목만 지우며, 설치기가 만들었고 이제 그 밖에 비어 있는 파일만
삭제합니다. 설치 후 파일이 다시 쓰이지 않았다면 제거는 원래 바이트를 복원합니다. 다시
쓰였다면 소유 항목만 지우고 나머지는 Claude Code가 쓴 현재 바이트 그대로 둡니다.
소유 항목 자리에 편집되었거나 외부의 항목이 있으면 편집된 소유 파일처럼 제거를
차단합니다. 정확 모드와 window 모드 사이의 migration은 모드에 맞춰 등록을 추가하거나
제거합니다. 정확 모드만 설치하는 경우에는 설정을 수정하지 않으며 `.claude/settings.json`과 전역·사용자 설정은
건드리지 않습니다. 등록이 구성되었다고 해서 Claude Code가 workspace를 신뢰하거나 hook을
전달한다는 증거는 아니며, 이는 운영자가 계속 확인해야 합니다. 설치는 수집을 허가하거나
control을 만들거나 native binary를 실행하지 않습니다. arm하지 않은 시작은 조용합니다.
유효한 상위 디렉터리 아래 receipt 디렉터리 자체가 없거나, 유효한 디렉터리에 control 파일이
없으면 recorder는 출력과 receipt 없이 0으로 종료합니다. 그 밖의 실패는 계속
`binding_window_hook_metadata_unavailable`을 표시합니다. control이 없거나 닫혔거나 잘못된 경우 아무것도 emit하지 않으며,
오래되거나 위조된 active control도 허용 목록의 미검증 pending 메타데이터만 허용합니다.
recorder와 helper는 native 원본·process·version·image를 탐색하지 않습니다.

A/B 배정 대신 새 일반 작업을 준비합니다. 지정 버전, 유한 정책, 엄격한
`claude_terminal_message_v1` finality, publisher/local-pin 모드, root 전용 범위와 가격을
고정합니다. 연결에는 명시적으로 활성화된 준비 작업, 별도의 유효한 제품 활성화, 새 root
receipt와 일치하는 scoped source가 필요합니다. 설치된 window helper에는 명시적인
origin·프로젝트·작업·receipt ID만 전달합니다. process를 찾거나 receipt를 추측하거나
작업을 시작하지 않습니다. 버전이 지정된 작업 조회와 CSRF·If-Match·idempotency로 보호한
connect는 유효한 root 연결을 다시 검사하며, `automatic_children:false`를 반환하고
변경 요청을 무작정 재시도하지 않습니다.

별도 승인된 Claude trial에서는
[로컬 측정](local-measurement.ko.md#버전-적합성-확인-업데이트-제어)의
`hm compatibility ordinary-window` `arm`, `status --arming`, `disarm` 절차를 따르세요
(작업이 비활성이고 열린 binding이 없을 때 소유 Claude window 패키지를 설치·업데이트하고,
receipt-only 발행을 arm한 뒤 프롬프트 없이 새 root를 실행하여 root `SessionStart`
receipt를 확인·활성화하고, root transcript가 생성되도록 첫 메시지 하나를 보낸 뒤 connect하고
측정 작업과 collect를 진행합니다). `receipt_only`에서 `SubagentStart`와 `SubagentStop`은
receipt를 발행하지 않습니다. arming은 native trial 권한이나 추가 지원을 부여하지 않습니다.

payload-only helper가 아니라 유효한 권한을 가진 provider가 same-user PID/start,
해당 process에서 얻은 정규 실행 파일 경로, 승인된 publisher와 로컬 disk pin을 확인합니다. native adapter는
standalone macOS arm64 CLI layout으로 제한하며 알 수 없는 host/layout은 거부합니다.
source version은 고정된 지정 버전과 독립적으로 같아야 합니다. signature나 disk SHA는
version이나 mapped image의 증거가 아닙니다. `publisher_verified_local_pin` 관측은
부분적인 `compatibility_unverified` 상태입니다. root-source 사용량은 root 자체 사용량이
아니며, 소유는 미검증이고 자식 기여 가능성은 알 수 없으며 자식 사용량·비용은 0이 아닌
미관측 null입니다. subagent 메타데이터는 자식을 연결하거나 자식 원본을 읽지 않습니다.

침묵이나 과거 quiescence가 아니라 엄격한 terminal 근거로 사용량을 확정합니다. 필수 계약,
identity, version이나 소유의 모순은 사용량·cursor의 부분 쓰기 없이 해당 관측을 중단하며,
이후 비호환이 발견되면 해당 cohort를 무효화합니다. 일시정지나 observer 재시작 뒤에도 같은
작업·버전의 scoped 재연결은 지정 버전, source 참조와 native pin digest가 같으면 native
root, PID와 source 경로를 재사용할 수 있습니다. identity와 pin을 다시 검증하고 새 관측
segment와 기준점을 시작하며 일시정지 구간은 backfill하지 않습니다. 현재 generation의 활성
root, 다른 작업의 root나 identity/pin이 달라진 경우에는 재사용할 수 없습니다. native
resume을 허용하거나 활성화와 native 검증을 우회하는 것은 아닙니다. N -> N+1에서는 새 지정
버전을 명시적으로 저장하고 새 root identity로 새 작업을 준비해야 합니다. 기존 작업·가격은 옮기지 않고, 범용
helper는 patch마다 다시 쓸 필요가 없으며 누락 구간도 backfill하지 않습니다.
[ADR 016](../decisions/016-ordinary-observation.md#claude-ordinary-window-addendum-collection-disabled)과
[Claude 정책](../decisions/013-forward-version-compatibility.md#claude-root-reference-exception)을 참고하세요.

## Codex 0.163.0 제한 일반 profile

<!-- tool-version-assets:codex-ordinary-profile:start -->
정확한 `codex-binding-01630-direct-family-v1` 소스는 등록된 동결 `functional_pilot`에서
새 CLI 부모 한 개와 새 직접 자식 최대 두 개를 허용합니다.
<!-- tool-version-assets:codex-ordinary-profile:end -->
[기존 profile](#codex-01621-제한-일반-profile)의 GPT 계열·관측 effort 정책,
접근 전 receipt 검증, 과거 구간 제외, replay 및 토폴로지 제한을 유지합니다.
프로젝트 연결 설정에서 버전을 명시적으로 선택하세요.

2026-10-16 macOS arm64 / Node 24 native 시험은 gpt-6.1-sol/high,
read-only/on-request/no-daemon과 명시적으로 1회 승인된 network 전용 연결 명령을 사용했습니다.
새로 연결한 소스 세 개, 관측 여섯 요청(부모 네 개·자식 각 한 개),
연결 기준선에서 제외한 세 요청과 소유 프로세스 종료를 확인했습니다.
새 소스만 자체 정확한 provenance를 사용하며 파일·workflow 호환성과 기존 profile·pin은 유지합니다.

비용은 부분 기준 추정값이며 완전 합계나 공급자 청구액이 아닙니다.
페이지로 나뉜 상속 이력이 있는 자식은 자체 suffix를 검증할 수 있어도 자식 사용량을
수집하지 않고 `candidate_unsupported_history`를 기록합니다. 이 검사는 family 등록,
관측기 재연결 및 이후 모든 사용량 읽기에 적용합니다.
resume, 더 깊거나 추가된 자식, 도구 소유 launch와 추론 채택은 이 profile로 허용하지 않습니다.
종료·미완료 응답의 완전성도 검증하지 않았습니다.
[native 검증 기록](../validation/codex-ordinary-binding-qualification.ko.md#2026-10-16-ordinary-route-acceptance)을 확인하세요.

## Codex 0.162.1 제한 일반 profile

새 `ordinary_admission` 실행과 독립 검토로 이 정확한 제한 경로를 검증했습니다.
[날짜별 승인 증거](../validation/codex-ordinary-binding-qualification.ko.md#2026-10-13-ordinary-route-acceptance)를 참고하세요.
기존 lease 기반 관측과 synthetic fixture는 별도 증거이며,
다른 일반 경로를 검증한 것은 아닙니다.

고정된 `functional_pilot` protocol에 코드 소유 source profile
`codex-binding-01621-direct-family-v1`, 정확한 버전 `0.162.1`, 등록 작업을
사용합니다. 작업 초기 모델은 비워 둘 수 있으며 이때 관측된 native 모델을 쓰고,
GPT 계열 모델을 지정하면 그대로 유지합니다. 이 기능 protocol은 도입 실험을 허용하지
않습니다. `session_binding`에는 검토된 Codex receipt 디렉터리, 허용 source
root와 등록 프로젝트를 설정합니다. Qualification lease, `native-pilot` 명령,
브라우저 지원 플래그가 admission을 부여하지 않습니다.

2026-10-13 native 증거는 검토된 read-only·no-daemon 실행의 새 CLI root와 새 직접
자식 2개, `gpt-6.1-sol/high`입니다. 사용자가 승인한 2026-10-15 정책에 따라 일반
사용은 모든 GPT 계열 모델을 허용하며 추론 effort를 강제하지 않습니다. 일반
coordinator는 root 최대 1개·직접 자식 최대 2개를 허용하고, 관측된 native 모델이
GPT 계열인지 확인하며 모델과 effort를 관측값 그대로 저장합니다. 이 정책 변경을
위한 새 native 실행은 하지 않았습니다. GPT 계열이 아닌 모델,
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

<a id="일반-claude-관측-지원-검증-대기"></a>

## 일반 Claude 관측

새 프로젝트 설정의 기본값은 별도 exact profile `claude-binding-2-1-306-family-v1`입니다.
Claude Code 2.1.306과 설치된 binary에서 root 하나와 flattened 멤버 둘까지 허용합니다.
별도 exact profile `claude-binding-2-1-301-family-v1`은 명시적으로 설정한
Claude Code 2.1.301에 같은 한도를 적용합니다. 이전 기본값 Claude Code 2.1.296을 포함한
저장 설정과 고정된 작업은 유지됩니다. 프로젝트 설정 API는
`{"operation":"configure","product_version":"2.1.301"}`을 받으며, 버전을 생략하면
기존 저장값 또는 2.1.306 기본값을 사용합니다. UI의 기본 정확 버전 모드에는 Claude 버전 드롭다운이 없고, **정확 버전**과 **일반 window** 사이를
전환할 때 명시적 버전 입력칸이 표시됩니다.
binary, receipt, transcript는 같은 작업의 고정 버전과 일치해야 합니다.
모든 일반 Claude record는 `qualified: false`를 유지합니다. 2.1.296, 2.1.301, 2.1.306의
제한된 print-mode 적합성 검증은 interactive 사용, 인증 일반 경로 합격 또는 완전한
사용량·비용을 검증하지 않습니다. [Claude 검증 기록](../validation/claude-ordinary-binding-02196-qualification.md)과
[지원 매트릭스](../support-matrix.ko.md#정확한-경로)를 참고하세요.
파일·workflow 및 과거 pin의 신뢰 상태는 승격하지 않습니다.

사용자가 승인한 2026-10-15 정책에 따라 이 흐름은 일반 사용이 허용됩니다. 코드 소유
profile `claude-binding-02196-family-v1`은 정확한 Claude Code 원본 버전과 binary
hash에서만 일반 연결을 허용합니다. 모든 Claude 모델(대소문자 구분 없이 정확히
`claude`이거나 `claude-`로 시작하는 모델 ID)을
받아들이며 관측된 모델과 effort를 그대로 저장합니다. 일반 사용 허용은 profile의
과거 `qualified: false` 증거 표시와 별개입니다. 이 표시는 승격되지 않았고, 이 정책을
위해 새 native 시험을 실행하지도 않았습니다. 다른 원본 버전이나 binary는 여전히 고정
코드로 거부되며 native 원본을 읽지 않습니다.
[ADR 016](../decisions/016-ordinary-observation.md#policy-addendum-2026-10-15)을 참고하세요.

평소의 [로컬 브라우저 UI](local-browser-ui.ko.md#로컬-서비스-시작)를 사용합니다.
pilot 플래그, qualification lease, 브라우저 입력으로는 이 경로를 열 수 없습니다.

1. **프로젝트 설정.** 로컬 설정에서 등록 프로젝트의 Claude 연결 설정 카드를 열고
   Claude 설정을 선택합니다. 지원되는 정확한 버전, 프로젝트 안의 receipt 디렉토리
   `.harness-delta/claude-connect/receipts`, Claude projects 디렉토리를 저장합니다.
   다른 버전은 `claude_source_version_unsupported`를 반환합니다.
2. **미리보기 후 설치.** 설치·갱신 미리보기를 선택합니다. 상태 조회와 미리보기는
   파일을 쓰지 않습니다. 미리보기는 `.claude/skills/harness-connect` 아래의 상대
   경로마다 동작과 hash를 보여 줍니다. 검토한 뒤 설치 버튼을 선택하세요. 이
   설치기가 소유한 파일만 바뀝니다. 수정되었거나 소유하지 않았거나 안전하지 않은
   경로는 `package_unowned`, `package_drift` 같은 고정 코드로 차단합니다. 제거도
   같은 미리보기 후 적용 순서를 따릅니다. 프로젝트에 활성 일반 작업이 있으면
   `ordinary_installation_in_use`로 거부하며, receipt와 native transcript는 남깁니다.
3. **작업 생성.** 새 작업에서 일반 Claude 관측 모드, 이름, 프로젝트와 완료 기준을
   선택합니다. UI는 `user_confirmed_completion`을 제공합니다. 비교 setup, protocol,
   arm은 없습니다. 작업은 생성 시점의 프로젝트 설정과 가격표를 고정합니다.
4. **native 부모에서 연결.** Claude를 직접 열고 작업 화면에 표시된 명령을 부모
   세션에서 한 번 실행합니다.
5. **관측 제어.** 작업 화면의 일시중단, 재개, 관측 종료와 결과 버튼을 사용합니다.
   완료는 사용자가 결과를 직접 확인해야 합니다.

```text
/harness-connect Connect this session to project PROJECT_ID, task TASK_ID, using http://127.0.0.1:PORT.
```

패키지를 설치해도 hook이 등록되지는 않습니다. hook은 native 부모에서 skill을
호출할 때 등록되며, 설정 카드는 hook 등록을 `unverified`로 표시합니다. 패키지 복사,
hook 등록, native receipt, 관측 중은 서로 다른 네 가지 사실입니다. 모델, effort,
권한, 실행과 종료는 Claude에서 사용자가 직접 제어합니다.

허용된 경로는 다음과 같이 동작합니다.

- **작업당 측정 root 하나.** 연결할 때마다 새 측정 root ID를 만듭니다. native 세션
  identity는 따로 저장하며 다시 쓰지 않습니다.
- **native root 독점.** 살아 있는 native root는 한 작업만 예약합니다. 해당 segment가
  acquiring, paused, stopping인 동안에도 예약은 유지됩니다. 같은 root를 제시한 다른
  작업은 `binding_session_conflict`를 받습니다.
- **작업 넘기기.** 첫 작업에서 관측 종료를 선택합니다. Claude는 계속 실행됩니다.
  그다음 두 번째 작업으로 skill을 다시 호출합니다. 종료 전에 기록된 receipt는
  `binding_receipt_stale`을 반환합니다. 두 번째 작업은 새 baseline, 자체 측정 ID와
  가격 고정으로 시작합니다. 과거 기록은 다른 작업으로 옮기지 않습니다.
- **일시중단과 재개.** 일시중단은 segment를 유지합니다. 재개는 선택된 live
  identity만 재검증한 뒤 새 baseline을 잡습니다.
- **재시작과 재실행.** 서버 재시작 후 작업은 paused로 남고 스스로 읽지 않습니다.
  같은 native session ID를 재개하더라도 다시 실행한 Claude의 process identity는
  새로 생깁니다. skill을 다시 호출하여 hook을 등록하고 새 측정 segment를 명시적으로 엽니다.
- **소급 수집 없음.** 일시중단, 오프라인, 연결 전 사용량은 미관측으로 남습니다.
- **Baseline 저장.** 제외 ID를 SQLite에 보관하므로 pilot 경로의 1,024개 한도가
  여기에는 적용되지 않습니다. pilot 경로의 한도는 그대로입니다.
- **가족 한도.** Claude Code 2.1.296으로 고정된 작업은 root를 포함해 최대 8개이며 아홉 번째는
  `binding_family_limit`을 반환합니다. Claude Code 2.1.301과 2.1.306으로 고정된 작업은 root를 포함해 최대
  3개이며 네 번째는 같은 코드를 반환합니다. 멤버는 root 아래로 평탄화하며,
  중첩 멤버의 직접 부모는 검증하지 않습니다.
- **모델.** 모든 Claude 모델을 관측된 effort와 함께 받아들이며 모델 고정은 없습니다.
  다른 제품 모델의 사용량 기록은 `binding_runtime_unsupported`로 수집을 중단합니다. 같은 batch의 지원 모델 기록을
  포함해 해당 source batch 전체를 거부합니다. 명시적 재개는 새 baseline으로 그
  batch를 제외하며 소급 수집하지 않습니다.
- **삭제.** 관측한 작업을 삭제하면 그 native root를 잊습니다. 같은 root에 연결된
  다른 작업은 일시중단되고 그 root의 이후 연결은 거부됩니다. 새 native root로
  계속하세요. native transcript는 삭제하지 않습니다.
- **비용.** 사용량은 부분 관측입니다. 전체 비용, 청구, 추론 결과는 제공하지 않습니다.

새 관측은 별도의 `claude_binding` provenance를 가지며 이후 관측에만 적용됩니다.
비교, Codex, 파일, workflow의 trust 상태는 바뀌지 않습니다.

설정에서 `installation_recovery_required`가 나오면 설치 프로세스를 중단하고
`.harness-delta/claude-connect/installation-lock/owner.json`의 PID가 존재하지 않는지
확인하세요. UI 복구는 종료된 설치 프로세스의 깨끗한 잠금만 해제합니다.
남아 있는 `transaction-*` 디렉토리는 거부하며 알 수 없는 파일을 삭제하지 않습니다.
중단된 transaction은 먼저 설치 패키지를 `installation.json`의 모든
`installed_sha256`과 비교하세요. 일치하면 설치가 commit된 상태이므로 되돌리지 말고
transaction을 검토용으로 보관하세요. 현재 패키지는 다르지만
`transaction-*/previous`가 manifest와 일치하면 현재 패키지를 다른 위치로 옮겨
보존한 뒤 검증된 이전 디렉토리만 복원하세요. 둘 다 다르면 모든 파일을 보존하고
소유권 manifest를 대조한 뒤 다시 시도하세요. 불일치를 우회하려고 잠금이나
transaction을 삭제하지 마세요.

이 경로의 과거 증거에는 합성 unit, fake-provider, HTTP, UI 테스트, 범위가 제한된 실제
binary의 localhost conformance, 개발 전용 qualification factory를 통한 대화형 연결
관측이 포함됩니다. 연결 전용 시험 한 건에서 측정 행과 독립 API counter의 일치를
확인하고 Bash approve-once 승인 두 건을 처리했습니다. 일반 사용 정책은 이 증거를
바꾸지 않으며 전체 native qualification으로 다시 표시하지 않습니다. runtime 검사는
Node 24 또는 26의 macOS arm64를 받아들이고 그 외에는 `binding_runtime_unsupported`를 반환합니다.
Node 26은 별도 증거가 필요합니다.

## 프로젝트 설치 경계

아래는 수동 예시이며 자동 설치가 아닙니다. 대상을 선택하고 패키지를 검토하세요.
기존 목적지가 있으면 복사하지 않습니다. portable helper에는 Node 24 또는 26과 내장
라이브러리만 필요합니다. 스킬 복사는 전역 설정, AGENTS, 인증을 바꾸지
않습니다. 이 복사와 달리 Claude 일반 window 설치기의 미리보기·적용은 위 설정 절차에
설명한 대로 프로젝트 `.claude/settings.local.json`을 수정합니다. Claude에서 명시적 호출하면 세션 hooks가 등록되므로 패키지와 trust를
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
Claude: /harness-connect Connect this session to project PROJECT_ID, task TASK_ID, using http://127.0.0.1:PORT.
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
interactive qualification은 아직 완료되지 않았습니다. Claude Code 2.1.296, 2.1.301, 2.1.306 모두
제한된 print-mode transcript qualification을 갖습니다. Claude Code 2.1.301과 2.1.306은 localhost
정상 완료/SIGINT 적합성 검증을 포함하며 인증 ordinary 경로 검증은 아닙니다.
Claude Code 2.1.291, 2.1.293, 2.1.294 transcript profile은 candidate 상태입니다.
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

Node 24 또는 26과 기존 의존성을 사용합니다. `npm run check`의 build 이후 transport test가
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
선택적 Claude hook recorder 진단, 비공개 가족 거부 진단, 제한된 Start 준비 대기 동작은
[Claude hook 진단](claude-hook-diagnostics.ko.md)을 참고하세요.

Claude 기준선의 제외 own request ID는 실시간 replay 목록과 별도로 최대 1,024개를
보존합니다. 한도 초과(`claude_baseline_limit`)나 부분/해석 불가능한 기준선
(`claude_baseline_incomplete`)은 연결을 차단하며 제외 ID를 버리지 않습니다.
이미 관측한 요청의 counter 충돌도 수집을 중단합니다. 일반 관측 경로는 제외 ID를
SQLite에 보관하며 이 한도가 없습니다.

격리된 일반 Codex CLI qualification 실행기(`--product-version`, `--route qualification`과
`ordinary_admission`, binary·connector pin, 고정 consent, 버전별 정지 한도, OSC9
`native-attention.json` 알림, 소유 AI 긴급 중단)는
[qualification 절차](../validation/codex-ordinary-binding-qualification.ko.md)를 참고하세요.
준비와 Node fixture 검증만으로 production 지원이 열리지 않으며, 형제 thread row는 차단하고
pause 중 원본 카운터는 미확인으로 남습니다.

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
protocol에도 실제 버전을 동일하게 넣으세요. 기존 profile ID는 Codex 0.162.1 후보에도
사용하지만 executable이나 receipt의 버전을 Codex 0.162.0으로 바꾸지는 않습니다.
metadata-only 적용 신원은 transcript 읽기
권한이 아닙니다. native 시작 전에 프로젝트 로컬 hook 설치/trust와 정확한
receipt/source 디렉터리를 검토합니다. receipt를 임의로 만들면 안 됩니다.
새 root 하나만 허용하며 자식 세션은 미지원입니다.

`agent_applied`라면 먼저 별도 적용 세션을 완료하고 실제 파일과 검사를 검토한 뒤,
선택한 checkout의 새 작업 root에서 `harness-connect`를 호출합니다.
적용 세션 신원 재사용, 미완료 적용, 파일 변경, 이전 root는 계속 차단됩니다.

자체 응답 관측은 Codex 0.160.0 파서를 재사용하며 immutable `codex_workflow` parser
lineage와 `compatibility_unverified`를 표시합니다. 이 표시는 launch 권한이나
production admission이 아닙니다. 계약 실패는 다음 source 읽기 전에 공통
parser tuple을 무효화합니다. 비용은 부분 기준가격 추정이며 전체 합계,
native 지침 로딩 증명이나 추론이 아닙니다.
[ADR 013](../decisions/013-forward-version-compatibility.md)을 참고하세요.

[Codex 0.162.1 릴리스](https://github.com/openai/codex/releases/tag/rust-v0.162.1)는
TUI 질문과 시작 시 feature 호환성을 수정합니다. 합성 검사는 버전별 receipt,
선택 checkout의 적용 신원, root-only 관측, pause/resume과 계약 무효화를 다룹니다.
native hook 로딩이나 최신 counter 의미를 검증하지는 않으며 별도로 승인된
native 시험이 계속 필요합니다.

## Claude 사용자 조작 UI pilot

로컬 운영자는 `claude-ordinary-human-pilot` source profile을 사용한 준비된
`functional_pilot` 작업 하나를 선택할 수 있습니다. [매트릭스](../support-matrix.ko.md#정확한-경로)에
`transcriptProfile`이 선언된 정확한 버전을 사용하세요. transcript qualification은
ordinary admission이 아닙니다. 기존 file·실행 workflow의
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

각 버전의 `transcriptProfile` 상태는 [지원 매트릭스](../support-matrix.ko.md#정확한-경로)와
[Claude 검증 기록](../validation/claude-ordinary-binding-02196-qualification.md)에서 확인하세요.
2.1.296, 2.1.301, 2.1.306은 제한된 print-mode 증거만 가지며(interactive·인증 일반 경로
검증이 아니며, 2.1.296 pilot에서 skill 범위의 `SubagentStop` hook은 receipt를 남기지 않았고
탐색도 여기에 의존하지 않습니다), 2.1.291, 2.1.293, 2.1.294는 합성 전용 후보입니다.
모든 비교/pilot Claude profile에는 `allowCandidateProfiles: true`가 필요하며 pilot profile에
대한 기본 provider 거부는 계속 유지됩니다. 현재 label인 `native_unverified_pilot`,
`legacy_unverified`, `candidate_pilot`은 유지됩니다. 이 pilot profile이 일반 제품 수집을
허용하지는 않으며, 전체 작업 비용과 추론 결정은 아직 사용할 수 없습니다.
이 pilot 권한은 [일반 관측 admission](#일반-claude-관측-지원-검증-대기)과 별개이며,
그 admission이 pilot profile을 열지는 않습니다.
