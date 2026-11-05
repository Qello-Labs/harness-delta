import { BookOpen, ListTodo, LoaderCircle, Settings, Waypoints } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AppModel } from '../hooks/use-app-model';
import type { ReactNode } from 'react';
import { AppFeedback } from './AppFeedback';
import { TaskConfirmation } from './TaskConfirmation';

export function AppLayout({ model, children }: { model: AppModel; children: ReactNode }) {
  const { navigate, t, screen, loading, online, locale, setLocale, busy } = model;
  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-screen bg-background text-foreground">
        <header className="border-b bg-card">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
            <button type="button" className="flex items-center gap-2 font-semibold" onClick={() => navigate('tasks')}>
              <Waypoints className="size-5" />
              Harness Delta<Badge variant="secondary">{t('Local', '로컬')}</Badge>
            </button>
            <nav className="flex gap-2" aria-label={t('Main navigation', '주요 탐색')}>
              <Button
                data-screen="intro"
                aria-current={screen === 'intro' ? 'page' : undefined}
                variant={screen === 'intro' ? 'secondary' : 'ghost'}
                onClick={() => navigate('intro')}
              >
                <BookOpen aria-hidden="true" />
                {t('Getting started', '시작 안내')}
              </Button>
              <Button
                data-screen="tasks"
                aria-current={screen === 'tasks' || screen === 'detail' || screen === 'new' ? 'page' : undefined}
                variant={screen === 'tasks' || screen === 'detail' || screen === 'new' ? 'secondary' : 'ghost'}
                onClick={() => navigate('tasks')}
              >
                <ListTodo aria-hidden="true" />
                {t('Tasks', '작업')}
              </Button>
              <Button
                data-screen="setup"
                aria-current={screen === 'setup' ? 'page' : undefined}
                variant={screen === 'setup' ? 'secondary' : 'ghost'}
                onClick={() => navigate('setup')}
              >
                <Settings aria-hidden="true" />
                {t('Setup', '설정')}
              </Button>
            </nav>
            <div className="flex items-center gap-2">
              <span data-connection={loading ? 'loading' : online ? 'online' : 'offline'} className="text-xs text-muted-foreground">
                {loading ? t('Connecting…', '연결 확인 중…') : online ? t('Connected locally', '로컬 연결됨') : t('Disconnected', '연결 끊김')}
              </span>
              <Button variant="outline" size="sm" aria-pressed={locale === 'ko'} onClick={() => setLocale('ko')}>
                KO
              </Button>
              <Button variant="outline" size="sm" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
                EN
              </Button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
          <AppFeedback model={model} />
          {children}
        </main>
        <TaskConfirmation model={model} />
        {busy && (
          <div role="status" className="fixed bottom-6 right-6 flex items-center gap-2 rounded-lg border bg-card px-4 py-3 shadow">
            <LoaderCircle className="size-4 animate-spin" />
            {t('Checking current state…', '현재 상태 확인 중…')}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
