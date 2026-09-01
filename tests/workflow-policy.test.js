const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const workflowText = fs.readFileSync(path.join(root, '.github/workflows/monthly-claim.yml'), 'utf8');
const localWorkflowText = fs.readFileSync(path.join(root, '.github/workflows/local-selfhosted-claim.yml'), 'utf8');
const heartbeatWorkflowText = fs.readFileSync(path.join(root, '.github/workflows/log-heartbeat.yml'), 'utf8');

test('scheduled hosted workflows are serialized and bounded', () => {
  assert.match(workflowText, /group:\s+monthly-beijing-telecom-claim/);
  assert.match(workflowText, /cancel-in-progress:\s+false/);
  assert.match(workflowText, /timeout-minutes:\s+35/);
  assert.match(heartbeatWorkflowText, /group:\s+repository-log-heartbeat/);
  assert.match(heartbeatWorkflowText, /cancel-in-progress:\s+false/);
  assert.match(heartbeatWorkflowText, /timeout-minutes:\s+10/);
});

test('monthly workflow does not depend on Pigbibi private home proxy actions', () => {
  assert.doesNotMatch(workflowText, /Pigbibi\/HomeProxyActions/);
  assert.doesNotMatch(workflowText, /Pigbibi\/InternalHomeProxyActions/);
  assert.doesNotMatch(workflowText, /Pigbibi\/BwgRouterSelfHeal\/actions\/setup-home-proxy/);
  assert.doesNotMatch(workflowText, /uses:\s\.\/actions\/setup-home-proxy/);
});

test('monthly workflow prefers CodexGateway then Gemini for slider vision', () => {
  assert.match(workflowText, /id-token:\s+write/);
  assert.match(workflowText, /CODEX_GATEWAY_SERVICE_URL/);
  assert.match(workflowText, /CODEX_GATEWAY_SERVICE_AUDIENCE/);
  assert.match(workflowText, /GEMINI_API_KEY/);
  // Public repos cannot use the private AIGateway action; call the service over HTTP.
  assert.doesNotMatch(workflowText, /Pigbibi\/AIGateway\/actions\/setup-codex-gateway/);
});

test('monthly workflow uses GitHub-hosted Linux with generic proxy modes', () => {
  assert.match(workflowText, /connectivity_mode:/);
  assert.match(workflowText, /runs-on:\s+ubuntu-latest/);
  assert.doesNotMatch(workflowText, /runner_target:/);
  assert.doesNotMatch(workflowText, /self-hosted|macOS|telecom-claim-local/);
  assert.match(workflowText, /TELECOM_CONNECTIVITY_MODE:/);
  assert.doesNotMatch(workflowText, /BWG_SSH_PRIVATE_KEY/);
  assert.match(workflowText, /Unsupported TELECOM_CONNECTIVITY_MODE/);
  assert.match(workflowText, /Auto connectivity selected/);
  assert.match(workflowText, /TELECOM_CONNECTIVITY_MODE=proxy_pool/);
  assert.match(workflowText, /TELECOM_CONNECTIVITY_MODE=ssh_tunnel/);
  assert.match(workflowText, /TELECOM_CONNECTIVITY_MODE=http_proxy/);
  assert.match(workflowText, /TELECOM_CONNECTIVITY_MODE=direct/);
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
  assert.doesNotMatch(workflowText, /ControlMaster=/);
  assert.doesNotMatch(workflowText, /ControlPath=/);
  assert.doesNotMatch(workflowText, /ControlPersist=/);
  assert.match(workflowText, /proxy stress check passed/);
  assert.match(workflowText, /Upload claim debug screenshots/);
  assert.match(workflowText, /artifacts\/claim-debug/);
  assert.match(workflowText, /retention-days:\s*3/);
  assert.match(workflowText, /TELECOM_STEALTH_MODE: "false"/);
  assert.match(workflowText, /BROWSER_CHANNEL: chrome/);
  assert.match(workflowText, /BROWSER_CDP_URL: "http:\/\/127\.0\.0\.1:9222"/);
  assert.match(workflowText, /TELECOM_BROWSER_TRANSPORT: "native_playwright"/);
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
  assert.match(workflowText, /TELECOM_SUCCESS_SMS_SENDER/);
  assert.match(workflowText, /TELECOM_SUCCESS_SMS_TIMEOUT_MS/);
  assert.match(workflowText, /run-real-chrome-claim\.sh/);
  assert.match(workflowText, /xvfb-run -a bash scripts\/run-real-chrome-claim\.sh/);
  assert.doesNotMatch(workflowText, /xvfb-run -a bash scripts\/start-chrome-cdp-linux\.sh/);
  assert.match(workflowText, /Install Google Chrome for real-browser CDP/);
  assert.doesNotMatch(workflowText, /Verify local Google Chrome for real-browser CDP/);
  assert.doesNotMatch(workflowText, /runner\.os/);
  assert.match(workflowText, /XVFB_PID/);
  assert.doesNotMatch(workflowText, /playwright install/);
  assert.doesNotMatch(workflowText, /BWG_SSH/);
  assert.match(workflowText, /TELECOM_ENTRY_URL: \$\{\{ secrets\.TELECOM_ENTRY_URL \|\| vars\.TELECOM_ENTRY_URL \|\| '' \}\}/);
  assert.doesNotMatch(workflowText, /wxopenid=|campaignId=\d+/);
});

