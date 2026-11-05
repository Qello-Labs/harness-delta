export function subscribeTaskRefresh(refresh: () => void): () => void {
  const visible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', visible);
  const timer = setInterval(refresh, 2500);
  refresh();
  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', visible);
  };
}
