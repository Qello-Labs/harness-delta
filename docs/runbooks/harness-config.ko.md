# 휴대 가능한 하네스 구성

[English](harness-config.md)

## 1. 선택한 파일 준비

Node 24 또는 26과 빌드한 Harness Delta checkout을 사용하세요.

```sh
npm ci
npm run build
```

대상 프로젝트에서 기존 Markdown 지침과 고정하려는 관련 파일만 선택하세요.
`harness-notes.md`에 목적, 프로젝트 루트에서의 수동 적용, 의존성, 선택한 파일의
범위와 수동 검증 방법을 작성하세요. 도구 명령은 수동 절차입니다. 등록은 원본을
유지하고 파일 내용을 그대로 복사합니다.

예상 구조:

```text
harness-config/
├── baseline/
│   ├── harness.md
│   ├── README.md
│   ├── manifest.json
│   └── scripts/search.py
├── v2/
│   ├── harness.md
│   ├── README.md
│   ├── manifest.json
│   └── scripts/search.py
└── comparisons/baseline-vs-v2.json
.harness-delta/setup/
├── baseline-vs-v2-<revision-hash>.json
└── tasks/<task-id>.json
```

`harness-config`는 의도적으로 Git에 공유할 수 있습니다. 공개 전에 선택한 파일을
확인하세요. PC별 비공개 연결은 Git에서 제외되는 `.harness-delta/setup`에
저장합니다. 이 디렉토리를 Git에 넣지 마세요. revision 접미사는 과거 작업의
고정 정보를 바꾸지 않고 여러 검토된 로컬 설정을 유지하기 위한 것입니다.

## 2. baseline과 수정 버전 등록

A는 프로젝트에 현재 적용된 구성이고 B는 준비한 개선 후보입니다.
등록 전에 후보 지침·적용 절차와 필요한 스크립트를 준비하세요.
양쪽 구성에서 공통 프로젝트 규칙은 유지합니다. 에이전트가 파일을 확인하고
기준·후보에 포함할 파일과 식별자를 제안한 뒤 확인받아 등록합니다.
후보 파일이 프로젝트에 존재하는 것만으로 이미 적용된 상태는 아닙니다.

사람이 채택하고 실제 적용한 구성은 다음 비교에서 새 후보와 비교할 A가 될 수
있습니다. A/B는 버전 이름이 아닌 비교 역할입니다. 기존 기준 묶음의 선택 파일이
확인된 현재 구성과 일치할 때만 재사용하고, 다르면 새 버전을 등록하세요.
과거 버전·비교·작업 배정은 유지합니다. 등록과 비교 파일 생성은 승자를 적용하거나
채택하지 않으며, 부분 추정치만으로 우수성이 입증되지 않습니다.

생성될 버전 디렉토리 밖에 선택 입력 파일을 작성하세요.

artifact의 `source_path` 파일은 `harness-config/` 디렉토리 전체의 바깥에 두세요.

```json
{
  "schema_version": 1,
  "harness_id": "search",
  "version": "baseline",
  "policy_version": "policy-v1",
  "readme_path": "harness-notes.md",
  "artifacts": [
    {"artifact_id":"instruction","role":"instruction","source_path":"policy.md","target_path":"harness.md"},
    {"artifact_id":"search-tool","role":"tool","source_path":"scripts/search.py","target_path":"scripts/search.py"}
  ]
}
```

빌드한 Harness Delta checkout에서 실행하세요.

```sh
node dist/harness-config-main.js register --root /path/to/project --input /path/to/register-input.json
```

예상 결과는 `registered`이며, 같은 입력을 반복하면 `already_registered`입니다.
수정한 파일을 등록하려면 `version`을 `v2`로 바꾸고 필요하면
`"base":{"path":"harness-config/baseline/manifest.json"}`을 추가하세요. 같은 명령을
실행하세요. 기존 버전에 다른 내용을 등록하면 `harness_version_conflict`입니다.
공개한 버전을 수정하지 말고 새 버전을 선택하세요.

