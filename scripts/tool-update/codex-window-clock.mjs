import { createWindowNativeService } from "./codex-window-watch.mjs";
import { WindowWatchError } from "./codex-window-watch.mjs";

export function createWindowClock(options) {
	return createWindowNativeService("clock", options);
}

export async function sampleWindowContinuousTime(options) {
	const clock = createWindowClock(options);
	let value, result;
	try {
		value = await clock.clock();
	} finally {
		result = await clock.stop();
	}
	if (result.failed) throw new WindowWatchError("continuous_clock_lost");
	return value;
}
