# 지원 매트릭스

[English](support-matrix.md)

[registry](../src/core/tool-version-profiles.json)와 같은 데이터로 생성한 [current-support.json](../scripts/generated/current-support.json)의 정확 경로 투영입니다. `node scripts/generate-tool-version-assets.mjs`로 재생성하고 `--check`로 검사합니다. 직접 편집하지 마세요.

## 정확한 경로

`not_declared`는 이 투영에 값이 없다는 뜻입니다. 선언되지 않은 버전이나 경로를 정확 등록/admission으로 지원하지 않습니다. 별도 조건부 parser 재사용이나 명시적으로 승인한 pilot을 미지원이라고 단정하지는 않습니다. `transcriptProfile`은 ordinary admission과 별도 근거이며 profile ID가 선언되지 않을 수 있습니다.

| 제품 | 버전 | 경로 | status | profileId | qualification | 추가 registry 값 |
| --- | --- | --- | --- | --- | --- | --- |
| `"codex"` | `"0.156.1"` | `"file"` | `"registered"` | `"codex-file-legacy-v1"` | `"not_declared"` | `{"parserVariant":"codex_legacy_v1"}` |
| `"codex"` | `"0.156.1"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.156.1"` | `"ordinaryBinding"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.156.1"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.156.1"` | `"transcriptProfile"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.283"` | `"file"` | `"registered"` | `"claude-file-message-components-v1"` | `"not_declared"` | `{"parserVariant":"claude_message_components_v1"}` |
| `"claude_code"` | `"2.1.283"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.283"` | `"ordinaryBinding"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.283"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.283"` | `"transcriptProfile"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.158.0"` | `"file"` | `"ledger_registered"` | `"codex-file-checkpoint-v1"` | `"not_declared"` | `{"parserVariant":"codex_checkpoint_v1","policyRevision":"codex-rollout-m2-v1"}` |
| `"codex"` | `"0.158.0"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.158.0"` | `"ordinaryBinding"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.158.0"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.158.0"` | `"transcriptProfile"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.160.0"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.160.0"` | `"workflow"` | `"admitted"` | `"codex-workflow-own-response-v1"` | `"not_declared"` | `{"operationVariant":"codex_own_response_workflow_v1"}` |
| `"codex"` | `"0.160.0"` | `"workflow"` | `"admitted"` | `"codex-workflow-direct-child-v1"` | `"not_declared"` | `{"operationVariant":"codex_own_response_workflow_v1"}` |
| `"codex"` | `"0.160.0"` | `"ordinaryBinding"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.160.0"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.160.0"` | `"transcriptProfile"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.162.0"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.162.0"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.162.0"` | `"ordinaryBinding"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.162.0"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.162.0"` | `"transcriptProfile"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.162.1"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.162.1"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.162.1"` | `"ordinaryBinding"` | `"admitted"` | `"codex-binding-01621-direct-family-v1"` | `{"qualification":"implicit_verified"}` | `{"model":"gpt-6.1-sol","effort":"high","maxDepth":1,"maxFamilyMembers":3,"modelPolicy":"gpt_family_observed_effort_v1","historyVariant":"codex_paginated_own_suffix_v1","rootOnlyOverride":false,"evidenceId":"codex-binding-01621-native-family-v1","evidenceIntentSha256":"bc6a3cdca7f0750c901e3f95087f63b34e5ecd6c1584fdae78f2729145f9fc2e","costStatus":"partial"}` |
| `"codex"` | `"0.162.1"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.162.1"` | `"transcriptProfile"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.163.0"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.163.0"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.163.0"` | `"ordinaryBinding"` | `"admitted"` | `"codex-binding-01630-direct-family-v1"` | `{"qualification":"verified"}` | `{"model":"gpt-6.1-sol","effort":"high","maxDepth":1,"maxFamilyMembers":3,"modelPolicy":"gpt_family_observed_effort_v1","historyVariant":"codex_reject_inherited_history_v1","rootOnlyOverride":false,"evidenceId":"codex-binding-01630-native-family-v1","evidenceIntentSha256":"a8add9d20b6c7c7845090c70b4896d0b6922acfdb916495b81ec71dc4281683e","costStatus":"partial"}` |
| `"codex"` | `"0.163.0"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.163.0"` | `"transcriptProfile"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.166.0"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.166.0"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.166.0"` | `"ordinaryBinding"` | `"admitted"` | `"codex-binding-01660-direct-family-v1"` | `{"qualification":"unqualified"}` | `{"model":"gpt-6.1-sol","effort":"high","maxDepth":1,"maxFamilyMembers":3,"modelPolicy":"gpt_family_observed_effort_v1","historyVariant":"codex_reject_inherited_history_v1","rootOnlyOverride":true,"costStatus":"partial"}` |
| `"codex"` | `"0.166.0"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"codex"` | `"0.166.0"` | `"transcriptProfile"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.296"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.296"` | `"workflow"` | `"admitted"` | `"claude-workflow-own-trace-v1"` | `"not_declared"` | `{"operationVariant":"claude_parent_workflow_v1"}` |
| `"claude_code"` | `"2.1.296"` | `"workflow"` | `"admitted"` | `"claude-workflow-direct-child-v1"` | `"not_declared"` | `{"operationVariant":"claude_exact_child_workflow_v1"}` |
| `"claude_code"` | `"2.1.296"` | `"ordinaryBinding"` | `"admitted"` | `"claude-binding-02196-family-v1"` | `{"qualified":false}` | `{"model":"claude-opus-5-5","maxFamilyMembers":8,"modelPolicy":"claude_family_observed_effort_v1","historyVariant":"claude_flattened_family_v1","imageIdentity":"claude-2.1.296-ordinary-image","evidenceId":"claude-binding-02196-ordinary-native-v1","costStatus":"partial"}` |
| `"claude_code"` | `"2.1.296"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.296"` | `"transcriptProfile"` | `"qualified"` | `"not_declared"` | `"not_declared"` | `{"evidence":"offline-actual-binary;native-pilot-2026-10-13;validation/claude-ordinary-binding-02196-qualification.md","finalityVariant":"claude_terminal_message_v1","legacyDefault":true}` |
| `"claude_code"` | `"2.1.301"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.301"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.301"` | `"ordinaryBinding"` | `"admitted"` | `"claude-binding-2-1-301-family-v1"` | `{"qualified":false}` | `{"model":"claude-sonnet-5-5","maxFamilyMembers":3,"modelPolicy":"claude_family_observed_effort_v1","historyVariant":"claude_flattened_family_v1","imageIdentity":"claude-2.1.301-ordinary-image","evidenceId":"claude-binding-2-1-301-ordinary-native-v1","costStatus":"partial"}` |
| `"claude_code"` | `"2.1.301"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.301"` | `"transcriptProfile"` | `"qualified"` | `"not_declared"` | `"not_declared"` | `{"evidence":"offline-actual-binary-print-normal-sigint-2026-10-16;validation/claude-ordinary-binding-02196-qualification.md","finalityVariant":"claude_terminal_message_v1","legacyDefault":false}` |
| `"claude_code"` | `"2.1.306"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.306"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.306"` | `"ordinaryBinding"` | `"admitted"` | `"claude-binding-2-1-306-family-v1"` | `{"qualified":false}` | `{"model":"claude-sonnet-5-5","maxFamilyMembers":3,"modelPolicy":"claude_family_observed_effort_v1","historyVariant":"claude_flattened_family_v1","imageIdentity":"claude-2.1.306-ordinary-image","evidenceId":"claude-binding-2-1-306-ordinary-localhost-v1","costStatus":"partial"}` |
| `"claude_code"` | `"2.1.306"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.306"` | `"transcriptProfile"` | `"qualified"` | `"not_declared"` | `"not_declared"` | `{"evidence":"offline-actual-binary-print-normal-sigint-2026-10-21;validation/claude-ordinary-binding-02196-qualification.md","finalityVariant":"claude_terminal_message_v1","legacyDefault":false}` |
| `"claude_code"` | `"2.1.294"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.294"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.294"` | `"ordinaryBinding"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.294"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.294"` | `"transcriptProfile"` | `"candidate"` | `"not_declared"` | `"not_declared"` | `{"evidence":"official-changelog-2.1.294;synthetic-fixtures;native-qualification-pending","finalityVariant":"claude_candidate_quiescence_v1","legacyDefault":false}` |
| `"claude_code"` | `"2.1.293"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.293"` | `"workflow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.293"` | `"ordinaryBinding"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.293"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.293"` | `"transcriptProfile"` | `"candidate"` | `"not_declared"` | `"not_declared"` | `{"evidence":"synthetic-fixtures;native-qualification-pending","finalityVariant":"claude_candidate_quiescence_v1","legacyDefault":false}` |
| `"claude_code"` | `"2.1.291"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.291"` | `"workflow"` | `"retired"` | `"claude-workflow-own-trace-v1"` | `"not_declared"` | `{"retiredAt":"2026-10-13"}` |
| `"claude_code"` | `"2.1.291"` | `"ordinaryBinding"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.291"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.291"` | `"transcriptProfile"` | `"candidate"` | `"not_declared"` | `"not_declared"` | `{"evidence":"official-docs-2026-10-07;synthetic-fixtures;native-qualification-pending","finalityVariant":"claude_candidate_quiescence_v1","legacyDefault":false}` |
| `"claude_code"` | `"2.1.288"` | `"file"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.288"` | `"workflow"` | `"retired"` | `"claude-workflow-own-trace-v1"` | `"not_declared"` | `{"retiredAt":"2026-10-06"}` |
| `"claude_code"` | `"2.1.288"` | `"ordinaryBinding"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.288"` | `"ordinaryWindow"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |
| `"claude_code"` | `"2.1.288"` | `"transcriptProfile"` | `"not_declared"` | `"not_declared"` | `"not_declared"` | `{}` |

## 범례와 제한

| 값 | 의미와 운영 경계 |
| --- | --- |
| `registered` | 정확 파일 adapter 등록입니다. 전체 사용량이나 비용 검증이 아닙니다. |
| `ledger_registered` | 정책 revision을 가진 ledger 기반 정확 등록입니다. 과거 admission이 현재 source identity나 전체 작업 완전성을 검증하지 않습니다. |
| `admitted` | 해당 정확 경로와 profile 범위의 사용 허용입니다. native qualification, 다른 경로 또는 과거 관측의 승격이 아닙니다. |
| `retired` | 이 workflow admission은 지원 종료됐으며 현재 허용 경로가 아닙니다. |
| `candidate` | 후보 근거만 있으며 검증된 production admission이 아닙니다. |
| `qualified` | transcriptProfile에 기록된 제한된 print-mode 근거입니다. interactive, authenticated ordinary, broader resume/compaction 검증이 아닙니다. |
| `implicit_verified` | registry가 유지하는 암묵적 검증 상태입니다. 명시적 verified로 바꾸거나 다른 source에 적용하지 않습니다. |
| `verified` | 명시적으로 기록된 해당 경로의 qualification 상태입니다. 다른 경로나 전체 비용 검증이 아닙니다. |
| `unqualified` | qualification 미완료입니다. selectable/admitted라는 이유로 검증된 지원이라고 표현하지 않습니다. |
| `qualified: false` | ordinary qualification은 false로 남습니다. 일반 사용 admission이나 transcript 검증이 이 값을 바꾸지 않습니다. |
| `not_declared` | 필드 또는 정확 경로 선언이 없습니다. 검증됨, 관측된 0 또는 허용으로 추정하지 않습니다. |
| `compatibility_unverified` | 별도 유한 window의 조건부 재사용 상태입니다. 정확 admission이 아니며 추정값을 분리하고 비호환 데이터를 무효화합니다. |

- 일반 파일, binding, workflow 사용량과 비용은 partial이며 전체 비용, 청구액, 추론 기반 도입 판단은 제공하지 않습니다. 별도 검증된 instrumented Codex의 표준화된 complete cost를 일반 관측에 적용하지 않습니다. [관측 비용](runbooks/observed-cost.ko.md)을 참고하세요.
- 정확 버전과 요구되는 binary/source pin을 지키세요. admission, qualification, 설치, 설정, synthetic 검증은 별개이며 과거 관측의 provenance를 승격하지 않습니다. 저장 버전은 자동 갱신하지 않고 버전 생략은 저장값을 유지하며 고정 작업과 가격은 이전하지 않습니다.
- `gpt_family_observed_effort_v1`과 `claude_family_observed_effort_v1`은 해당 제품 계열 모델과 관측 effort 정책입니다. model/effort 근거 값을 모든 실행의 pin으로 해석하지 마세요. 다른 제품 모델은 거부되며 Claude batch는 원자적으로 거부됩니다.
- Codex ordinary family는 등록된 고정 `functional_pilot`, 새 CLI root와 제한된 새 직접 자식을 요구합니다. assignment-free Claude 모드나 qualification lease가 권한을 부여하지 않습니다. `maxFamilyMembers`는 root를 포함하고 `rootOnlyOverride: true`는 family 검증을 뜻하지 않습니다. [연결 절차](runbooks/harness-connect.ko.md)를 따르세요.
- Codex child workflow는 read-only이며 family resume과 더 넓은 descendant 수집을 허용하지 않습니다. Claude child workflow도 새 read-only 직접 자식 하나로 제한하고 child resume, 더 깊거나 추가된 자식을 지원하지 않습니다. [native workflow](runbooks/task-native-workflow.md)에 작업별 경계를 유지합니다.
- 비교/pilot provider는 transcript-qualified profile에도 `allowCandidateProfiles: true`와 별도 로컬 pilot 권한을 요구하며 기본 거부는 닫혀 있습니다. `native_unverified_pilot`, `legacy_unverified`, `candidate_pilot` 표시는 유지되고 일반 관측 권한을 부여하지 않습니다. [pilot 절차](runbooks/harness-connect.ko.md#claude-사용자-조작-ui-pilot)를 참고하세요.
- 승격 경로는 오프라인 인프라뿐입니다. 실제 승격 descriptor나 grant가 없으므로 사용할 수 없고 출시 전 게이트 R0~R7은 보류 상태입니다. 오프라인 완료는 운영 지원이 아닙니다. [승격 지원 상태](development/tool-update-pipeline.ko.md#승격-지원-상태)를 참고하세요.
- 관측하지 않은 연결 전·일시정지·오프라인 구간은 backfill하지 않습니다. 누락 사용량이나 가격은 0이 아니라 unknown입니다. complete request-universe와 terminal accounting은 일반 관측으로 검증되지 않습니다.

## Ordinary window

이 registry 투영에는 ordinary-window 정책, profile 또는 cap 데이터가 없습니다. 따라서 버전 cap을 생성하거나 정확 admission으로 추론하지 않습니다. 구현된 유한 정책은 [ADR 013](decisions/013-forward-version-compatibility.md#implemented-windows-and-evidence)과 [Codex 설정](runbooks/harness-connect.ko.md#codex-일반-window-설정-수집-비활성), [Claude 설정](runbooks/harness-connect.ko.md#claude-일반-window-설정-수집-비활성)을 참고하세요.

Window activation은 기본적으로 닫혀 있습니다. 오프라인 구현, 설치와 정적 선택은 수집이나 정확 지원을 활성화하지 않습니다. 별도 제품 활성화와 native 검증이 필요하며 root-source 참조는 root-own 사용량이 아닙니다. 소유는 미검증이고 자식 관측 범위와 비용은 null로 남습니다.

## 근거와 절차

- [버전 admission 절차](runbooks/codex-version-admission.md)와 [기여 절차](../CONTRIBUTING.md#file-adapter-profiles)
- [정확 adapter capability 근거](decisions/001-adapter-capabilities.md)와 [일반 관측 정책](decisions/016-ordinary-observation.md)
- [Codex ordinary qualification 기록](validation/codex-ordinary-binding-qualification.ko.md)과 [Claude transcript 및 ordinary 근거](validation/claude-ordinary-binding-02196-qualification.md)
- [Codex checkpoint readiness 한도](validation/codex-01580-offline-readiness.md): 과거 live report는 현재 source identity나 전체 작업 완전성을 검증하지 않습니다.
