import type { GuidedSetupProps } from './types';
import { useGuidedSetup } from './hooks/use-guided-setup';
import { GuidedApplicationMode } from './steps/GuidedApplicationMode';
import { GuidedCandidate } from './steps/GuidedCandidate';
import { GuidedComparison } from './steps/GuidedComparison';
import { GuidedMeasurementRequest } from './steps/GuidedMeasurementRequest';
import { GuidedBundle } from './steps/GuidedBundle';
import { GuidedPolicy } from './steps/GuidedPolicy';
import { GuidedReview } from './steps/GuidedReview';
import { GuidedAdvanced } from './steps/GuidedAdvanced';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export { measurementSettingIdentifier, buildSetupRequest, buildMeasurementRequest } from './guided-requests';

export function GuidedSetup(props: GuidedSetupProps) {
  const model = useGuidedSetup(props);
  const { t } = model;
  return (
    <Card data-guided-setup="">
      <CardHeader>
        <CardTitle>{t('2. Prepare comparison settings', '2. 비교·측정 설정 준비')}</CardTitle>
        <CardDescription>
          {t('Prepare with your agent, load one setup bundle and confirm the summary.', '에이전트와 준비하고, 설정 파일 하나를 불러와 요약을 확인하세요.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <GuidedApplicationMode {...model} />
        <GuidedCandidate {...model} />
        <GuidedComparison {...model} />
        <GuidedMeasurementRequest {...model} />
        <GuidedBundle {...model} />
        <GuidedPolicy {...model} />
        <GuidedReview {...model} />
        <GuidedAdvanced {...model} />
      </CardContent>
    </Card>
  );
}
