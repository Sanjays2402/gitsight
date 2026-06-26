/**
 * Pure contributor-compare logic (W35).
 *
 * DOM-free + framework-free + NO @shared alias, so it's unit-tested under
 * node --test. The contributors leaderboard (W14) ranks authors but offers
 * no way to set two side by side. This module takes two W23 author details
 * (commits, churn, touched files) and computes the comparison the view
 * renders: per-author totals + the file overlap between them (files BOTH
 * touched, plus each author's exclusive files).
 *
 * The AuthorFile/AuthorDetail shapes come in via a relative .ts import (the
 * same trick the other web helpers use) so Node resolves them at test time
 * without the Vite `@shared` alias.
 *
 * Tests: web/src/contributorCompare.test.mjs
 */

import type { AuthorDetail, AuthorFile } from '../../src/shared/authorDetail.ts';

/** A per-author summary line in the comparison. */
export interface AuthorSummary {
  name: string;
  email: string;
  commits: number;
  insertions: number;
  deletions: number;
  /** Total insertions + deletions across the author's touched files. */
  churn: number;
  /** Distinct files the author has touched. */
  files: number;
}

/** The file-overlap breakdown between two authors. */
export interface FileOverlap {
  /** Paths BOTH authors touched, busiest-combined first. */
  shared: string[];
  /** Count of files only author A touched. */
  onlyA: number;
  /** Count of files only author B touched. */
  onlyB: number;
  /** shared / (union) as a 0..1 Jaccard index (0 when neither touched anything). */
  jaccard: number;
}

/** The full two-author comparison the view renders. */
export interface ContributorComparison {
  a: AuthorSummary;
  b: AuthorSummary;
  overlap: FileOverlap;
}

/** Sum a churn total over an author's files. */
function churnOf(files: AuthorFile[]): number {
  let n = 0;
  for (const f of files) n += Math.max(0, f.insertions) + Math.max(0, f.deletions);
  return n;
}

/** Fold one author detail into a compact summary row. */
export function summariseAuthor(d: AuthorDetail): AuthorSummary {
  let insertions = 0;
  let deletions = 0;
  for (const f of d.files) {
    insertions += Math.max(0, f.insertions);
    deletions += Math.max(0, f.deletions);
  }
  return {
    name: d.name,
    email: d.email,
    commits: d.commits,
    insertions,
    deletions,
    churn: churnOf(d.files),
    files: d.filesTouched,
  };
}

/**
 * Compute the file overlap between two authors from their touched-file
 * lists. `shared` lists paths both touched, ordered by combined churn so
 * the files they collaborate on most surface first. Jaccard = |intersection|
 * / |union| over the touched-file SETS (uses the displayed file lists, which
 * are the most-touched subset — a stable, bounded proxy).
 */
export function fileOverlap(aFiles: AuthorFile[], bFiles: AuthorFile[]): FileOverlap {
  const aChurn = new Map<string, number>();
  for (const f of aFiles) aChurn.set(f.path, Math.max(0, f.insertions) + Math.max(0, f.deletions));
  const bChurn = new Map<string, number>();
  for (const f of bFiles) bChurn.set(f.path, Math.max(0, f.insertions) + Math.max(0, f.deletions));

  const shared: string[] = [];
  for (const path of aChurn.keys()) {
    if (bChurn.has(path)) shared.push(path);
  }
  shared.sort((x, y) => (bChurn.get(y)! + aChurn.get(y)!) - (bChurn.get(x)! + aChurn.get(x)!) || x.localeCompare(y));

  const onlyA = aChurn.size - shared.length;
  const onlyB = bChurn.size - shared.length;
  const union = aChurn.size + bChurn.size - shared.length;
  const jaccard = union > 0 ? shared.length / union : 0;

  return { shared, onlyA, onlyB, jaccard };
}

/** Build the full comparison from two author details. */
export function buildContributorComparison(a: AuthorDetail, b: AuthorDetail): ContributorComparison {
  return {
    a: summariseAuthor(a),
    b: summariseAuthor(b),
    overlap: fileOverlap(a.files, b.files),
  };
}

/** Format the overlap Jaccard as a rounded integer percent. */
export function overlapPercent(overlap: FileOverlap): number {
  return Math.round(overlap.jaccard * 100);
}
