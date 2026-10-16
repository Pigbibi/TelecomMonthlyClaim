const { withModelRecovery } = require('./gemini-model-policy.cjs');
/**
 * Vision estimator for telecom slider hole X / drag distance.
 * Legacy Gateway HTTP/CLI settings stop before any provider call.
 * Vision requires an explicit TELECOM_VISION_URL and provider key.
 */

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

function finalizeVisionParse(parsed, imageWidth, method) {
  let x = pickFirstNumber(parsed, ['x', 'gapX', 'holeX', 'targetX', 'offsetX']);
  let move = pickFirstNumber(parsed, ['move', 'distance', 'sliderDistance', 'drag', 'dragX']);
  // Providers sometimes return ratios instead of pixels.
  if (Number.isFinite(x) && x > 0 && x <= 1.5) x *= imageWidth;
  if (Number.isFinite(move) && move > 0 && move <= 1.5) {
    const asImageFrac = move * imageWidth;
    const asTrackFrac = move * 220;
    if (asImageFrac >= 40 && asImageFrac <= 280) move = asImageFrac;
    else if (asTrackFrac >= 40 && asTrackFrac <= 280) move = asTrackFrac;
    else move = asImageFrac;
  }
  x = Math.round(x);
  move = Math.round(move);
  if (!Number.isFinite(x) && Number.isFinite(move) && move > 280 && move <= Math.max(80, imageWidth - 20)) {
    x = move;
    move = NaN;
  }
  if (Number.isFinite(move) && Number.isFinite(x) && Math.abs(move - x) <= 2 && move > 280) {
    move = NaN;
  }
  // If model duplicated gap-x into move (both mid-range image coords), keep x and drop move.
  if (Number.isFinite(move) && Number.isFinite(x) && Math.abs(move - x) <= 2 && x > 280) {
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
      x,
      move,
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
  const url = process.env.TELECOM_VISION_URL || '';
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

  if (mode === 'gemini') {
    delete headers.Authorization;
  } else {
    headers.Authorization = mode === 'anthropic' ? undefined : `Bearer ${key}`;
    if (headers.Authorization === undefined) delete headers.Authorization;
  }

  let usedModel = model;
  const invoke = async (selected, remaining) => {
    usedModel = selected;
    let attemptUrl = url;
    if (mode === 'gemini') {
      const parsedUrl = new URL(url.replace(/\/models\/[^/:]+/, `/models/${selected}`));
      if (!parsedUrl.searchParams.has('key')) parsedUrl.searchParams.set('key', key);
      attemptUrl = parsedUrl.toString();
    }
    return fetch(attemptUrl, { method:'POST', headers, body:JSON.stringify(body), signal:AbortSignal.timeout(remaining) });
  };
  const resp = mode === 'gemini'
    ? await withModelRecovery(invoke, {key,model})
    : await invoke(model,30000);
  const text = await resp.text();
  if (!resp?.ok) {
    return { ok: false, reason: `vision-http-${resp?.status || 'error'}`, body: text.slice(0, 300), method: mode, model: usedModel };
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
  const url = !!process.env.TELECOM_VISION_URL;
  return gateway || (key && url);
}

function isVisionPuzzleLoading(result = {}) {
  const text = [
    result.reason,
    result.body,
    result.gatewayReason,
    result.httpReason,
    result.gatewayBody,
    result.parsed?.reason,
  ].filter(Boolean).join(' ');
  return /loading|spinner|not yet visible|加载中|请稍候|转圈/.test(text);
}

async function estimateSliderDistanceWithVision(options = {}) {
  if (process.env.CODEX_GATEWAY_SERVICE_URL) {
    return { ok: false, reason: 'vision-gateway-service-retired', method: 'codex-gateway-service' };
  }
  if (process.env.CODEX_GATEWAY_COMMAND || process.env.CAPTCHA_CODEX_GATEWAY_COMMAND) {
    return { ok: false, reason: 'vision-gateway-cli-retired', method: 'codex-gateway-cli' };
  }
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

  return estimateWithHttpVision(normalized);
}

module.exports = {
  estimateSliderDistanceWithVision,
  visionProvidersConfigured,
  isVisionPuzzleLoading,
};
