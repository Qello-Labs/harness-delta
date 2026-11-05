import { lazy } from 'react';
const GettingStarted = lazy(() => import('../GettingStarted.js').then(module => ({ default: module.GettingStarted })));
import { Suspense } from 'react';
import type { AppModel } from '../hooks/use-app-model';

export function IntroScreen({ model }: { model: AppModel }) {
  const { t, locale, snapshot, navigate } = model;
  return (
    <Suspense fallback={<p role="status">{t('Loading guidance…', '안내 확인 중…')}</p>}>
      <GettingStarted locale={locale} setups={snapshot.setups} onNavigate={next => navigate(next === 'new' && !snapshot.projects.length ? 'setup' : next)} />
    </Suspense>
  );
}
