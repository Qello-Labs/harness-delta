# 배정된 개발 작업 하나를 측정하기

[English](workflow-quickstart.md) · [문서 탐색](../../README.md#documentation)

부분 비용을 기술하는 작은 **기능 파일럿**에 이 절차를 사용하세요.
대상은 Codex 0.160.0(`codex-workflow-own-response-v1`)과
Claude Code 2.1.296(`claude-workflow-own-trace-v1`, 부모 전용; `claude-workflow-direct-child-v1`)과
아래의 조건부 후속 버전입니다.
논리적 작업마다 하나의 A/B 배정을 유지합니다.
모델과 effort는 실행마다 선택합니다. 새 세션을 열어도 배정은 바뀌지 않습니다.

## 지원 범위와 실행 비용

| 경로 | 지원 범위 |
| --- | --- |
| Codex 0.160.0 루트 workflow | launch, 같은 세션 resume, 명시적 독립 루트 link, 전경 collect, stop, recover; 부분 사용량 |
| Codex 0.160.0 직계 자식 workflow | 별도 프로필: 새 루트와 새 자식 1개, 고정 macOS arm64/Node24, read-only; family resume·외부 자식 link 미지원 |
| 기존 파일 수집기 | 정확한 프로필: Codex 0.156.1/0.158.0, Claude Code 2.1.283; 조건부 파일 버전도 허용; [로컬 측정](local-measurement.ko.md) 참고 |
| Claude Code 2.1.296 부모 전용 workflow | 실행마다 새 launch(read-only 또는 `workspace-edit`), 같은 작업의 추가 launch, `resumable`로 유지한 세션의 resume, stop, recover; 부분 사용량. 2.1.288과 2.1.291은 지원 종료 |
| Claude Code 2.1.296 직계 자식 workflow | 별도 프로필: 새 read-only 루트와 read-only `workflow-child` 최대 1개; 정확한 버전 전용; resume·더 깊은 자식·추가 자식 미지원 |
| App/IDE/MCP, fork, compaction, 더 깊은 자식 | 이 절차에서 미지원 |
| 작업 전체 비용, 실제 청구액, 절감·도입 추론 | 제공하지 않음 |
| 팀 파일 교환 | 합성 검증 전용; 기능 파일럿 결과는 이 경로로 교환할 수 없음 |

정규 Codex 버전 `>0.160.0`, `<0.164.0`(0.162.1 포함)과 Claude Code 버전 `>2.1.296`,
`<2.2.0`은 `functional_pilot`에서 workflow 프로필을
재사용할 수 있습니다. 신뢰 상태는 `compatibility_unverified`이며 기준 추정액을
별도로 표시합니다. Claude 범위는 새 부모 전용 launch만 허용합니다. 자식과 resume은 허용하지 않습니다. 이 범위가 티켓 연결이나 일반 세션 가족의 검증을 대신하지는
않습니다. [버전 설정과 검사](task-native-workflow.md#conditional-forward-versions)를 참고하세요.

**실행 주의:** native launch/resume는 기존 인증 상태를 사용하며 유료 또는 구독 사용량을 소비할 수 있습니다.
실제 실행마다 먼저 승인하세요. timeout과 stop은 제공자의 지출 상한이 아닙니다.
입력 준비·등록·상태 조회는 제품을 실행하지 않습니다.

Codex 새 루트 launch의 `project_trust: "untrusted"`는 해당 실행의 프로젝트
로컬 설정·hooks·rules를 비활성화합니다. 그 효과가 의도된 경우에만 사용하세요.
resume/link/collect·자식 launch에는 적용되지 않습니다.
[실행 상세와 설정 범위 검증](task-native-workflow.md#codex-launch-resume-link-and-collection)을 참고하세요.

## 1. 저장소에서 설치하기

준비물은 Node.js 24 또는 26, npm, 선택한 workflow 버전에 허용되는 기존 고정 바이너리입니다.
고정된 Codex 직계 자식 workflow와 실제 native qualification에는 계속 Node 24가 필요합니다.
Node 26에서도 기존 루트 launch/resume 조정과 Claude 부모 launch를 사용할 수 있지만,
같은 실행별 승인과 원본 gate를 적용합니다. runtime 검증 범위는 합성이며,
추가적인 정확한 버전 native qualification을 뜻하지 않습니다.
로컬 검증 환경은 macOS arm64입니다. 다른 플랫폼은 미검증입니다.
패키지는 private 상태이며 공개 패키지 설치 절차는 없습니다.

1. 버전 관리자로 Node 24 또는 26을 선택하세요.
2. 저장소 루트에서 고정 의존성을 설치하세요.

   ```sh
   npm ci
   ```

3. CLI를 빌드하세요.

   ```sh
   npm run build
   ```

4. workflow 도움말을 확인하세요.

   ```sh
   npm start -- --db .harness-delta/pilot/local.sqlite workflow --help
   ```

예상 결과: `external`, `codex`, `claude`, `status`, `task`, `begin`, `finish`, `report`가 표시됩니다.
`external`은 별도의 [사용자가 여는 세션 절차](external-session-workflow.ko.md)이며,
아래의 도구 소유 launch 경로와 다릅니다.
4단계의 `workflow status`로 선택한 v2 native 지원 조건을 확인하세요.
`npm start -- <arguments>` 진입점은 SQLite를 로드하기 전에 Node 24 또는 26, 빌드,
설치된 의존성을 확인합니다. `unsupported_node`(exit 2), `build_required`(exit 3),
`dependencies_required`(exit 4)로 첫 실행 문제를 구분합니다.
`npm ci` 전에 Node 24 또는 26을 선택하세요. `npm exec node@24`만으로 셸이나 npm script가
해당 runtime을 쓰는지 확인할 수 없습니다. 같은 터미널에서 `node --version`을 확인하세요.
Node major를 바꿨다면 `npm ci`를 다시 실행해 SQLite를 선택한 runtime에 맞추세요.
설치가 실패하면 선택한 Node 버전과 [CONTRIBUTING의 SQLite 빌드 준비물](../../CONTRIBUTING.md#development-environment)을 확인하세요.
설치는 로컬 Git hooks도 설치합니다. 수집을 시작하거나 제품 인증을 바꾸지는 않습니다.
아래 명령은 모두 저장소 루트에서 실행하며 데이터베이스를 명시합니다.
로컬 패키지를 설치하면 `hm`을 사용할 수 있지만 `npm ci`만으로 셸 PATH에 생기지는 않습니다.

## 2. 파일럿 입력 합의하기

등록 전에 팀 담당자가 아래 입력을 선택해야 합니다.
제품은 기준 가격 카탈로그를 제공합니다. 기간·표본 수·누락 허용치는 직접 선택해야 합니다.

| 결정 | 기록 위치 |
| --- | --- |
| 공통 프로젝트 요구사항과 작은 A/B 지시 차이 | `variant-a.md`, `variant-b.md`; 양쪽에 공통 지시 유지 |
| 작업 산출물·허용 편집·사람의 완료 기준 | 비공개 prompt 파일; 기준 ID는 `workflow.json` |
| 참가자·환경·담당자별 층·배정자 소유권 | `protocol.json`; 각 층에는 담당자 1명 |
| 모집 날짜·판정 기간·표본 예산·중단/이탈 규칙 | `protocol.json`; 모집 전에 freeze |
| 기준 카탈로그 또는 명시적 가격, 기존 입력 비용 가정 | [카탈로그](reference-price-catalog.ko.md), 또는 `prices.json`과 [비용 안내](observed-cost.ko.md) |
| 실행 모델/effort·sandbox·timeout·실행 횟수·종료 | `runtime.json`, execution 파일, 실제 실행 승인 |

작업과 **사람의 검토**를 모두 포함할 만큼 판정 기간을 선택하세요.
배정 시 `followup_ends_at`이 고정됩니다. pause·resume·재작업으로 늘어나지 않습니다.
finish는 이 기한 전에 실행해야 합니다. 늦은 결과는 별도 저장되지만 기한 내 상태를 수정하지 않습니다.
최종 보고서 cutoff는 기한 이상이며 결과 평가 시각보다 뒤여야 합니다.
미래 시각은 cutoff로 사용할 수 없습니다.

기능 확인에는 `purpose: functional_pilot`을 사용하세요.
`minimum_effect`, `quality_margin`, `confidence_level`은 넣지 마세요. 이 목적의 스키마는 해당 필드를 거부합니다.
보고서는 `functional_only`, 도입 상태는 `not_applicable`입니다.
같은 논리적 작업을 양쪽 변형에서 한 번씩 수행하지 마세요. 새 요구사항에는 새 작업이 필요합니다.
후속 배치 준비는 서로 다른 작업 4개·담당자 1명·균형 블록 2개로 제한할 수 있습니다.
이 값들은 담당자가 선택해야 하며 통계적 검정력을 입증하지 않습니다.

## 3. 전체 입력 세트 준비하기

1. Git에서 제외되는 파일럿 디렉터리를 만드세요.

   ```sh
   mkdir -p .harness-delta/pilot
   ```

2. [합성 예제 세트](../../examples/workflow/)를 복사하세요.

   ```sh
   cp -R examples/workflow/. .harness-delta/pilot/
   ```

3. 등록 전에 예제 선택값을 바꾸세요.

| 파일 | 반드시 교체할 값 |
| --- | --- |
| `prices.json` (명시적 가격표 경로) | 합성 가격·모델·출처·날짜 교체; 등록 시 카탈로그를 고정하려면 이 파일과 protocol의 `price_table_id` 생략 |
| `variant-a.md`, `variant-b.md` | 검토한 A/B 지시; 개인 원본을 공개 fixture에 넣지 않음 |
| `protocol.json` | 2099년 날짜, 예제 ID, 참가자/환경/층, 판정 기간·표본·누락·중단 정책 |
| `workflow.json` | 일치하는 ID, 논리적 작업, 기준, 환경, 실제 코드 commit, artifact 경로 |
| `runtime.json` | 선택한 모델·effort 또는 미지정 `null`; 진단용 모델은 필수가 아님 |
| `launch.json`, `resume.json` | 정규 절대 binary/home/recorder/prompt 경로, 승인된 sandbox·timeout |
| `link.json`, `collect.json` | 같은 정규 설정; 필요한 정확한 연결 세션 UUID·source 경로 |
| `claude-launch.json` (Claude 전용) | 선택한 바이너리 경로/버전/SHA, mode 0700 비공개 workspace, 빌드된 mediator, prompt, `permissions`, 한도 |
| `claude-resume.json` (Claude 전용) | 같은 설정, 새 `run_id`, 같은 작업의 이전 resumable 실행을 가리키는 `resume_run_id`, 그 실행의 `workspace` |

workflow 설정·protocol의 source profile·바이너리 버전을 일치시키세요.
저장소 Codex 예제는 0.160.0입니다. 조건부 버전은 execution의 `product_version`과
실제 `binary.sha256`도 설정하세요. Claude는 `product: "claude_code"`,
프로필 `claude-workflow-own-trace-v1`을 쓰고 `workflow.json`, `protocol.json`,
`binary.version`에 선택한 버전을 넣으세요. protocol은 product/version마다 profile 하나,
Claude workflow profile마다 항목 최대 하나를 갖습니다. 자식 실행에는
`claude-workflow-direct-child-v1`을 쓰는 별도 protocol을 사용하세요.
기능 protocol은 각 Claude workflow 프로필을 2.1.296으로, 또는 own-trace 프로필을 조건부
범위 버전으로 허용합니다. 다른 비합성 protocol은
최신 정확한 admission을 요구합니다. [등록 규칙](task-native-workflow.md#claude-parent-only-workflow)을 참고하세요.
`binary.path`는 `claude` 실행기 대신 정확한 버전 파일을 가리켜야 합니다.
그 파일이 없거나 바뀌면 배정 전 preflight가 `claude_probe_executable_mismatch`로 실패합니다.
`permissions: "workspace-edit"`를 쓰면 workspace·harness-delta 빌드(mediator)·prompt·바이너리·데이터베이스를
측정 대상 프로젝트 루트 밖에 두세요. 안에 있으면 preflight가 `claude_workflow_harness_inside_project`로 실패합니다.
`workspace`는 여러 launch에서 재사용할 수 있으며 실행마다 별도 하위 디렉터리를 씁니다.

JSON 예제는 전체 스키마 입력이지만 선택값은 합성입니다.
prompt·승인된 실행 요청·DB는 Git에서 제외되는 로컬 저장소에 보관하세요.
일반 산출물은 측정 데이터와 분리하세요.
Codex 0.160.0은 코드에 고정된 바이너리 해시와 같아야 합니다. 조건부 버전은 검토한 실제 해시를 사용합니다.
별도 결정 없이 예제 실행을 위해 제품 설치·로그인·업데이트를 하지 마세요.

**산출물 주의:** 측정 CLI는 일반 native stdout을 버립니다.
파일 생성 작업은 비공개 prompt에 저장 위치와 허용 편집을 명시하세요.
산출물 작성이 필요하면 루트 `workspace-write`를 승인하세요.
read-only 분석 답변은 이 CLI를 통해 표시되지 않습니다.

4. 양쪽 지시를 편집한 뒤 등록 전에 manifest를 갱신하세요.

   ```sh
   node --input-type=module <<'JS'
   import { readFileSync, writeFileSync } from 'node:fs';
   import { createHash } from 'node:crypto';
   const sha = value => createHash('sha256').update(value).digest('hex');
   for (const arm of ['a', 'b']) {
     const path = `.harness-delta/pilot/variant-${arm}`;
     const config = JSON.parse(readFileSync(`${path}.json`, 'utf8'));
     config.instruction_manifest_hash = sha(JSON.stringify([
       { artifact_id: 'instructions', sha256: sha(readFileSync(`${path}.md`)) }
     ]));
     writeFileSync(`${path}.json`, `${JSON.stringify(config, null, 2)}\n`);
   }
   JS
   ```

예상 결과: 각 variant JSON에 검토한 지시 파일의 manifest hash가 기록됩니다.
이 예제는 변형마다 artifact 1개를 사용합니다. 여러 artifact는 ID순으로 정렬한 같은 `{artifact_id, sha256}` 공식을 사용합니다.
artifact 경로는 config 위치가 아니라 명령의 실행 디렉터리 기준입니다.
등록은 변경할 수 없습니다. 미완성 초안은 별도 임시 저장소에 두세요.
등록 입력을 바꿔야 한다면 새 ID와 합의된 미래 프로토콜을 사용하세요.

## 4. 한 번 등록하고 freeze하기

이 파일럿에는 새 전용 DB를 사용하세요. 합성 시험은 다른 DB에 보관하세요.
아래 명령은 명시적 `prices-1` 가격표를 사용합니다. 카탈로그를 쓰면 `protocol.json`의
`price_table_id`를 생략하고 `price-table register`를 건너뛰세요. 등록 시 현재 카탈로그를
한 번 고정합니다. 나머지 명령은 순서대로 실행하세요.
프로젝트 루트는 정규 절대 경로로 교체하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite project add project-1 --root /absolute/path/to/project
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table register --config .harness-delta/pilot/prices.json
node dist/cli.js --db .harness-delta/pilot/local.sqlite variant register --config .harness-delta/pilot/variant-a.json
node dist/cli.js --db .harness-delta/pilot/local.sqlite variant register --config .harness-delta/pilot/variant-b.json
node dist/cli.js --db .harness-delta/pilot/local.sqlite comparison register --config .harness-delta/pilot/protocol.json
node dist/cli.js --db .harness-delta/pilot/local.sqlite comparison freeze pilot-1
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow status pilot-1
```

예상 결과: 합의된 전체 입력과 허용된 workflow 프로필에는 `native_execution: true`가 표시됩니다.
조건부 source는 `source_compatibility`에 `compatibility_unverified`로 표시되며
해당 source의 `readiness.real_allocation`은 false를 유지합니다.
`whole_task_cost_unconfirmed`, `analysis_unverified`는 예상되는 한계입니다.
`native_source_unqualified`, `native_adapter_not_wired`가 있으면 launch 전에 중단하세요.
freeze가 실패하면 필수 필드와 모집 시작 전인지 확인하세요.
설정 플래그를 바꿔서 미지원 소스를 승인할 수는 없습니다.

## 5. 작업을 배정하고 launch하기

사전 조건: 합의된 입력·동결된 프로토콜·정확한 바이너리·이번 실제 실행 승인.
`launch.json`에는 새 `run_id`를 쓰고 확인 ID도 새 값을 사용하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex launch \
  --config .harness-delta/pilot/workflow.json --runtime .harness-delta/pilot/runtime.json \
  --execution .harness-delta/pilot/launch.json --confirmation confirmation-1
```

Claude Code는 같은 옵션과 `claude-launch.json`으로 `workflow claude launch`를 실행하세요.
`child_runtime`에는 직계 자식 protocol, 정확한 버전, `permissions: "read-only"`가 필요합니다.
own-trace protocol에서 조건부 버전의 자식을 실행하면 배정 전에 `workflow_adapter_mismatch`로 실패합니다.
profile이 일치해도 편집 권한을 쓰면 `claude_workflow_child_read_only_required`로 실패합니다.
adapter preflight를 직접 호출하면 직계 자식 admission이 없는 버전에
`claude_workflow_child_unadmitted`가 나올 수 있습니다.
같은 native 세션을 나중에 이어 가려면 launch에 `"resumable": true`를 추가한 뒤 `claude-resume.json`으로 `workflow claude resume`을 실행하세요. resumable launch에서는 Claude Code가 자체 transcript를 사용자의 Claude 설정에 보관합니다. Harness Delta는 그 파일을 읽지 않으며, 실행 사이의 시간은 `offline` gap으로 기록됩니다.
resume 예제는 read-only입니다. 유지한 read-only launch를 read-only로 resume한 경우만
native 증거가 있습니다. 편집 모드 resume이나 실행 사이 권한 변경은 입증되지 않았습니다.
resume은 유지한 launch의 권한과 비교하지 않습니다.

launch가 작업을 배정하고 시작합니다. 이 v2 배정에 `task register`를 실행하지 마세요.
`workflow begin`은 제품 실행 없이 배정/시작을 준비합니다. 그 자체로 harness를 적용하지 않습니다.
preflight는 배정/시작 전에 binary·recorder·prompt·home을 확인합니다(Claude: binary·prompt·effort·자식 범위·harness 위치; workspace는 launch 시 확인).
preflight 실패는 배정이나 활성 구간을 만들지 않습니다.
이후 spawn 전 실패에서는 활성화한 작업을 다시 pause할 수 있으며 receipt에 `activation_reverted: true`가 표시됩니다.

예상 receipt: 정규 작업 ID, 선택한 변형, 세션 ID, `adapter_result`.
이후 명령에는 반환된 정규 작업 ID를 사용하세요.
`completed`는 실행 종료를 뜻합니다. 사람의 성공 판정이나 사용량 전체 관측을 뜻하지 않습니다.
`failed`이면 `reason`, `diagnostic`을 확인하세요. 이전의 적격 사용량은 부분적으로 남을 수 있습니다.
`stopped`이면 계속하기 전에 작업 상태를 확인하세요. 유료 launch를 자동 재시도하지 마세요.
receipt의 지시 검증은 발신 실행 설정을 확인하며 native의 최종 harness 적용을 보증하지 않습니다.

## 6. 확인·stop·pause하기

1. 작업 상태·기한·실행·`next_actions`를 확인하세요.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow task task-1
   ```

2. 실행이 살아 있으면 stop을 요청하세요.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex stop run-1
   ```

3. 실행이 `running`이 아닐 때까지 작업을 다시 확인하세요.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow task task-1
   ```

4. 쉬려는 작업이 active이면 작업을 pause하세요.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite task pause task-1
   ```

예상 결과: `stop`은 실행/수집을 끝내고 `pause`는 작업 활성 시간 구간을 닫습니다.
Claude 실행에는 `workflow claude stop`, `workflow claude recover`를 사용하세요.
실행 중 pause해도 실행은 끝납니다. launch는 `workflow_scope_revoked`를 보고하고 진행 중이던 구간은 `incomplete` 공백으로 기록됩니다.
실행이 completed 또는 stopped여도 작업은 active로 남습니다. 활성 시간은 사람의 노동 시간이 아닙니다.

수집기가 사라졌지만 실행이 `running`이면 pause 또는 finish 전에 recover하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex recover run-1
```

recover는 실패 `abandoned`와 관측 공백을 기록하며 사용량을 추가하지 않습니다.
작업이 비활성이면 공백 대신 `gap_warning: task_not_active`가 표시됩니다. 실행이 `running`인 동안 pause 또는 finish했다면 그 전환에서 이미 공백이 기록되었습니다.
recover는 남은 native 프로세스에 종료 신호를 보내지 못합니다. 다음 실행 전에 남은 제품 프로세스를 직접 종료하세요.

## 7. resume 또는 다른 세션 사용하기

각 동작에는 새 실행·확인 ID를 사용하세요.
원래 논리적 작업·DB·프로젝트·기준·배정을 유지하세요.
모델/effort 변경은 작업을 재배정하지 않습니다.
launch/resume는 새 확인으로 paused 작업을 다시 활성화합니다.

같은 세션은 receipt의 정확한 `session_id`를 `resume.json`에 넣으세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex resume \
  --config .harness-delta/pilot/workflow.json --runtime .harness-delta/pilot/runtime.json \
  --execution .harness-delta/pilot/resume.json --confirmation confirmation-2
```

Claude Code에는 이 절차의 resume·link가 없습니다. 같은 작업에서 새 `run_id`와 확인 ID로
`workflow claude launch`를 다시 실행해 이어가세요. 새 세션에는 이전 대화가 없습니다.

다른 독립 루트는 같은 workflow 파일을 유지하고 `launch.json`의 `run_id`, prompt를 새 값으로 바꾸세요.
새 확인 ID로 5단계의 launch 명령을 실행하세요.
외부에서 시작한 루트는 정확한 UUID와 정규 source 경로를 명시해 연결하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex link \
  --config .harness-delta/pilot/workflow.json --runtime .harness-delta/pilot/runtime.json \
  --execution .harness-delta/pilot/link.json --confirmation confirmation-3
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex collect \
  --config .harness-delta/pilot/workflow.json --runtime .harness-delta/pilot/runtime.json \
  --execution .harness-delta/pilot/collect.json --confirmation confirmation-4
```

예상 결과: link/collect는 `external_unverified`를 표시합니다. 배정된 harness 적용이나 제품 실행은 하지 않습니다.
외부 작업은 해당 세션을 사용하기 전에 선택한 지시의 적용을 별도로 확인하세요.
첫 수집 기준점이 설정된 뒤 새 turn을 시작하세요. 작업 중에는 수집기를 전경에서 유지하세요.
이전·paused·offline 사용량은 제외되며 저장된 관측값은 source 파일이 없어져도 남습니다.
자동 발견·`--last`·과거 backfill·자동 재시도는 없습니다.
native append와 읽기가 겹치면 아무것도 수집하지 않고 다음 poll에서 재시도합니다. 연속 20회 또는 실행 기한까지입니다.
identity·잘림·prefix 변경은 계속 거부합니다.
배정된 workflow 작업에는 `workflow codex`를 유지하세요. 일반 `session link`/`collect`는
해당 버전이 허용되더라도 범위·신뢰가 다른 파일 파서 경로입니다.
별도 직계 자식 프로필은 family resume를 지원하지 않습니다. pause 후에는 새 루트/자식 쌍을 사용하세요.

## 8. 사람이 결과 판정하기

사전 조건: 수집이 끝났고 실행이 남아 있지 않으며 산출물을 검토했습니다.
`followup_ends_at` 전에 충족한 기준 ID를 모두 기록하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow finish task-1 --outcome success --met criterion-1
```

예상 결과: 기한 전에 평가하면 `counted_in_deadline_status: true`입니다.
`success`는 모든 기준이 필요합니다. `failed`, `aborted`는 일부 기준을 받을 수 있습니다.
최종 판정은 변경할 수 없습니다. 테스트 통과·프로세스 종료·양의 사용량이 작업을 자동 완료하지 않습니다.
첫 완료·평가·재작업을 별도로 기록할 때만 해당 lifecycle 명령을 사용하세요. [로컬 측정](local-measurement.ko.md)을 참고하세요.
검토가 늦었더라도 실제 결과를 기록하세요. `assessment_after_followup_deadline`은 저장되지만 기한 내 상태에서 제외된다는 경고입니다.

## 9. 보고서를 만들고 읽기

판정 기한과 평가 시각이 지난 뒤 현재 UTC cutoff를 저장하세요.

```sh
reportCutoff=$(node -p 'new Date().toISOString()')
```

고정 스냅샷을 만드세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow report pilot-1 \
  --id report-1 --cutoff "$reportCutoff" --reason initial
```

사람이 읽는 표를 확인하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite comparison report report-1 --format markdown-readable
```

예상 결과: 원래 A/B 배정·사람의 결과·부분 비용·명시적 한계.
cutoff가 기한 전이면 완료 작업도 `followup_pending`입니다.
`deadline_status`는 `success`, `failed`, `aborted`, `outcome_missing`, `not_started`, `followup_pending` 중 하나입니다.
늦은 평가는 새 `flexible-cost-descriptive-2` 보고서의 `late_outcome`에 표시됩니다.
저장된 version-1 스냅샷은 원래 형식을 유지합니다.
추가 증거가 도착하면 적절한 revision reason과 새 보고서 ID로 생성하세요. 기존 스냅샷은 바뀌지 않습니다.

비교에 고정된 가격표로 같은 작업의 관측 성분을 추정하세요:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table estimate-task task-1 \
  --cutoff "$reportCutoff" --input-basis output-only-v1
```

입력 비용 가정을 선택하거나 추정값을 비교하기 전에 [비용 안내](observed-cost.ko.md)를 읽으세요.
cached input을 total input에, reasoning output을 total output에 다시 더하지 마세요.
부분 금액은 청구액이 아닙니다. 가격 없는 모델은 unavailable로 남기며 다른 모델 가격으로 대체하지 마세요.

| 값/상태 | 뜻 |
| --- | --- |
| 관측된 `0` | 적격 관측에서 0이 측정됨 |
| Missing | 적격 값이 관측되지 않음 |
| Error | 소스 또는 관측 실패 |
| Excluded | 허용 범위 밖의 구간/값 |
| Unmeasurable | 이 소스로 요청값을 확정할 수 없음 |
| `partial_amount: null` | 적격 가격 금액 없음; 0이 아님 |
| `complete_amount: null` | 부분 가격 계산이 되어도 작업 전체 비용은 미확정 |

## 10. 오류 해결 또는 로컬 데이터 삭제하기

CLI는 고정 코드와 일반 오류의 `hint:`를 출력합니다.
원시 producer 메시지·비공개 경로·지시 내용을 출력하지 않습니다.

| 코드 | 다음 행동 |
| --- | --- |
| `invalid_command: ...` | 해당 명령의 `--help`를 읽고 필수 인수/옵션 입력 |
| `*_file_unreadable`, `*_file_invalid_json`, `invalid_execution` | 경로/JSON 수정 후 예제 operation과 비교 |
| `binary_mismatch`, `binary_unreadable` | 정확한 고정 바이너리·정규 경로 사용; 몰래 업데이트하지 않음 |
| `invalid_hook_recorder`, `invalid_prompt`, `unsafe_home` | 원본 recorder·UTF-8 prompt(≤1 MiB)·기존 home 수정 |
| `confirmation_conflict` | 새 `--confirmation` ID 입력 |
| `workflow_run_active` | 기존 실행 기다리기·stop·recover |
| `real_experiment_disabled` | freeze와 `workflow status` 확인; purpose 표기와 소스 승인은 별도 |
| `workflow_manifest_mismatch` | 중단; 등록 지시 변경을 해결하고 이후 입력에 합의 |
| `invalid_transition` | `workflow task`를 읽고 현재 상태가 허용하는 동작 수행 |
| `invalid_criteria` | `success`에는 충족한 모든 기준 ID 입력 |
| `invalid_cutoff` | 현재 이하의 유효한 UTC 시각 저장 |

범위 상실·미지원 topology/버전·충돌 사용량·종료 실패·개인정보 노출 시 중단하세요.
실패/중단 결과와 이전 적격 부분 관측값을 보존하세요. 재배정하거나 backfill하지 마세요.

로컬 작업 삭제가 의도된 경우 실행하세요.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite delete task task-1
```

삭제는 종속 보고서를 무효화하고 ID 재사용을 막습니다.
원래 제품 transcript·산출물·내보낸 사본은 삭제하지 않습니다.
보존 기간 적용은 선택 사항입니다. [로컬 삭제·보존 안내](local-measurement.ko.md)를 참고하세요.

## 용어와 추가 자료

| English | 한국어 | 뜻 |
| --- | --- | --- |
| Task | 작업 | 고정된 사람의 기준을 가진 지속 단위 |
| Run | 실행 | 실행 1회; 사람의 결과가 아님 |
| Session | 세션 | 명시적으로 연결한 제품 소스 1개 |
| Assignment | 배정 | 실행 간 유지하는 원래 A/B 선택 |
| Stop | 실행 중지 | 실행/수집 끝내기 |
| Pause | 작업 일시중단 | 작업 활성 시간 닫기 |
| Follow-up deadline | 판정 기한 | 결과 집계의 고정 기한 |
| Partial cost estimate | 부분 비용 추정 | 명시적 기준 가격의 관측 가능한 성분 |

설정 계약은 [flexible comparison](flexible-comparison.md), 고급 source/자식 경계는 [native workflow](task-native-workflow.md)를 참고하세요.
[v1 합성 비교](task-comparison.ko.md), [합성 교환](team-file-exchange.ko.md), [방법 검증](comparison-analysis-validation.md)은 명시된 개발 범위에서만 사용하세요.
