/* Public JARVIS: verified, rate-limited cloud chat. No local computer permissions. */
import { DurableObject } from 'cloudflare:workers';

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const MAX_BODY = 12_288;
const MAX_PROMPT = 2_000;
const MAX_HISTORY = 8;
const TURNSTILE_ACTION = 'jarvis_chat';
const DAILY_GLOBAL_LIMIT = 60;
const DAILY_VISITOR_LIMIT = 12;
const HOURLY_VISITOR_LIMIT = 4;
const SYSTEM = 'You are JARVIS, a thoughtful British engineering assistant with restrained dry wit. Address the user as Sir. Be accurate and concise. You are a public website using Cloudflare Workers AI, not ChatGPT. You have no tools, live browsing, camera, microphone, filesystem, sensor readings, or desktop controls. Never claim to have performed actions, inspected source code, or viewed physical surroundings. For a greeting, greet the user naturally. For a vision question, say that you cannot see without an uploaded image and a supported vision feature.';

function json(value, status = 200) {
  return Response.json(value, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}

function validHistory(history) {
  return Array.isArray(history) && history.length <= MAX_HISTORY && history.every(entry =>
    entry && typeof entry === 'object' &&
    (entry.role === 'user' || entry.role === 'assistant') &&
    typeof entry.content === 'string' && entry.content.length <= MAX_PROMPT);
}

function certainReply(prompt) {
  const p = prompt.trim().toLowerCase().replace(/[!.?]+$/g,'').trim();
  if (/^(hi|hey|hello|good (morning|afternoon|evening))$/.test(p)) return 'At your service, Sir. How may I assist?';
  if (/^(what can you see|can you see me|what do you see)$/.test(p)) return 'I can read the messages you send here, Sir. This cloud website cannot see your camera, screen, files, or surroundings.';
  if (/^(which finger am i holding up|how many fingers am i holding up)$/.test(p)) return 'I cannot see your hand, Sir. This cloud website has no camera access.';
  if (/^(do you have access to my camera|can you access my camera|are you watching me)$/.test(p)) return 'No, Sir. This hosted JARVIS cannot access your camera or watch your surroundings.';
  return null;
}

async function boundedBody(request) {
  const claimed = request.headers.get('content-length');
  if (claimed !== null && (!Number.isSafeInteger(Number(claimed)) || Number(claimed) > MAX_BODY)) throw new RangeError('Request too large.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  while (true) {
    const {done,value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { await reader.cancel(); throw new RangeError('Request too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_HOSTNAME || !env.TURNSTILE_SITEKEY ||
      typeof token !== 'string' || token.length < 1 || token.length > 2048) return false;
  const fields = new URLSearchParams({secret:env.TURNSTILE_SECRET,response:token});
  if (ip) fields.set('remoteip',ip);
  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:fields,signal:AbortSignal.timeout(10_000)
    });
    if (!result.ok) return false;
    const validation = await result.json();
    return validation.success === true && validation.action === TURNSTILE_ACTION &&
      validation.hostname === env.TURNSTILE_HOSTNAME;
  } catch { return false; }
}

async function visitorKey(ip, secret, date) {
  // Per-day keyed digest, so raw IP addresses are never retained in quota storage.
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest = await crypto.subtle.sign('HMAC',key,encoder.encode(`${date}:${ip}`));
  return Array.from(new Uint8Array(digest)).map(n=>n.toString(16).padStart(2,'0')).join('');
}

export class PublicChatQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS quota (bucket TEXT NOT NULL, visitor TEXT NOT NULL, used INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(bucket, visitor))');
    });
  }

  async admit(visitor, now = Date.now()) {
    if (typeof visitor !== 'string' || !/^[0-9a-f]{64}$/.test(visitor)) return {ok:false,reason:'invalid'};
    const date = new Date(now).toISOString();
    const day = date.slice(0,10);
    const hour = date.slice(0,13);
    const buckets = [
      {bucket:`D:${day}`,visitor:'global',max:DAILY_GLOBAL_LIMIT,expiry:now+86_400_000},
      {bucket:`D:${day}`,visitor,max:DAILY_VISITOR_LIMIT,expiry:now+86_400_000},
      {bucket:`H:${hour}`,visitor,max:HOURLY_VISITOR_LIMIT,expiry:now+3_600_000}
    ];
    return this.ctx.storage.transactionSync(() => {
      const db = this.ctx.storage.sql;
      db.exec('DELETE FROM quota WHERE expires < ?',now);
      for (const item of buckets) {
        const row = db.exec('SELECT used FROM quota WHERE bucket = ? AND visitor = ?',item.bucket,item.visitor).toArray()[0];
        if (row && row.used >= item.max) return {ok:false,reason:item.visitor==='global'?'site_limit':'visitor_limit'};
      }
      for (const item of buckets) db.exec('INSERT INTO quota (bucket,visitor,used,expires) VALUES (?,?,1,?) ON CONFLICT(bucket,visitor) DO UPDATE SET used=used+1',item.bucket,item.visitor,item.expiry);
      return {ok:true};
    });
  }
}

