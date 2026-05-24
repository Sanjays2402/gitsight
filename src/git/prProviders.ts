import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from './git';
import { HostInfo, parseRemote, pullRequestWebUrl } from './hostDetect';

const pexec = promisify(execFile);

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';
export type CheckState = 'SUCCESS' | 'FAILURE' | 'PENDING' | undefined;
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | undefined;

export interface PR {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  author: string;
  createdAt: Date;
  updatedAt: Date;
  baseRefName: string;
  headRefName: string;
  url: string;
  additions: number;
  deletions: number;
  reviewDecision?: ReviewState;
  checksState?: CheckState;
  labels: string[];
  provider: 'github' | 'azure-devops';
}

export interface PrProvider {
  readonly name: 'GitHub' | 'Azure DevOps';
  readonly providerKey: 'github' | 'azure-devops';
  list(): Promise<PR[]>;
  checkout(number: number): Promise<void>;
  /** Optional rich detail (body, files, reviews). Best-effort. */
  detail(number: number): Promise<{ body: string; files: { path: string; additions: number; deletions: number }[]; reviews: { author: string; state: string; body: string }[] }>;
  /** Optional: resolve current user's display name/login for @me filter. */
  currentUser?(): Promise<string | undefined>;
}

export async function detectProvider(git: Git): Promise<PrProvider | undefined> {
  const remotes = await git.remotes().catch(() => []);
  const origin = remotes.find(r => r.name === 'origin') ?? remotes[0];
  if (!origin) return undefined;
  const info = parseRemote(origin.fetchUrl);
  if (!info) return undefined;
  if (info.host === 'github') return new GitHubProvider(git, info);
  if (info.host === 'azure-devops') return new AzureDevOpsProvider(git, info);
  return undefined;
}

// ────────────────────────────────────────────────────────────────────
// GitHub via `gh` CLI
// ────────────────────────────────────────────────────────────────────

class GitHubProvider implements PrProvider {
  readonly name = 'GitHub' as const;
  readonly providerKey = 'github' as const;

  constructor(private git: Git, private info: HostInfo) {}

  async list(): Promise<PR[]> {
    const { stdout } = await pexec(
      'gh',
      ['pr', 'list', '--limit', '30', '--state', 'all',
       '--json', 'number,title,state,isDraft,author,createdAt,updatedAt,baseRefName,headRefName,url,additions,deletions,reviewDecision,statusCheckRollup,labels'],
      { cwd: this.git.cwd, maxBuffer: 50 * 1024 * 1024 }
    );
    const raw = JSON.parse(stdout);
    return raw.map((p: any) => ({
      number: p.number,
      title: p.title,
      state: p.state as PrState,
      isDraft: !!p.isDraft,
      author: p.author?.login ?? 'unknown',
      createdAt: new Date(p.createdAt),
      updatedAt: new Date(p.updatedAt),
      baseRefName: p.baseRefName,
      headRefName: p.headRefName,
      url: p.url,
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      reviewDecision: p.reviewDecision,
      checksState: rollupGh(p.statusCheckRollup),
      labels: (p.labels ?? []).map((l: any) => l.name),
      provider: 'github',
    }));
  }

  async checkout(number: number): Promise<void> {
    await pexec('gh', ['pr', 'checkout', String(number)], { cwd: this.git.cwd });
  }

  async currentUser(): Promise<string | undefined> {
    try {
      const { stdout } = await pexec('gh', ['api', 'user', '--jq', '.login'], { cwd: this.git.cwd });
      return stdout.trim() || undefined;
    } catch { return undefined; }
  }

  async detail(number: number) {
    const { stdout } = await pexec(
      'gh', ['pr', 'view', String(number), '--json', 'body,files,reviews'],
      { cwd: this.git.cwd, maxBuffer: 100 * 1024 * 1024 }
    );
    const j = JSON.parse(stdout);
    return {
      body: j.body || '',
      files: (j.files || []).map((f: any) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
      reviews: (j.reviews || []).map((r: any) => ({ author: r.author?.login ?? '', state: r.state, body: r.body || '' })),
    };
  }
}

function rollupGh(rollup: any[] | undefined): CheckState {
  if (!Array.isArray(rollup) || !rollup.length) return undefined;
  const states = rollup.map(s => s.conclusion ?? s.state ?? s.status).filter(Boolean);
  if (states.some(s => /^(FAILURE|failure|TIMED_OUT|cancelled)$/i.test(s))) return 'FAILURE';
  if (states.some(s => /^(PENDING|pending|IN_PROGRESS|QUEUED)$/i.test(s))) return 'PENDING';
  if (states.every(s => /^(SUCCESS|success|NEUTRAL)$/i.test(s))) return 'SUCCESS';
  return 'PENDING';
}

// ────────────────────────────────────────────────────────────────────
// Azure DevOps via `az repos` CLI
// Requires:  brew install azure-cli && az extension add --name azure-devops
//            az login (or az devops login --org https://dev.azure.com/<org>)
// ────────────────────────────────────────────────────────────────────

class AzureDevOpsProvider implements PrProvider {
  readonly name = 'Azure DevOps' as const;
  readonly providerKey = 'azure-devops' as const;

