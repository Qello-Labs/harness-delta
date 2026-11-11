# admitted Claude localhost 적합성 runner

[English](tool-update-conformance.md)

이미 admitted된 Claude Code 2.1.306의 제한된 합성 print-mode 시나리오를 이식한 개발용
runner입니다. 코드와 합성 테스트는 준비됐지만 저장소 소유 runner의 실제 바이너리 합격 검증은
대기 상태입니다. 미등록 버전을 허용하거나 기본값, ordinary qualification, interactive,
인증된 지원, complete-cost 주장을 바꾸지 않습니다.
첫 단계는 [탐색과 정적 평가](tool-update-pipeline.ko.md)를 참고하세요.

## 실행은 별도 승인 필요

### 실행이 차단된 Codex root-window 준비

`scripts/tool-update/codex-window-conformance.mjs`는 Codex 0.167.0,
`codex_binding`, collect/root, `codex-binding-root-window-v1`, macOS arm64,
Node 24용 별도 private 개발 명령입니다. admitted target이나 아래 Claude runner의
확장이 아닙니다. 실행은 무조건 차단되며 B1 발급자와 vendor spawn을 활성화하지 않습니다.

이는 실행이 차단된 준비 단계이며 B1 준비 완료가 아닙니다. 오프라인 결함을 수정해도
`--version`을 포함한 어떤 vendor 시도도 허용되지 않습니다.

```sh
node scripts/tool-update/codex-window-conformance.mjs execute
```

예상 결과는 exit 2이며 고정 JSON에 `code:b1_execution_disabled`,
`execution_attempted:false`, `actual_qualification:false`를 담습니다. consent JSON,
intent, 승인 flag, 만료·재사용 packet으로 해제할 수 없습니다. `verify-cleanup`도 실제
cleanup consent가 없어 거부합니다.

오프라인 준비는 명시적인 private plan과 기존 빈 case 디렉터리를 정규 절대 경로로
받습니다. 두 부모 디렉터리는 실행자 소유 0700이어야 하고 plan은 일반 단일 링크 0600
파일이며 최대 16 KiB입니다. `intent.json`을 배타적으로 작성하며 vendor 이미지나 source를
검사하지 않습니다.

```sh
node scripts/tool-update/codex-window-conformance.mjs prepare \
  --plan "$plan_file" --case normal --out "$owned_case"
```

엄격한 plan 필드는 `schema_version:1`, `product:codex`, `version:0.167.0`,
`commit:086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`, `route:codex_binding`,
`policy_id:codex-binding-root-window-v1`, `operation:collect`, `topology:root`,
`runtime:node24`, `platform:darwin_arm64`, `model:gpt-6.1-sol`, `effort:high`,
`pins`입니다. SHA-256 pin 11개 이름은 `native`, `host`, `source`, `build`,
`instrument`, `runtime`, `lockfile`, `config`, `environment`, `egress`, `quota`입니다.
준비는 이 주장을 기록할 뿐 실제 입력 검증, containment qualification, 권한 발급을 하지
않습니다. 결과는 `prepared_execution_disabled`입니다.
선택적인 엄격한 `inputs` 객체는 별도 입력 preflight를 위한 `batch_root`, `prefix_root`,
`native_path`, `host_path`, `config_path`, `environment_path`, `profile_path`,
`quota_packet_path`, `native_manifest_path`, `native_manifest_sha256`,
`native_manifest_identity`를 받습니다. prefix와 case 경로는 각각 `batch_root/prefix`,
`batch_root/cases/<case_id>`여야 합니다.

별도 verifier는 실행자가 제공한 private packet만 소비하며 consent 발급이나 process 실행을
하지 않습니다.

```sh
node scripts/tool-update/codex-window-conformance.mjs verify-consent \
  --intent "$intent_file" --consent "$consent_file"
```

