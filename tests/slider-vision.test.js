const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateSliderDistanceWithVision } = require('../src/slider-vision');

function withVisionEnv(env, fn) {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
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
          content: { parts: [{ text: '{"x":156,"confidence":0.91,"reason":"ok"}' }] },
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
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /key=gemini-test-key/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.contents[0].parts[0].text.includes('北京电信滑块验证码'), true);
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(body.contents[0].parts[1].inlineData.data, 'bg-data');
  assert.equal(body.contents[0].parts[2].inlineData.data, 'block-data');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
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
