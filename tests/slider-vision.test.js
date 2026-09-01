const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateSliderDistanceWithVision } = require('../src/slider-vision');

function withVisionEnv(env, fn) {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  for (const key of [
    'CODEX_GATEWAY_SERVICE_URL',
    'CODEX_GATEWAY_SERVICE_AUDIENCE',
    'CODEX_GATEWAY_COMMAND',
    'CAPTCHA_CODEX_GATEWAY_COMMAND',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    });
}

test('uses Gemini API key and request format when configured', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      text: async () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: '{"x":156,"move":118,"confidence":0.91,"reason":"ok"}' }] },
        }],
      }),
    };
  };

  const result = await withVisionEnv({
    TELECOM_VISION_URL: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
    GEMINI_API_KEY: 'gemini-test-key',
    TELECOM_VISION_MODE: 'gemini',
  }, () => estimateSliderDistanceWithVision({
    bgPngBase64: 'data:image/png;base64,bg-data',
    blockPngBase64: 'data:image/png;base64,block-data',
    imageWidth: 280,
    correctY: 92,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.naturalX, 156);
  assert.equal(result.moveX, 118);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /key=gemini-test-key/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.contents[0].parts[0].text.includes('北京电信滑块验证码'), true);
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(body.contents[0].parts[1].inlineData.data, 'bg-data');
  assert.equal(body.contents[0].parts[2].inlineData.data, 'block-data');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('uses CodexGateway service HTTP before direct Gemini when SERVICE_URL is set', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('audience=')) {
      return { ok: true, text: async () => JSON.stringify({ value: 'oidc-token' }) };
    }
    return {
      ok: true,
      text: async () => JSON.stringify({
        output: '{"x":156,"move":118,"confidence":0.9,"reason":"service"}',
      }),
    };
  };

  const result = await withVisionEnv({
    CODEX_GATEWAY_SERVICE_URL: 'https://gateway.example.invalid',
    CODEX_GATEWAY_SERVICE_AUDIENCE: 'codex-gateway',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.invalid/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-token',
    GEMINI_API_KEY: 'should-not-be-used',
    TELECOM_VISION_URL: 'https://example.invalid/v1',
  }, () => estimateSliderDistanceWithVision({
    bgPngBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    imageWidth: 280,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.method, 'codex-gateway-service');
  assert.equal(result.moveX, 118);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/v1\/codex$/);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer oidc-token');
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.provider_chain, 'codex');
  assert.equal(body.task, 'slider');
  const schemaJson = Buffer.from(body.output_schema.content_base64, 'base64').toString('utf8');
  const schema = JSON.parse(schemaJson);
  assert.deepEqual(schema.required, ['x', 'move', 'confidence', 'reason']);

});

