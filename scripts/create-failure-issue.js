#!/usr/bin/env node
const { stateMonth } = require('../src/retry-date');
const {
  OPEN_FAILURE_ISSUES_QUERY,
  failureIssueTitle,
  failureIssueBody,
  requestGitHub,
} = require('../src/failure-issue');

async function createFailureIssue({ month, kind = 'claim', runUrl = '', github: githubRequest = requestGitHub }) {
  const title = failureIssueTitle(month, kind);
  const issues = await githubRequest(OPEN_FAILURE_ISSUES_QUERY);
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

module.exports = { createFailureIssue };
