import { SetupBundleSchema } from '../setup-bundle';
import type { SetupReviewResult } from '../types';
import type { GuidedState } from './use-guided-state';

function buildGuidedReviewInput(state: GuidedState): Record<string, unknown> {
  const { path, project, selectedTemplate, documents, identifier, freezeAt, mode } = state;
  const input: Record<string, unknown> = { comparison_path: path, project_id: project?.id };
  if ((selectedTemplate || documents.profile?.trim()) && identifier) input.template_id = identifier;
  if (!selectedTemplate && !documents.variants?.trim() && documents.arm_a_status && documents.arm_b_status)
    input.policy_status = { arm_a: documents.arm_a_status, arm_b: documents.arm_b_status };
  for (const [key, value] of Object.entries(documents)) {
    if (['identifier', 'arm_a_status', 'arm_b_status'].includes(key) || (key === 'profile' && selectedTemplate)) continue;
    if (value.trim()) {
      const parsed: unknown = JSON.parse(value);
      if (key === 'profile' && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('id' in parsed) && identifier) {
        input[key] = { ...parsed, id: identifier };
      } else input[key] = parsed;
    }
  }
  if (freezeAt) input.freeze_at = freezeAt;
  if (mode) input.application_mode = mode;
  return input;
}

export function useGuidedReview(state: GuidedState, change: () => void) {
  const {
    t,
    project,
    mode,
    inputRevision,
    active,
    perform,
    setLoadingBundle,
    setBundleError,
    setPath,
    setTemplate,
    setDocuments,
    setFreezeAt,
    setInspected,
    setSuggestedIdentifier,
    setBundleName,
    setCopied,
    setManualPrompt,
    setReview,
    setInputError,
    setConfirmed
  } = state;
  async function loadBundle(file: File) {
    change();
    setLoadingBundle(true);
    const revision = inputRevision.current;
    try {
      const parsed = SetupBundleSchema.safeParse(JSON.parse(await file.text()) as unknown);
      if (!active.current || revision !== inputRevision.current) return;
      if (!parsed.success) {
        setBundleError(t('Choose the measurement setup bundle created by your agent.', '에이전트가 만든 측정 설정 묶음 파일을 선택하세요.'));
        return;
      }
      const { input } = parsed.data;
      if (input.project_id !== project?.id) {
        setBundleError(
          t('This bundle belongs to another project. Select its registered project first.', '다른 프로젝트의 설정입니다. 해당 등록 프로젝트를 먼저 선택하세요.')
        );
        return;
      }
      const next: Record<string, string> = {};
      for (const key of ['profile', 'protocol', 'variants', 'price_table'] as const)
        if (input[key] !== undefined) next[key] = JSON.stringify(input[key], null, 2);
      if (input.policy_status) {
        next.arm_a_status = input.policy_status.arm_a;
        next.arm_b_status = input.policy_status.arm_b;
      }
      if (input.template_id) next.identifier = input.template_id;
      setPath(input.comparison_path);
      setTemplate(input.profile ? '' : (input.template_id ?? ''));
      setDocuments(next);
      setFreezeAt('');
      setInspected(null);
      setSuggestedIdentifier('');
      setBundleName(file.name);
      setCopied(null);
      setManualPrompt(null);
      const result = await perform<SetupReviewResult>('/api/setup-review', input.application_mode || !mode ? input : { ...input, application_mode: mode });
      if (active.current && revision === inputRevision.current) {
        setReview(result);
        if (result && !result.ready && 'comparison' in result) {
          setInspected(result.comparison);
          setSuggestedIdentifier(result.comparison.proposed_profile_id);
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (active.current && revision === inputRevision.current)
        setBundleError(
          t('Could not read this JSON file. Check the file and select it again.', 'JSON 파일을 읽지 못했습니다. 파일을 확인하고 다시 선택하세요.')
        );
    } finally {
      if (active.current && revision === inputRevision.current) setLoadingBundle(false);
    }
  }
  async function inspect() {
    setInputError(false);
    let input: Record<string, unknown>;
    try {
      input = buildGuidedReviewInput(state);
    } catch {
      setInputError(true);
      return;
    }
    setConfirmed(false);
    const revision = inputRevision.current;
    const result = await perform<SetupReviewResult>('/api/setup-review', input);
    if (active.current && inputRevision.current === revision) {
      if (result && !result.ready && 'comparison' in result) {
        setInspected(result.comparison);
        setSuggestedIdentifier(result.comparison.proposed_profile_id);
      } else if (!result) setInspected(null);
      setReview(result);
    }
  }
  return { loadBundle, inspect };
}
