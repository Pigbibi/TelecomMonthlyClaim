import assert from 'node:assert/strict';
import test from 'node:test';
import { withModelRecovery } from '../src/gemini-model-policy.cjs';

test('retired model is verified before request and cached', async () => {
  const original = globalThis.fetch;
  const paths=[];
  globalThis.fetch=async (url) => {
    paths.push(url);
    if(url.includes('?pageSize'))return Response.json({models:[{name:'models/gemini-flash-lite-latest',supportedGenerationMethods:['generateContent']}]});
    return Response.json({candidates:[{content:{parts:[{text:'25'}]}}]});
  };
  const calls=[];
  const call=async model => {calls.push(model);return model==='old'?Response.json({error:{message:'model no longer available'}},{status:404}):Response.json({ok:true});};
  try {
    assert.equal((await withModelRecovery(call,{key:'synthetic',model:'old'})).ok,true);
    assert.equal((await withModelRecovery(call,{key:'synthetic',model:'old'})).ok,true);
    assert.deepEqual(calls,['old','gemini-flash-lite-latest','gemini-flash-lite-latest']);
    assert.equal(paths.length,2);
  }finally{globalThis.fetch=original;}
});

test('auth quota and server errors do not change model', async () => {
  for(const status of [401,403,429,500,503]) {
    let calls=0;
    const response=await withModelRecovery(async()=>{calls++;return Response.json({error:{message:'model unavailable'}},{status});},{key:'synthetic',model:`old-${status}`});
    assert.equal(response.status,status);assert.equal(calls,1);
  }
});

test('incorrect synthetic result cannot be selected', async () => {
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async url=>url.includes('?pageSize')?Response.json({models:[{name:'models/gemini-99-flash-lite',supportedGenerationMethods:['generateContent']}]}):Response.json({candidates:[{content:{parts:[{text:'incorrect'}]}}]});
  try {
    const response=await withModelRecovery(async()=>{calls++;return Response.json({error:{message:'model retired'}},{status:404});},{key:'synthetic',model:'old-wrong'});
    assert.equal(response.status,404);assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});
