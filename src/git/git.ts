import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const pexec = promisify(execFile);

export interface Commit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  date: Date;
  subject: string;
  body: string;
  refs: string[];
}

export interface BlameLine {
  sha: string;
  author: string;
  email: string;
  date: Date;
  summary: string;
  line: number;
}

export interface Branch {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  remote: boolean;
  sha: string;
}

export interface Tag { name: string; sha: string; subject: string; date?: Date; }
export interface Remote { name: string; fetchUrl: string; pushUrl: string; }
export interface Stash { index: number; ref: string; subject: string; branch: string; date: Date; }
export interface Worktree { path: string; branch: string; head: string; bare: boolean; detached: boolean; locked: boolean; }
export interface Contributor { name: string; email: string; commits: number; }
export interface FileChange { status: string; path: string; oldPath?: string; }

export class Git {
  constructor(public readonly cwd: string) {}

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await pexec('git', args, { cwd: this.cwd, maxBuffer: 100 * 1024 * 1024 });
      return stdout;
    } catch (e: any) {
      throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${(e.stderr || e.message).toString().trim()}`);
    }
  }

  async isRepo(): Promise<boolean> {
    try { await this.run(['rev-parse', '--git-dir']); return true; } catch { return false; }
  }
  async topLevel(): Promise<string> { return (await this.run(['rev-parse', '--show-toplevel'])).trim(); }
  async currentBranch(): Promise<string> { return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); }
  async headSha(): Promise<string> { return (await this.run(['rev-parse', 'HEAD'])).trim(); }

  async branches(includeRemote = true): Promise<Branch[]> {
    const refs = includeRemote ? ['refs/heads', 'refs/remotes'] : ['refs/heads'];
    const out = await this.run([
      'for-each-ref',
      '--format=%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)\t%(objectname)\t%(refname)',
      ...refs,
    ]);
    return out.split('\n').filter(Boolean).map(line => {
      const [name, head, upstream, track, sha, fullRef] = line.split('\t');
      if (/HEAD$/.test(name)) return null;
      const aheadMatch = /ahead (\d+)/.exec(track || '');
      const behindMatch = /behind (\d+)/.exec(track || '');
      return {
        name,
        current: head === '*',
        upstream: upstream || undefined,
        ahead: aheadMatch ? +aheadMatch[1] : 0,
        behind: behindMatch ? +behindMatch[1] : 0,
        remote: fullRef.startsWith('refs/remotes/'),
        sha,
      } as Branch;
    }).filter((b): b is Branch => !!b);
  }

  async tags(): Promise<Tag[]> {
    const out = await this.run(['for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(contents:subject)\t%(creatordate:iso-strict)', 'refs/tags', '--sort=-creatordate']);
    return out.split('\n').filter(Boolean).map(line => {
      const [name, sha, subject, date] = line.split('\t');
      return { name, sha, subject: subject || '', date: date ? new Date(date) : undefined };
    });
  }

  async remotes(): Promise<Remote[]> {
    const out = await this.run(['remote', '-v']);
    const map = new Map<string, Remote>();
    for (const line of out.split('\n').filter(Boolean)) {
      const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
      if (!m) continue;
      const [, name, url, kind] = m;
      const r = map.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
      if (kind === 'fetch') r.fetchUrl = url; else r.pushUrl = url;
      map.set(name, r);
    }
    return [...map.values()];
  }

  async log(opts: { max?: number; file?: string; line?: { start: number; end: number }; branch?: string; all?: boolean; grep?: string; author?: string } = {}): Promise<Commit[]> {
    const sep = '\x1f', recSep = '\x1e';
    const fmt = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%s', '%b', '%D'].join(sep) + recSep;
    const args = ['log', `--pretty=format:${fmt}`, `--max-count=${opts.max ?? 500}`];
    if (opts.all) args.push('--all');
    if (opts.grep) args.push(`--grep=${opts.grep}`, '--regexp-ignore-case');
    if (opts.author) args.push(`--author=${opts.author}`);
    if (opts.branch) args.push(opts.branch);
    if (opts.line && opts.file) {
      args.push(`-L${opts.line.start},${opts.line.end}:${path.relative(this.cwd, opts.file)}`);
    } else if (opts.file) {
      args.push('--follow', '--', path.relative(this.cwd, opts.file));
    }
    const out = await this.run(args);
    return out.split(recSep).map(s => s.trim()).filter(Boolean).map(rec => {
      const [sha, shortSha, parents, author, email, date, subject, body, refs] = rec.split(sep);
      return {
        sha, shortSha,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author, email,
        date: new Date(date),
        subject, body: body || '',
        refs: refs ? refs.split(',').map(s => s.trim()).filter(Boolean) : [],
      };
    });
  }

  async blame(file: string, sha?: string): Promise<BlameLine[]> {
    const rel = path.relative(this.cwd, file);
    const args = ['blame', '--porcelain'];
    if (sha) args.push(sha);
    args.push('--', rel);
    const out = await this.run(args);
    const lines = out.split('\n');
    const commits = new Map<string, { author: string; email: string; date: Date; summary: string }>();
    const result: BlameLine[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
      if (header) {
        const sha = header[1];
        const lineNo = parseInt(header[2], 10);
        let j = i + 1;
        const meta: Record<string, string> = {};
        while (j < lines.length && !lines[j].startsWith('\t')) {
          const sp = lines[j].indexOf(' ');
          if (sp === -1) meta[lines[j]] = ''; else meta[lines[j].slice(0, sp)] = lines[j].slice(sp + 1);
          j++;
        }
        if (!commits.has(sha)) {
          commits.set(sha, {
            author: meta['author'] || 'Unknown',
            email: (meta['author-mail'] || '<>').replace(/[<>]/g, ''),
            date: new Date(parseInt(meta['author-time'] || '0', 10) * 1000),
            summary: meta['summary'] || '',
          });
        }
        result.push({ sha, line: lineNo, ...commits.get(sha)! });
        i = j + 1;
      } else i++;
    }
    return result;
  }

  async show(sha: string): Promise<string> { return this.run(['show', '--stat', '--patch', sha]); }
  async showFile(sha: string, file: string): Promise<string> {
    return this.run(['show', `${sha}:${path.relative(this.cwd, file)}`]);
  }
  async diff(opts: { staged?: boolean; from?: string; to?: string; file?: string } = {}): Promise<string> {
    const args = ['diff'];
    if (opts.staged) args.push('--staged');
    if (opts.from && opts.to) args.push(`${opts.from}...${opts.to}`);
    else if (opts.from) args.push(opts.from);
    if (opts.file) args.push('--', path.relative(this.cwd, opts.file));
    return this.run(args);
  }
  async diffNames(from: string, to: string): Promise<FileChange[]> {
    const out = await this.run(['diff', '--name-status', `${from}...${to}`]);
    return out.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      const status = parts[0][0];
      if (status === 'R' || status === 'C') return { status, oldPath: parts[1], path: parts[2] };
      return { status, path: parts[1] };
    });
  }
  async commitFiles(sha: string): Promise<FileChange[]> {
    const out = await this.run(['show', '--name-status', '--pretty=format:', sha]);
    return out.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      const status = parts[0][0];
      if (status === 'R' || status === 'C') return { status, oldPath: parts[1], path: parts[2] };
      return { status, path: parts[1] };
    });
  }

  async stashes(): Promise<Stash[]> {
    const out = await this.run(['stash', 'list', '--pretty=format:%gd\t%gs\t%aI']);
    return out.split('\n').filter(Boolean).map((line, i) => {
      const [ref, subject, date] = line.split('\t');
      const m = /WIP on ([^:]+):/.exec(subject || '');
      return { index: i, ref, subject: subject || '', branch: m?.[1] || '', date: new Date(date) };
    });
  }
  async stashApply(ref: string) { await this.run(['stash', 'apply', ref]); }
  async stashPop(ref: string) { await this.run(['stash', 'pop', ref]); }
  async stashDrop(ref: string) { await this.run(['stash', 'drop', ref]); }
  async stashSave(message?: string) { await this.run(message ? ['stash', 'push', '-m', message] : ['stash', 'push']); }

  async worktrees(): Promise<Worktree[]> {
    const out = await this.run(['worktree', 'list', '--porcelain']);
    const trees: Worktree[] = [];
    let cur: Partial<Worktree> = {};
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur.path) trees.push(cur as Worktree);
        cur = { path: line.slice(9), bare: false, detached: false, locked: false, branch: '', head: '' };
      } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
      else if (line === 'bare') cur.bare = true;
      else if (line === 'detached') cur.detached = true;
      else if (line.startsWith('locked')) cur.locked = true;
    }
    if (cur.path) trees.push(cur as Worktree);
    return trees;
  }
  async addWorktree(target: string, branch: string, createBranch: boolean) {
    const args = ['worktree', 'add'];
    if (createBranch) args.push('-b', branch, target);
    else args.push(target, branch);
    await this.run(args);
  }
  async removeWorktree(target: string) { await this.run(['worktree', 'remove', target]); }

  async contributors(max = 100): Promise<Contributor[]> {
    const out = await this.run(['shortlog', '-sne', `--max-count=${max * 1000}`, 'HEAD']);
    return out.split('\n').filter(Boolean).map(line => {
      const m = /^\s*(\d+)\s+(.+?)\s+<(.+)>$/.exec(line);
      if (!m) return null;
      return { commits: +m[1], name: m[2], email: m[3] } as Contributor;
    }).filter((c): c is Contributor => !!c).slice(0, max);
  }

  // Mutations
  async checkout(target: string) { await this.run(['checkout', target]); }
  async createBranch(name: string, from?: string) {
    const args = ['branch', name];
    if (from) args.push(from);
    await this.run(args);
  }
  async deleteBranch(name: string, force = false) { await this.run(['branch', force ? '-D' : '-d', name]); }
  async renameBranch(from: string, to: string) { await this.run(['branch', '-m', from, to]); }
  async merge(branch: string) { await this.run(['merge', branch]); }
  async rebase(onto: string) { await this.run(['rebase', onto]); }
  async cherryPick(sha: string) { await this.run(['cherry-pick', sha]); }
  async revert(sha: string) { await this.run(['revert', '--no-edit', sha]); }
  async resetTo(sha: string, mode: 'soft' | 'mixed' | 'hard') { await this.run(['reset', `--${mode}`, sha]); }
  async createTag(name: string, sha?: string, message?: string) {
    const args = ['tag'];
    if (message) args.push('-a', name, '-m', message);
    else args.push(name);
    if (sha) args.push(sha);
    await this.run(args);
  }
  async deleteTag(name: string) { await this.run(['tag', '-d', name]); }
  async fetch(remote?: string) { await this.run(remote ? ['fetch', remote, '--prune'] : ['fetch', '--all', '--prune']); }
  async pull() { await this.run(['pull', '--ff-only']); }
  async push(remote = 'origin', branch?: string, force = false) {
    const args = ['push', remote];
    if (branch) args.push(branch);
    if (force) args.push('--force-with-lease');
    await this.run(args);
  }
  async addRemote(name: string, url: string) { await this.run(['remote', 'add', name, url]); }
  async removeRemote(name: string) { await this.run(['remote', 'remove', name]); }
}

// Translate origin URL → web URL for GitHub/GitLab/Bitbucket
export function remoteWebUrl(remoteUrl: string, sha?: string): string | undefined {
  let m = /^git@([^:]+):(.+?)(\.git)?$/.exec(remoteUrl);
  let host: string, repo: string;
  if (m) { host = m[1]; repo = m[2]; }
  else {
    m = /^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(\.git)?$/.exec(remoteUrl);
    if (!m) return undefined;
    host = m[1]; repo = m[2];
  }
  const base = `https://${host}/${repo}`;
  if (!sha) return base;
  if (host.includes('bitbucket')) return `${base}/commits/${sha}`;
  return `${base}/commit/${sha}`;
}
