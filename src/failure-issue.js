// The workflow, the create script and the close script must agree on which
// failure kinds exist and how each one is titled; drift leaves issues open.
const FAILURE_KINDS = ['claim', 'state_read', 'state_persistence', 'workflow'];

const FAILURE_LABELS = {
  claim: 'claim',
  state_read: 'state read',
  state_persistence: 'state persistence',
  workflow: 'workflow',
};

const FAILURE_DESCRIPTIONS = {
  claim: 'The Beijing Telecom claim attempt failed. Check carrier and SMS evidence before retrying.',
  state_read: 'Monthly state could not be loaded. The claim was stopped to prevent a duplicate submission.',
  state_persistence: 'Monthly state could not be saved. The carrier claim may already have succeeded; inspect the run evidence before retrying. Do not rerun the claim just to repair state storage.',
  workflow: 'The workflow failed outside the carrier claim. Inspect the failed step and existing claim evidence before retrying.',
};

const OPEN_FAILURE_ISSUES_QUERY = '/issues?state=open&labels=telecom-monthly,automation&per_page=20';

function failureIssueTitle(month, kind = 'claim') {
  return `Telecom monthly ${FAILURE_LABELS[kind] || FAILURE_LABELS.workflow} failed: ${month}`;
}

function failureIssueBody(kind, runUrl) {
  return [FAILURE_DESCRIPTIONS[kind] || FAILURE_DESCRIPTIONS.workflow, '', runUrl ? `Run: ${runUrl}` : ''].join('\n');
}

async function requestGitHub(pathname, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('Missing GITHUB_TOKEN or GITHUB_REPOSITORY');
  const res = await fetch(`https://api.github.com/repos/${repo}${pathname}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = {
  FAILURE_KINDS,
  OPEN_FAILURE_ISSUES_QUERY,
  failureIssueTitle,
  failureIssueBody,
  requestGitHub,
};
