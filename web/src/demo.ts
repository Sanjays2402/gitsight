/**
 * A small hand-built demo snapshot (W2).
 *
 * Lets the web app render a real, branchy graph before the companion
 * server exists (W3/W4). It exercises the shared lane algorithm: a
 * mainline, a feature branch that merges back, a tag, a remote ref, and
 * HEAD. Replaced at runtime by the live snapshot once `/api/graph`
 * answers.
 */

import type { GraphSnapshot } from '@shared/graphSnapshot';
import { SNAPSHOT_VERSION } from '@shared/graphSnapshot';

void SNAPSHOT_VERSION;

function iso(daysAgo: number, h = 9): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, 17, 0, 0);
  return d.toISOString();
}

export const DEMO_SNAPSHOT: GraphSnapshot = {
  repo: 'gitsight',
  head: 'main',
  generatedAt: new Date().toISOString(),
  commitCount: 9,
  remote: 'https://github.com/Sanjays2402/gitsight.git',
  commits: [
    { sha: 'a0merge0', shortSha: 'a0merge', parents: ['b1main0', 'c2feat0'], author: 'Cake', email: 'cake@local', date: iso(0, 23), subject: 'Merge branch feat/web-frontend', refs: ['HEAD -> main'] },
    { sha: 'b1main0', shortSha: 'b1main0', parents: ['d3main0'], author: 'Sanjay', email: 's@local', date: iso(1, 14), subject: 'chore: bump version to 1.16', refs: ['origin/main'] },
    { sha: 'c2feat0', shortSha: 'c2feat0', parents: ['e4feat0'], author: 'Cake', email: 'cake@local', date: iso(1, 11), subject: 'feat(web): render commit graph in the browser', refs: [] },
    { sha: 'e4feat0', shortSha: 'e4feat0', parents: ['d3main0'], author: 'Cake', email: 'cake@local', date: iso(2, 16), subject: 'feat(shared): extract stack-agnostic graph core', refs: ['feat/web-frontend'] },
    { sha: 'd3main0', shortSha: 'd3main0', parents: ['f5main0'], author: 'Sanjay', email: 's@local', date: iso(3, 10), subject: 'fix: guard against detached HEAD in snapshot', refs: [] },
    { sha: 'f5main0', shortSha: 'f5main0', parents: ['g6main0'], author: 'Ada', email: 'ada@local', date: iso(5, 13), subject: 'refactor: simplify lane assignment loop', refs: ['tag: v1.15.0'] },
    { sha: 'g6main0', shortSha: 'g6main0', parents: ['h7main0'], author: 'Sanjay', email: 's@local', date: iso(8, 9), subject: 'docs: document the snapshot wire format', refs: [] },
    { sha: 'h7main0', shortSha: 'h7main0', parents: ['i8root0'], author: 'Cake', email: 'cake@local', date: iso(12, 18), subject: 'test: cover octopus merges', refs: [] },
    { sha: 'i8root0', shortSha: 'i8root0', parents: [], author: 'Sanjay', email: 's@local', date: iso(20, 12), subject: 'init: gitsight', refs: [] },
  ],
};
