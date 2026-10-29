# admitted Claude localhost 적합성 runner

[English](tool-update-conformance.md)

이미 admitted된 Claude Code 2.1.306의 제한된 합성 print-mode 시나리오를 이식한 개발용
runner입니다. 코드와 합성 테스트는 준비됐지만 저장소 소유 runner의 실제 바이너리 합격 검증은
대기 상태입니다. 미등록 버전을 허용하거나 기본값, ordinary qualification, interactive,
인증된 지원, complete-cost 주장을 바꾸지 않습니다.
첫 단계는 [탐색과 정적 평가](tool-update-pipeline.ko.md)를 참고하세요.

## 실행은 별도 승인 필요

탐색에서 후보를 찾았다는 이유만으로 실행하지 마세요. 사람이 정확한 이미지, runtime, 범위,
모델, pin, 종료 예산을 승인해야 합니다. runner는 승인 기록을 만들거나 갱신하지 않습니다.
`approved: true` 필드는 사람의 결정을 대신하지 않습니다.

지원하는 유일한 경로는 macOS arm64, Node 24의 수동 localhost 합성 print-mode입니다.

- Claude Code 2.1.306, SHA-256
  `b5d795b7760032d79954b55a9cd1876dcf3a8dc9608fd6bb9f618593f69fd44b`.
- 실행 이미지 크기 272984176 bytes, 기존 ordinary profile
  `claude-binding-2-1-306-family-v1`.
- root 하나와 member 둘, 모델 `claude-sonnet-5-5`, normal 다음 SIGINT.
- 시나리오별 실행 10000-120000 ms, 종료 1000-10000 ms, TERM grace 100-2000 ms이며
  grace는 종료 예산보다 작아야 합니다.

수동 승인은 `localhost_only_not_isolated: true`를 명시적으로 인정합니다. runner는 loopback
목적지와 합성 credential을 설정하지만 OS 수준 egress 격리를 주장하지 않습니다.
모든 unattended 요청은 `unattended_isolation_unverified`로 거부하며, 임의 격리 주장을 넣어도
해제되지 않습니다. 검증된 disposable runner 자동화는 추후 검토된 설계가 필요합니다.

## 승인과 로컬 입력

`scripts/tool-update/conformance.mjs`의 `approvalSchema`가 엄격한 계약입니다. 알 수 없는
필드, 미등록 버전, 잘못된 이미지·runtime, pin 불일치는 후보 실행 전에 거부합니다.

| 필드 | 필수 값 |
| --- | --- |
| `schema_version`, `approved`, `run_id` | `1`, `true`, 고유 UUID |
| `approved_at`, `expires_at` | UTC 시각, 현재 유효하며 간격은 최대 한 시간 |
| `product`, `version`, `route`, `profile_id` | 위 정확한 경로, product는 `claude_code`, route는 `claude_binding` |
| `binary_sha256`, `binary_size` | 위 정확한 값 |
| `runtime` | 선택한 Node의 정확한 `version`, `sha256`, `platform: darwin`, `arch: arm64` |
| `scope` | `kind: localhost_synthetic_print`, `roots: 1`, `members: 2`, `scenarios: [normal, sigint]`, 위 정확한 모델 |
| `mode`, `localhost_only_not_isolated` | `manual`, `true` |
| `budgets` | 제한된 `duration_ms`, `termination_ms`, `term_grace_ms` |
| `pins` | `binary`, `runtime`, `source`, `build`, `instrument`, `skill`, `lockfile`, `package`, `supervisor`, `python`, `ps`, `pgrep`, `git`의 정확한 SHA-256 |

실제 소스·build·패키징된 helper를 검토하고 pin을 계산한 뒤 승인하세요. export된
`snapshotPins(binary)`는 벤더 이미지를 실행하지 않고 pin을 계산합니다. 선택한 같은 Node로
build하세요. 소스, build, instrument, runtime이 바뀌면 승인은 무효입니다. runtime은 개인
캐시 경로나 다운로드한 helper가 아니라 `process.execPath`를 사용합니다.
source·build 다이제스트는 변경을 감지할 뿐 파생 관계를 증명하지 않습니다. 승인자는 선택한
runtime으로 해당 소스를 새로 build했음을 확인해야 합니다. run ID는 같은 출력 루트 안에서만
재사용을 막으며 모든 출력 루트에 걸친 일회성을 강제하지는 않습니다. 시험마다 새 승인을
발급하세요. 유효 기간이 남았다고 자동 재시도를 허용하는 것은 아닙니다.

승인·출력 디렉터리는 미리 존재하고 실행자 소유이며 private 권한과 정규 절대 경로를 가져야
합니다. 승인 파일도 private이어야 하며 실행 이미지 경로도 정규 절대 경로여야 합니다.
이 경로는 로컬 입력이며 공유 evidence 필드가 아닙니다.

## 승인된 시험만 실행

아래 경로는 자리표시자입니다. 검토된 입력으로만 교체하세요.

```sh
approval_file="/absolute/private/reviewed-approval.json"
binary_file="/absolute/reviewed/claude"
out_dir="/absolute/private/conformance-output"
node scripts/tool-update/conformance.mjs \
  --approval "$approval_file" --binary "$binary_file" --out "$out_dir"
```

실제 fixture는 격리 프로젝트를 등록하고 shipped helper의 configure·preview·install을 거쳐,
Store와 UI task metadata를 함께 만들고 task를 활성화합니다. root·member receipt가 각
source 읽기를 먼저 허용해야 합니다. shipped collector를 독립 숫자 oracle과 대조하며,
합성 partial-response 이벤트에서 SIGINT를 보냅니다. 경과 시간이나 exit zero는 완전성의
증거가 아닙니다.

supervisor는 관측하여 소유권을 확인한 identity를 회수하며, 관측된 group escape도 포함합니다.
미관측 escape 부재나 backend 취소는 증명하지 못합니다. 소유권·cleanup 미확인이나 실행
이미지 drift는 실패입니다.

## evidence와 남은 제한

성공하면 private `<run_id>/evidence.json`을 쓰고 `conformance_passed`를 출력합니다.
출력 위치를 확립한 뒤의 실패는 엄격한 `failure-<UUID>.json`과 고정 실패 코드를 남깁니다.
원본 경로, native 내용, credential, stderr는 evidence가 아닙니다. 안전한 cleanup이 확인되지
않으면 실패한 임시 fixture가 private 상태로 남을 수 있으며 성공으로 바꿔 표시하면 안 됩니다.

과거 oracle은 normal에서 served 6/terminal 6, baseline 1 제외, retained 3/1/1,
input/output 675/555입니다. SIGINT는 served 6/terminal 5, baseline 1 제외,
retained 2/1/1, 540/444이며 중단 request 하나는 0이 아니라 missing입니다.
이는 기대값이지 새 실제 시험이 통과했다는 주장이 아닙니다.

runner의 native 합격을 주장하기 전에 실제 바이너리 normal·SIGINT, receipt, finality,
collector, drift, 개인정보, cleanup 증거를 남기세요. 독립 검토와
[개발 워크플로](workflow.md)도 적용됩니다. 지원, admission, 기본값, 가격 catalog,
remote CI, publication 변경은 포함하지 않습니다.
