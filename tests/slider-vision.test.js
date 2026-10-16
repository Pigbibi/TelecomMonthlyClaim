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
    'CODEX_GATEWAY_PROVIDER_CHAIN',
    'CODEX_GATEWAY_SLIDER_GEMINI_MODEL',
    'CODEX_GATEWAY_SLIDER_GEMINI_FREE_MODEL',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'TELECOM_VISION_URL',
    'TELECOM_VISION_MODE',
    'TELECOM_VISION_MODEL',
    'TELECOM_VISION_API_KEY',
    'TELECOM_VISION_PROVIDER_CHAIN',
    'TELECOM_VISION_TIMEOUT_SECONDS',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
    'OPENAI_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'GATEWAY_CALL_LOG',
    'GATEWAY_GEMINI_ANSWER',
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

test('retired CLI settings never execute a command or fall through to HTTP', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-retired-cli-'));
  const marker = path.join(tmp, 'called');
  const script = path.join(tmp, 'must-not-run.js');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); process.exit(2);`);
  try {
    for (const setting of ['CODEX_GATEWAY_COMMAND', 'CAPTCHA_CODEX_GATEWAY_COMMAND']) {
      for (const withHttp of [false, true]) {
        let fetched = false;
        const result = await withVisionEnv({
          [setting]: `"${process.execPath}" "${script}"`,
          ...(withHttp ? {
            TELECOM_VISION_URL: 'https://provider.example.invalid/v1',
            TELECOM_VISION_API_KEY: 'synthetic-only',
          } : {}),
        }, () => {
          global.fetch = async () => { fetched = true; throw new Error('unexpected HTTP'); };
          return estimateSliderDistanceWithVision({ bgPngBase64: TINY_PNG });
        });
        assert.equal(fs.existsSync(marker), false);
        assert.equal(fetched, false);
        assert.deepEqual(result, {
          ok: false, reason: 'vision-gateway-cli-retired', method: 'codex-gateway-cli',
        });
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a provider key alone does not enable implicit CLI or direct HTTP', async () => {
  const { visionProvidersConfigured } = require('../src/slider-vision');
  await withVisionEnv({ GEMINI_API_KEY: 'synthetic-only' }, async () => {
    global.fetch = async () => { throw new Error('unexpected provider call'); };
    assert.equal(visionProvidersConfigured(), false);
    assert.deepEqual(await estimateSliderDistanceWithVision({ bgPngBase64: TINY_PNG }), {
      ok: false, reason: 'vision-not-configured',
    });
  });
});

test('retired service configuration stops without OIDC, HTTP, or CLI fallback', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-retired-gateway-'));
  const marker = path.join(tmp, 'provider-called');
  const script = path.join(tmp, 'must-not-run.js');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`);
  let fetched = false;
  global.fetch = async () => {
    fetched = true;
    throw new Error('retired route must not fetch OIDC or a provider');
  };
  try {
    for (const serviceUrl of ['https://gateway.example.invalid', 'https://gateway.example.invalid/v1/codex']) {
      const result = await withVisionEnv({
        CODEX_GATEWAY_SERVICE_URL: serviceUrl,
        CODEX_GATEWAY_COMMAND: `"${process.execPath}" "${script}"`,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.invalid/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-request-token',
        GEMINI_API_KEY: 'synthetic-only',
        TELECOM_VISION_URL: 'https://provider.example.invalid/v1',
      }, () => estimateSliderDistanceWithVision({ bgPngBase64: 'synthetic-image' }));
      assert.deepEqual(result, {
        ok: false, reason: 'vision-gateway-service-retired', method: 'codex-gateway-service',
      });
      assert.equal(fetched, false);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(JSON.stringify(result).includes(serviceUrl), false);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

test('preserves explicit HTTP loading failures for the loading detector', async () => {
  await withVisionEnv({
    TELECOM_VISION_URL: 'https://provider.example.invalid/v1',
    TELECOM_VISION_API_KEY: 'synthetic-only',
  }, async () => {
    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({x: -1, move: -1, confidence: 0.01, reason: 'loading spinner only'}),
    });
    const result = await estimateSliderDistanceWithVision({ bgPngBase64: TINY_PNG });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'vision-x-out-of-range');
    assert.equal(require('../src/slider-vision').isVisionPuzzleLoading(result), true);
    assert.match(result.parsed.reason, /loading/);
  });
});

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// The explicit HTTP path retains the coordinate acceptance checks.
test('rejects out-of-range explicit HTTP vision output', async () => {
  await withVisionEnv({
    TELECOM_VISION_URL: 'https://provider.example.invalid/v1',
    TELECOM_VISION_API_KEY: 'synthetic-only',
  }, async () => {
    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({x: -1, move: -1, confidence: 0.1, reason: 'no gap'}),
    });
    const result = await estimateSliderDistanceWithVision({ bgPngBase64: TINY_PNG });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'vision-x-out-of-range');
  });
});