test('local self-hosted workflow targets mac runner and does not mutate repo state', () => {
  assert.match(localWorkflowText, /name:\s+Local Self-Hosted Telecom Claim/);
  assert.match(localWorkflowText, /runs-on:\s+\[self-hosted, macOS, X64, telecom-claim-local\]/);
  assert.match(localWorkflowText, /Run claim via real Chrome CDP/);
  assert.match(localWorkflowText, /bash scripts\/run-real-chrome-claim\.sh/);
  assert.match(localWorkflowText, /TELECOM_CDP_PROFILE_MODE: "native"/);
  assert.match(localWorkflowText, /TELECOM_BROWSER_TRANSPORT: "native_playwright"/);
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
  assert.match(localWorkflowText, /TELECOM_SUCCESS_SMS_SENDER/);
  assert.match(localWorkflowText, /TELECOM_SUCCESS_SMS_TIMEOUT_MS/);
  assert.match(localWorkflowText, /PUSHPLUS_RELAY_INBOX_TOKEN/);
  assert.match(localWorkflowText, /TELECOM_ENTRY_URL: \$\{\{ secrets\.TELECOM_ENTRY_URL \|\| vars\.TELECOM_ENTRY_URL \|\| '' \}\}/);
  assert.doesNotMatch(localWorkflowText, /wxopenid=|campaignId=\d+/);
  assert.match(localWorkflowText, /Upload claim debug screenshots/);
  assert.match(localWorkflowText, /retention-days:\s*3/);
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
  const background = fs.readFileSync(path.join(root, 'chrome-extension/slider-preflight/background.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'chrome-extension/slider-preflight/manifest.json'), 'utf8');
  assert.match(script, /crypto\.randomBytes/);
  assert.match(script, /fs\.rmSync\(extensionDir/);
  assert.match(script, /fs\.rmSync\(profileDir/);
  assert.doesNotMatch(manifest, /TELECOM_PHONE|185\d{8}/);
  assert.match(script, /install-chrome-for-testing\.sh/);
  assert.match(script, /node:net/);
  assert.match(script, /getFreeTcpPort/);
  assert.match(script, /remote-debugging-port=\$\{cdpPort\}/);
  assert.doesNotMatch(script, /DevToolsActivePort/);
  assert.doesNotMatch(script, /remote-debugging-port=0/);
  assert.match(script, /detached:\s*true/);
  assert.doesNotMatch(script, /TELECOM_CDP_PORT \|\| 9222/);
  assert.doesNotMatch(script, /--headless/);
  assert.match(background, /Network\.enable/);
  assert.match(background, /Page\.captureScreenshot/);
  assert.match(background, /stage: 'tab-opened'/);
  assert.match(background, /stage: 'debugger-attached'/);
  assert.match(background, /stage: 'slider-ready'/);
  assert.match(script, /extension-preflight-failed/);
  assert.match(script, /connectOverCDP/);
  assert.match(script, /TELECOM_EXTENSION_STAGE_TIMEOUT_MS/);
});

test('native Playwright transport starts a fresh headed system Chrome before attachment', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/run-native-chrome-claim.js'), 'utf8');
  const vision = fs.readFileSync(path.join(root, 'src/slider-vision.js'), 'utf8');
  const wrapper = fs.readFileSync(path.join(root, 'scripts/run-real-chrome-claim.sh'), 'utf8');
  assert.match(wrapper, /TRANSPORT=native_playwright/);
  assert.match(wrapper, /run-native-chrome-claim\.js/);
  assert.match(script, /Google Chrome\.app\/Contents\/MacOS\/Google Chrome/);
  assert.match(script, /getFreeTcpPort/);
  assert.match(script, /mkdtempSync/);
  assert.match(script, /TELECOM_REUSE_VALIDATED_PAGE: 'true'/);
  assert.match(script, /new WebSocket/);
  assert.match(script, /Input\.insertText/);
  assert.match(script, /element\.click\(\)/);
  assert.match(script, /input\.van-field__control/);
  assert.match(script, /短信验证码登录/);
  assert.match(script, /其他登录方式/);
  assert.match(script, /本机号码一键登录/);
  assert.match(script, /__telecomNativeOneClickAttempted/);
  assert.match(script, /document\.body\?\.querySelectorAll\('\*'\)/);
  assert.match(script, /clickedLoginSwitch/);
  assert.match(script, /fillNativePhoneInput/);
  assert.match(script, /phonePrimed:/);
  assert.doesNotMatch(script, /for \(const digit of String\(phone/);
  assert.match(script, /readNativePhoneState/);
  assert.match(script, /Native Chrome entry page did not render:.*JSON\.stringify\(diagnostics\)/);
  assert.match(script, /bodyTextLength:/);
  assert.match(script, /bodySummary:/);
  assert.match(script, /visibleActions:/);
  assert.match(script, /inputs: \[\.\.\.document\.querySelectorAll\('input'\)\]/);
  assert.match(script, /computeSliderImageMatchInPage/);
  assert.match(script, /legacy login slider images unavailable; using vision-first puzzle solver/);
  assert.match(script, /return solveConfirmationSlider\(client\)/);
  assert.match(script, /SmsInboxClient/);
  assert.match(script, /preDepositC\\\\w\*_list/);
  assert.match(script, /login completed before Playwright attachment/);
  assert.match(script, /Native Chrome package page diagnostics/);
  assert.match(script, /dismissBenignDialogs/);
  assert.match(script, /Native Chrome dismissed package-page dialog/);
  assert.match(script, /configured package unavailable/);
  assert.match(script, /TELECOM_PACKAGE_UNAVAILABLE/);
  assert.match(script, /collectMetaOfferLabels/);
  assert.match(script, /pageFamily/);

  assert.match(script, /recentTelecomApiDiagnostics\(packageDiagnosticsStartedAt\)/);
  assert.match(script, /packageDiagnosticsStartedAt = packageStartedAt - 10000/);
  assert.match(script, /recentRuntimeDiagnostics\(packageDiagnosticsStartedAt\)/);
  assert.match(script, /recentResourceDiagnostics\(packageDiagnosticsStartedAt\)/);
  assert.match(script, /Network\.loadingFinished/);
  assert.match(script, /pending: true/);
  assert.match(script, /hasSingleSignOnPhoneNo/);
  assert.match(script, /Runtime\.exceptionThrown/);
  assert.match(script, /Runtime\\\.evaluate timed out/);
  assert.match(script, /TELECOM_LOGIN_ALREADY_COMPLETE: 'true'/);
  assert.match(script, /TELECOM_CONFIRM_SMS_ALREADY_SENT: packageUnavailable \|\| alreadyClaimed \? 'false' : 'true'/);
  assert.match(script, /Network\.setBlockedURLs/);
  assert.match(script, /sendRandByUnlog/);
  assert.match(script, /Native Chrome slider-load probe passed without submitting the slider/);
  assert.match(script, /state\?\.challengeVisible/);
  assert.match(script, /getSliderChallenge\/i\.test\(event\.pathname\)/);
  assert.match(script, /input\[type="range"\]/);
  assert.match(script, /--proxy-server=/);
  assert.match(script, /Native Chrome confirmation slider assets still incomplete/);
  assert.match(script, /Native Chrome vision-first slider attempt/);
  assert.match(script, /vision solver skipped: set CODEX_GATEWAY_SERVICE_URL/);
  assert.match(script, /visionProvidersConfigured/);
  assert.match(vision, /CODEX_GATEWAY_SERVICE_URL/);
  assert.match(vision, /codex-gateway-service/);
  assert.match(script, /solvePuzzleWithVisionFallback/);
  assert.match(script, /chooseVisionMoveX/);
  assert.match(script, /findPuzzleSlider/);
  assert.match(script, /visionMoveX/);
  assert.match(script, /cssWidth/);
  assert.match(script, /vision-x-out-of-range/);
  assert.match(script, /vision unavailable; falling back to local match/);
  assert.match(script, /Always drag the distance for THIS challenge/);
  assert.match(script, /puzzle-still-loading/);
  assert.match(script, /slider attempt rejected/);
  assert.match(script, /vision-direct/);
  assert.match(script, /puzzle-verify-popup/);
  assert.match(script, /\.refreshIcon.*#slider_refresh_icon.*\.slider-refresh-icon/);
  assert.match(script, /rendered-flat-component/);
  assert.match(script, /rendered-crop-only/);
  assert.match(script, /preferCanvasTransparentMatch\(local, rawInfo\)/);
  assert.match(script, /vision-fallback/);
  assert.match(script, /isFlatPuzzleCandidateReliable/);
  assert.match(script, /process\.platform === 'linux' \? dragSliderTrusted : dragSlider/);
  assert.match(script, /Input\.dispatchMouseEvent/);
  assert.match(script, /当日发送短信数量过多/);
  assert.ok(script.includes("dialogs.join('\\\\n')"));
  assert.match(script, /`--remote-debugging-port=\$\{cdpPort\}`/);
  assert.doesNotMatch(script, /--headless/);
  assert.doesNotMatch(script, /remote-debugging-port=0/);
});

test('native package clicks return before telecom click handlers run', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/run-native-chrome-claim.js'), 'utf8');
  assert.match(script, /setTimeout\(\(\) => item\.click\(\), 0\)/);
  assert.match(script, /setTimeout\(\(\) => element\.click\(\), 0\)/);
  assert.match(script, /Native Chrome target package click scheduled/);
  assert.match(script, /isTransientPageEvaluationError/);
});

test('native Chrome redacts sensitive form fields before failure screenshots', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/run-native-chrome-claim.js'), 'utf8');
  assert.match(script, /redactSensitivePageFields/);
  assert.match(script, /querySelectorAll\('input,textarea,\[contenteditable="true"\]'\)/);
  assert.match(script, /createTreeWalker\(document\.body, NodeFilter\.SHOW_TEXT\)/);
  assert.ok(script.indexOf('await redactSensitivePageFields(client)') < script.indexOf("Page.captureScreenshot', { format: 'png'"));
  assert.match(script, /if \(!await redactSensitivePageFields\(client\)\) return/);
});

test('native Chrome login timeout diagnostics stay metadata-only', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/run-native-chrome-claim.js'), 'utf8');
  assert.match(script, /recentTelecomApiDiagnostics/);
  assert.match(script, /inputLength:/);
  assert.match(script, /bodyBytes/);
  assert.doesNotMatch(script, /postData/);
  assert.doesNotMatch(script, /inputValue:/);
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
