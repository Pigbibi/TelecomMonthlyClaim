#!/usr/bin/env node
const { stateMonth } = require('../src/retry-date');
const { claimStateFile, readClaimStateStatus } = require('../src/claim-state');
const {
  FAILURE_KINDS,
  OPEN_FAILURE_ISSUES_QUERY,
  failureIssueTitle,
  requestGitHub,
} = require('../src/failure-issue');

async function resolveFailureIssue({ month, stateStatus, github: githubRequest = requestGitHub }) {
  if (stateStatus !== 'success') return false;
  const titles = FAILURE_KINDS.map(kind => failureIssueTitle(month, kind));
  const issues = await githubRequest(OPEN_FAILURE_ISSUES_QUERY);
  const matching = issues.filter(item => titles.includes(item.title));
  for (const issue of matching) {
    await githubRequest(`/issues/${issue.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }
  return matching.length > 0;
}

async function main() {
  const month = stateMonth();
  const stateStatus = readClaimStateStatus(claimStateFile(month));

  if (await resolveFailureIssue({ month, stateStatus })) {
    console.log(`Closed resolved failure issue for ${month}`);
  } else {
    console.log(`No open failure issue to close for ${month}`);
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { resolveFailureIssue };
