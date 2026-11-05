import { useEffect, useRef, useState } from 'react';
import type { ApplicationMode } from '../application-mode';
import { buildMeasurementRequest, buildSetupRequest, measurementSettingIdentifier } from '../guided-requests';
import type { GuidedSetupProps, InspectedComparison, SetupReviewResult } from '../types';

export function useGuidedState(props: GuidedSetupProps) {
  const { locale, project, setups } = props;
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const [path, setPath] = useState('');
  const [template, setTemplate] = useState('');
  const [documents, setDocuments] = useState<Record<string, string>>({});
  const [inspected, setInspected] = useState<InspectedComparison | null>(null);
  const [suggestedIdentifier, setSuggestedIdentifier] = useState('');
  const [freezeAt, setFreezeAt] = useState('');
  const [review, setReview] = useState<SetupReviewResult | null>(null);
  const [inputError, setInputError] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [bundleName, setBundleName] = useState('');
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [mode, setMode] = useState<ApplicationMode | ''>('');
  const inputRevision = useRef(0);
  const [copying, setCopying] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<{ kind: string; text: string } | null>(null);
  const selectedTemplate = setups.find(setup => !setup.shared && setup.project_id === project?.id && setup.id === template);
  const identifier = selectedTemplate?.id ?? (documents.identifier?.trim() || measurementSettingIdentifier('', documents.profile) || suggestedIdentifier);
  const measurementPrompt =
    !selectedTemplate &&
    buildMeasurementRequest(locale, project, path, inspected, identifier, {
      arm_a: documents.arm_a_status || null,
      arm_b: documents.arm_b_status || null
    });
  const [instruction, setInstruction] = useState('');
  const [supporting, setSupporting] = useState('');
  const [readme, setReadme] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      inputRevision.current++;
    };
  }, []);
  const prompt = buildSetupRequest(locale, project, instruction, supporting, readme, mode);
  const fileMode = review?.ready ? review.application_mode : inspected?.application_mode;
  const modeMismatch = !!mode && !!fileMode && mode !== fileMode;
  return {
    ...props,
    t,
    path,
    setPath,
    template,
    setTemplate,
    documents,
    setDocuments,
    inspected,
    setInspected,
    suggestedIdentifier,
    setSuggestedIdentifier,
    freezeAt,
    setFreezeAt,
    review,
    setReview,
    inputError,
    setInputError,
    confirmed,
    setConfirmed,
    bundleName,
    setBundleName,
    bundleError,
    setBundleError,
    loadingBundle,
    setLoadingBundle,
    mode,
    setMode,
    inputRevision,
    copying,
    setCopying,
    copied,
    setCopied,
    manualPrompt,
    setManualPrompt,
    selectedTemplate,
    identifier,
    measurementPrompt,
    instruction,
    setInstruction,
    supporting,
    setSupporting,
    readme,
    setReadme,
    active,
    prompt,
    fileMode,
    modeMismatch
  };
}

export type GuidedState = ReturnType<typeof useGuidedState>;
