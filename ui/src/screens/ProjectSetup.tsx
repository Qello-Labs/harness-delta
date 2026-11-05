import { Field } from '../app-controls';
import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { AppModel } from '../hooks/use-app-model';

export function ProjectSetup({ model }: { model: AppModel }) {
  const { t, snapshot, setupProject, selectSetupProject, directory, setDirectory, busy, online, perform, setNotice } = model;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('1. Register and select a project', '1. 프로젝트 등록·선택')}</CardTitle>
        <CardDescription>
          {t('Selection registers a directory; it creates no repository or commit.', '디렉토리를 등록하며 저장소나 커밋을 만들지 않습니다.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="radiogroup" aria-label={t('Project for harness preparation', '하네스를 준비할 프로젝트')} className="grid min-w-0 gap-3 sm:grid-cols-2">
          {snapshot.projects.map(p => (
            <div key={p.id} className={setupProject === p.id ? 'min-w-0 rounded-lg border bg-muted/40 p-4' : 'min-w-0 rounded-lg border p-4'}>
              <label className="flex items-center gap-2 font-medium">
                <input type="radio" name="setup-project" value={p.id} checked={setupProject === p.id} onChange={() => selectSetupProject(p.id)} />
                {p.name}
              </label>
              <p className="mt-1 break-all text-sm text-muted-foreground">{p.directory}</p>
              <details className="mt-3 text-sm">
                <summary>{t('Project details', '프로젝트 상세')}</summary>
                <p className="mt-2 break-all">Project ID: {p.id}</p>
                <p className="mt-2 break-all">
                  {t('Git HEAD read automatically: ', '자동 조회한 Git HEAD: ')}
                  {p.baseline ?? '—'}
                </p>
              </details>
            </div>
          ))}
        </div>
        <Field
          id="directory"
          label={t('Project directory', '프로젝트 디렉토리')}
          help={t(
            'Explicitly select the local project. No unrelated session discovery or arbitrary path writes.',
            '로컬 프로젝트를 명시적으로 선택합니다. 무관한 세션 탐색이나 임의 경로 쓰기를 하지 않습니다.'
          )}
        >
          <div className="flex gap-2">
            <Input
              id="directory"
              value={directory}
              onChange={e => setDirectory(e.target.value)}
              placeholder={t('Choose a directory', '디렉토리를 선택하세요')}
            />
            <Button
              variant="outline"
              disabled={busy || !online}
              onClick={() => {
                void perform<{ selection: string | null }>('/api/project-picker', {}).then(value => {
                  if (value?.selection) setDirectory(value.selection);
                });
              }}
            >
              <FolderOpen />
              {t('Choose', '선택')}
            </Button>
          </div>
        </Field>
        <Button
          disabled={busy || !online || !directory.trim()}
          onClick={() => {
            void perform('/api/projects', { directory }).then(value => {
              if (value) {
                setDirectory('');
                setNotice(
                  t(
                    'Project connected. Create an ordinary task or prepare reviewed comparison settings.',
                    '프로젝트를 연결했습니다. 일반 작업을 만들거나 비교 설정을 준비하세요.'
                  )
                );
              }
            });
          }}
        >
          {t('Connect project', '프로젝트 연결')}
        </Button>
      </CardContent>
    </Card>
  );
}