경로는 프로젝트 내부의 이식 가능한 ASCII 구성 요소를 사용합니다. 절대 경로,
상위 경로 이동, 심볼릭 링크, 대소문자 경로 충돌과 Windows 장치 이름을 거부합니다.
주 지침의 대상은 `harness.md`입니다. 선택 artifact는 최대 255개이며, `readme_path`에서
복사한 README 항목을 더해 manifest artifact는 최대 256개입니다. 파일당 1 MiB, 합계 16 MiB입니다.
선택 파일 누락과 해결되지 않는 인라인 로컬 Markdown 링크는 생성을 막습니다.
명령 문자열, 참조형 링크, 원격 링크와 의존성 전체는 완전히 검증하지 않습니다.
누락 파일을 명시적으로 제공하거나, 선택하지 않은 선행 조건과 한계를 README에
설명하세요.

## 3. 휴대 가능한 비교 설정 생성

비교 입력을 작성하세요.

```json
{
  "schema_version": 1,
  "id": "baseline-vs-v2",
  "name": "Baseline vs v2",
  "arm_a": "baseline",
  "arm_b": "v2"
}
```

```sh
node dist/harness-config-main.js compare --root /path/to/project --input /path/to/comparison-input.json
```

예상 결과는 `generated`이며, 같은 입력을 반복하면 `already_generated`입니다.
기존 ID의 내용을 바꾸면 `shared_settings_conflict`입니다. 비교 파일에는 상대
manifest 참조와 해시가 들어갑니다. baseline은 A, 수정 버전은 B입니다.
모델·effort, 로컬 DB 식별자나 실험 기본값은 포함하지 않습니다. 도구만 변경해도
지침 해시가 동일한 상태에서 전체 묶음 해시가 바뀝니다. 해시는 무결성을 나타내며
진위나 실제 사용을 증명하지 않습니다.

선택적으로 사용할 저장소 참조 스킬은
[harness-register](../../skills/harness-register/SKILL.md)와
[harness-compare-config](../../skills/harness-compare-config/SKILL.md)입니다. 도우미에
`--harness-delta` checkout을 명시해야 하며 전역 플러그인은 필요하지 않습니다.
스킬 설치와 하네스 snapshot 생성은 별도 작업입니다.

## 4. PC별 연결

먼저 기존 [검토된 로컬 설정 선행 조건](local-browser-ui.ko.md)과
[비교 등록](task-comparison.ko.md)을 완료하세요. 프로젝트, 순서가 맞는 호환 variant,
동결된 protocol, 완료 기준, 가격 기준과 검토된 실행 설정이 필요합니다.
이 기능은 해당 항목을 생성하거나 동결하지 않습니다. 공유 harness-config 파일을
등록한 프로젝트 checkout에 복사하세요.

1. 로컬 UI → 설정에서 비교 JSON 파일을 선택하세요.
2. snapshot 무결성과 A/B 각각의 원본 도구 호환 상태를 확인하세요.
3. 등록한 프로젝트와 검토된 로컬 측정 기준을 직접 선택하세요.
4. **로컬 설정 연결**을 선택하세요.

예상 결과는 `.harness-delta/setup`에 변경 불가능한 비공개 JSON이 생성되고 새
작업에서 설정을 선택할 수 있는 상태입니다. 같은 입력을 반복하면 기존 연결로
표시합니다. 불러오기는 세션을 읽거나 작업·도구·에이전트·모델을 시작하지 않습니다.
등록 누락이나 A/B 순서 불일치는 계속 차단합니다. 이름으로 설정을 식별하지
않으며 이름이 같은 항목도 명시적인 ID로 구별합니다.

연결한 뒤 시작할 때:

```sh
node dist/cli.js --db /path/to/local.sqlite ui --setup /path/to/project/harness-config/comparisons/baseline-vs-v2.json
```

일치하는 revision이 없으면 `shared_binding_required`, 여러 개이면
`shared_binding_selection_required`입니다. 하나를 직접 선택하세요.

```sh
node dist/cli.js --db /path/to/local.sqlite ui --setup /path/to/project/harness-config/comparisons/baseline-vs-v2.json --setup-binding-revision shared-<revision-hash>
```