  constructor(private git: Git, private info: HostInfo) {}

  private get org(): string { return `https://dev.azure.com/${this.info.owner}`; }

  private async az(args: string[]): Promise<any> {
    const { stdout } = await pexec(
      'az',
      [...args, '--organization', this.org, '--output', 'json'],
      { cwd: this.git.cwd, maxBuffer: 100 * 1024 * 1024, env: { ...process.env, AZURE_DEVOPS_EXT_PAT_AUTH: process.env.AZURE_DEVOPS_EXT_PAT_AUTH ?? '' } }
    );
    return stdout.trim() ? JSON.parse(stdout) : null;
  }

  async list(): Promise<PR[]> {
    // List all PRs (active + completed + abandoned) — three calls to mimic GitHub's `--state all`
    const project = this.info.project!;
    const repo = this.info.repo;
    const fetch = (status: 'active' | 'completed' | 'abandoned') =>
      this.az(['repos', 'pr', 'list', '--project', project, '--repository', repo, '--status', status, '--top', '20']).catch(() => []);

    const [active, completed, abandoned] = await Promise.all([fetch('active'), fetch('completed'), fetch('abandoned')]);
    const all: any[] = [...(active || []), ...(completed || []), ...(abandoned || [])];

    return all.map(p => {
      const state: PrState = p.status === 'completed' ? 'MERGED' : p.status === 'abandoned' ? 'CLOSED' : 'OPEN';
      const reviewers = (p.reviewers || []) as any[];
      const vote = Math.min(...reviewers.map(r => r.vote ?? 0), 10);
      const maxVote = Math.max(...reviewers.map(r => r.vote ?? 0), -10);
      const reviewDecision: ReviewState =
        vote < 0 ? 'CHANGES_REQUESTED' :
        maxVote >= 10 ? 'APPROVED' :
        reviewers.length ? 'REVIEW_REQUIRED' : undefined;

      return {
        number: p.pullRequestId ?? p.codeReviewId,
        title: p.title ?? '',
        state,
        isDraft: !!p.isDraft,
        author: p.createdBy?.displayName ?? p.createdBy?.uniqueName ?? 'unknown',
        createdAt: new Date(p.creationDate),
        updatedAt: new Date(p.closedDate ?? p.creationDate),
        baseRefName: stripRef(p.targetRefName),
        headRefName: stripRef(p.sourceRefName),
        url: pullRequestWebUrl(this.info, p.pullRequestId),
        additions: 0,  // ADO doesn't ship line totals on list; would need per-PR iteration commits
        deletions: 0,
        reviewDecision,
        checksState: undefined,  // requires separate Build/Status API call
        labels: (p.labels ?? []).map((l: any) => l.name),
        provider: 'azure-devops',
      } as PR;
    });
  }

  async checkout(number: number): Promise<void> {
    // No `az repos pr checkout` — emulate via fetch + checkout of pull-request ref
    await pexec('git', ['fetch', 'origin', `pull/${number}/merge:pr-${number}`], { cwd: this.git.cwd }).catch(async () => {
      // ADO uses different ref scheme: refs/pull/{id}/merge
      await pexec('git', ['fetch', 'origin', `refs/pull/${number}/merge:pr-${number}`], { cwd: this.git.cwd });
    });
    await pexec('git', ['checkout', `pr-${number}`], { cwd: this.git.cwd });
  }

  async currentUser(): Promise<string | undefined> {
    try {
      const u = await this.az(['account', 'show', '--query', 'user.name']);
      return (typeof u === 'string' ? u : undefined) || undefined;
    } catch { return undefined; }
  }

  async detail(number: number) {
    try {
      const project = this.info.project!;
      const repo = this.info.repo;
      const pr = await this.az(['repos', 'pr', 'show', '--id', String(number)]);
      const iterations = await this.az(['repos', 'pr', 'list-iterations', '--id', String(number)]).catch(() => null);
      const latest = iterations?.[iterations.length - 1]?.id ?? 1;
      const changes = await this.az(['repos', 'pr', 'list-iteration-changes', '--id', String(number), '--iteration', String(latest)]).catch(() => null);

      const files = (changes?.changeEntries ?? []).map((c: any) => ({
        path: c.item?.path ?? '',
        additions: 0,  // ADO doesn't return diff stats per file without another call
        deletions: 0,
      }));

      const reviews = (pr?.reviewers ?? []).map((r: any) => ({
        author: r.displayName ?? r.uniqueName ?? '',
        state: voteToState(r.vote),
        body: '',
      }));

      return {
        body: pr?.description || '',
        files,
        reviews,
      };
    } catch (e: any) {
      return { body: `(Failed to load detail: ${e.message})`, files: [], reviews: [] };
    }
  }
}

function stripRef(r: string): string { return (r || '').replace(/^refs\/heads\//, ''); }

function voteToState(vote: number): string {
  if (vote >= 10) return 'APPROVED';
  if (vote === 5) return 'APPROVED_WITH_SUGGESTIONS';
  if (vote === 0) return 'NO_VOTE';
  if (vote === -5) return 'WAITING_FOR_AUTHOR';
  if (vote === -10) return 'REJECTED';
  return 'NO_VOTE';
}
