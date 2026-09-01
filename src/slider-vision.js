/**
 * Vision estimator for telecom slider hole X / drag distance.
 *
 * Preferred path (same as FranchiseLead / 12345):
 *   setup-codex-gateway with provider-chain=codex,gemini-free
 *   CODEX_GATEWAY_COMMAND=...  (Codex first, gemini-free inside gateway)
 *
 * Direct Gemini / OpenAI / Anthropic HTTP remains the outer fallback:
 *   TELECOM_VISION_URL=...
 *   GEMINI_API_KEY / TELECOM_VISION_API_KEY / ...
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (match) return Number(match[0]);
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function pickFirstNumber(obj, keys) {
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = coerceNumber(obj[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  return NaN;
}

function splitCommand(command) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s"']+/g;
  for (const match of String(command || '').matchAll(pattern)) {
    parts.push(match[1] ?? match[2] ?? match[0]);
  }
  return parts;
}

function buildSliderPrompt({ imageWidth, cssWidth, correctY }) {
  const cssHint = Number.isFinite(Number(cssWidth)) && Number(cssWidth) > 40
    ? Number(cssWidth)
    : null;
  return [
    `这是北京电信滑块验证码截图。截图宽度 imageWidth=${imageWidth} 像素。`,
    cssHint ? `拼图区域 CSS 宽度约 cssWidth=${cssHint}。` : '',
    correctY != null ? `缺口大致纵坐标 correctY=${correctY}。` : '',
    '请同时给出：',
    '1) x：拼图缺口左边缘相对本截图左边缘的水平像素坐标（相对 imageWidth）；',
    '2) move：底部滑块按钮需要向右拖动的 CSS 像素距离（通常约 60-220，绝不要等于 x，也绝不要接近 imageWidth）。',
    '只输出 JSON：{"x":number,"move":number,"confidence":number,"reason":string}',
  ].filter(Boolean).join('');
}

function decodePngBase64(value) {
  const raw = String(value || '').replace(/^data:image\/png;base64,/, '');
  if (!raw) return null;
  return Buffer.from(raw, 'base64');
}

function finalizeVisionParse(parsed, imageWidth, method) {
  let x = Math.round(pickFirstNumber(parsed, ['x', 'gapX', 'holeX', 'targetX', 'offsetX']));
  let move = Math.round(pickFirstNumber(parsed, ['move', 'distance', 'sliderDistance', 'drag', 'dragX']));
  if (!Number.isFinite(x) && Number.isFinite(move) && move > 280 && move <= Math.max(80, imageWidth - 20)) {
    x = move;
    move = NaN;
  }
  if (Number.isFinite(move) && Number.isFinite(x) && Math.abs(move - x) <= 2 && move > 280) {
    move = NaN;
  }
  const maxX = Math.max(80, imageWidth - 20);
  const hasMove = Number.isFinite(move) && move >= 40 && move <= 280;
  const hasX = Number.isFinite(x) && x >= 40 && x <= maxX;
  if (!hasMove && !hasX) {
    return {
      ok: false,
      reason: 'vision-x-out-of-range',
      parsed,
      imageWidth,
      method,
    };
  }
  return {
    ok: true,
    naturalX: hasX ? x : move,
    moveX: hasMove ? move : undefined,
    confidence: coerceNumber(parsed.confidence) || 0.7,
    reason: parsed.reason || '',
    method,
    parsed,
  };
}

function parseVisionJsonText(outText, imageWidth, method) {
  if (/Unsupported Image/i.test(outText) || /Image not provided/i.test(outText)) {
    return { ok: false, reason: 'vision-image-unsupported', body: String(outText).slice(0, 300), method };
  }
  const start = String(outText).indexOf('{');
  const end = String(outText).lastIndexOf('}');
  if (start < 0) {
    return { ok: false, reason: 'vision-no-json', body: String(outText).slice(0, 300), method };
  }
  const jsonText = end > start ? String(outText).slice(start, end + 1) : `${String(outText).slice(start).trim()}}`;
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch {
    return { ok: false, reason: 'vision-bad-json', body: String(outText).slice(0, 300), method };
  }
  return finalizeVisionParse(parsed, imageWidth, method);
}

function estimateWithCodexGateway({ bgPngBase64, blockPngBase64, imageWidth, cssWidth, correctY }) {
  const command = splitCommand(process.env.CODEX_GATEWAY_COMMAND || process.env.CAPTCHA_CODEX_GATEWAY_COMMAND || '');
  if (!command.length || !bgPngBase64) {
    return { ok: false, reason: 'vision-gateway-not-configured' };
  }
  const png = decodePngBase64(bgPngBase64);
  if (!png?.length) {
    return { ok: false, reason: 'vision-image-missing' };
  }
  const timeoutSeconds = Math.max(15, Number(process.env.TELECOM_VISION_TIMEOUT_SECONDS || process.env.CAPTCHA_CODEX_TIMEOUT_SECONDS || 60));
  const providerChain = process.env.TELECOM_VISION_PROVIDER_CHAIN
    || process.env.CODEX_GATEWAY_PROVIDER_CHAIN
    || 'codex,gemini-free';
  const prompt = buildSliderPrompt({ imageWidth, cssWidth, correctY });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-slider-vision-'));
  try {
    const imagePath = path.join(tmpDir, 'slider.png');
    const promptPath = path.join(tmpDir, 'prompt.md');
    const schemaPath = path.join(tmpDir, 'schema.json');
    const outputPath = path.join(tmpDir, 'answer.json');
    fs.writeFileSync(imagePath, png);
    if (blockPngBase64) {
      const block = decodePngBase64(blockPngBase64);
      if (block?.length) fs.writeFileSync(path.join(tmpDir, 'block.png'), block);
    }
    fs.writeFileSync(promptPath, prompt);
    fs.writeFileSync(schemaPath, JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number' },
        move: { type: 'number' },
        confidence: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['x', 'move'],
    }));
    const args = [
      ...command.slice(1),
      '--prompt-file', promptPath,
      '--image', imagePath,
    ];
    const blockPath = path.join(tmpDir, 'block.png');
    if (fs.existsSync(blockPath)) {
      args.push('--image', blockPath);
    }
    args.push(
      '--output-schema', schemaPath,
      '--out', outputPath,
      '--timeout-seconds', String(timeoutSeconds),
      '--sandbox', 'read-only',
      '--ask-for-approval', 'never',
      '--task', 'captcha',
      '--complexity', 'high',
      '--providers', providerChain,
    );
    const result = spawnSync(command[0], args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_GATEWAY_PROVIDER_CHAIN: providerChain,
      },
      timeout: timeoutSeconds * 1000,
    });
    if (result.error) {
      return {
        ok: false,
        reason: 'vision-gateway-error',
        body: String(result.error.message || result.error).slice(0, 300),
        method: 'codex-gateway',
      };
    }
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim().slice(-600);
      return {
        ok: false,
        reason: 'vision-gateway-failed',
        body: detail || `exit ${result.status}`,
        method: 'codex-gateway',
      };
    }
    const rawText = fs.existsSync(outputPath)
      ? fs.readFileSync(outputPath, 'utf8')
      : String(result.stdout || '');
    return parseVisionJsonText(rawText, imageWidth, 'codex-gateway');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function estimateWithHttpVision({
  bgPngBase64,
  blockPngBase64,
  imageWidth,
  cssWidth,
  correctY,
}) {
  const key = process.env.TELECOM_VISION_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || '';
  const model = process.env.TELECOM_VISION_MODEL
    || process.env.GEMINI_MODEL
    || process.env.ANTHROPIC_MODEL
    || DEFAULT_GEMINI_MODEL;
  let url = process.env.TELECOM_VISION_URL || '';
  if (!url && key && (process.env.GEMINI_API_KEY || process.env.TELECOM_VISION_MODE === 'gemini')) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  }
  const mode = (process.env.TELECOM_VISION_MODE
    || (url.includes('generativelanguage.googleapis.com') || url.includes('googleapis.com') || url.includes('gemini') ? 'gemini'
      : (url.includes('anthropic') || url.includes('8787') ? 'anthropic' : 'openai'))).toLowerCase();
  if (!url || !key || !bgPngBase64) {
    return { ok: false, reason: 'vision-not-configured' };
  }

  const prompt = buildSliderPrompt({ imageWidth, cssWidth, correctY });
  let body;
  let headers = { 'content-type': 'application/json' };
  if (mode === 'gemini') {
    const contents = [{
      role: 'user',
      parts: [
        { text: prompt },
        {
          inlineData: {
            mimeType: 'image/png',
            data: bgPngBase64.replace(/^data:image\/png;base64,/, ''),
          },
        },
      ],
    }];
    if (blockPngBase64) {
      contents[0].parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: blockPngBase64.replace(/^data:image\/png;base64,/, ''),
        },
      });
    }
    body = {
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        candidateCount: 1,
      },
    };
  } else if (mode === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    const content = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: bgPngBase64.replace(/^data:image\/png;base64,/, '') },
      },
      { type: 'text', text: prompt },
    ];
    if (blockPngBase64) {
      content.splice(1, 0, {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: blockPngBase64.replace(/^data:image\/png;base64,/, '') },
      });
    }
    body = { model, max_tokens: 200, messages: [{ role: 'user', content }] };
  } else {
    headers.Authorization = `Bearer ${key}`;
    const content = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: bgPngBase64.startsWith('data:') ? bgPngBase64 : `data:image/png;base64,${bgPngBase64}` } },
    ];
    if (blockPngBase64) {
      content.push({
        type: 'image_url',
        image_url: { url: blockPngBase64.startsWith('data:') ? blockPngBase64 : `data:image/png;base64,${blockPngBase64}` },
      });
    }
    body = {
      model,
      max_tokens: 200,
      messages: [{ role: 'user', content }],
    };
  }

  let requestUrl = url;
  if (mode === 'gemini') {
    const parsedUrl = new URL(url);
    if (!parsedUrl.searchParams.has('key')) parsedUrl.searchParams.set('key', key);
    requestUrl = parsedUrl.toString();
    delete headers.Authorization;
  } else {
    headers.Authorization = mode === 'anthropic' ? undefined : `Bearer ${key}`;
    if (headers.Authorization === undefined) delete headers.Authorization;
  }

  const resp = await fetch(requestUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, reason: `vision-http-${resp.status}`, body: text.slice(0, 300), method: mode };
  }
  let data;
  try { data = JSON.parse(text); } catch {
    return { ok: false, reason: 'vision-non-json', body: text.slice(0, 300), method: mode };
  }
  let outText = '';
  if (Array.isArray(data.candidates)) {
    const parts = data.candidates[0]?.content?.parts || [];
    outText = parts.map(part => part.text || '').join('\n');
    if (!outText && data.candidates[0]?.finishReason) {
      return {
        ok: false,
        reason: `vision-finish-${String(data.candidates[0].finishReason).toLowerCase()}`,
        body: text.slice(0, 300),
        method: mode,
      };
    }
  } else if (Array.isArray(data.content)) {
    outText = data.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
  } else if (data.choices?.[0]?.message?.content) {
    outText = String(data.choices[0].message.content);
  } else {
    outText = text;
  }
  return parseVisionJsonText(outText, imageWidth, mode === 'gemini' ? 'gemini-direct' : mode);
}

function visionProvidersConfigured() {
  const gateway = !!(process.env.CODEX_GATEWAY_COMMAND || process.env.CAPTCHA_CODEX_GATEWAY_COMMAND);
  const key = !!(process.env.TELECOM_VISION_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN);
  const url = !!(process.env.TELECOM_VISION_URL || process.env.GEMINI_API_KEY);
  return gateway || (key && url);
}

async function estimateSliderDistanceWithVision(options = {}) {
  const normalized = {
    imageWidth: 280,
    cssWidth: null,
    correctY: null,
    ...options,
  };
  if (!normalized.bgPngBase64) {
    return { ok: false, reason: 'vision-image-missing' };
  }
  if (!visionProvidersConfigured()) {
    return { ok: false, reason: 'vision-not-configured' };
  }

  let gatewayError = null;
  if (process.env.CODEX_GATEWAY_COMMAND || process.env.CAPTCHA_CODEX_GATEWAY_COMMAND) {
    const gateway = estimateWithCodexGateway(normalized);
    if (gateway.ok) return gateway;
    gatewayError = gateway;
    if (!(process.env.GEMINI_API_KEY || process.env.TELECOM_VISION_API_KEY || process.env.TELECOM_VISION_URL)) {
      return gateway;
    }
    console.warn(`CodexGateway slider vision failed (${gateway.reason}); falling back to direct Gemini/HTTP`, {
      body: gateway.body,
    });
  }

  const http = await estimateWithHttpVision(normalized);
  if (http.ok || !gatewayError) return http;
  return {
    ok: false,
    reason: 'vision-gateway-and-http-failed',
    gatewayReason: gatewayError.reason,
    gatewayBody: gatewayError.body,
    httpReason: http.reason,
    body: http.body,
    method: 'codex-gateway+http',
  };
}

module.exports = {
  estimateSliderDistanceWithVision,
  visionProvidersConfigured,
};