실제 비공개 revision ID를 사용하세요. 기존 검토된 로컬 manifest도 지원합니다.
실행 설정이 다른 template은 향후 작업을 위한 별도 revision을 만듭니다.
기존 작업의 고정 정보를 바꾸지 않습니다.

## 5. 작업 준비와 측정

연결한 설정으로 작업을 만드세요. 작업과 A/B 배정 식별자는 예약되며 중단해도
유지됩니다. 준비 차단 상태는 화면에 남습니다. 선택한 원본 파일을 수동으로
바로잡고 같은 작업의 준비를 재시도하세요. snapshot의 도구를 자동 복구하거나
일치하는 arm을 받기 위해 재배정하지 마세요. 기존 준비·적용·새 세션·연결 흐름을
따르세요. 현재 작업 흐름이 관측을 허용한 뒤 실제 작업을 시작하세요.

관측 중 snapshot·비공개 설정·원본 도구 파일이 바뀌거나 사라지면 수집이 멈춥니다.
읽던 불확실한 데이터는 버리며 기존 관측값, 부분 비용, 시간 창, 배정과 결과는
계속 볼 수 있습니다. 수정한 뒤 직접 계속하기·재연결해야 하며 자동 재개나
누락 구간 소급 수집은 하지 않습니다.

snapshot 무결성은 네이티브 시작 순서, 지침 로딩, 도구 실제 실행이나 의존성을
입증하지 않습니다. 기존 정확한 버전과 상위 버전 호환 표시를 유지합니다.
[현재 네이티브 지원 한계](task-native-workflow.md)와
[ADR 014](../decisions/014-portable-harness-config.md)를 참고하세요.
이 기능으로 전체 작업 비용, 통계적 채택 판단이나 새 네이티브 지원이 생기지 않습니다.

미리보기 뒤 선택한 비교 파일이 바뀌면 연결은 `shared_preview_changed`로 차단됩니다. 다시 불러와 확인하세요. 작업의 설정 선택에서 revision ID와 검토한 template·실행 설정을 구별할 수 있습니다. 프로젝트를 삭제한 뒤 같은 디렉토리를 다시 등록해도 이전 연결은 이전되지 않습니다. 비공개 JSON은 로컬에 남습니다. 과거 작업 기록이 더 이상 필요하지 않을 때 오래된 비공개 파일을 의도적으로 보관하거나 제거하세요.

## 6. 에이전트 적용 (format 2)

배정된 번들에 프로젝트 규칙·스크립트를 적용하는 절차가 있으면 format 2를
사용하세요. 두 버전을 정상 등록한 뒤 다음 비교를 생성하세요.

```json
{
  "schema_version": 2,
  "id": "agent-baseline-vs-v2",
  "name": "Agent baseline vs v2",
  "arm_a": "baseline",
  "arm_b": "v2",
  "application": "agent_applied"
}
```

1. 비교를 불러오고 검토된 로컬 template을 연결한 뒤 작업을 준비하세요.
   UI는 파일을 적용하거나 수집을 시작하지 않고 배정을 저장합니다.
2. 기존 checkout/worktree와 Codex 또는 Claude Code를 선택하세요. 브랜치와
   HEAD를 확인하고 네이티브 세션 문맥을 준비하세요. 재시도는 배정을 유지하며
   브랜치를 바꾸거나 새 worktree를 자동 생성하지 않습니다.
3. 새 네이티브 세션 열기를 요청하세요. CLI가 설치된 macOS에서는 준비된
   프롬프트를 전달하는 Terminal 인터랙티브 세션을 요청합니다. 명령 문법은
   Codex CLI 0.161.0과 Claude Code 2.1.295에서 확인했지만 실제 창 열기와
   에이전트 수용 검증은 남아 있습니다. 데스크톱 프롬프트 deep link와 다른
   플랫폼은 지원하지 않습니다. 사용할 수 없거나 실패하면 선택한 대상에서
   새 세션을 직접 열고 복사 가능한 적용 문맥을 붙여 넣으세요.
