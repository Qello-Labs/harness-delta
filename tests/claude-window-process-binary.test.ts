import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import {
  type ClaudeWindowBinaryAdapters,
  ClaudeWindowBinaryReader,
  type ClaudeWindowImageStat,
  type ClaudeWindowProcessMetadata,
  type ClaudeWindowSignature
} from '../src/claude-process-binary.js';

vi.mock('node:child_process', () => ({
  execFileSync: () => {
    throw new Error('real_process_access_forbidden');
  }
}));

const processMetadata = {
  pid: 3107,
  uid: 501,
  start: 'synthetic-start',
  parentPid: 3106
};
const parentMetadata = {
  pid: 3106,
  uid: 501,
  start: 'synthetic-parent-start',
  parentPid: 3105
};
const imagePath = '/synthetic/claude/versions/2.1.318/claude';
const signature: ClaudeWindowSignature = {
  valid: true,
  team: 'Q6L2SF6YDW',
  identifier: 'com.anthropic.claude-code',
  cdHash: 'a'.repeat(40)
};
interface FixtureState {
  active: boolean;
  uid: number | null;
  process: ClaudeWindowProcessMetadata | null;
  parent: ClaudeWindowProcessMetadata | null;
  image: { path: string; layout: string; requiredHost: string | null };
  canonical: string;
  stat: { -readonly [Key in keyof ClaudeWindowImageStat]: ClaudeWindowImageStat[Key] };
  signature: { -readonly [Key in keyof ClaudeWindowSignature]: ClaudeWindowSignature[Key] };
  content: number;
  signatureContent: number;
  signatureInode: number | null;
  shortRead: boolean;
  invalidMagic: boolean;
  failed: string;
  after: (name: string) => void;
}
function syntheticDigest(size: number, content: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536, content);
  for (let position = 0; position < size; position += buffer.length) {
    if (position === 0) {
      buffer.writeUInt32LE(0xfeedfacf);
      buffer.writeUInt32LE(0x0100000c, 4);
    } else buffer.fill(content);
    hash.update(buffer.subarray(0, Math.min(buffer.length, size - position)));
  }
  return hash.digest('hex');
}
function fixture(size = 64) {
  const events: string[] = [];
  const state: FixtureState = {
    active: true,
    uid: 501,
    process: { ...processMetadata },
    parent: { ...parentMetadata },
    image: {
      path: imagePath,
      layout: 'standalone',
      requiredHost: null
    },
    canonical: imagePath,
    stat: {
      device: 3,
      inode: 7,
      size,
      mode: 0o755,
      mtimeMs: 10,
      ctimeMs: 11,
      regularFile: true
    } satisfies ClaudeWindowImageStat,
    signature: { ...signature },
    content: 17,
    signatureContent: 17,
    signatureInode: null,
    shortRead: false,
    invalidMagic: false,
    failed: '',
    after: () => undefined
  };
  let unauthorized = 0;
  function effect<T>(name: string, value: T): T {
    if (!state.active) unauthorized++;
    events.push(name);
    if (state.failed === name) throw new Error('SYNTHETIC_PRIVATE_ERROR');
    state.after(name);
    return value;
  }
  const adapters: ClaudeWindowBinaryAdapters = {
    currentUid: () => effect('uid', state.uid),
    readProcess: pid =>
      effect(
        pid === processMetadata.pid ? 'process' : 'parent',
        pid === processMetadata.pid ? state.process && { ...state.process } : state.parent && { ...state.parent }
      ),
    readImage: () => effect('image', { ...state.image }),
    realpath: () => effect('realpath', state.canonical),
    stat: () => effect('stat', { ...state.stat }),
    open: () =>
      effect('open', {
        stat: () => effect('fstat', { ...state.stat }),
        read: (buffer, offset, length, position) => {
          buffer.fill(state.content, offset, offset + length);
          if (position === 0 && length >= 8) {
            buffer.writeUInt32LE(state.invalidMagic ? 0 : 0xfeedfacf, offset);
            buffer.writeUInt32LE(0x0100000c, offset + 4);
          }
          return effect('read', state.shortRead ? 0 : length);
        },
        verifySignature: () =>
          effect('signature', {
            signature: { ...state.signature },
            sha256: syntheticDigest(state.stat.size, state.signatureContent),
            stat: { ...state.stat, inode: state.signatureInode ?? state.stat.inode }
          }),
        close: () => {
          events.push('close');
          if (state.failed === 'close') throw new Error('SYNTHETIC_PRIVATE_ERROR');
        }
      })
  };
  const assertAuthorized = () => {
    if (!state.active) {
      throw new Error('binding_window_activation_required');
    }
  };
  const reader = () => new ClaudeWindowBinaryReader({ adapters, assertAuthorized });
  return { state, events, reader, unauthorized: () => unauthorized };
}

