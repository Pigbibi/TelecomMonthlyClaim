#!/usr/bin/env node
const { stateMonth } = require('../src/retry-date');

const FAILURE_LABELS = {
  claim: 'claim',
  state_read: 'state read',
  state_persistence: 'state persistence',
  workflow: 'workflow',
};

function failureIssueTitle(month, kind = 'claim') {
  return `Telecom monthly ${FAILURE_LABELS[kind] || FAILURE_LABELS.workflow} failed: ${month}`;
}

function failureIssueBody(kind, runUrl) {
  const descriptions = {
    claim: 'The Beijing Telecom claim attempt failed. Check carrier and SMS evidence before retrying.',
    state_read: 'Monthly state could not be loaded. The claim was stopped to prevent a duplicate submission.',
    state_persistence: 'Monthly state could not be saved. The carrier claim may already have succeeded; inspect the run evidence before retrying. Do not rerun the claim just to repair state storage.',
    workflow: 'The workflow failed outside the carrier claim. Inspect the failed step and existing claim evidence before retrying.',
  };
  return [descriptions[kind] || descriptions.workflow, '', runUrl ? `Run: ${runUrl}` : ''].join('\n');
}

async function github(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('Missing GITHUB_TOKEN or GITHUB_REPOSITORY');
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
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

async function createFailureIssue({ month, kind = 'claim', runUrl = '', github: githubRequest = github }) {
  const title = failureIssueTitle(month, kind);
  const issues = await githubRequest(`/issues?state=open&labels=telecom-monthly,automation&per_page=20`);
  if (issues.some(issue => issue.title === title)) return false;
  await githubRequest('/issues', {
    method: 'POST',
    body: JSON.stringify({ title, labels: ['telecom-monthly', 'automation'], body: failureIssueBody(kind, runUrl) }),
  });
  return true;
}

async function main() {
  const month = stateMonth();
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  const created = await createFailureIssue({ month, kind: process.env.FAILURE_KIND || 'claim', runUrl });
  console.log(`${created ? 'Created failure issue' : 'Open issue already exists'} for ${month}`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { failureIssueTitle, failureIssueBody, createFailureIssue };
