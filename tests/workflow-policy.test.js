const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const workflowText = fs.readFileSync(path.join(root, '.github/workflows/monthly-claim.yml'), 'utf8');
const localWorkflowText = fs.readFileSync(path.join(root, '.github/workflows/local-selfhosted-claim.yml'), 'utf8');

test('monthly workflow does not depend on Pigbibi private home proxy actions', () => {
  assert.doesNotMatch(workflowText, /Pigbibi\/HomeProxyActions/);
  assert.doesNotMatch(workflowText, /Pigbibi\/InternalHomeProxyActions/);
  assert.doesNotMatch(workflowText, /Pigbibi\/BwgRouterSelfHeal\/actions\/setup-home-proxy/);
  assert.doesNotMatch(workflowText, /uses:\s\.\/actions\/setup-home-proxy/);
});

test('monthly workflow documents generic proxy modes instead of BWG-only execution', () => {
  assert.match(workflowText, /connectivity_mode:/);
  assert.match(workflowText, /runner_target:/);
  assert.match(workflowText, /default:\s+"local_selfhosted"/);
  assert.match(workflowText, /TELECOM_CONNECTIVITY_MODE:/);
  assert.doesNotMatch(workflowText, /BWG_SSH_PRIVATE_KEY/);
  assert.match(workflowText, /Unsupported TELECOM_CONNECTIVITY_MODE/);
  assert.match(workflowText, /direct\|http_proxy\|ssh_tunnel\|proxy_pool/);
});

test('repository does not ship Pigbibi internal home proxy automation', () => {
  for (const relativePath of [
    'actions/setup-home-proxy/action.yml',
    'scripts/setup-home-proxy.sh',
    'scripts/check-home-proxy.sh',
    'scripts/home-http-proxy.js',
    'scripts/install-openwrt-router.sh',
    'scripts/install-bwg-public-webhook.sh',
    'openwrt/telecom-bwg-tunnel.init',
    'bwg/telecom-public-webhook-proxy.py',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, relativePath);
  }
});

test('monthly workflow supports generic ssh tunnel proxy configuration', () => {
  assert.match(workflowText, /ssh_tunnel/);
  assert.match(workflowText, /PROXY_SSH_HOST/);
  assert.match(workflowText, /PROXY_SSH_PRIVATE_KEY/);
  assert.match(workflowText, /PROXY_TUNNEL_REMOTE_ENDPOINT/);
  assert.match(workflowText, /PROXY_TUNNEL_PROXY_SCHEME/);
  assert.match(workflowText, /ssh-keyscan/);
  assert.match(workflowText, /nc -z 127\.0\.0\.1 "\$\{PROXY_TUNNEL_LOCAL_PORT\}"/);
  assert.match(workflowText, /proxy_url="\$\{PROXY_TUNNEL_PROXY_SCHEME:-http\}:\/\/127\.0\.0\.1:\$\{PROXY_TUNNEL_LOCAL_PORT\}"/);
  assert.match(workflowText, /OPENWRT_HTTP_PROXY=\$proxy_url/);
  assert.match(workflowText, /ControlMaster=auto/);
  assert.match(workflowText, /proxy stress check passed/);
  assert.match(workflowText, /Upload claim debug screenshots/);
  assert.match(workflowText, /artifacts\/claim-debug/);
  assert.match(workflowText, /TELECOM_STEALTH_MODE: "false"/);
  assert.match(workflowText, /BROWSER_CHANNEL: chrome/);
  assert.match(workflowText, /BROWSER_CDP_URL: "http:\/\/127\.0\.0\.1:9222"/);
  assert.match(workflowText, /TELECOM_BROWSER_TRANSPORT: "auto"/);
  assert.match(workflowText, /TELECOM_BROWSER_PROFILE: "desktop"/);
  assert.match(workflowText, /TELECOM_CDP_PROFILE_MODE: "native"/);
  assert.match(workflowText, /TELECOM_REQUIRE_REAL_CHROME: "true"/);
  assert.match(workflowText, /TELECOM_FORCE_FRESH_CDP_SESSION: "true"/);
  assert.match(workflowText, /TELECOM_REUSE_CDP_PROFILE: "true"/);
  assert.match(workflowText, /TELECOM_CLEAR_BROWSER_DATA: "true"/);
  assert.match(workflowText, /TELECOM_SLIDER_MODE: "api"/);
  assert.match(workflowText, /TELECOM_USE_DEFAULT_CHROME: "0"/);
  assert.match(workflowText, /TELECOM_DISABLE_CHROME_EXTENSIONS: "true"/);
  assert.match(workflowText, /TELECOM_KEEP_VALIDATED_PAGE_OPEN: "true"/);
  assert.match(workflowText, /TELECOM_REUSE_VALIDATED_PAGE: "true"/);
  assert.match(workflowText, /TELECOM_PROBE_ONLY/);
  assert.match(workflowText, /SEND_CODE_ATTEMPTS: "1"/);
  assert.match(workflowText, /local_selfhosted/);
  assert.match(workflowText, /github\.event_name == 'schedule'/);
  assert.match(workflowText, /runner_target != 'github_hosted'/);
  assert.match(workflowText, /telecom-claim-local/);
  assert.match(workflowText, /run-real-chrome-claim\.sh/);
  assert.doesNotMatch(workflowText, /xvfb-run -a bash scripts\/start-chrome-cdp-linux\.sh/);
  assert.match(workflowText, /Install Google Chrome for real-browser CDP/);
  assert.match(workflowText, /Verify local Google Chrome for real-browser CDP/);
  assert.match(workflowText, /runner\.os == 'macOS'/);
  assert.match(workflowText, /runner\.os == 'Linux'/);
  assert.match(workflowText, /Cleanup stale self-hosted git refs/);
  assert.match(workflowText, /runner\.environment == 'self-hosted'/);
  assert.match(workflowText, /find "\$GITHUB_WORKSPACE\/\.git\/refs" -type f -name '\* \*' -print -delete/);
  assert.match(workflowText, /XVFB_PID/);
  assert.doesNotMatch(workflowText, /playwright install/);
  assert.doesNotMatch(workflowText, /BWG_SSH/);
  assert.match(workflowText, /https:\/\/wapbj\.189\.cn\/wap2017\/index\/preDepositHighPic_check\.html\?campaignId=16239231179147085&version=V1&channelId=dx531&wxopenid=43178673fef1756c9db3fd4216bf911454dffc23a55b56ca538af38fc915ad85/);
});

