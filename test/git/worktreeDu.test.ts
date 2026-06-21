import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeDu, formatBytes, renderDuMarkdown, FsAdapter, DirEntry } from '../../src/git/worktreeDu';

/**
 * In-memory filesystem fixture. Each path maps to either {file, size}
 * or {dir, children}.
 */
type Node =
  | { type: 'file'; size: number }
  | { type: 'symlink' }
  | { type: 'dir'; children: Record<string, Node> };

function makeFs(root: Node): FsAdapter {
  return {
    async readdir(p: string): Promise<DirEntry[]> {
      const node = walk(p, root);
      if (!node || node.type !== 'dir') throw new Error('not a dir: ' + p);
      return Object.entries(node.children).map(([name, child]) => ({
        name,
        isFile: child.type === 'file',
        isDirectory: child.type === 'dir',
        isSymlink: child.type === 'symlink',
      }));
    },
    async stat(p: string) {
      const node = walk(p, root);
      if (!node) throw new Error('ENOENT: ' + p);
      if (node.type === 'file') return { size: node.size, isFile: true, isDirectory: false, isSymlink: false };
      if (node.type === 'symlink') return { size: 0, isFile: false, isDirectory: false, isSymlink: true };
      return { size: 0, isFile: false, isDirectory: true, isSymlink: false };
    },
  };
}

function walk(absPath: string, root: Node): Node | undefined {
  // Treat anything starting with /root as the root.
  const parts = absPath.replace(/^\/root\/?/, '').split('/').filter(Boolean);
  let node: Node | undefined = root;
  for (const p of parts) {
    if (!node || node.type !== 'dir') return undefined;
    node = node.children[p];
  }
  return node;
}

test('computeDu: aggregates total + top-level breakdown', async () => {
  const fs = makeFs({
    type: 'dir',
    children: {
      'src': {
        type: 'dir',
        children: {
          'a.ts': { type: 'file', size: 1000 },
          'b.ts': { type: 'file', size: 2000 },
          'sub': { type: 'dir', children: { 'c.ts': { type: 'file', size: 500 } } },
        },
      },
      'README.md': { type: 'file', size: 200 },
      'node_modules': { type: 'dir', children: { 'big': { type: 'file', size: 10_000 } } },
    },
  });
  const r = await computeDu('/root', fs);
  // Total bytes: 1000 + 2000 + 500 + 200 + 10000 = 13_700
  assert.equal(r.totalBytes, 13_700);
  // Files: a.ts, b.ts, sub/c.ts, README.md, node_modules/big = 5
  assert.equal(r.fileCount, 5);
  // Directories descended: src, src/sub, node_modules = 3
  assert.equal(r.directoryCount, 3);

  const tl = Object.fromEntries(r.topLevel.map(t => [t.name, t.bytes]));
  assert.equal(tl['node_modules'], 10_000);
  assert.equal(tl['src'], 3_500);
  assert.equal(tl['README.md'], 200);
  // Top-level ordering is descending by bytes.
  assert.equal(r.topLevel[0].name, 'node_modules');
  assert.equal(r.topLevel[1].name, 'src');
});

test('computeDu: skips .git by default', async () => {
  const fs = makeFs({
    type: 'dir',
    children: {
      '.git': { type: 'dir', children: { 'big': { type: 'file', size: 100_000 } } },
      'src': { type: 'dir', children: { 'a.ts': { type: 'file', size: 100 } } },
    },
  });
  const r = await computeDu('/root', fs);
  assert.equal(r.totalBytes, 100);
  assert.equal(r.topLevel.find(t => t.name === '.git'), undefined);
});

