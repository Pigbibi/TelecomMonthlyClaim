// Shared policy mirrored in FranchiseLeadWorkflows and TelecomMonthlyClaim.
// Only explicit model retirement permits switching; no retries for quota/auth/5xx.
const PROBE_IMAGE = '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';
const cache = new Map();
function retired(status, text) {
  return [400, 404, 410].includes(status) && /model/i.test(text)
    && /not found|no longer|not supported|not available|retired|deprecated/i.test(text);
}
async function bodyText(response) {
  return response.text ? response.text() : JSON.stringify(await response.json());
}
async function withModelRecovery(call, { key, model, timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('model_recovery_budget_exhausted');
    return value;
  };
  const cacheKey = `${key}\0${model}`;
  const selected = cache.get(cacheKey) || model;
  const original = await call(selected, remaining());
  if (original.ok) return original;
  const text = await bodyText(original);
  const preserved = () => new Response(text, { status: original.status });
  if (!retired(original.status, text)) return preserved();
  const root = 'https://generativelanguage.googleapis.com/v1beta/models';
  const headers = { 'x-goog-api-key': key, 'content-type': 'application/json' };
  const list = await fetch(`${root}?pageSize=100`, { headers, signal: AbortSignal.timeout(Math.min(8000,remaining())) });
  if (!list.ok) return list;
  const names = (await list.json()).models?.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => n !== selected && /^gemini-(?:\d+(?:\.\d+)*-flash-lite|flash-lite-latest)$/.test(n)) || [];
  names.sort((a,b) => (b === 'gemini-flash-lite-latest') - (a === 'gemini-flash-lite-latest') || b.localeCompare(a, undefined, {numeric:true}));
  const body = {contents:[{parts:[{text:'Read the arithmetic image. Return only the numerical result.'},
    {inline_data:{mime_type:'image/png',data:PROBE_IMAGE}}]}]};
  for (const candidate of names.slice(0,2)) {
    const probe = await fetch(`${root}/${candidate}:generateContent`, {
      method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(Math.min(8000,remaining())),
    });
    if (!probe.ok) {
      const text = await bodyText(probe);
      if (retired(probe.status,text)) continue;
      return new Response(text,{status:probe.status});
    }
    const data = await probe.json();
    const text = (data.candidates || []).flatMap(c => c.content?.parts || []).map(p => p.text || '').join('').trim();
    if (text !== '25') continue;
    const result = await call(candidate,remaining());
    if (result.ok) cache.set(cacheKey,candidate);
    return result;
  }
  return preserved();
}
module.exports = { withModelRecovery, retired, PROBE_IMAGE };
