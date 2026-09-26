// Manual synthetic Gemini verification; no portal or user data.
const {withModelRecovery,PROBE_IMAGE}=require('../src/gemini-model-policy.cjs');
const key=process.env.GEMINI_API_KEY;
const model=process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const body={contents:[{parts:[{text:'Read the arithmetic image. Return only the numerical result.'},{inline_data:{mime_type:'image/png',data:PROBE_IMAGE}}]}]};
async function invoke(selected,remaining){
 return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${selected}:generateContent`,{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(remaining)});
}
async function valid(response){if(!response.ok){console.log(`status=http_${response.status}`);return false;}const d=await response.json();return (d.candidates||[]).flatMap(c=>c.content?.parts||[]).map(p=>p.text||'').join('').trim()==='25';}
(async()=>{
 if(!key){console.log('status=missing_key');process.exitCode=1;return;}
 const normal=await valid(await withModelRecovery(invoke,{key,model}));
 const recovery=await valid(await withModelRecovery((selected,remaining)=>selected==='synthetic-retired'?Promise.resolve(Response.json({error:{message:'model retired'}},{status:404})):invoke(selected,remaining),{key,model:'synthetic-retired'}));
 console.log(`synthetic_match=${normal}`);console.log(`simulated_retirement_recovered=${recovery}`);
 process.exitCode=normal&&recovery?0:1;
})().catch(()=>{console.log('status=request_failed');process.exitCode=1;});
