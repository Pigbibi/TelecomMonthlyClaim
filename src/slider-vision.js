/**
 * Optional vision-model fallback for slider hole X.
 *
 * Local Anthropic-compatible proxy currently returns "[Unsupported Image]",
 * so this stays OFF by default. Enable when a real vision endpoint is available:
 *
 *   TELECOM_VISION_URL=https://api.openai.com/v1/chat/completions
 *   TELECOM_VISION_API_KEY=...
 *   TELECOM_VISION_MODEL=gpt-4.1-mini
 *   TELECOM_VISION_MODE=openai   # or anthropic / gemini
 *
 * Or Anthropic Messages style:
 *   TELECOM_VISION_URL=https://api.anthropic.com/v1/messages
 *   TELECOM_VISION_MODE=anthropic
 *
 * Or Gemini generateContent style:
 *   TELECOM_VISION_URL=https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent
 *   GEMINI_API_KEY=...
 *   TELECOM_VISION_MODE=gemini
 */

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

async function estimateSliderDistanceWithVision({
  bgPngBase64,
  blockPngBase64,
  imageWidth = 280,
  cssWidth = null,
  correctY = null,
}) {
  const url = process.env.TELECOM_VISION_URL || '';
  const key = process.env.TELECOM_VISION_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || '';
  const model = process.env.TELECOM_VISION_MODEL
    || process.env.ANTHROPIC_MODEL
    || 'gpt-4.1-mini';
  const mode = (process.env.TELECOM_VISION_MODE
    || (url.includes('generativelanguage.googleapis.com') || url.includes('googleapis.com') || url.includes('gemini') ? 'gemini'
      : (url.includes('anthropic') || url.includes('8787') ? 'anthropic' : 'openai'))).toLowerCase();
  if (!url || !key || !bgPngBase64) {
    return { ok: false, reason: 'vision-not-configured' };
  }

  const cssHint = Number.isFinite(Number(cssWidth)) && Number(cssWidth) > 40
    ? Number(cssWidth)
    : null;
  const prompt = [
    `这是北京电信滑块验证码截图。截图宽度 imageWidth=${imageWidth} 像素。`,
    cssHint ? `拼图区域 CSS 宽度约 cssWidth=${cssHint}。` : '',
    correctY != null ? `缺口大致纵坐标 correctY=${correctY}。` : '',
    '请同时给出：',
    '1) x：拼图缺口左边缘相对本截图左边缘的水平像素坐标（相对 imageWidth）；',
    '2) move：底部滑块按钮需要向右拖动的 CSS 像素距离（通常约 60-220，绝不要等于 x，也绝不要接近 imageWidth）。',
    '只输出 JSON：{"x":number,"move":number,"confidence":number,"reason":string}',
  ].filter(Boolean).join('');

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
    return { ok: false, reason: `vision-http-${resp.status}`, body: text.slice(0, 300) };
  }
  let data;
  try { data = JSON.parse(text); } catch {
    return { ok: false, reason: 'vision-non-json', body: text.slice(0, 300) };
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
      };
    }
  } else if (Array.isArray(data.content)) {
    outText = data.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
  } else if (data.choices?.[0]?.message?.content) {
    outText = String(data.choices[0].message.content);
  } else {
    outText = text;
  }
  if (/Unsupported Image/i.test(outText) || /Image not provided/i.test(outText)) {
    return { ok: false, reason: 'vision-image-unsupported', body: outText.slice(0, 300) };
  }
  const start = outText.indexOf('{');
  const end = outText.lastIndexOf('}');
  if (start < 0) {
    return { ok: false, reason: 'vision-no-json', body: outText.slice(0, 300) };
  }
  const jsonText = end > start ? outText.slice(start, end + 1) : `${outText.slice(start).trim()}}`;
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch {
    return { ok: false, reason: 'vision-bad-json', body: outText.slice(0, 300) };
  }
  let x = Math.round(pickFirstNumber(parsed, ['x', 'gapX', 'holeX', 'targetX', 'offsetX']));
  let move = Math.round(pickFirstNumber(parsed, ['move', 'distance', 'sliderDistance', 'drag', 'dragX']));
  // Models sometimes put the gap X into "move". Treat oversized move as x.
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
      body: outText.slice(0, 300),
    };
  }
  return {
    ok: true,
    naturalX: hasX ? x : move,
    moveX: hasMove ? move : undefined,
    confidence: coerceNumber(parsed.confidence) || 0.7,
    reason: parsed.reason || '',
    method: 'vision',
    parsed,
  };
}

module.exports = { estimateSliderDistanceWithVision };
