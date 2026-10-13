# 사용자가 여는 외부 세션: 준비와 첫 검증된 연결

[English](external-session-workflow.md). [작업 흐름 빠른 시작](workflow-quickstart.ko.md)으로 프로젝트, variant, 검토한 실행 설정과 동결된 protocol을 등록하세요. 로컬 브라우저 경로는 typed external service를 재사용합니다. 아래 고급 CLI는 검토한 설정 파일을 읽습니다. 표시 이름과 비공개 template 기록은 측정 metadata와 분리됩니다.

별도의 일반 세션 skill과 제한된 Claude 사용자 파일럿은
[Harness Connect](harness-connect.ko.md)를 참고하세요. 파일·native launch의
조건부 버전은 이 티켓 coordinator의 정확한 source 허용 범위를 넓히지 않습니다.

## 지원과 증거

생산 source guard는 독립 `cli`/`exec` root의 정확한 Codex 0.160.0 own-response profile입니다. 새 수동 coordinator는 오프라인 합성 검증을 거쳤으며, 첫 작업 전 startup 기록 시점은 별도 승인된 실제 검증이 필요합니다. IDE/app/MCP, fork, compaction, child는 이 경로에 허용되지 않습니다. Claude 수동 지원은 외부 process/telemetry qualification 대기 상태입니다. 이미 허용된 Claude 2.1.296 도구 소유 workflow(2.1.288과 2.1.291은 지원 종료)는 다른 경로이므로 수동 외부 source의 증거가 아닙니다. 설치된 새 버전을 조용히 허용하지 마세요.

증거를 구분하세요:

| Field | 의미 |
| --- | --- |
| `configuration_evidence` | 준비 시 managed·선언된 common 파일 hash가 일치한 snapshot |
| `native_context_evidence: native_developer_context_observed` | 검증된 native developer response item에서 전달한 ticket fragment가 일치함 |
| `freshness_evidence: fresh_root_after_ticket` | 지원 root의 생성 timestamp가 ticket 발급 이후이며 다른 ticket에 소비되지 않은 identity임 |
| `tool_use_evidence: unavailable` | 모델의 지침 준수나 도구 사용을 주장하지 않음 |

Ticket, 경고, 파일 존재나 source 발견만으로 native context가 확인되지는 않습니다. Context가 없으면 연결을 거부하고 window를 시작하지 않습니다. Native CLI가 첫 turn 이후에만 developer context를 저장할 가능성은 아직 검증되지 않았습니다. 모델의 자기 확인을 증거로 삼거나 구현 작업을 먼저 시작해 증거를 만들지 마세요. 기존 adapter receipt의 `harness_application: external_unverified`와 새 context 증거는 별개입니다. 필수 common 파일은 보존·확인하지만 hash만으로 native loading은 확인되지 않습니다.

## 새 작업 준비

검토한 template은 등록된 A/B variant, 동결된 protocol, 프로젝트, runtime과 criterion ID를 지정합니다. Simple-task builder는 그 프로젝트·기준만 선택하고 내부 task ID를 생성합니다. Protocol, 가격, admission 기본값을 임의로 만들지 않습니다. 생성한 작업의 완료 기준은 고정됩니다.

준비 spec:

```json
{
  "schema_version": 1,
  "common_artifacts": [],
  "common_manifest_hash": null,
  "allowed_preimage_hashes": []
}
```

필수 common 규칙은 canonical 일반 UTF-8 파일로 `{ "artifact_id": "common", "path": "/absolute/project/AGENTS.md" }`처럼 지정하세요. Manifest는 artifact ID로 정렬한 `{artifact_id,sha256}` compact JSON 배열의 SHA-256입니다. Null hash는 빈 목록에만 허용됩니다. Common 파일은 변경하지 않습니다.

