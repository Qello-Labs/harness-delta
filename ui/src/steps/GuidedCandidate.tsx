import type { GuidedSetupModel } from '../hooks/use-guided-setup';
import { Check, Copy, Files } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type GuidedCandidateProps = Pick<
  GuidedSetupModel,
  | 't'
  | 'inspected'
  | 'bundleName'
  | 'project'
  | 'mode'
  | 'instruction'
  | 'setInstruction'
  | 'setCopied'
  | 'setManualPrompt'
  | 'supporting'
  | 'setSupporting'
  | 'readme'
  | 'setReadme'
  | 'prompt'
  | 'copying'
  | 'copied'
  | 'copyRequest'
  | 'manualPrompt'
>;

export function GuidedCandidate(props: GuidedCandidateProps) {
  return (
    <details open={!props.inspected && !props.bundleName}>
      <summary className="cursor-pointer font-medium">{props.t('Prepare a harness comparison first', '하네스 비교 파일부터 준비하기')}</summary>
      <div className="mt-4 grid min-w-0 gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <div className="rounded-lg bg-muted/40 p-4">
            <p className="font-medium">{props.project?.name ?? props.t('Select a registered project above', '위에서 등록된 프로젝트를 선택하세요')}</p>
            {props.project && (
              <>
                <p className="break-all text-sm text-muted-foreground">{props.project.directory}</p>
                <p className="break-all text-xs text-muted-foreground">{props.project.id}</p>
              </>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="guided-instruction">
              {props.mode === 'agent_applied'
                ? props.t('Application procedure for the candidate (required)', '후보 적용 절차 (필수)')
                : props.mode === 'selected_markdown_only'
                  ? props.t('Candidate instruction (required)', '후보 지침 (필수)')
                  : props.t('Candidate instruction or application procedure (required)', '후보 지침 또는 적용 절차 (필수)')}
            </Label>
            <Input
              id="guided-instruction"
              value={props.instruction}
              disabled={!props.project}
              placeholder="harness/candidate.md"
              onChange={event => {
                props.setInstruction(event.target.value);
                props.setCopied(null);
                props.setManualPrompt(null);
              }}
            />
            <p className="text-sm text-muted-foreground">
              {props.t(
                'Provide a user-prepared file path relative to the selected project. An existing file is not evidence of application.',
                '선택한 프로젝트 기준으로 사용자가 준비한 파일의 상대경로를 입력하세요. 파일 존재는 적용 근거가 아닙니다.'
              )}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="guided-supporting">
              {props.t('Supporting scripts or documents (optional, one relative path per line)', '참고 스크립트·문서 (선택, 한 줄에 상대경로 하나)')}
            </Label>
            <textarea
              id="guided-supporting"
              value={props.supporting}
              disabled={!props.project}
              rows={3}
              className="w-full rounded border bg-background p-3 text-sm"
              onChange={event => {
                props.setSupporting(event.target.value);
                props.setCopied(null);
                props.setManualPrompt(null);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="guided-readme">{props.t('README source (optional relative path)', 'README 원본 (선택 상대경로)')}</Label>
            <Input
              id="guided-readme"
              value={props.readme}
              disabled={!props.project}
              onChange={event => {
                props.setReadme(event.target.value);
                props.setCopied(null);
                props.setManualPrompt(null);
              }}
            />
          </div>
          <Button
            disabled={!props.prompt || props.copying !== null}
            data-copy-skill="harness-register+harness-compare-config"
            onClick={() => {
              if (props.prompt) void props.copyRequest('setup', props.prompt);
            }}
          >
            {props.copied === 'setup' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {props.copied === 'setup' ? props.t('Copied', '복사됨') : props.t('Copy agent request', '에이전트 요청문 복사')}
          </Button>
          {props.copied === 'setup' && (
            <p role="status" className="text-sm">
              {props.t('Paste into your agent. Confirm its proposal before registration.', '에이전트에 붙여넣고 등록 전에 제안을 확인하세요.')}
            </p>
          )}
        </div>
        <aside className="min-w-0 space-y-4 rounded-lg bg-muted/30 p-4 text-sm">
          <h3 className="flex items-center gap-2 font-medium">
            <Files className="size-4" aria-hidden="true" />
            {props.t('Current A → prepared B', '현재 A → 준비한 B')}
          </h3>
          <p>
            {props.t(
              'A is what is actually applied now. B is your prepared improvement with common policies preserved. The agent inspects both, groups questions and asks you to confirm IDs, versions, mode and selected files.',
              'A는 지금 실제 적용 중인 구성입니다. B는 공통 정책을 보존한 준비된 개선안입니다. 에이전트가 둘을 확인하고 ID·버전·방식·선택 파일에 관한 질문을 묶어 확인받습니다.'
            )}
          </p>
          <p>
            {props.t(
              'Human adoption and real application are separate. Once adopted and applied, that current state becomes A; the next candidate C takes role B. Latest bundles, success and cost never auto-adopt.',
              '사람의 채택 결정과 실제 적용은 별도입니다. 채택하고 적용한 현재 상태가 다음 A가 되며 새 후보 C가 B 역할을 맡습니다. 최신 bundle·성공·비용으로 자동 채택하지 않습니다.'
            )}
          </p>
          <details>
            <summary className="cursor-pointer text-muted-foreground">{props.t('View combined request', '통합 요청문 보기')}</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
              {props.prompt ??
                props.t(
                  'Select a project and enter valid relative file paths to prepare the request.',
                  '프로젝트를 선택하고 유효한 상대경로를 입력하면 요청문이 준비됩니다.'
                )}
            </pre>
          </details>
        </aside>
      </div>
      {props.manualPrompt?.kind === 'setup' && (
        <div className="space-y-2">
          <p role="alert" className="text-sm">
            {props.t('Clipboard access failed. Select and copy the request below.', '복사하지 못했습니다. 아래 요청문을 직접 복사하세요.')}
          </p>
          <textarea
            aria-label={props.t('Request to copy manually', '직접 복사할 요청문')}
            readOnly
            rows={4}
            value={props.manualPrompt.text}
            onFocus={event => event.currentTarget.select()}
            className="w-full rounded border bg-background p-3 text-sm"
          />
        </div>
      )}
    </details>
  );
}
