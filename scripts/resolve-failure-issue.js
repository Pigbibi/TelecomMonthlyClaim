#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { stateMonth } = require('../src/retry-date');
const { failureIssueTitle } = require('./create-failure-issue');

async function github(pathname, options = {}) {
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

async function resolveFailureIssue({ month, stateStatus, github: githubRequest = github }) {
  if (stateStatus !== 'success') return false;
  const titles = ['claim', 'state_read', 'state_persistence', 'workflow'].map(kind => failureIssueTitle(month, kind));
  const issues = await githubRequest('/issues?state=open&labels=telecom-monthly,automation&per_page=20');
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
  const stateFile = path.join('state', `${month}.json`);
  let stateStatus = '';
  try {
    stateStatus = String(JSON.parse(fs.readFileSync(stateFile, 'utf8')).status || '');
  } catch {}

  if (await resolveFailureIssue({ month, stateStatus })) {
    console.log(`Closed resolved failure issue for ${month}`);
  } else {
    console.log(`No open failure issue to close for ${month}`);
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { failureIssueTitle, resolveFailureIssue };