적용 가능한 파일은 `<등록한 canonical root>/.harness-delta-managed/active-instructions.md` 하나입니다. 선택 variant의 정렬된 내용으로 파일 전체를 교체하므로 A 위에 B를 덧붙이지 않습니다. 이미 일치하면 쓰지 않으며, 없는 target은 생성하고 다른 내용은 명시적으로 검토한 raw SHA-256 preimage가 있어야 교체합니다. 알 수 없는 사용자 변경이나 symlink/안전하지 않은 target은 덮어쓰지 않고 실패합니다. AGENTS, hook, native settings, trust, credential, 프로젝트 script는 변경하지 않습니다.

이전에 activation·session·usage가 없는 새 작업:

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external prepare \
  --config workflow.json --runtime runtime.json --spec preparation.json \
  --first-connection-clock --apply-managed-file
```

예상 결과: `configuration_verified`, active interval 없음, `window.started_at`과 `ends_at` 모두 null. 준비·배정은 새 관찰 window를 시작하지 않습니다. `--apply-managed-file`을 빼면 확인만 합니다. `--first-connection-clock`이 없으면 기존 assignment clock을 유지하며 새 context/ticket 계약이 적용되지 않습니다. 과거 작업을 소급 변환할 수 없습니다.

## 새 native 세션을 열고 연결

Start 명령은 검토한 canonical binary 기록을 요구합니다:

```json
{
  "path": "/absolute/path/to/codex-0.160.0",
  "version": "0.160.0",
  "sha256": "112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b"
}
```

도구는 실행 없이 정확한 binary 파일 hash를 확인합니다. PATH upgrade, 설치나 native account 변경을 하지 않습니다.

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external start \
  --config workflow.json --runtime runtime.json --spec preparation.json \
  --native-binary native-binary.json
```

예상 결과: 비공개 복사 명령과 일회용 ticket. 사용자가 평소 terminal에서 해당 native CLI 명령을 실행합니다. 명령은 선택 fragment를 invocation별 `developer_instructions`로 전달하며 hook 설치나 trust 변경을 하지 않습니다. 명령은 비공개 설정 내용이므로 측정 export에 넣지 마세요. 이 invocation의 추가 developer instructions를 선택하므로 필요한 기존 추가 규칙은 이미 사용자가 검토한 설정에 포함해야 합니다. 기본 model instructions는 교체하지 않습니다.

