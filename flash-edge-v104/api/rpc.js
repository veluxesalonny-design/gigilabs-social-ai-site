const PROVIDERS=[
  {name:'BasePublic',url:'https://mainnet.base.org'},
  {name:'PublicNode',url:'https://base-rpc.publicnode.com'},
  {name:'dRPC',url:'https://base.drpc.org'}
];

export const RPC_POLICY='BasePublic → PublicNode → dRPC · sequential failover · transport cooldown only · contract reverts do not poison providers';
const states=PROVIDERS.map(p=>({...p,failures:0,cooldownUntil:0,lastError:null,lastGoodAt:0}));
const inflight=new Map();
const cache=new Map();

function safeText(x){let s=String(x??'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();if(!s)return'provider error';if(/cloudflare|just a moment|challenge-platform|cf-chl|doctype html/i.test(s))return'provider returned HTML/challenge';return s.slice(0,220)}
function makeError(code,message,retryAfterMs=0,provider=''){const e=new Error(message);e.code=code;e.retryAfterMs=retryAfterMs;e.provider=provider;return e}
function transportClass(status,text,type=''){const raw=String(text||''),html=/text\/html/i.test(type)||/^\s*</.test(raw)||/cloudflare|just a moment|challenge-platform|cf-chl/i.test(raw);if(html)return{code:'RPC_PROVIDER_HTML',message:'RPC provider challenge',cooldown:300000};if(status===429||/rate|limit|too many|quota|capacity exceeded|request limit/i.test(raw))return{code:'RPC_RATE_LIMIT',message:'RPC provider rate limited',cooldown:90000};if(status>=500)return{code:'RPC_PROVIDER_5XX',message:'RPC provider unavailable',cooldown:20000};return null}
function isCallLevelError(message,code){const m=String(message||'');return /execution reverted|revert|invalid opcode|out of gas|insufficient funds|nonce too low|already known|replacement transaction|intrinsic gas|invalid argument|invalid params|method not found/i.test(m)||code===-32601||code===-32602}
function cacheTtl(method,params){if(method==='eth_chainId')return 60000;if(method==='eth_blockNumber')return 900;if(method==='eth_getCode')return 15000;if(method==='eth_call'&&typeof params?.[1]==='string'&&params[1].startsWith('0x'))return 30000;return 0}
function keyFor(method,params){try{return method+'|'+JSON.stringify(params)}catch{return method}}
function prune(){const now=Date.now();for(const[k,v]of cache)if(v.until<=now)cache.delete(k);while(cache.size>800)cache.delete(cache.keys().next().value)}
function cool(s,code,cooldown){s.failures++;s.lastError=code;s.cooldownUntil=Date.now()+Math.min(300000,cooldown*Math.max(1,s.failures))}
function markGood(s){s.failures=0;s.cooldownUntil=0;s.lastError=null;s.lastGoodAt=Date.now()}

export function sanitizeRpcError(err){const code=String(err?.code||'RPC_ERROR'),retryAfterMs=Math.max(0,Number(err?.retryAfterMs)||0);let message=safeText(err?.message||err);if(code==='RPC_COOLDOWN')message='RPC providers cooling down';else if(code==='RPC_ALL_UNAVAILABLE')message='Base RPC providers temporarily unavailable';return{code,message,retryAfterMs}}

async function perform(method,params,timeout){
  const now=Date.now();
  if(!states.some(s=>s.cooldownUntil<=now)){
    const retry=Math.max(500,Math.min(...states.map(s=>s.cooldownUntil-now).filter(x=>x>0))||3000);
    throw makeError('RPC_COOLDOWN','RPC providers cooling down',retry);
  }
  let lastTransport=null,lastResponse=null;
  for(const s of states){
    if(s.cooldownUntil>Date.now())continue;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const r=await fetch(s.url,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:controller.signal});
      const type=r.headers.get('content-type')||'',text=await r.text();
      const transport=transportClass(r.status,text,type);
      if(transport){cool(s,transport.code,transport.cooldown);lastTransport=makeError(transport.code,transport.message,s.cooldownUntil-Date.now(),s.name);continue}
      let d;try{d=JSON.parse(text)}catch{cool(s,'RPC_BAD_JSON',10000);lastTransport=makeError('RPC_BAD_JSON','RPC provider returned invalid JSON',s.cooldownUntil-Date.now(),s.name);continue}
      if(r.ok&&!d?.error&&d?.result!==undefined&&d?.result!==null){markGood(s);return d.result}
      if(d?.error){
        const msg=safeText(d.error.message||'JSON-RPC error'),ec=Number(d.error.code);
        const rate=transportClass(429,msg,type);
        if(rate&&/rate|limit|too many|quota|capacity exceeded|request limit/i.test(msg)){cool(s,'RPC_RATE_LIMIT',90000);lastTransport=makeError('RPC_RATE_LIMIT','RPC provider rate limited',s.cooldownUntil-Date.now(),s.name);continue}
        // A contract/method-level error describes this request, not provider health.
        // Do not cool the endpoint or poison the rest of the scan.
        if(isCallLevelError(msg,ec))throw makeError('RPC_CALL_ERROR',msg,0,s.name);
        lastResponse=makeError('RPC_RESPONSE_ERROR',msg,0,s.name);
        continue;
      }
      lastResponse=makeError('RPC_EMPTY_RESPONSE','RPC provider returned no result',0,s.name);
    }catch(err){
      if(err?.code==='RPC_CALL_ERROR')throw err;
      const aborted=err?.name==='AbortError',code=aborted?'RPC_TIMEOUT':'RPC_NETWORK',baseCool=aborted?10000:7000;
      cool(s,code,baseCool);lastTransport=makeError(code,aborted?'RPC request timed out':'RPC network request failed',s.cooldownUntil-Date.now(),s.name);
    }finally{clearTimeout(timer)}
  }
  if(lastResponse)throw lastResponse;
  if(lastTransport){lastTransport.code='RPC_ALL_UNAVAILABLE';lastTransport.message='Base RPC providers temporarily unavailable';lastTransport.retryAfterMs=Math.max(500,Math.min(...states.map(s=>Math.max(0,s.cooldownUntil-Date.now())).filter(Boolean))||3000);throw lastTransport}
  throw makeError('RPC_ALL_UNAVAILABLE','Base RPC providers temporarily unavailable',3000);
}

export async function baseRpc(method,params=[],timeout=4200,options={}){const key=keyFor(method,params),ttl=options.cache===false?0:cacheTtl(method,params),now=Date.now();if(ttl){const hit=cache.get(key);if(hit&&hit.until>now)return hit.value}if(!options.noDedupe&&inflight.has(key))return inflight.get(key);const p=perform(method,params,timeout).then(v=>{if(ttl){cache.set(key,{value:v,until:Date.now()+ttl});prune()}return v}).finally(()=>inflight.delete(key));if(!options.noDedupe)inflight.set(key,p);return p}
export async function latestBaseBlock(){return baseRpc('eth_blockNumber',[],3500)}
export function rpcHealth(){const now=Date.now();return{lastProvider:states.slice().sort((a,b)=>b.lastGoodAt-a.lastGoodAt)[0]?.name||null,providers:states.map(s=>({name:s.name,cooldownMs:Math.max(0,s.cooldownUntil-now),failures:s.failures,lastGoodAt:s.lastGoodAt,lastError:s.lastError}))}}