test('local self-hosted workflow targets mac runner and does not mutate repo state', () => {
  assert.match(localWorkflowText, /name:\s+Local Self-Hosted Telecom Claim/);
  assert.match(localWorkflowText, /runs-on:\s+\[self-hosted, macOS, X64, telecom-claim-local\]/);
  assert.match(localWorkflowText, /Run claim via real Chrome CDP/);
  assert.match(localWorkflowText, /bash scripts\/run-real-chrome-claim\.sh/);
  assert.match(localWorkflowText, /TELECOM_CDP_PROFILE_MODE: "native"/);
  assert.match(localWorkflowText, /TELECOM_BROWSER_TRANSPORT: "extension"/);
  assert.match(localWorkflowText, /TELECOM_BROWSER_PROFILE: "desktop"/);
  assert.match(localWorkflowText, /TELECOM_USE_DEFAULT_CHROME: "0"/);
  assert.match(localWorkflowText, /TELECOM_DISABLE_CHROME_EXTENSIONS: "true"/);
  assert.match(localWorkflowText, /TELECOM_FORCE_FRESH_CDP_SESSION: "true"/);
  assert.match(localWorkflowText, /TELECOM_REUSE_CDP_PROFILE: "true"/);
  assert.match(localWorkflowText, /TELECOM_CLEAR_BROWSER_DATA: "true"/);
  assert.match(localWorkflowText, /TELECOM_KEEP_VALIDATED_PAGE_OPEN: "true"/);
  assert.match(localWorkflowText, /TELECOM_REUSE_VALIDATED_PAGE: "true"/);
  assert.match(localWorkflowText, /TELECOM_PROBE_ONLY/);
  assert.match(localWorkflowText, /SEND_CODE_ATTEMPTS: "1"/);
  assert.match(localWorkflowText, /PUSHPLUS_RELAY_INBOX_TOKEN/);
  assert.match(localWorkflowText, /Upload claim debug screenshots/);
  assert.doesNotMatch(localWorkflowText, /git push origin HEAD:main/);
  assert.doesNotMatch(localWorkflowText, /Create issue on final failure/);
  assert.doesNotMatch(localWorkflowText, /Record run log on logs branch/);
});

test('macOS Chrome profile copy excludes volatile session files', () => {
  const startScript = fs.readFileSync(path.join(root, 'scripts/start-chrome-cdp.sh'), 'utf8');
  assert.match(startScript, /--exclude 'Sessions'/);
});

test('macOS claim Chrome does not stop the user Chrome session', () => {
  const startScript = fs.readFileSync(path.join(root, 'scripts/start-chrome-cdp.sh'), 'utf8');
  assert.doesNotMatch(startScript, /tell application "Google Chrome" to quit/);
  assert.doesNotMatch(startScript, /pkill -x "Google Chrome"/);
  assert.match(startScript, /\.telecom-claim-chrome/);
});

test('extension preflight does not persist phone or browser profile data', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/run-extension-preflight-claim.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'chrome-extension/slider-preflight/manifest.json'), 'utf8');
  assert.match(script, /crypto\.randomBytes/);
  assert.match(script, /fs\.rmSync\(extensionDir/);
  assert.match(script, /fs\.rmSync\(profileDir/);
  assert.doesNotMatch(manifest, /TELECOM_PHONE|185\d{8}/);
  assert.match(script, /install-chrome-for-testing\.sh/);
});

test('enables requireRealChrome when BROWSER_CDP_URL or TELECOM_REQUIRE_REAL_CHROME is set', () => {
  const { loadConfig } = require('../src/config');
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TELECOM_') || key === 'BROWSER_CDP_URL' || key === 'BROWSER_CHANNEL' || key === 'HEADLESS') {
      delete process.env[key];
    }
  }
  try {
    process.env.TELECOM_PHONE = '18500000000';
    process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
    assert.equal(loadConfig().requireRealChrome, false);

    process.env.BROWSER_CDP_URL = 'http://127.0.0.1:9222';
    assert.equal(loadConfig().requireRealChrome, true);

    delete process.env.BROWSER_CDP_URL;
    process.env.TELECOM_REQUIRE_REAL_CHROME = 'true';
    assert.equal(loadConfig().requireRealChrome, true);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});
