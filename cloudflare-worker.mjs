/* Cloud JARVIS: text conversation only. No local OS permissions or personal files. */
import { createRemoteJWKSet, jwtVerify } from 'jose';

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const MAX_BODY = 16_384;
const MAX_PROMPT = 4_000;
const SYSTEM = 'You are JARVIS, a thoughtful British engineering assistant with restrained dry wit. Address the owner as Sir. Be accurate, concise, helpful and honest about limitations. You are running in Cloudflare Workers AI, not ChatGPT or a local Mac assistant. You have no filesystem, sensor, browsing, or desktop controls. Never claim to have read live system data or completed actions.';

function json(value, status = 200) {
  return Response.json(value, {status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}

async function authorized(request, env) {
  // Fail closed: a public Worker must never exhaust the owner's free AI allocation.
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD || !env.OWNER_EMAIL) return false;
  let url;
  try { url = new URL(env.TEAM_DOMAIN); } catch { return false; }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com') || url.pathname !== '/' || url.search || url.hash) return false;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16_384) return false;
  try {
    const keys=createRemoteJWKSet(new URL('/cdn-cgi/access/certs',url));
    const {payload}=await jwtVerify(token,keys,{issuer:url.origin,audience:env.POLICY_AUD,algorithms:['RS256']});
    return typeof payload.email==='string' && payload.email.toLowerCase()===env.OWNER_EMAIL.trim().toLowerCase();
  } catch { return false; }
}

function validHistory(history) {
  if (!Array.isArray(history) || history.length>12) return false;
  return history.every(entry => entry && typeof entry==='object' &&
    (entry.role==='user'||entry.role==='assistant') &&
    typeof entry.content==='string' && entry.content.length<=MAX_PROMPT);
}

async function boundedBody(request) {
  const claimed=request.headers.get('content-length');
  if (claimed!==null && (!Number.isSafeInteger(Number(claimed))||Number(claimed)>MAX_BODY)) throw new RangeError('Request exceeds 16 KiB.');
  if (!request.body) return '';
  const reader=request.body.getReader();
  const chunks=[];let total=0;
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    total+=value.byteLength;
    if(total>MAX_BODY){await reader.cancel();throw new RangeError('Request exceeds 16 KiB.');}
    chunks.push(value);
  }
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!await authorized(request,env)) return json({error:'Cloudflare Access authorization required. Configure a protected Worker and sign in.'},403);
    if (path==='/api/health' && request.method==='GET') return json({status:'ok',model:MODEL});
    if (path==='/api/status' && request.method==='GET') return json({busy:false,model:MODEL,development:{enabled:false,proposals:[],extensions:[]},settings:null});
    if (path!=='/api/chat'||request.method!=='POST') return json({error:'This hosted endpoint does not implement local computer commands.'},404);
    if(!env.AI) return json({error:'Workers AI binding is not configured.'},503);
    const type=request.headers.get('content-type')||'';
    if(!type.toLowerCase().startsWith('application/json')) return json({error:'Send JSON.'},415);
    let data;
    try {data=JSON.parse(await boundedBody(request));}
    catch(error){return json({error:error instanceof RangeError?'Request exceeds 16 KiB.':'Invalid JSON.'},error instanceof RangeError?413:400);}
    const prompt=data && typeof data.prompt==='string'?data.prompt.trim():'';
    const history=data?.history ?? [];
    if(!prompt||prompt.length>MAX_PROMPT||!validHistory(history)) return json({error:'Provide a prompt of at most 4,000 characters and at most 12 valid history messages.'},400);
    try {
      const result=await env.AI.run(MODEL,{messages:[{role:'system',content:SYSTEM},...history,{role:'user',content:prompt}],temperature:.42,max_tokens:520});
      const reply=typeof result?.response==='string' ? result.response.trim() : '';
      if(!reply) throw new Error('Empty model answer');
      return json({status:'complete',reply});
    } catch(error) {
      console.error(JSON.stringify({event:'ai_error',type:error instanceof Error?error.name:'Unknown'}));
      return json({error:'AI inference is unavailable or its daily free allocation is exhausted. Try again later.'},503);
    }
  }
};
