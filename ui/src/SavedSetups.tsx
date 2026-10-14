import type { ReactNode } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SetupSummary } from './SetupSummary';
import { taskSetupOptions } from './setup-options';
import type { Locale, Project, Setup } from './types';

export function SavedSetups({ locale, project, setups, busy, onUse, onImport, preview }: {
  locale: Locale;
  project: Project | null;
  setups: Setup[];
  busy: boolean;
  onUse: (setup: Setup) => void;
  onImport: () => void;
  preview: ReactNode;
}) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  const saved = taskSetupOptions(setups).filter(setup => setup.project_id === project?.id);
  return <Card data-saved-setups="">
    <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>{t('Saved comparison and measurement settings', '저장된 비교·측정 설정')}</CardTitle>
      {project && <span className="text-sm text-muted-foreground">{t(`${saved.length} saved`, `${saved.length}개`)}</span>}</div>
      <CardDescription>{t('Reuse these settings for this project when creating a new task.', '이 프로젝트에서 다시 사용할 설정입니다. 새 작업을 만들 때 선택하세요.')}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {project && <div className="rounded-lg bg-muted/40 p-4 text-sm"><p className="font-medium">{t('Already saved? You do not need to import it again.', '이미 저장했다면 다시 불러올 필요가 없습니다.')}</p>
        <p className="mt-1 text-muted-foreground">{t('The comparison pair and reviewed measurement conditions remain saved. Prepare a new setting above for a new candidate.', '하네스 A/B와 검토된 측정 조건이 저장됩니다. 새 개선 후보를 비교하려면 위에서 새 설정을 준비하세요.')}</p></div>}
      {!project ? <p className="text-sm text-muted-foreground">{t('Select a registered project above to see its saved settings.', '위에서 등록된 프로젝트를 선택하면 저장된 설정을 볼 수 있습니다.')}</p> :
        saved.length ? saved.map(setup => <SetupSummary key={setup.id} setup={setup} projectName={project.name} locale={locale} busy={busy} onUse={() => onUse(setup)} />) :
          <div data-saved-setups-empty="" className="rounded-lg border border-dashed p-5"><h3 className="font-medium">{t('No saved settings yet', '아직 저장된 설정이 없습니다')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('Prepare the candidate files above, then review and connect the comparison JSON returned by your agent.', '위에서 후보 파일을 준비하고, 에이전트가 만든 비교 JSON을 검토·연결하세요.')}</p></div>}
      <details className="border-t pt-4 text-sm"><summary className="cursor-pointer font-medium">{t('Have an existing settings file?', '기존 설정 파일이 있나요?')}</summary>
        <div className="mt-3 space-y-3"><p className="text-muted-foreground">{t('Import only a reviewed file that is not yet connected here.', '이 화면에 아직 연결하지 않은 검토된 설정 파일만 불러오세요.')}</p>
          <Button variant="outline" disabled={busy || !project} onClick={onImport}><FolderOpen />{t('Import existing settings file', '기존 설정 파일 불러오기')}</Button>
          <p className="text-muted-foreground">{t('For a new comparison, enter its JSON path in the step above. Importing a file alone does not create a comparison or start measurement.', '새 비교의 JSON 경로는 위 단계의 ‘비교 JSON 파일 경로’에 입력하세요. 파일 불러오기만으로 새 비교를 만들거나 측정을 시작하지 않습니다.')}</p></div>
      </details>
      {preview}
    </CardContent>
  </Card>;
}