test('computeDu: respects custom skip list', async () => {
  const fs = makeFs({
    type: 'dir',
    children: {
      'node_modules': { type: 'dir', children: { 'big': { type: 'file', size: 100_000 } } },
      'src': { type: 'dir', children: { 'a.ts': { type: 'file', size: 100 } } },
    },
  });
  const r = await computeDu('/root', fs, { skipNames: ['.git', 'node_modules'] });
  assert.equal(r.totalBytes, 100);
  assert.equal(r.topLevel.find(t => t.name === 'node_modules'), undefined);
});

test('computeDu: largestFiles is a top-N descending list', async () => {
  const fs = makeFs({
    type: 'dir',
    children: {
      'a': { type: 'file', size: 5 },
      'b': { type: 'file', size: 50 },
      'c': { type: 'file', size: 500 },
      'd': { type: 'file', size: 5000 },
      'e': { type: 'file', size: 50_000 },
    },
  });
  const r = await computeDu('/root', fs, {}, 3);
  assert.equal(r.largestFiles.length, 3);
  assert.deepEqual(r.largestFiles.map(f => f.name), ['e', 'd', 'c']);
});

test('computeDu: respects maxEntries cap and flags truncated', async () => {
  const children: Record<string, Node> = {};
  for (let i = 0; i < 50; i++) children[`f${i}`] = { type: 'file', size: 1 };
  const fs = makeFs({ type: 'dir', children });
  const r = await computeDu('/root', fs, { maxEntries: 10 });
  assert.equal(r.truncated, true);
  assert.ok(r.fileCount <= 10);
});

test('computeDu: symlinks are zero-size unless followSymlinks', async () => {
  const fs = makeFs({
    type: 'dir',
    children: {
      'link': { type: 'symlink' },
      'real': { type: 'file', size: 100 },
    },
  });
  const r = await computeDu('/root', fs);
  assert.equal(r.totalBytes, 100);
  const linkEntry = r.topLevel.find(t => t.name === 'link');
  assert.ok(linkEntry);
  assert.equal(linkEntry!.bytes, 0);
});

test('computeDu: empty directory has zero totals', async () => {
  const fs = makeFs({ type: 'dir', children: {} });
  const r = await computeDu('/root', fs);
  assert.equal(r.totalBytes, 0);
  assert.equal(r.fileCount, 0);
  assert.equal(r.topLevel.length, 0);
});

test('formatBytes: pretty units, base-1024', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.50 GB');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(Infinity), '0 B');
});

test('formatBytes: drops decimals above 100 to keep alignment tight', () => {
  assert.equal(formatBytes(150 * 1024 * 1024), '150 MB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15.0 MB');
});

test('renderDuMarkdown: includes total, top-level, and largest sections', async () => {
  const fs = makeFs({
    type: 'dir',
    children: {
      'src': { type: 'dir', children: { 'a.ts': { type: 'file', size: 1234 } } },
      'README.md': { type: 'file', size: 56 },
    },
  });
  const r = await computeDu('/root', fs);
  const md = renderDuMarkdown(r, { root: '/root' });
  assert.ok(md.includes('Top-level usage'));
  assert.ok(md.includes('Largest individual files'));
  assert.ok(md.includes('src'));
  assert.ok(md.includes('README.md'));
  // Footer mentions the root path
  assert.ok(md.includes('/root'));
});

test('renderDuMarkdown: handles empty / zero state', () => {
  const md = renderDuMarkdown({
    totalBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    topLevel: [],
    largestFiles: [],
    truncated: false,
  }, { root: '/root' });
  assert.ok(md.includes('Total:'));
  assert.ok(md.includes('no files measured'));
});

test('renderDuMarkdown: surfaces truncated warning', () => {
  const md = renderDuMarkdown({
    totalBytes: 100,
    fileCount: 1,
    directoryCount: 1,
    topLevel: [{ name: 'x', fullPath: '/root/x', bytes: 100, isDirectory: false }],
    largestFiles: [{ name: 'x', fullPath: '/root/x', bytes: 100, isDirectory: false }],
    truncated: true,
  }, { root: '/root' });
  assert.ok(md.includes('entry cap'));
});
