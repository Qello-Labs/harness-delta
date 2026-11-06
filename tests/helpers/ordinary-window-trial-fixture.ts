import type { ordinaryWindowFixture } from './ordinary-window-fixture.js';
import { activateOrdinaryWindowDecision } from '../../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowBatch } from '../../src/ordinary-window-binding.js';
import { windowTrialPacket } from './ordinary-window-decision-fixture.js';

export function prepareOrdinaryWindowTrialFixture(f: ReturnType<typeof ordinaryWindowFixture>, tokenLimit = 100) {
  let now = Date.parse(f.clock());
  const clock = () => new Date(now).toISOString();
  activateOrdinaryWindowDecision(f.store, windowTrialPacket(f.selection, { tokenLimit }), clock());
  f.connect();
  now += 1000;
  const usage = (id = 'one') => {
    const record = f.record(id);
    return {
      ...record,
      payload: {
        ...record.payload,
        input_total: {
          status: 'observed' as const,
          value: 10,
          reason: null
        },
        cached_input: {
          status: 'observed' as const,
          value: 2,
          reason: null
        },
        output_total: {
          status: 'observed' as const,
          value: 5,
          reason: null
        },
        reasoning_output: {
          status: 'observed' as const,
          value: 1,
          reason: null
        }
      }
    };
  };
  f.onRead(() => Promise.resolve(f.batch([usage()])));
  const read = (baseline = false) =>
    readOrdinaryWindowBatch({
      store: f.store,
      taskId: f.taskId,
      rootSessionId: f.rootId,
      baseline,
      clock,
      provider: () => {
        f.calls.push('construct');
        return f.provider;
      }
    });
  return {
    ...f,
    usage,
    read,
    clock,
    advance: (amount: number) => {
      now += amount;
    }
  };
}

export function replaceOrdinaryWindowTrialRoot(f: ReturnType<typeof ordinaryWindowFixture>) {
  f.store.immediateTransaction(() => {
    f.store.execute("UPDATE binding_root_segments SET state='closed',revision=revision+1 WHERE root_session_id=?", [f.rootId]);
    f.store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('replacement','project',?,'codex','0.167.0')", [f.taskId]);
    f.store.execute(
      `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
      VALUES ('replacement',?,'codex','replacement-native-root','/synthetic/window-project','acquiring',?)`,
      [f.taskId, f.clock()]
    );
    f.store.execute("UPDATE ordinary_tasks SET selected_root_id='replacement' WHERE task_id=?", [f.taskId]);
  });
}
