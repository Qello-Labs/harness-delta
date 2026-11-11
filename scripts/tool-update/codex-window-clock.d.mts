import type { WindowClockOptions, WindowWatch } from "./codex-window-watch.mjs";
export function createWindowClock(options: WindowClockOptions): WindowWatch;
export function sampleWindowContinuousTime(options: WindowClockOptions): Promise<bigint>;
