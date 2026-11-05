import type { GuidedSetupProps } from '../types';
import { useGuidedReview } from './use-guided-review';
import { useGuidedState } from './use-guided-state';

export function useGuidedSetup(props: GuidedSetupProps) {
  const state = useGuidedState(props);
  const { active, setCopying, setCopied, setManualPrompt, inputRevision, setReview, setConfirmed, setInputError, setBundleError, setLoadingBundle } = state;
  async function copyRequest(skill: string, prompt: string) {
    setCopying(skill);
    setCopied(null);
    setManualPrompt(null);
    try {
      await navigator.clipboard.writeText(prompt);
      if (active.current) setCopied(skill);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (active.current) setManualPrompt({ kind: skill, text: prompt });
    } finally {
      if (active.current) setCopying(null);
    }
  }
  const change = () => {
    inputRevision.current++;
    setReview(null);
    setConfirmed(false);
    setInputError(false);
    setBundleError(null);
    setLoadingBundle(false);
  };
  const reviewActions = useGuidedReview(state, change);
  return { ...state, copyRequest, change, ...reviewActions };
}

export type GuidedSetupModel = ReturnType<typeof useGuidedSetup>;