엄격한 packet은 UUID와 approval-reference hash를 정확한 intent bytes, case/root,
11개 pin, collect/root 범위, 최대 1200000 ms 유효기간에 묶습니다. intent와 consent는
같은 canonical 0700 case 디렉터리의 소유 단일 링크 no-follow 0600 파일이며 각각 최대
64 KiB입니다. 입력 preflight 전에 case-root 배타적 reservation을 소비하므로 실패 후
다른 nonce로 재시도할 수 없습니다. 실제 preflight는 vendor를 실행하지 않고 범위가 정해진
파일과 현재 source/build/runtime/instrument closure를 hash합니다. 사용 시 만료, 파일
identity, packet/reservation bytes와 pin을 다시 확인합니다. 실행자 소유 packet이 승인
신뢰 경계이며 사람의 identity를 암호학적으로 증명하지는 않습니다. 실제 B1 packet은
제공하지 않습니다. 성공 결과도 `reserved_execution_disabled`이며 미완성 runner의 실행
권한이 아닙니다.

private native manifest는 전체 prefix inventory, launcher와 같은 디렉터리의 CLI/host,
명시적인 process/runtime/system-tool 집합, argv, configuration, environment, profile,
quota 파일을 묶습니다. 제한된 일반 파일 bytes/hash/mode, device/inode identity,
directory entry를 재검증하며 선택하지 않은 resource도 포함합니다. 고정된 B0 inventory로
기록된 CDHash와 signing metadata를 유지하지만 component를 실행하거나 source 대응 관계를
증명하지 않습니다. runtime link record는 선언한 dependency symlink의 identity와 target도
묶지만 host namespace 불변성이나 독립 closure 검토를 대신하지 않습니다.
sandbox process 집합에는 native `codex`와 `codex-code-mode-host`만 포함하며
controller runtime과 system 도구는 sandbox 밖의 별도 identity입니다. 고정 entry argv는
Node나 `bin/codex.js`가 아니라 native `codex`로 시작합니다. 엄격한 `launcher_input`은
`argv_tail`과 base environment를 고정합니다. static recipe는 argument 경계를 보존하고,
inventory의 macOS arm64 platform package를 선택하며, 상속된 package manager marker
네 개를 교체하고 `CODEX_MANAGED_PACKAGE_ROOT`를 설정합니다. 결과는 고정 argv 및
environment 파일과 일치해야 합니다. launcher는 읽고 hash할 뿐 실행하지 않습니다.
ambient package-manager ownership heuristic, 다른 vendor root, 필요한 기본
`SIGXFSZ` 전달은 명시적인 미검증 잔여 항목이며 interpreter 허용 사유가 아닙니다.
실제 실행이나 launcher 동등성을 승인하지 않습니다.

byte oracle은 `127.0.0.1`에만 bind하는 실제 HTTP/1.1/SSE transport도 제공합니다.
하나의 batch에서 만든 case listener는 counter와 connection admission을 공유합니다.
예기치 않은 refusal, deadline, protocol 실패는 batch를 terminal stop으로 바꾸고 모든
관련 listener/socket을 닫으며 이후 case 생성과 작업을 거부합니다. 정상 case 종료는
나머지 case를 중단하지 않습니다.
body 할당 전에 Upgrade, CONNECT, HTTP/2, identity 이외 compression, chunked framing을
거부합니다. header/body/request/response 한도는 16/64/80/256 KiB이며 case당
connection/request 최대 16개, batch당 112개, response slot 8개, 합성 input+output
단위 32000개입니다. cache와 reasoning은 부분집합이며 추가 사용량이 아닙니다. 중단된
terminal usage는 0이 아니라 missing이며 숫자 요약에 wire text를 포함하지 않습니다.

합성 metadata reservation은 opaque 일회성 객체입니다. 새 소유
`project/.harness-delta/window-receipts` 경로만 쓰며 디렉터리는 0700, control은
배타적 no-follow 0600, hook의 정확한 7개 key, 최대 4096 bytes입니다. consent-bound
writer는 이 metadata-only lifecycle을 재사용하며 opaque reservation을 재검증하고
매 check/close에서 원래 directory와 control의 device/inode, private mode/owner,
제한된 control의 정확한 bytes/size도 검증합니다. 교체 경로나 symlink는 enumeration
전에 거부합니다. 중단·만료 시에는 원래 storage임이 증명될 때만 inactive로 바꿉니다.
교체를 증명할 수 없으면 `receipt_storage_changed` 또는 `control_storage_changed`를
보고하고 외부 대체 파일을 덮어쓰거나 inactivation 성공을 주장하지 않습니다. 정상 receipt
추가로 생긴 directory entry 수·size 변화는 directory identity 교체와 구분합니다. receipt admission은
최대 17개 entry를 확인하고 16개 초과 시 거부하지만, 변경하지 않은 hook의 17번째 파일
생성을 예방하지는 않습니다. production publisher는 그대로이며 decision 없이는 inactive입니다.