4. 해당 세션의 에이전트가 harness-apply로 배정된 번들을 읽고 도메인을 조사해
   대상 파일을 직접 수정합니다. 필요한 출력 경로를 발견하면서 각 파일을
   편집 전에 checkpoint합니다. 관련 없는 dirty/untracked 파일을 보존하세요.
   파일·명령 권한은 네이티브 창에서 결정하세요.
5. 편집 후 UI에서 실제 변경과 검사 결과를 확인하세요. 보고된 파일 집합의
   해시는 독립 검증합니다. 스크립트·검사 결과는 `agent_reported`이며 누락·거부·
   실패 결과를 표시합니다. 전체 파일 시스템·도구 감사는 아닙니다. 별도 게시
   승인은 없습니다.
6. 적용 검증 후 채워진 작업 세션 안내를 복사하세요. 대상에서 별도의 새 세션을
   열고 harness-connect를 사용하세요. 파일 적용은 생성 지침의 로딩이나 측정
   준비를 입증하지 않습니다. 기존 신원·로딩·원본 지원 gate를 유지하며, 이
   기능의 작업 세션 경로는 production 지원 검증 대기 중입니다. 명시적인
   Codex 0.162.0/0.162.1 root-only 로컬 functional pilot은 파일 적용을 완료하고
   별도 작업·원본 권한을 받은 뒤 연결할 수 있지만, parser 기준값은
   미검증입니다. [제한된 pilot](harness-connect.ko.md#codex-01620-일반-root-로컬-pilot)을 참고하세요.

적용 helper 동작은 `context`, `checkpoint`, `identity`, `report`, `status`입니다.
설치된 skill 경로와 Node 24 또는 26을 사용하세요. checkpoint는 실제 dirty 내용과 파일
부재를 보존하며, 기준 누락은 거절하고 Git HEAD로 대체하지 않습니다. 보고에는
해시와 제한된 검사 ID·결과만 넣고 소스 내용·비밀·명령 출력을 넣지 마세요.
숨김 경로·symlink/hardlink·비공개 DB 및 sidecar·등록 번들·node_modules·알려진
비밀 경로는 지원하지 않습니다. 파일당 1 MiB, 시도당 checkpoint 경로 256개가
한도입니다. checkpoint/report HTTP 본문과 helper 입력 파일은 1 MiB가
한도이며, 나머지 쓰기 경로는 16 KiB 전송 한도를 유지합니다.

복사 대안은 자동 열기의 증거가 아니며 열기 응답은 에이전트 시작의 증거가
아닙니다. 같은 시도의 열기 중복 클릭은 창을 다시 요청하지 않습니다. 열기를
다시 시도하려면 먼저 기존 시도를 포기하세요. 완료 후 파일이 바뀌면 기존
시도를 포기하고 새 문맥을 준비하면서 해당 사용자 변경을 보존·검토하세요.
포기·서버 재시작은 네이티브 에이전트를 중지·재실행하거나 파일을 되돌리지
않습니다. 네이티브 창에서 직접 중지하세요. 오래된 helper와 삭제된 작업은
계속 차단합니다. 삭제는 제품 소유 검토·열기 자료를 제거하되 작업 공간의 수정과
불투명한 적용 세션 제외 정보는 보존합니다. 비공개 루트가 교체되었거나 안전하지
않으면 `application_cleanup_pending`을 표시합니다. 원래 비공개 디렉터리를
복원하고 삭제를 재시도하세요. 작업은 삭제된 상태를 유지합니다.

적용 역할 등록은 metadata-only 신원 provider가 필요합니다. 현재 Codex 루트
receipt 연동은 기존의 정확한 버전 제한을 유지합니다. Claude 적용 신원 resolver는
사용할 수 없으며, 파일 적용 결과는 표시하되 후속 연결은 차단합니다. cwd나
에이전트 주장으로 세션을 식별하지 마세요. 적용 세션에서 harness-connect를
실행하지 마세요.

[ADR 015](../decisions/015-agent-harness-application.md)를 참고하세요. 합성 테스트는
연결과 무결성만 검증합니다. 창 열기·프로젝트 적응·스크립트·권한·작업 세션의
지침 로딩은 별도로 승인된 네이티브 수용 검증이 필요합니다.
