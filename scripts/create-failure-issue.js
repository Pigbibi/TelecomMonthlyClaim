#!/usr/bin/env node
const { stateMonth } = require('../src/retry-date');

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

async function main() {
  const month = stateMonth();
  const title = `Telecom monthly claim failed: ${month}`;
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  const issues = await github(`/issues?state=open&labels=telecom-monthly,automation&per_page=20`);
  if (issues.some(issue => issue.title === title)) {
    console.log(`Open issue already exists for ${month}`);
    return;
  }
  await github('/issues', {
    method: 'POST',
    body: JSON.stringify({
      title,
      labels: ['telecom-monthly', 'automation'],
      body: [`Monthly Beijing Telecom package claim failed on final retry day.`, '', runUrl ? `Run: ${runUrl}` : '', '', 'Check workflow logs and SMS inbox connectivity.'].join('\n'),
    }),
  });
  console.log(`Created failure issue for ${month}`);
}

main().catch(err => { console.error(err); process.exit(1); });