synthetic-only collection bootstrap은 격리된 in-memory Store에서 실제 project/task,
exact-root trial, connect/baseline, collect API를 사용합니다. 합성 reservation만 받고
product decision이나 comparison assignment를 만들지 않으며 실제 수집 권한을 부여하지
못합니다. 변경하지 않은 hook은 합성 native source를 읽지 않고 metadata만 방출합니다.
exact-root trial과 active task가 생긴 뒤 수집하며 replay는 사용량을 중복 부과하지 않습니다.

script-local TUI adapter는 변경하지 않은 Python PTY owner를 통해 고정된 nonvendor
테스트 helper만 실행합니다. spawn/input 전에 구독하고 normal quit과 control EOF를
구분하며 고정 상태만 보존합니다. native TUI 실행은 차단됩니다. nonvendor 경로는 소유
launch의 PID, parent, foreground group, session, UID, start time을 다시 확인한 뒤
한 번의 OS SIGINT를 전달하며 불일치는 거부합니다. 별도 prearmed output event로 fixture
handler의 acknowledgement를 확인합니다. correlation fixture는 별도 barrier에서 두 번째
고정 입력을 허용합니다. 강제로 `write(false)`를 반환하는 테스트도 실제 PTY와 callback을
유지하며 입력 재전송이 없음을 확인합니다. owner, adapter, 복사된 fixture, signal helper,
process 도구의 pin을 사용 전에 확인합니다. vendor에 대한 atomic PID-reuse 예방을
주장하지 않습니다.

macOS arm64/Node 24의 opt-in native exec/mapping qualification은 image 없이
hash한 deny-default 상속 `sandbox-exec` profile을 만듭니다. 쓰기는 소유
case root로 제한하고 읽기·실행 경로는 allow-list로 제한합니다. 고정된 oracle port의
outbound IPv4 localhost TCP만 허용하며 DNS와 Mach service는 거부합니다. 소유한 빈
OpenSSL 설정으로 실행자의 global 설정을 읽지 않도록 합니다. sudo나 global firewall
규칙을 사용하지 않습니다.
runtime 파일과 dependency link는 runtime 디렉터리 subtree 대신 literal 권한을
받습니다. vendor 실행은 native `codex`, `codex-code-mode-host`로 제한하며 Node,
Python, 다른 interpreter와 JS launcher는 이 profile 안에서 실행할 수 없습니다. `rg`와
voice component를 포함한 나머지 vendor executable mapping도 거부합니다. 쓰기 가능한
case root에서도 executable mapping을 허용하지 않으며 nonvendor 복사본으로 거부를 검증합니다.

별도 case-state quota qualifier는 소유 image 안에 quota가 있는 APFS volume을 만들고
소유 mount root 아래로만 다시 attach한 뒤 정확한 67108864-byte quota 위의 private
case 디렉터리를 사용합니다. 직접·descendant 쓰기의 초과 거부를 확인한 후 소유 image를
확실하게 detach하고 삭제합니다.

```sh
node scripts/tool-update/codex-window-quota-qualification.mjs --local-nonvendor --out "$quota_out"
```

독립 owner가 실제 quota 객체를 유지합니다. attach 전에 coordinator가 정확한 root/image
identity를 검증하고 소유를 확인하며, 이후 writable-path 검증도 같은 owner에 IPC로
요청합니다. coordinator가 사라져도 owner는 살아서 정확한 volume/device 소속을 확인하고,
detach를 확실히 검증한 뒤 소유 image만 삭제합니다. private mounted/cleanup receipt가
결과를 기록합니다. IPC supervision에서는 attach와 path 검증 후 `quota-mounted`를
보내고, prearmed barrier는 `quota-continue`에서 해제합니다. 로컬 검증은 cleanup witness를
먼저 준비한 뒤 소유 coordinator에만 SIGKILL을 전달합니다. 이는 attach 후의 제한된 경로를
검증하며 초기화 중 모든 손실, owner SIGKILL 시 takeover, 전체 cleanup process의 동시
손실을 포괄하지 않습니다.