export default {
  async fetch(request,env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (path === '/api/config' && request.method === 'GET') return json({sitekey:env.TURNSTILE_SITEKEY || null,action:TURNSTILE_ACTION,maxPromptChars:MAX_PROMPT});
    if (path === '/api/health' && request.method === 'GET') return json({status:'ok',model:MODEL});
    if (path === '/api/status' && request.method === 'GET') return json({busy:false,model:MODEL,development:{enabled:false,proposals:[],extensions:[]},settings:null});
    if (path !== '/api/chat' || request.method !== 'POST') return json({error:'This hosted endpoint has no local computer or account tools.'},404);
    if (!env.AI || !env.PUBLIC_CHAT_QUOTA || !env.TURNSTILE_SECRET || !env.TURNSTILE_SITEKEY || !env.TURNSTILE_HOSTNAME) {
      return json({error:'Public chat is not configured yet.'},503);
    }
    if (url.hostname !== env.TURNSTILE_HOSTNAME) return json({error:'Invalid chat hostname.'},403);
    if (!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json')) return json({error:'Send JSON.'},415);
    let data;
    try { data=JSON.parse(await boundedBody(request)); }
    catch (error) { return json({error:error instanceof RangeError?'Request exceeds 12 KiB.':'Invalid JSON.'},error instanceof RangeError?413:400); }
    const prompt = typeof data?.prompt === 'string' ? data.prompt.trim() : '';
    const history = data?.history ?? [];
    if (!prompt || prompt.length > MAX_PROMPT || !validHistory(history)) return json({error:'Invalid prompt or conversation history.'},400);
    const clientIp = request.headers.get('CF-Connecting-IP');
    if (!clientIp) return json({error:'Verified visitor information is required.'},403);
    if (!await verifyTurnstile(data.turnstileToken, clientIp, env)) return json({error:'Verification failed or expired. Please complete a new challenge.'},403);
    try {
      const day = new Date().toISOString().slice(0,10);
      const id = await visitorKey(clientIp,env.TURNSTILE_SECRET,day);
      const allowed = await env.PUBLIC_CHAT_QUOTA.getByName('jarvis-public-quota-v1').admit(id);
      if (!allowed?.ok) return json({error:allowed?.reason === 'site_limit'?'JARVIS has reached its public daily usage limit. Please try tomorrow.':'Your chat allowance is exhausted for now. Please return later.'},429);
    } catch (error) {
      console.error(JSON.stringify({event:'quota_error',type:error instanceof Error?error.name:'Unknown'}));
      return json({error:'The chat usage guard is unavailable. Try again later.'},503);
    }
    const certain = certainReply(prompt);
    if (certain) return json({status:'complete',reply:certain});
    try {
      const result = await env.AI.run(MODEL,{messages:[{role:'system',content:SYSTEM},...history,{role:'user',content:prompt}],temperature:.25,max_tokens:300});
      const reply = typeof result?.response === 'string' ? result.response.trim() : '';
      if (!reply) throw new Error('Empty AI response');
      return json({status:'complete',reply});
    } catch (error) {
      console.error(JSON.stringify({event:'ai_error',type:error instanceof Error?error.name:'Unknown'}));
      return json({error:'AI inference is unavailable or the free allocation is exhausted. Try later.'},503);
    }
  }
};
