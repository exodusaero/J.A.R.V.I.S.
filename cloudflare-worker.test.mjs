import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import handler from './cloudflare-worker.mjs';

const origin='https://jarvis.example.workers.dev';
const domain='https://example-team.cloudflareaccess.com';
const audience='jarvis-audience';
const environment={TEAM_DOMAIN:domain,POLICY_AUD:audience,OWNER_EMAIL:'sir@example.com',AI:{
  async run(_name,payload){return {response:'Systems nominal, Sir.',inputCount:payload.messages.length};}
},ASSETS:{fetch:async()=>new Response('static',{status:200})}};

const request=(path,method='GET',body,token='')=>new Request(origin+path,{
  method,headers:{...(body?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))}:{}),
    ...(token?{'Cf-Access-Jwt-Assertion':token}:{})},body
});

test('public callers cannot access an AI or status endpoint',async()=>{
  const blocked=await handler.fetch(request('/api/health'),environment);
  assert.equal(blocked.status,403);
  assert.equal((await blocked.json()).error.includes('Access'),true);
  const fake=await handler.fetch(request('/api/chat','POST',JSON.stringify({prompt:'hi'}),'not.a.jwt'),environment);
  assert.equal(fake.status,403);
  assert.equal((await handler.fetch(request('/api/health'),{...environment,TEAM_DOMAIN:''})).status,403);
});

test('static assets forward to asset binding without AI requests',async()=>{
  const result=await handler.fetch(request('/hud.js'),environment);
  assert.equal(result.status,200);
  assert.equal(await result.text(),'static');
});

test('a signed Access JWT permits bounded AI chat; invalid requests are rejected',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwk=await exportJWK(publicKey);jwk.kid='jarvis-k1';jwk.alg='RS256';jwk.use='sig';
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async resource=>{
    assert.equal(String(resource),domain+'/cdn-cgi/access/certs');
    return Response.json({keys:[jwk]});
  };
  try {
    const token=await new SignJWT({email:'sir@example.com'})
      .setProtectedHeader({alg:'RS256',kid:'jarvis-k1'})
      .setIssuer(domain).setAudience(audience)
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const health=await handler.fetch(request('/api/health','GET',undefined,token),environment);
    assert.equal(health.status,200);
    const wrongOwner=await handler.fetch(request('/api/health','GET',undefined,token),{...environment,OWNER_EMAIL:'someone-else@example.com'});
    assert.equal(wrongOwner.status,403);
    const chat=await handler.fetch(request('/api/chat','POST',JSON.stringify({prompt:'Hi Jarvis',history:[]}),token),environment);
    assert.equal(chat.status,200);
    assert.deepEqual(await chat.json(),{status:'complete',reply:'Systems nominal, Sir.'});
    const invalid=await handler.fetch(request('/api/chat','POST',JSON.stringify({prompt:' ',history:[]}),token),environment);
    assert.equal(invalid.status,400);
    const unknown=await handler.fetch(request('/api/files','GET',undefined,token),environment);
    assert.equal(unknown.status,404);
  } finally {globalThis.fetch=previousFetch;}
});
