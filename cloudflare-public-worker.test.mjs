import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import handler,{PublicChatQuota} from './cloudflare-public-worker.mjs';

if (!globalThis.crypto) Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});

const hostname='jarvis.example.workers.dev';
const origin=`https://${hostname}`;
let calls=0;
const environment={
  TURNSTILE_SITEKEY:'test-sitekey',TURNSTILE_HOSTNAME:hostname,TURNSTILE_SECRET:'test-secret',
  ASSETS:{fetch:async()=>new Response('asset',{status:200})},
  AI:{async run(_model,payload){calls++;assert.equal(payload.max_tokens,300);return {response:'Good evening, Sir.'};}},
  PUBLIC_CHAT_QUOTA:{getByName:()=>({admit:async()=>({ok:true})})}
};

function req(path,body,ip='198.51.100.10') {
  return new Request(origin+path,{method:body?'POST':'GET',
    headers:{...(body?{'Content-Type':'application/json'}:{}),'CF-Connecting-IP':ip},
    body:body?JSON.stringify(body):undefined});
}

function siteverify(handlerFn) {
  const old=globalThis.fetch;
  globalThis.fetch=async (url,options)=>{
    assert.equal(String(url),'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(options.method,'POST');
    assert.equal(options.body.get('secret'),'test-secret');
    return Response.json(handlerFn(options.body));
  };
  return ()=>{globalThis.fetch=old;};
}

test('public static assets, status, and Turnstile configuration are readable',async()=>{
  assert.equal(await (await handler.fetch(req('/hud.css'),environment)).text(),'asset');
  const config=await (await handler.fetch(req('/api/config'),environment)).json();
  assert.deepEqual(config,{sitekey:'test-sitekey',action:'jarvis_chat',maxPromptChars:2000});
  assert.equal((await handler.fetch(req('/api/health'),environment)).status,200);
  assert.equal((await handler.fetch(req('/api/files'),environment)).status,404);
});

test('chat fails closed when secrets, quotas, or real verification are absent',async()=>{
  const data={prompt:'Hello',turnstileToken:'demo',history:[]};
  assert.equal((await handler.fetch(req('/api/chat',data),{...environment,TURNSTILE_SECRET:''})).status,503);
  assert.equal((await handler.fetch(req('/api/chat',data),{...environment,PUBLIC_CHAT_QUOTA:null})).status,503);
  assert.equal((await handler.fetch(req('/api/chat',data,''),environment)).status,403);
  const restore=siteverify(()=>({success:false}));
  try {
    assert.equal((await handler.fetch(req('/api/chat',data),environment)).status,403);
  } finally {restore();}
});

test('only a validated single-use challenge with expected action and hostname reaches AI',async()=>{
  const seen=new Set();
  const restore=siteverify(body=>{
    const token=body.get('response');
    if(seen.has(token))return {success:false,'error-codes':['timeout-or-duplicate']};
    seen.add(token);
    return {success:true,action:token==='wrong-action'?'other_action':'jarvis_chat',hostname:token==='wrong-host'?'evil.example':hostname};
  });
  try {
    calls=0;
    const data={prompt:'Explain aerospace systems integration.',turnstileToken:'genuine',history:[]};
    const result=await handler.fetch(req('/api/chat',data),environment);
    assert.equal(result.status,200);
    assert.equal((await result.json()).reply,'Good evening, Sir.');
    assert.equal(calls,1);
    assert.equal((await handler.fetch(req('/api/chat',data),environment)).status,403);
    assert.equal((await handler.fetch(req('/api/chat',{...data,turnstileToken:'wrong-action'}),environment)).status,403);
    assert.equal((await handler.fetch(req('/api/chat',{...data,turnstileToken:'wrong-host'}),environment)).status,403);
    assert.equal(calls,1);
  } finally {restore();}
});

test('plain greetings and camera questions never invoke imaginary tools',async()=>{
  const restore=siteverify(()=>({success:true,action:'jarvis_chat',hostname}));
  try {
    calls=0;
    const greeting=await handler.fetch(req('/api/chat',{prompt:'hey',turnstileToken:'t1'}),environment);
    assert.match((await greeting.json()).reply,/At your service/);
    const camera=await handler.fetch(req('/api/chat',{prompt:'which finger am I holding up?',turnstileToken:'t2'}),environment);
    assert.match((await camera.json()).reply,/cannot see your hand/);
    assert.equal(calls,0);
  } finally {restore();}
});

test('bounded input and strict hostname protections reject invalid submissions',async()=>{
  const data={prompt:'hello',turnstileToken:'token',history:[]};
  const badOrigin=new Request('https://other.example/api/chat',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'198.51.100.10'},body:JSON.stringify(data)});
  assert.equal((await handler.fetch(badOrigin,environment)).status,403);
  assert.equal((await handler.fetch(req('/api/chat',{...data,prompt:'z'.repeat(2001)}),environment)).status,400);
  assert.equal((await handler.fetch(req('/api/chat',{...data,history:Array(9).fill({role:'user',content:'x'})}),environment)).status,400);
});

function makeQuota() {
  const rows=new Map();let init;
  const sql={exec(command,...args){
    if(command.startsWith('CREATE'))return {};
    if(command.startsWith('DELETE')){for(const [key,value] of rows)if(value.expires<args[0])rows.delete(key);return {};}
    if(command.startsWith('SELECT')){const row=rows.get(JSON.stringify(args));return {toArray:()=>row?[{used:row.used}]:[]};}
    if(command.startsWith('INSERT')){const key=JSON.stringify(args.slice(0,2));const previous=rows.get(key);rows.set(key,{used:(previous?.used||0)+1,expires:args[2]});return {};}
    throw new Error('Unexpected SQL');
  }};
  const storage={sql,transactionSync:fn=>fn()};
  const ctx={storage,blockConcurrencyWhile:fn=>{init=Promise.resolve().then(fn);}};
  const quota=new PublicChatQuota(ctx,{});
  return {quota,ready:()=>init};
}

test('persistent quota applies hourly, daily, and site-wide admission caps',async()=>{
  const {quota,ready}=makeQuota(); await ready();
  const t=Date.parse('2026-10-28T15:00:00Z');
  const user='a'.repeat(64);
  for(let i=0;i<4;i++)assert.equal((await quota.admit(user,t)).ok,true);
  assert.equal((await quota.admit(user,t)).reason,'visitor_limit');
  for(let hour=1;hour<=2;hour++)for(let i=0;i<4;i++)assert.equal((await quota.admit(user,t+hour*3600000)).ok,true);
  assert.equal((await quota.admit(user,t+3*3600000)).reason,'visitor_limit');
  for(let i=0;i<48;i++)assert.equal((await quota.admit((i+10).toString(16).padStart(64,'0'),t)).ok,true);
  assert.equal((await quota.admit('b'.repeat(64),t)).reason,'site_limit');
});
