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
async function estimateSliderDistanceWithVision({ bgPngBase64, blockPngBase64, imageWidth = 280, correctY = null }) {
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

  const prompt = [
    `这是北京电信滑块验证码。背景图宽 ${imageWidth} 像素。`,
    correctY != null ? `缺口大致纵坐标 correctY=${correctY}。` : '',
    '请找出拼图缺口左边缘的水平像素坐标 X（整数，约 40-220）。',
    '只输出 JSON：{"x":number,"confidence":number,"reason":string}',
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
    const parsed = new URL(url);
    if (!parsed.searchParams.has('key')) parsed.searchParams.set('key', key);
    requestUrl = parsed.toString();
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
  const x = Math.round(Number(parsed.x));
  if (!Number.isFinite(x) || x < 40 || x > imageWidth - 40) {
    return { ok: false, reason: 'vision-x-out-of-range', parsed };
  }
  return {
    ok: true,
    naturalX: x,
    confidence: Number(parsed.confidence) || 0,
    reason: parsed.reason || '',
    method: 'vision',
  };
}

module.exports = { estimateSliderDistanceWithVision };
