import { afterEach, expect, test } from 'vitest';
import { Store } from '../src/store.js';

const stores: Store[] = [];
function fixture() {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const modes = ['transaction', 'immediateTransaction'] as const;
test.each(modes.flatMap(outer => modes.map(inner => ({ outer, inner }))))(
  '$outer publishes effects only after its outer commit, not the nested $inner return',
  ({ outer, inner }) => {
    const store = fixture();
    const published: string[] = [];
    store[outer](() => {
      store.afterCommit(() => published.push('outer'));
      store[inner](() => {
        store.execute('INSERT INTO projects(id) VALUES (?)', ['synthetic-project']);
        store.afterCommit(() => published.push('inner'));
      });
      expect(published).toEqual([]);
      store.execute('INSERT INTO projects(id) VALUES (?)', ['synthetic-later-project']);
    });
    expect(store.all('SELECT id FROM projects ORDER BY id')).toEqual([{ id: 'synthetic-later-project' }, { id: 'synthetic-project' }]);
    expect(published).toEqual(['outer', 'inner']);
  }
);

test.each(modes)('%s rollback discards publication and database changes together', mode => {
  const store = fixture();
  const published: string[] = [];
  const failure = new Error('synthetic_transaction_failure');
  expect(() =>
    store[mode](() => {
      store.execute('INSERT INTO projects(id) VALUES (?)', ['synthetic-project']);
      store.afterCommit(() => published.push('revoked'));
      throw failure;
    })
  ).toThrow(failure);
  expect(store.all('SELECT id FROM projects')).toEqual([]);
  store.immediateTransaction(() => undefined);
  expect(published).toEqual([]);
});

test('a rolled-back savepoint drops only its own publication effects', () => {
  const store = fixture();
  const published: string[] = [];
  const failure = new Error('synthetic_savepoint_failure');
  store.immediateTransaction(() => {
    store.afterCommit(() => published.push('retained-before'));
    expect(() =>
      store.transaction(() => {
        store.afterCommit(() => published.push('rolled-back'));
        throw failure;
      })
    ).toThrow(failure);
    store.afterCommit(() => published.push('retained-after'));
  });
  expect(published).toEqual(['retained-before', 'retained-after']);
});

test('publication failure preserves committed changes and does not skip later publication', () => {
  const store = fixture();
  const published: string[] = [];
  const failure = new Error('synthetic_control_write_failure');
  expect(() =>
    store.immediateTransaction(() => {
      store.execute('INSERT INTO projects(id) VALUES (?)', ['synthetic-project']);
      store.afterCommit(() => {
        throw failure;
      });
      store.afterCommit(() => published.push('later-product'));
    })
  ).toThrow(failure);
  expect(store.all('SELECT id FROM projects')).toEqual([{ id: 'synthetic-project' }]);
  expect(published).toEqual(['later-product']);
  store.transaction(() => undefined);
  expect(published).toEqual(['later-product']);
});