test('pins the scoped process image and publisher without attesting a release or mapped image', () => {
  const f = fixture();
  const bytes = Buffer.alloc(64, 17);
  bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(0x0100000c, 4);

  const pin = f.reader().snapshot(3107);

  expect(pin).toEqual({
    mode: 'publisher_verified_local_pin',
    process: processMetadata,
    parent: parentMetadata,
    path: imagePath,
    stat: f.state.stat,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature,
    mappedImageProof: 'unverified'
  });
  expect(Object.isFrozen(pin) && Object.isFrozen(pin.stat) && Object.isFrozen(pin.signature) && Object.isFrozen(pin.process)).toBe(true);
  expect(f.events.filter(name => name === 'close')).toHaveLength(1);
});

test('denies construction before any native adapter operation when collection is closed', () => {
  const f = fixture();
  f.state.active = false;

  expect(() => f.reader()).toThrow('binding_window_activation_required');

  expect(f.events).toEqual([]);
});

test.each(['snapshot', 'revalidate'] as const)('denies %s after revocation before any further native adapter operation', method => {
  const f = fixture();
  const reader = f.reader();
  const pin = reader.snapshot(3107);
  f.events.length = 0;
  f.state.active = false;

  expect(() => (method === 'snapshot' ? reader.snapshot(3107) : reader.revalidate(pin))).toThrow('binding_window_activation_required');

  expect(f.events).toEqual([]);
  expect(f.unauthorized()).toBe(0);
});

test.each(['uid', 'process', 'parent', 'image', 'realpath', 'stat', 'open', 'fstat', 'read', 'signature'])(
  'stops immediately on revocation inside %s and closes any already opened handle',
  operation => {
    const f = fixture(131072);
    f.state.after = name => {
      if (name === operation) f.state.active = false;
    };

    let failure: unknown;
    try {
      f.reader().snapshot(3107);
    } catch (error) {
      failure = error;
    }

    expect(f.unauthorized()).toBe(0);
    expect(failure).toMatchObject({ message: 'binding_window_activation_required' });
    const last = f.events.at(-1);
    expect(last === operation || last === 'close').toBe(true);
    if (f.events.includes('open')) {
      expect(f.events.filter(name => name === 'close')).toHaveLength(1);
    }
  }
);

test.each(['uid', 'process', 'parent', 'image', 'realpath', 'stat', 'open', 'fstat', 'read', 'signature', 'close'])(
  'sanitizes a failing %s adapter and never establishes another pin in the segment',
  operation => {
    const f = fixture();
    f.state.failed = operation;
    const reader = f.reader();

    expect(() => reader.snapshot(3107)).toThrow(/^binding_executable_identity_unverified$/);
    f.state.failed = '';
    f.events.length = 0;
    expect(() => reader.snapshot(3107)).toThrow('binding_executable_changed');

    expect(f.events).toEqual([]);
  }
);

test.each([
  [
    'absent process',
    (f: ReturnType<typeof fixture>) => {
      f.state.process = null;
    }
  ],
  [
    'foreign user',
    (f: ReturnType<typeof fixture>) => {
      f.state.process = { ...processMetadata, uid: 502 };
    }
  ],
  [
    'wrong PID',
    (f: ReturnType<typeof fixture>) => {
      f.state.process = { ...processMetadata, pid: 9 };
    }
  ],
  [
    'absent start',
    (f: ReturnType<typeof fixture>) => {
      f.state.process = { ...processMetadata, start: '' };
    }
  ],
  [
    'unknown user',
    (f: ReturnType<typeof fixture>) => {
      f.state.uid = null;
    }
  ],
  [
    'absent ancestry',
    (f: ReturnType<typeof fixture>) => {
      f.state.parent = null;
    }
  ],
  [
    'foreign ancestor',
    (f: ReturnType<typeof fixture>) => {
      f.state.parent = { ...parentMetadata, uid: 502 };
    }
  ],
  [
    'self parent',
    (f: ReturnType<typeof fixture>) => {
      f.state.process = { ...processMetadata, parentPid: 3107 };
    }
  ],
  [
    'unknown layout',
    (f: ReturnType<typeof fixture>) => {
      f.state.image.layout = 'wrapper';
    }
  ],
  [
    'unapproved host layout',
    (f: ReturnType<typeof fixture>) => {
      f.state.image.requiredHost = '/synthetic/host';
    }
  ],
  [
    'relative image hint',
    (f: ReturnType<typeof fixture>) => {
      f.state.image.path = 'claude';
    }
  ],
  [
    'raw parent traversal',
    (f: ReturnType<typeof fixture>) => {
      f.state.image.path = '/synthetic/alias/../claude';
    }
  ],
  [
    'path alias',
    (f: ReturnType<typeof fixture>) => {
      f.state.canonical = '/synthetic/other';
    }
  ],
  [
    'nonregular image',
    (f: ReturnType<typeof fixture>) => {
      f.state.stat.regularFile = false;
    }
  ],
  [
    'nonexecutable image',
    (f: ReturnType<typeof fixture>) => {
      f.state.stat.mode = 0o600;
    }
  ],
  [
    'missing component bytes',
    (f: ReturnType<typeof fixture>) => {
      f.state.stat.size = 0;
    }
  ],
  [
    'CLI above 512 MiB',
    (f: ReturnType<typeof fixture>) => {
      f.state.stat.size = 536870913;
    }
  ],
  [
    'invalid image format',
    (f: ReturnType<typeof fixture>) => {
      f.state.invalidMagic = true;
    }
  ],
  [
    'short source read',
    (f: ReturnType<typeof fixture>) => {
      f.state.shortRead = true;
    }
  ],
  [
    'invalid signature',
    (f: ReturnType<typeof fixture>) => {
      f.state.signature.valid = false;
    }
  ],
  [
    'wrong team',
    (f: ReturnType<typeof fixture>) => {
      f.state.signature.team = 'SYNTHETIC_OTHER_TEAM';
    }
  ],
  [
    'wrong role',
    (f: ReturnType<typeof fixture>) => {
      f.state.signature.identifier = 'com.anthropic.other';
    }
  ],
  [
    'unsigned asset',
    (f: ReturnType<typeof fixture>) => {
      f.state.signature.cdHash = '';
    }
  ]
] as const)('refuses %s without publishing local pins', (_label, change) => {
  const f = fixture();
  change(f);

  expect(() => f.reader().snapshot(3107)).toThrow('binding_executable_identity_unverified');
});