[기존 execution schema](task-native-workflow.md#codex-launch-resume-link-and-collection)로 정확한 source/session, 새 `run_id`, `operation: link`, native UUID와 source path를 선택하세요. UI는 명시적인 source 선택 뒤 기술적인 handle을 숨길 수 있습니다. 최근 활동에서 source를 추측하지 않습니다.

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external connect \
  --config workflow.json --runtime runtime.json --spec preparation.json \
  --execution link.json --ticket TICKET_ID
node dist/cli.js --db .harness-delta/local.sqlite workflow external state TASK_ID
```

예상 결과: 정확한 root scope/identity와 baseline을 검증한 후 bounded native developer fragment를 확인합니다. 이전 usage는 제외합니다. 일치하는 source/context 연결이 완료돼야 ticket을 소비하고 `external-first-connection-v1`을 한 번 시작합니다. 실패·대기 연결은 양 끝 시간을 설정하지 않습니다. 오래된 root, 변경된 fragment, 재사용 ticket, 변경된 준비 revision은 실패합니다. Source prompt·response·source code·instruction 내용은 evidence table에 남기지 않습니다.

## 관찰·일시정지·재연결·판정

검증된 session에 새 run ID와 `operation: collect`를 사용하세요:

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external collect \
  --config workflow.json --runtime runtime.json --spec preparation.json --execution collect.json
node dist/cli.js --db .harness-delta/local.sqlite workflow external pause TASK_ID
```

수집은 foreground이며 이후 usage만 관찰합니다. 매번 새 baseline을 설정하므로 중단·오프라인 usage를 소급 수집하지 않습니다. Scope, source continuity, managed/common byte 확인, 중복 제거와 실제 deadline을 경계마다 확인합니다. Collector 종료는 active time을 일시정지하지만 native process는 사용자 제어 아래 두며 성공을 판정하지 않습니다. Pause는 durable stop을 요청합니다. Crash 후 기존 run recovery를 사용하세요. 진행 중 불확실성은 gap으로 남습니다.

같은 native source는 다시 collect로 이어갑니다. 같은 task의 새 native 세션은 새 ticket을 발급해 연결합니다. Session·재작업이 이어져도 arm, 첫 window와 누적된 유효 usage는 고정됩니다. Deadline은 관찰을 닫으며 성공 판정이 아닙니다.

Managed surface 해제 전 observer와 native agent를 중단하세요:

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external release TASK_ID --external-session-stopped
```

이 acknowledgement는 process 확인 증거가 아닙니다. 실행 중 observer가 없어야 해제할 수 있으며 시간을 일시정지하고 같은 store의 lease만 해제합니다. Managed 파일을 복원하거나 삭제하지 않습니다. 필요하면 검토한 hash로 재준비하세요. 새 revision은 새 일치 ticket/source를 요구합니다. 병렬 A/B에는 별도 등록한 checkout을 사용하세요. 별도 store와 unmanaged native process는 lease 범위 밖입니다.

Collector를 멈춘 뒤 사람이 결과 하나를 선택합니다:

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external outcome TASK_ID rework
node dist/cli.js --db .harness-delta/local.sqlite workflow external outcome TASK_ID success --criteria CRITERION_ID
node dist/cli.js --db .harness-delta/local.sqlite workflow external outcome TASK_ID failed
node dist/cli.js --db .harness-delta/local.sqlite workflow external outcome TASK_ID aborted
node dist/cli.js --db .harness-delta/local.sqlite workflow external result TASK_ID
```

서로 대체하는 선택입니다. 성공에는 모든 고정 criterion ID가 필요합니다. 확정 전 재작업은 같은 task와 누적량을 유지합니다. R03에 따라 확정된 성공은 변경하지 않으며 추가 작업은 followup task 안내를 제공합니다. 늦은 결과는 저장하지만 이 계약의 deadline status에서는 제외됩니다. 새 작업은 기존 `workflow finish` 대신 이 outcome API를 사용합니다.

## 한 시계·부분 결과·복구

`external-observation-v1`은 window 하나, effective cutoff, elapsed/active time, 명시적인 결과와 부분 reference cost를 반환합니다. 첫 검증된 연결이 시작이며 동결된 followup duration으로 끝을 계산합니다. 재연결·재작업은 두 시간을 바꾸지 않습니다. Report는 task/coverage 시작이 connection 시작과 같음을 확인하고 이전 usage를 제외합니다. 배정 시 고정한 가격 pin과 partial/missing 구분을 유지하며, 알 수 없는 가격을 0으로 바꾸지 않습니다. 전체 비용과 inference는 비활성화됩니다.

기존 protocol·assignment deadline과 과거 report bytes는 보존합니다. 새 clock task는 기존 randomized comparison report에 들어가지 않습니다. `timing_contract_mismatch`가 다른 clock을 혼합한 protocol을 거부합니다. 새 task 상태·UI는 실제 deadline 하나만 표시합니다. 과거 report read endpoint는 원래 계약을 유지합니다.

Drift는 다음 source 경계 전 수집을 멈추고 시간을 일시정지하며 `configuration_changed`를 표시합니다. 알 수 없는 내용은 보존합니다. 준비 실패는 `recovery_needed`와 소유권을 유지하며 중단된 `applying`은 성공이 아닙니다. 사용자 변경 위에 자동 rollback하지 않습니다. 확인·중단·외부 작업 acknowledgement 후 검토한 내용으로만 재준비하세요. Source 누락·불확실성·불완전 coverage는 partial이며 observed zero가 아닙니다.

[검증 기록](../validation/external-session-flow.md)은 오프라인 테스트와 native qualification을 구분합니다. 공식 [Codex 설정](https://learn.chatgpt.com/docs/config-file/config-reference)과 [CLI 문서](https://learn.chatgpt.com/docs/cli/reference)는 invocation별 instructions를 설명합니다. [Claude CLI 문서](https://code.claude.com/docs/en/cli-reference)의 append-file/session flag만으로 외부 source를 허용할 수는 없습니다.
