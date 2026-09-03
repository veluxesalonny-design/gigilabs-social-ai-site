const PROVIDERS=[
  {label:'Base public',url:'https://mainnet.base.org'},
  {label:'PublicNode',url:'https://base-rpc.publicnode.com'}
];

export const RPC_POLICY='Base public primary → PublicNode failover · sequential · cooldown · LlamaRPC/1RPC removed';
const states=PROVIDERS.map(p=>({...p,fails:0,cooldownUntil:0,lastError:null}));
const inflight=new Map();
const cache=new Map();

function prune(){
  const now=Date.now();
  if(cache.size>600)for(const[k,v]of cache)if(v.until<=now)cache.delete(k);
  if(cache.size>900){let n=0;for(const k of cache.keys()){cache.delete(k);if(++n>300)break}}
}
function safeText(x){
  let s=String(x??'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  if(!s)return 'provider error';
  if(/cloudflare|just a moment|challenge-platform|cf-chl|doctype html/i.test(s))return 'provider returned an HTML/Cloudflare challenge';
  return s.slice(0,180);
}
function classify(status,text,contentType=''){
  const raw=String(text||''),html=/text\/html/i.test(contentType)||/^\s*</.test(raw)||/cloudflare|just a moment|challenge-platform|cf-chl/i.test(raw);
  if(html)return{code:'RPC_PROVIDER_HTML',message:'RPC provider returned an HTML/Cloudflare challenge',cooldown:300000};
  if(status===429||/rate|limit|too many|over rate|quota|1200rqs/i.test(raw))return{code:'RPC_RATE_LIMIT',message:'RPC provider rate limit reached',cooldown:120000};
  if(status>=500)return{code:'RPC_PROVIDER_5XX',message:'RPC provider temporarily unavailable',cooldown:30000};
  return{code:'RPC_PROVIDER_ERROR',message:safeText(raw),cooldown:10000};
}
function cacheTtl(method,params){
  if(method==='eth_chainId')return 60000;
  if(method==='eth_blockNumber')return 1100;
  if(method==='eth_getCode')return 15000;
  if(method==='eth_call'){
    const block=params?.[1];
    if(typeof block==='string'&&block.startsWith('0x'))return 30000;
  }
  return 0;
}
function keyFor(method,params){try{return method+'|'+JSON.stringify(params)}catch{return method}}
function makeError(code,message,retryAfterMs=0,provider=''){
  const e=new Error(message);e.code=code;e.retryAfterMs=retryAfterMs;e.provider=provider;return e;
}
export function sanitizeRpcError(err){
  const code=String(err?.code||'RPC_ERROR');
  const retryAfterMs=Math.max(0,Number(err?.retryAfterMs)||0);
  let message=safeText(err?.message||err);
  if(code==='RPC_PROVIDER_HTML')message='RPC provider challenge detected; failover/cooldown active';
  else if(code==='RPC_RATE_LIMIT')message='RPC rate limit detected; failover/cooldown active';
  else if(code==='RPC_COOLDOWN')message='RPC providers are cooling down; retry shortly';
  else if(code==='RPC_ALL_UNAVAILABLE')message='Base RPC providers temporarily unavailable';
  else if(/html|doctype|cloudflare|just a moment/i.test(message))message='RPC provider challenge detected; failover/cooldown active';
  return{code,message,retryAfterMs};
}
async function perform(method,params,timeout){
  const now=Date.now();
  const live=states.filter(s=>s.cooldownUntil<=now);
  if(!live.length){
    const retry=Math.max(1000,Math.min(...states.map(s=>s.cooldownUntil-now).filter(x=>x>0))||5000);
    throw makeError('RPC_COOLDOWN','RPC providers are cooling down',retry);
  }
  let last=null;
  for(const s of states){
    if(s.cooldownUntil>Date.now())continue;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const r=await fetch(s.url,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:controller.signal});
      const type=r.headers.get('content-type')||'';
      const text=await r.text();
      if(/text\/html/i.test(type)||/^\s*</.test(text)){
        const c=classify(r.status,text,type);s.fails++;s.lastError=c.code;s.cooldownUntil=Date.now()+c.cooldown;last=makeError(c.code,c.message,c.cooldown,s.label);continue;
      }
      let d;try{d=JSON.parse(text)}catch{const c=classify(r.status,text,type);s.fails++;s.lastError=c.code;s.cooldownUntil=Date.now()+c.cooldown;last=makeError(c.code,c.message,c.cooldown,s.label);continue}
      if(r.ok&&!d.error&&d.result!==undefined&&d.result!==null){s.fails=0;s.lastError=null;s.cooldownUntil=0;return d.result}
      const msg=d?.error?.message||`HTTP ${r.status}`;const c=classify(r.status,msg,type);s.fails++;s.lastError=c.code;s.cooldownUntil=Date.now()+Math.min(300000,c.cooldown*Math.max(1,s.fails));last=makeError(c.code,c.message,s.cooldownUntil-Date.now(),s.label);
    }catch(err){
      const aborted=err?.name==='AbortError';const code=aborted?'RPC_TIMEOUT':'RPC_NETWORK';const cool=aborted?15000:10000;s.fails++;s.lastError=code;s.cooldownUntil=Date.now()+Math.min(120000,cool*Math.max(1,s.fails));last=makeError(code,aborted?'RPC request timed out':'RPC network request failed',s.cooldownUntil-Date.now(),s.label);
    }finally{clearTimeout(timer)}
  }
  if(last){last.code='RPC_ALL_UNAVAILABLE';last.message='Base RPC providers temporarily unavailable';last.retryAfterMs=Math.max(3000,Math.min(...states.map(s=>Math.max(0,s.cooldownUntil-Date.now())).filter(Boolean))||5000);throw last}
  throw makeError('RPC_ALL_UNAVAILABLE','Base RPC providers temporarily unavailable',5000);
}
export async function baseRpc(method,params=[],timeout=4200,options={}){
  const key=keyFor(method,params),ttl=options.cache===false?0:cacheTtl(method,params),now=Date.now();
  if(ttl){const hit=cache.get(key);if(hit&&hit.until>now)return hit.value}
  if(!options.noDedupe&&inflight.has(key))return inflight.get(key);
  const p=perform(method,params,timeout).then(v=>{if(ttl){cache.set(key,{value:v,until:Date.now()+ttl});prune()}return v}).finally(()=>inflight.delete(key));
  if(!options.noDedupe)inflight.set(key,p);
  return p;
}
export async function latestBaseBlock(){return baseRpc('eth_blockNumber',[],3500)}
export function rpcHealth(){const now=Date.now();return states.map(s=>({label:s.label,state:s.cooldownUntil>now?'COOLDOWN':'READY',retryAfterMs:Math.max(0,s.cooldownUntil-now),lastError:s.lastError}))}