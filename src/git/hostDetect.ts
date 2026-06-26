/**
 * Detect Git host (GitHub, Azure DevOps, GitLab, Bitbucket) from a remote URL,
 * and produce both the web URL for a commit and the canonical identifiers a
 * PR provider needs (e.g. org/project/repo for ADO, owner/repo for GH).
 *
 * The pure host-detection logic now lives in the stack-agnostic shared
 * module `src/shared/remoteUrl.ts` (W28) so the standalone web app can build
 * "Open on remote" links without forking it. This file RE-EXPORTS that core
 * (the graphPalette / graphExport pattern) plus the extension's existing
 * public surface, so every importer of `src/git/hostDetect` is unaffected.
 */

export type { GitHost, HostInfo } from '../shared/remoteUrl';
export { parseRemote, remoteWebUrl, pullRequestWebUrl } from '../shared/remoteUrl';
