import type { Setup } from './types';

export function taskSetupOptions(setups: Setup[]): Setup[] {
  return setups.filter(setup => setup.shared || !setups.some(connected =>
    connected.project_id === setup.project_id && connected.shared?.template_id === setup.id));
}
