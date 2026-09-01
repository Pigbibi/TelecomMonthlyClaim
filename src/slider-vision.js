/**
 * Vision estimator for telecom slider hole X / drag distance.
 *
 * Preferred path (aligned with FranchiseLead / 12345 provider order):
 *   1) CodexGateway service HTTP via GitHub OIDC (CODEX_GATEWAY_SERVICE_URL)
 *      — public repos cannot `uses:` the private AIGateway action, so we call
 *        the same /v1/codex service contract directly from Node.
 *   2) Local CODEX_GATEWAY_COMMAND CLI when present (self-hosted / private repos)
 *   3) Direct Gemini / OpenAI / Anthropic HTTP fallback
 *
 * Gateway service only runs provider=codex; gemini-free must stay caller-side.
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

function sliderOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      x: { type: 'number' },
      move: { type: 'number' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['x', 'move', 'confidence', 'reason'],
  };
}

function encodeAttachment(name, bytes, suffix = '.png') {
  return {
    name,
    suffix,
    content_base64: Buffer.from(bytes).toString('base64'),
  };
}

async function fetchGithubOidcToken(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL || '';
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || '';
  if (!requestUrl || !requestToken) {
    return { ok: false, reason: 'vision-oidc-unavailable' };
  }
  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience || 'codex-gateway');
  const resp = await fetch(url, {
    headers: { Authorization: `bearer ${requestToken}` },
  });
  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, reason: `vision-oidc-http-${resp.status}`, body: text.slice(0, 300) };
  }
  let payload;
  try { payload = JSON.parse(text); } catch {
    return { ok: false, reason: 'vision-oidc-non-json', body: text.slice(0, 300) };
  }
  const token = String(payload.value || '').trim();
  if (!token) {
    return { ok: false, reason: 'vision-oidc-empty' };
  }
  return { ok: true, token };
}

async function estimateWithCodexGatewayService({
  bgPngBase64,
  blockPngBase64,
  imageWidth,
  cssWidth,
  correctY,
}) {
  const serviceBase = process.env.CODEX_GATEWAY_SERVICE_URL || '';
  if (!serviceBase || !bgPngBase64) {
    return { ok: false, reason: 'vision-gateway-not-configured' };
  }
  const png = decodePngBase64(bgPngBase64);
  if (!png?.length) {
    return { ok: false, reason: 'vision-image-missing' };
  }
  const audience = process.env.CODEX_GATEWAY_SERVICE_AUDIENCE || 'codex-gateway';
  const oidc = await fetchGithubOidcToken(audience);
  if (!oidc.ok) return { ...oidc, method: 'codex-gateway-service' };

  const timeoutSeconds = Math.max(15, Number(process.env.TELECOM_VISION_TIMEOUT_SECONDS || process.env.CAPTCHA_CODEX_TIMEOUT_SECONDS || 60));
  const endpoint = serviceBase.endsWith('/v1/codex') ? serviceBase : `${serviceBase.replace(/\/$/, '')}/v1/codex`;
  const images = [encodeAttachment('slider.png', png, '.png')];
  if (blockPngBase64) {
    const block = decodePngBase64(blockPngBase64);
    if (block?.length) images.push(encodeAttachment('block.png', block, '.png'));
  }
  const schemaJson = Buffer.from(JSON.stringify(sliderOutputSchema()), 'utf8');
  const payload = {
    prompt: buildSliderPrompt({ imageWidth, cssWidth, correctY }),
    timeout_seconds: timeoutSeconds,
    search: false,
    sandbox: 'read-only',
    ask_for_approval: 'never',
    model: (process.env.CAPTCHA_CODEX_MODEL || process.env.CODEX_GATEWAY_MODEL || '').trim(),
    reasoning_effort: (process.env.CODEX_GATEWAY_REASONING_EFFORT || '').trim(),
    task: 'captcha',
    complexity: 'high',
    // Service only accepts codex; Gemini fallback stays in this caller.
    provider_chain: 'codex',
    images,
    output_schema: encodeAttachment('schema.json', schemaJson, '.json'),
  };
  const overhead = Math.max(30, Number(process.env.CODEX_GATEWAY_SERVICE_TIMEOUT_OVERHEAD_SECONDS || 60));
  let resp;
  let text;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oidc.token}`,
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        'User-Agent': 'telecom-monthly-claim-slider-vision',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout((timeoutSeconds + overhead) * 1000),
    });
    text = await resp.text();
  } catch (error) {
    return {
      ok: false,
      reason: 'vision-gateway-error',
      body: String(error?.message || error).slice(0, 300),
      method: 'codex-gateway-service',
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      reason: `vision-gateway-http-${resp.status}`,
      body: text.slice(0, 300),
      method: 'codex-gateway-service',
    };
  }
  let data;
  try { data = JSON.parse(text); } catch {
    return parseVisionJsonText(text, imageWidth, 'codex-gateway-service');
  }
  const outText = typeof data.output === 'string' ? data.output : text;
  return parseVisionJsonText(outText, imageWidth, 'codex-gateway-service');
}

function estimateWithCodexGatewayCli({ bgPngBase64, blockPngBase64, imageWidth, cssWidth, correctY }) {
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
    fs.writeFileSync(schemaPath, JSON.stringify(sliderOutputSchema()));
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

async function estimateWithCodexGateway(options) {
  if (process.env.CODEX_GATEWAY_SERVICE_URL) {
    return estimateWithCodexGatewayService(options);
  }
  return estimateWithCodexGatewayCli(options);
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
  const gateway = !!(
    process.env.CODEX_GATEWAY_SERVICE_URL
    || process.env.CODEX_GATEWAY_COMMAND
    || process.env.CAPTCHA_CODEX_GATEWAY_COMMAND
  );
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
  if (
    process.env.CODEX_GATEWAY_SERVICE_URL
    || process.env.CODEX_GATEWAY_COMMAND
    || process.env.CAPTCHA_CODEX_GATEWAY_COMMAND
  ) {
    const gateway = await estimateWithCodexGateway(normalized);
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