test('uses CodexGateway CLI before direct Gemini when CODEX_GATEWAY_COMMAND is set', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-fake-gateway-'));
  const scriptPath = path.join(tmpDir, 'fake-codex-gateway.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\\n' '{"x":156,"move":118,"confidence":0.9,"reason":"gateway"}' > "$out"
`);
  fs.chmodSync(scriptPath, 0o755);

  const result = await withVisionEnv({
    CODEX_GATEWAY_COMMAND: scriptPath,
    GEMINI_API_KEY: 'should-not-be-used',
    TELECOM_VISION_URL: 'https://example.invalid/v1',
  }, () => estimateSliderDistanceWithVision({
    bgPngBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    imageWidth: 280,
  }));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'codex-gateway');
  assert.equal(result.naturalX, 156);
  assert.equal(result.moveX, 118);
});

test('falls back to Gemini when CodexGateway fails', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-fake-gateway-fail-'));
  const scriptPath = path.join(tmpDir, 'fake-codex-gateway.sh');
  fs.writeFileSync(scriptPath, '#!/bin/bash\necho gateway-down >&2\nexit 2\n');
  fs.chmodSync(scriptPath, 0o755);

  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      text: async () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: '{"x":142,"move":110,"confidence":0.8,"reason":"gemini"}' }] },
        }],
      }),
    };
  };

  const result = await withVisionEnv({
    CODEX_GATEWAY_COMMAND: scriptPath,
    TELECOM_VISION_URL: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    GEMINI_API_KEY: 'gemini-test-key',
    TELECOM_VISION_MODE: 'gemini',
  }, () => estimateSliderDistanceWithVision({
    bgPngBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    imageWidth: 280,
  }));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'gemini-direct');
  assert.equal(result.moveX, 110);
  assert.equal(calls.length, 1);
});

test('treats oversized move as gap x when x is missing', async () => {
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '{"move":458,"confidence":0.8,"reason":"gap"}' }] },
      }],
    }),
  });

  const result = await withVisionEnv({
    TELECOM_VISION_URL: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
    GEMINI_API_KEY: 'gemini-test-key',
    TELECOM_VISION_MODE: 'gemini',
  }, () => estimateSliderDistanceWithVision({
    bgPngBase64: 'data:image/png;base64,bg-data',
    imageWidth: 903,
    cssWidth: 450,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.naturalX, 458);
  assert.equal(result.moveX, undefined);
});

test('falls back to TELECOM_VISION_API_KEY for non-Gemini providers', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [{
          message: { content: '{"x":142,"confidence":0.8,"reason":"ok"}' },
        }],
      }),
    };
  };

  const result = await withVisionEnv({
    TELECOM_VISION_URL: 'https://api.openai.com/v1/chat/completions',
    TELECOM_VISION_API_KEY: 'openai-test-key',
    TELECOM_VISION_MODE: 'openai',
  }, () => estimateSliderDistanceWithVision({
    bgPngBase64: 'data:image/png;base64,bg-data',
  }));

  assert.equal(result.ok, true);
  assert.equal(result.naturalX, 142);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer openai-test-key');
});

test('accepts fractional x from Codex-style ratios', async () => {
  // finalize not exported - exercise via HTTP mock instead
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"x":0.52,"move":0.18,"confidence":0.9,"reason":"ratio"}' }] } }],
    }),
  });
  const result = await withVisionEnv({
    TELECOM_VISION_URL: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    GEMINI_API_KEY: 'k',
    TELECOM_VISION_MODE: 'gemini',
  }, () => estimateSliderDistanceWithVision({
    bgPngBase64: 'data:image/png;base64,bg',
    imageWidth: 900,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.naturalX, 468);
  assert.equal(result.moveX, 162);
});

test('detects loading-spinner vision text as puzzle-still-loading', () => {
  const { isVisionPuzzleLoading } = require('../src/slider-vision');
  assert.equal(isVisionPuzzleLoading({
    reason: 'vision-x-out-of-range',
    parsed: { reason: '截图只显示加载中的弹窗和转圈，没有出现滑块' },
    x: -1,
    move: -1,
  }), true);
  assert.equal(isVisionPuzzleLoading({ reason: 'vision-x-out-of-range', parsed: { reason: 'gap at 156' } }), false);
});

test('maps dual-provider loading failures to puzzle-still-loading', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-fake-gateway-loading-'));
  const scriptPath = path.join(tmpDir, 'fake-codex-gateway.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\\n' '{"x":-1,"move":-1,"confidence":0.01,"reason":"截图只显示加载中的弹窗和转圈"}' > "$out"
`);
  fs.chmodSync(scriptPath, 0o755);

  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '{"x":-1,"move":-1,"confidence":0.01,"reason":"loading spinner only"}' }] },
      }],
    }),
  });

  const result = await withVisionEnv({
    CODEX_GATEWAY_COMMAND: scriptPath,
    TELECOM_VISION_URL: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    GEMINI_API_KEY: 'gemini-test-key',
    TELECOM_VISION_MODE: 'gemini',
  }, () => estimateSliderDistanceWithVision({
    bgPngBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    imageWidth: 903,
  }));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'puzzle-still-loading');
  assert.match(String(result.parsed?.reason || ''), /加载中|loading/i);
});
