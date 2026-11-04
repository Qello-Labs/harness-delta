import { afterEach, expect, test, vi } from 'vitest';
import { subscribeTaskRefresh } from './task-refresh';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('refreshes immediately on returning from the applying agent and removes listeners on cleanup', () => {
  vi.useFakeTimers();
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  const refresh = vi.fn();
  const stop = subscribeTaskRefresh(refresh);
  expect(refresh).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event('focus'));
  expect(refresh).toHaveBeenCalledTimes(2);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(refresh).toHaveBeenCalledTimes(2);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(refresh).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(2500);
  expect(refresh).toHaveBeenCalledTimes(4);
  stop();
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(2500);
  expect(refresh).toHaveBeenCalledTimes(4);
});
