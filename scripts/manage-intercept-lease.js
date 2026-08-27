#!/usr/bin/env node

const SUPPORTED_PRESETS = new Set(['telecom-claim-silent']);

function leaseIdFromEnv(env = process.env) {
  const explicit = String(env.PUSHPLUS_INTERCEPT_LEASE_ID || '').trim();
  if (explicit) return explicit;
  const runId = String(env.GITHUB_RUN_ID || process.pid);
  const attempt = String(env.GITHUB_RUN_ATTEMPT || '1');
  return `telecom-${runId}-${attempt}`;
}

function buildLeaseUrl(inboxUrl, preset, leaseId) {
  if (!SUPPORTED_PRESETS.has(preset)) throw new Error(`Unsupported intercept preset: ${preset}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(leaseId)) throw new Error('Invalid intercept lease ID');
  const url = new URL(inboxUrl);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('PUSHPLUS_RELAY_INBOX_URL must be an HTTPS URL without embedded credentials');
  }
  url.pathname = `/intercepts/leases/${encodeURIComponent(preset)}/${encodeURIComponent(leaseId)}`;
  url.search = '';
  url.hash = '';
  return url;
}

async function manageInterceptLease(action, preset, { env = process.env, fetchImpl = fetch } = {}) {
  if (!['acquire', 'release'].includes(action)) throw new Error('Action must be acquire or release');
  const inboxUrl = String(env.PUSHPLUS_RELAY_INBOX_URL || '').trim();
  const token = String(env.PUSHPLUS_RELAY_INBOX_TOKEN || '').trim();
  if (!inboxUrl && !token) {
    console.log('PushPlus relay inbox is not configured; intercept lease skipped.');
    return { skipped: true };
  }
  if (!inboxUrl || !token) {
    throw new Error('PUSHPLUS_RELAY_INBOX_URL and PUSHPLUS_RELAY_INBOX_TOKEN must be configured together');
  }

  const leaseId = leaseIdFromEnv(env);
  const url = buildLeaseUrl(inboxUrl, preset, leaseId);
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  const options = { method: action === 'acquire' ? 'PUT' : 'DELETE', headers };
  if (action === 'acquire') {
    const ttlSeconds = Number(env.PUSHPLUS_INTERCEPT_LEASE_TTL_SECONDS || 3600);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60) {
      throw new Error('PUSHPLUS_INTERCEPT_LEASE_TTL_SECONDS must be at least 60');
    }
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify({ ttlSeconds: Math.floor(ttlSeconds) });
  }

  const response = await fetchImpl(url, options);
  if (!response.ok) throw new Error(`PushPlus intercept lease ${action} failed: HTTP ${response.status}`);
  console.log(`PushPlus intercept lease ${action === 'acquire' ? 'acquired' : 'released'} for ${preset}.`);
  return { skipped: false, leaseId };
}

async function main() {
  const [action, preset] = process.argv.slice(2);
  await manageInterceptLease(action, preset);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { buildLeaseUrl, leaseIdFromEnv, manageInterceptLease };
