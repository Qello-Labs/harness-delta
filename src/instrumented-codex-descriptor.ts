import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { IdSchema, TokenSchema } from './contracts.js';
import { InstrumentedAccounting, InstrumentedAccountingError } from './instrumented-codex-accounting.js';

export const InstrumentedBootstrapSchema = z.strictObject({
  schema_version: z.literal(1), protocol: z.literal('harness-codex-accounting-v1'),
  run_id: IdSchema, producer_instance_id: IdSchema, task_generation: TokenSchema,
  configuration_receipt_id: IdSchema, configuration_revision: IdSchema, root_session_id: IdSchema,
});

/** This transports permits, not producer admission; the caller must own the verified subprocess. */
export function connectInstrumentedDescriptor(
  accounting: InstrumentedAccounting,
  descriptor: Duplex,
  producerInstanceId: string,
) {
  accounting.assertActive();
  if (producerInstanceId !== accounting.producerInstanceId()) {
    accounting.recordTransportFailure('record_conflict');
    throw new InstrumentedAccountingError('unowned_record');
  }
  const control = accounting.control();
  const bootstrap = InstrumentedBootstrapSchema.parse({
    schema_version: 1, protocol: 'harness-codex-accounting-v1',
    run_id: control.run_id, producer_instance_id: producerInstanceId,
    task_generation: control.task_generation, configuration_receipt_id: control.configuration_receipt_id,
    configuration_revision: control.configuration_receipt_id, root_session_id: control.root_session_id,
  });
  let buffer = Buffer.alloc(0);
  let failure: InstrumentedAccountingError | null = null;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const reject = (error: InstrumentedAccountingError) => {
    failure ??= error;
    if (error.code !== 'inactive_scope') accounting.recordTransportFailure('record_conflict');
    buffer = Buffer.alloc(0);
    descriptor.destroy();
  };
  const data = (chunk: unknown) => {
    try {
      accounting.assertActive();
      if (!Buffer.isBuffer(chunk)) throw new InstrumentedAccountingError('invalid_record');
      buffer = Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        accounting.assertActive();
        if (newline > 65536) throw new InstrumentedAccountingError('invalid_record');
        const bytes = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        const text = bytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(bytes)) throw new InstrumentedAccountingError('invalid_record');
        let record: unknown;
        try { record = JSON.parse(text) as unknown; }
        catch (error) {
          if (error instanceof SyntaxError) throw new InstrumentedAccountingError('invalid_record');
          throw error;
        }
        const receipt = accounting.receive(record);
        descriptor.write(`${JSON.stringify(receipt)}\n`);
      }
      if (buffer.length > 65536) throw new InstrumentedAccountingError('invalid_record');
    } catch (error) {
      reject(error instanceof InstrumentedAccountingError ? error : new InstrumentedAccountingError('invalid_record'));
    }
  };
  const onError = () => {
    accounting.recordTransportFailure('producer_lost');
    failure ??= new InstrumentedAccountingError('invalid_record');
  };
  const onClose = () => {
    if (buffer.length) {
      accounting.recordTransportFailure('record_conflict');
      failure ??= new InstrumentedAccountingError('invalid_record');
    }
    buffer = Buffer.alloc(0);
    descriptor.off('data', data);
    descriptor.off('error', onError);
    resolveClosed();
  };
  descriptor.on('data', data);
  descriptor.on('error', onError);
  descriptor.once('close', onClose);
  descriptor.write(`${JSON.stringify(bootstrap)}\n`);
  return {
    closed,
    failure: () => failure,
    close: () => { descriptor.destroy(); },
  };
}
