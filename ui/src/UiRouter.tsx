import { useEffect, useState } from 'react';
import { App } from './App.js';
import { OrdinaryWindowScreen } from './OrdinaryWindowReport.js';

export function UiRouter() {
  const [route, setRoute] = useState(() => location.hash);
  useEffect(() => {
    const changed = () => setRoute(location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return route === '#ordinary-window-task-v1' || route.startsWith('#ordinary-window-task-v1?') ? <OrdinaryWindowScreen key={route} route={route} /> : <App />;
}