기본 테스트는 fake를 사용하며 image를 mount하지 않습니다. 이 제한된 quota 결과는
별도 evidence/overhead 예산, 예방적 process/exec 개수, receipt 생성 개수, 모든 loss의
cleanup을 증명하지 않습니다.

다음 명령은 새로운 canonical 소유 output 경로와 명시적인 로컬 승인이 필요하며 Codex
이미지가 아닌 nonvendor probe만 실행합니다.

```sh
node scripts/tool-update/codex-window-qualification.mjs qualify-native --out "$qualification_out"
node scripts/tool-update/codex-window-image-owner.mjs qualify-loss --out "$loss_out"
```

native qualification은 선택된 native 경로 두 곳에 소유 C probe를 compile합니다. native
positive control과 직접·descendant Node, Python, writable Node script, Node spawn,
미선택 vendor exec 및 native mapping 거부를 확인합니다. network나 oracle 요청을
보내지 않고 소유 probe binary를 삭제합니다. `native_exec_mapping_verified` 결과는
`containment_verified`와 구분하며 후자는 false로 유지합니다. 과거 Node 기반 network/
filesystem/quota 제어 16개가 강화된 native profile을 검증한 것은 아닙니다.
이전 `qualify` 명령은 interpreter를 허용하는 compatibility 경로가 아닙니다.

별도 image-loss qualifier는 소유 4 GiB APFS image를 만듭니다. 독립 image owner는
identity-checked attach handshake 후 정상 close, control EOF, 소유 owner SIGKILL에서
detach를 검증합니다. 실제 quota qualification entry는 독립 quota owner를 사용하므로
attach 이후 coordinator가 SIGKILL돼도 살아 있는 peer가 detach와 삭제를 수행할 수 있습니다.
검증된 image mount에서 image owner의 startup watchdog을 해제하고 lifetime watchdog은
원래 승인 deadline의 남은 시간만 사용합니다. loss 검증 범위는 attach 이후이며 초기화 중 모든
손실이나 전체 cleanup process의 동시 손실을 포괄하지는 않습니다. packet은 제한된 metadata와
상태만 담고 actual-target qualification은 항상 false입니다. image-loss artifact와 실패 packet은
private 상태로 남기며 기본 테스트는 fake를 사용해 image를 생성하거나 mount하지 않습니다.

합성 deadline 검사는 불변 `B=T0+1200000`, teardown 5000 ms, audit 10000 ms를
예약하고 온전한 case만 허용하며 만료 시 작업 시간을 줄입니다. 최종 audit은 기존 예약만
사용하고 teardown을 다시 예약하지 않습니다. 실제 disappearance, 닫힌 resource, 복원된
terminal은 KILL 전달과 별개입니다. 오프라인 산술·상태 제어이며 suspend-inclusive host
clock의 calibration이 아닙니다.

일반 build 뒤 합성 검사를 실행하세요.

```sh
npm test -- tests/tool-update-codex-window*.test.ts
```

native acceptance나 B1 준비 완료가 아닙니다. SBPL/APFS는 검증한 filesystem/network
경계를 강제하지만, 그 자체로 vendor exec 15회·동시 process 16개라는 상태 기반 제한을
강제하지 못합니다. 예방적 개수 제한 증명, 독립 qualification 검토, suspend-inclusive
clock calibration, 완전한 vendor TUI/input 순서, 실제 consent-to-source commit 연동은
검증되지 않았습니다. 실제 실행과 최종 cleanup-audit 명령은 계속 차단됩니다. 기본 테스트는
합성 입력과 실제 loopback/nonvendor PTY fixture만 사용합니다. 합성·로컬 nonvendor
결과로 actual-target qualification gate를 닫지 않습니다.
실제 consent/source 연동, 독립 input/runtime/system-tool closure 검토, 예방적
exec/process 및 나머지 evidence/overhead 예산, 실제 clock/admission/dispatch/termination/loss/
broker/escape 보장 검증, 전체 executor 순서·guard closure, 실제 cleanup
audit은 `--version`을 포함한 어떤 vendor 시도도 차단하는 미해결 항목입니다.
consent가 누락된 구현을 대신하지 않습니다. 17번째 receipt 파일의 생성 예방도 검증된
admission 거부와는 별도로 남아 있습니다.

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