test('accepts a synthetic standalone CLI exactly at the separate 512 MiB window ceiling', () => {
  const f = fixture(536870912);

  const pin = f.reader().snapshot(3107);

  expect(pin.stat.size).toBe(536870912);
  expect(pin.signature).toEqual(signature);
});

test.each([
  [
    'process start',
    (f: ReturnType<typeof fixture>) => {
      f.state.process = {
        ...processMetadata,
        start: 'reused-pid-start'
      };
    }
  ],
  [
    'parent start',
    (f: ReturnType<typeof fixture>) => {
      f.state.parent = {
        ...parentMetadata,
        start: 'reused-parent-start'
      };
    }
  ],
  [
    'device',
    (f: ReturnType<typeof fixture>) => {
      f.state.stat.device++;
    }
  ],
  [
    'inode',
    (f: ReturnType<typeof fixture>) => {
      f.state.stat.inode++;
    }
  ],
  [
    'size',
    (f: ReturnType<typeof fixture>) => {
      f.state.stat.size++;
    }
  ],
  [
    'SHA',
    (f: ReturnType<typeof fixture>) => {
      f.state.content++;
      f.state.signatureContent = f.state.content;
    }
  ],
  [
    'signature',
    (f: ReturnType<typeof fixture>) => {
      f.state.signature.cdHash = 'b'.repeat(40);
    }
  ],
  [
    'image path',
    (f: ReturnType<typeof fixture>) => {
      f.state.image.path = '/synthetic/replacement';
      f.state.canonical = f.state.image.path;
    }
  ]
] as const)('revalidates %s before reads or restart and forbids repinning after drift', (_label, change) => {
  const f = fixture();
  const reader = f.reader();
  const pin = reader.snapshot(3107);
  change(f);

  expect(() => reader.revalidate(pin)).toThrow('binding_executable_changed');
  f.events.length = 0;
  expect(() => reader.snapshot(3107)).toThrow('binding_executable_changed');

  expect(f.events).toEqual([]);
});

test('revalidates a persisted pin in a reconstructed segment reader without replacing it', () => {
  const f = fixture();
  const pin = f.reader().snapshot(3107);
  const reader = f.reader();

  reader.revalidate(pin);

  expect(reader.snapshot(3107)).toEqual(pin);
  expect(f.events.filter(name => name === 'signature')).toHaveLength(3);
});

test.each(['read', 'signature'] as const)('rejects file replacement during %s and closes the handle', operation => {
  const f = fixture();
  f.state.after = name => {
    if (name === operation) f.state.stat.inode++;
  };

  expect(() => f.reader().snapshot(3107)).toThrow('binding_executable_identity_unverified');

  expect(f.events.filter(name => name === 'close')).toHaveLength(1);
});

test('rejects PID reuse after hashing instead of promoting the replacement process', () => {
  const f = fixture();
  f.state.after = name => {
    if (name === 'signature') {
      f.state.process = { ...processMetadata, start: 'reused-pid-start' };
    }
  };

  expect(() => f.reader().snapshot(3107)).toThrow('binding_executable_identity_unverified');

  expect(f.events.filter(name => name === 'close')).toHaveLength(1);
});

test.each(['bytes', 'identity'] as const)('rejects a transient signature %s substitution even when the selected path is restored', substitution => {
  const f = fixture();
  if (substitution === 'bytes') f.state.signatureContent = 31;
  else f.state.signatureInode = 8;

  expect(() => f.reader().snapshot(3107)).toThrow('binding_executable_identity_unverified');

  expect(f.state.stat.inode).toBe(7);
  expect(f.state.canonical).toBe(imagePath);
  expect(f.events.filter(name => name === 'close')).toHaveLength(1);
});
