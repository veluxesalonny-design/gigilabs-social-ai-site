import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { exactBase } from './exact.js';
import { prepareLive } from './prepare.js';
import { baseRpc as rpc, latestBaseBlock, RPC_POLICY, rpcHealth, sanitizeRpcError } from './rpc.js';

const VERSION='Flash Edge V9.4.3';
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const APPROVED_RUNTIME='0x370c586265de600f83c972751bc334e493b07fe33ee100f84fb710763d732cad';
const MASTER_SIZES=[1000,2500,5000,10000,25000,50000,75000,100000,150000,200000,250000];
const ASSETS=[
  {symbol:'WETH',address:'0x4200000000000000000000000000000000000006'},
  {symbol:'cbBTC',address:'0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'},
  {symbol:'cbETH',address:'0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22'},
  {symbol:'AERO',address:'0x940181a94A35A4569E4529A3CDfB74e38FD98631'},
  {symbol:'DAI',address:'0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'},
  {symbol:'USDbC',address:'0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA'},
  {symbol:'EURC',address:'0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42'}
];
const RX=parseAbi(['function owner() view returns(address)','function paused() view returns(bool)','function maxBorrowRaw() view returns(uint256)']);
let screenCache={at:0,pairs:null};
const scanCache=new Map(),scanInflight=new Map();

function jsonSafe(data){return JSON.parse(JSON.stringify(data,(_k,v)=>typeof v==='bigint'?v.toString():v))}
function ok(res,data,status=200){res.status(status).json(jsonSafe(data))}
function fail(res,err,status=500){const s=sanitizeRpcError(err),rpc=String(err?.code||'').startsWith('RPC_');res.status(status).json({ok:false,error:rpc?s.code:'ENGINE_ERROR',message:rpc?s.message:String(err?.message||err).slice(0,220),retryAfterMs:rpc?s.retryAfterMs||0:0,rpcHealth:rpc?rpcHealth():undefined})}
function norm(x){return String(x||'').toLowerCase()}
function validAddress(x){return /^0x[0-9a-fA-F]{40}$/.test(String(x||''))}
function dexName(x){x=norm(x);return x.includes('aerodrome')?'Aerodrome':x.includes('uniswap')?'Uniswap':x.includes('sushi')?'Sushi':null}
function routeKey(r){return [r.assetSymbol,norm(r.buyPair||r.buyMeta?.pair),norm(r.sellPair||r.sellMeta?.pair)].join(':')}
function unsupportedReason(env){const s=String(env?.exact?.reason||'');return env?.stage==='UNAVAILABLE'&&/factory unsupported|unsupported .*pool|pool mismatch|token mismatch/i.test(s)?s:''}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i)}catch{out[i]=null}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));return out}

async function latestBlock(){return Number(BigInt(await latestBaseBlock()))}
async function fetchScreenPairs(){
  if(screenCache.pairs&&Date.now()-screenCache.at<5500)return screenCache.pairs;
  const sets=await mapLimit(ASSETS,2,async asset=>{
    const c=new AbortController(),t=setTimeout(()=>c.abort(),3500);
    try{const r=await fetch('https://api.dexscreener.com/token-pairs/v1/base/'+asset.address,{headers:{accept:'application/json'},signal:c.signal});if(!r.ok)throw Error('screen feed HTTP '+r.status);const a=await r.json();return Array.isArray(a)?a:[]}finally{clearTimeout(t)}
  });
  const dedup=new Map();for(const arr of sets.filter(Boolean))for(const p of arr||[]){const k=[norm(p?.dexId),norm(p?.pairAddress)].join(':');if(p?.pairAddress&&!dedup.has(k))dedup.set(k,p)}
  const pairs=[...dedup.values()];if(pairs.length)screenCache={at:Date.now(),pairs};else if(screenCache.pairs)return screenCache.pairs;return pairs;
}
function orientPair(p,asset){
  if(!p?.pairAddress||norm(p.chainId)!=='base'||!dexName(p.dexId))return null;
  const liq=Number(p?.liquidity?.usd||0);if(!(liq>=75000))return null;
  const ba=norm(p.baseToken?.address),qa=norm(p.quoteToken?.address),aa=norm(asset.address),u=norm(USDC);let px=0;
  if(ba===aa&&qa===u)px=Number(p.priceUsd);else if(ba===u&&qa===aa){const baseUsd=Number(p.priceUsd),native=Number(p.priceNative);if(baseUsd>0&&native>0)px=baseUsd/native}else return null;
  if(!(px>0))return null;return{assetSymbol:asset.symbol,assetAddress:asset.address,pair:p.pairAddress,dex:dexName(p.dexId),px,liq};
}
function modelNet(buyPx,sellPx,size,liq){const gross=size*(sellPx/buyPx-1),flash=size*.0005,impact=size*Math.min(.008,(size/Math.max(liq,1))*.35),gas=.75;return{gross,flash,impact,gas,net:gross-flash-impact-gas}}
function buildScreenRoutes(pairs,cap){
  const routes=[];
  for(const asset of ASSETS){
    const pools=pairs.map(p=>orientPair(p,asset)).filter(Boolean);
    for(const buy of pools)for(const sell of pools){
      if(norm(buy.pair)===norm(sell.pair)||sell.px<=buy.px)continue;
      const spreadBps=(sell.px/buy.px-1)*10000;if(spreadBps<3)continue;
      const liq=Math.min(buy.liq,sell.liq),max=Math.min(250000,cap,Math.max(0,liq*.01));if(max<1000)continue;
      const ladder=[...new Set([...MASTER_SIZES.filter(x=>x<=max),Math.round(max/100)*100].filter(x=>x>=1000&&x<=max))].sort((a,b)=>a-b);if(!ladder.length)continue;
      const scored=ladder.map(size=>({size,...modelNet(buy.px,sell.px,size,liq)})).sort((a,b)=>b.net-a.net),best=scored[0];if(!best||best.net<-12)continue;
      routes.push({id:[asset.symbol,norm(buy.pair),norm(sell.pair)].join(':'),k:'base',chain:'Base',chainId:8453,assetSymbol:asset.symbol,assetAddress:asset.address,quoteSymbol:'USDC',quoteAddress:USDC,buyDex:buy.dex,sellDex:sell.dex,bd:buy.dex,sd:sell.dex,buyPair:buy.pair,sellPair:sell.pair,sameDex:buy.dex===sell.dex,spreadBps,liquidityUsd:liq,maxBorrowUsd:max,borrowUsd:best.size,b:best.size,optimalBorrow:best.size,screenNet:best.net,screenGross:best.gross,sizeCandidates:scored.slice(0,3).map(x=>x.size),testedSizes:scored.map(x=>({borrowUsd:x.size,screenNet:x.net}))});
    }
  }
  const dedup=new Map();for(const r of routes){const k=routeKey(r),p=dedup.get(k);if(!p||r.screenNet>p.screenNet)dedup.set(k,r)}return[...dedup.values()].sort((a,b)=>b.screenNet-a.screenNet);
}
async function exactRoute(route,budget){
  const sizes=(route.sizeCandidates||[route.borrowUsd]).slice(0,budget),tests=[];
  for(const size of sizes){const env=await exactBase({...route,optimalBorrow:size,borrowUsd:size,b:size,gas:.75});tests.push({...env,_size:size});if(env?.retryAfterMs>0)break}
  const ranked=tests.slice().sort((a,b)=>(b.exact?.netAfterGas??-Infinity)-(a.exact?.netAfterGas??-Infinity)),best=ranked.find(x=>x.stage==='EXACT_PASS'&&x.exact?.status==='PASS')||ranked[0]||{stage:'UNAVAILABLE',exact:{status:'BLOCKED',reason:'no exact result'}};
  return{...best,proofSource:'server',selectedBorrowUsd:best._size,exactAt:best.exactAt||Date.now(),testedSizes:tests.map(x=>({borrowUsd:x._size,stage:x.stage,netAfterGas:x.exact?.netAfterGas??null})),retryAfterMs:best.retryAfterMs||0};
}
async function scanFresh(cap,blockNumber){
  const started=Date.now(),pairs=await fetchScreenPairs(),allRoutes=buildScreenRoutes(pairs,cap),searchRoutes=allRoutes.slice(0,48),exactById=new Map(),blockedPairs=new Set();let exactChecks=0,exactRoutes=0,rpcBackoffMs=0;
  for(const r of searchRoutes){
    if(exactChecks>=10||exactRoutes>=5||rpcBackoffMs>0)break;
    const bk=norm(r.buyPair),sk=norm(r.sellPair);if(blockedPairs.has(bk)||blockedPairs.has(sk))continue;
    const e=await exactRoute(r,Math.min(2,10-exactChecks));exactById.set(r.id,e);exactChecks+=e?.testedSizes?.length||0;exactRoutes++;rpcBackoffMs=Math.max(rpcBackoffMs,Number(e?.retryAfterMs)||0);
    const reason=unsupportedReason(e);if(reason){if(/SERVER BUY/i.test(reason))blockedPairs.add(bk);else if(/SERVER SELL/i.test(reason))blockedPairs.add(sk);else{blockedPairs.add(bk);blockedPairs.add(sk)}}
  }
  const suppressedUnsupported=searchRoutes.filter(r=>blockedPairs.has(norm(r.buyPair))||blockedPairs.has(norm(r.sellPair))).length;
  const displayRoutes=searchRoutes.filter(r=>!blockedPairs.has(norm(r.buyPair))&&!blockedPairs.has(norm(r.sellPair))).slice(0,12);
  let candidates=displayRoutes.map(r=>{const e=exactById.get(r.id)||{stage:'SCREEN_ONLY',proofSource:'screen',exact:{status:'BLOCKED',reason:rpcBackoffMs?'RPC cooldown active; exact deferred':'exact budget reserved for higher-ranked supported routes this block'},retryAfterMs:rpcBackoffMs},selected=Number(e.selectedBorrowUsd||r.borrowUsd);return{...r,blockNumber,borrowUsd:selected,b:selected,optimalBorrow:selected,exactEnvelope:e}});
  candidates.sort((a,b)=>{const ap=a.exactEnvelope?.stage==='EXACT_PASS'?1:0,bp=b.exactEnvelope?.stage==='EXACT_PASS'?1:0;if(bp!==ap)return bp-ap;const an=a.exactEnvelope?.exact?.netAfterGas??-Infinity,bn=b.exactEnvelope?.exact?.netAfterGas??-Infinity;if(bn!==an)return bn-an;return b.screenNet-a.screenNet});
  const exactPasses=candidates.filter(c=>c.exactEnvelope?.stage==='EXACT_PASS'&&c.exactEnvelope?.exact?.status==='PASS').length;
  return{ok:true,engine:VERSION,mode:'cached broad screen → bounded local exact → live prepare',rpcPolicy:RPC_POLICY,rpcHealth:rpcHealth(),blockNumber,latencyMs:Date.now()-started,assets:ASSETS.length,venues:3,searchCapUsd:cap,screenPairs:pairs.length,screenRouteCount:allRoutes.length,searchDepth:searchRoutes.length,candidateCount:candidates.length,sameDexCandidates:candidates.filter(c=>c.sameDex).length,exactRoutes,exactChecks,suppressedUnsupported,exactPasses,retryAfterMs:rpcBackoffMs,candidates};
}
async function scan(cap){
  const blockNumber=await latestBlock(),key=blockNumber+':'+cap,cached=scanCache.get(key);if(cached&&Date.now()-cached.at<3500)return{...cached.value,cacheHit:true};
  if(scanInflight.has(key))return scanInflight.get(key);
  const p=scanFresh(cap,blockNumber).then(value=>{scanCache.clear();scanCache.set(key,{at:Date.now(),value});return value}).finally(()=>scanInflight.delete(key));scanInflight.set(key,p);return p;
}
async function receiverCheck(receiver,owner){
  if(!validAddress(receiver)||!validAddress(owner))throw Error('invalid receiver or owner');const code=await rpc('eth_getCode',[receiver,'latest']);if(!code||code==='0x')throw Error('no receiver bytecode');const hash='0x'+createHash('sha256').update(String(code).toLowerCase()).digest('hex');if(norm(hash)!==norm(APPROVED_RUNTIME))throw Error('receiver runtime mismatch');
  async function read(fn){const data=encodeFunctionData({abi:RX,functionName:fn}),out=await rpc('eth_call',[{to:receiver,data},'latest']);return decodeFunctionResult({abi:RX,functionName:fn,data:out})}
  const chainOwner=await read('owner'),paused=await read('paused'),cap=await read('maxBorrowRaw');if(norm(chainOwner)!==norm(owner))throw Error('owner mismatch');return{ok:true,owner:chainOwner,paused:Boolean(paused),capUsd:Number(cap)/1e6,runtimeHash:hash,rpcPolicy:RPC_POLICY};
}
export default async function handler(req,res){
  try{
    const action=String(req.query?.action||req.body?.action||'health');
    if(action==='health')return ok(res,{ok:true,engine:VERSION,mode:'cached broad screen → bounded local exact → live prepare',rpcPolicy:RPC_POLICY,rpcHealth:rpcHealth(),assets:ASSETS.length,maxSearchUsd:250000});
    if(action==='block')return ok(res,{ok:true,blockNumber:await latestBlock(),serverTime:Date.now(),rpcPolicy:RPC_POLICY,rpcHealth:rpcHealth()});
    if(action==='scan')return ok(res,await scan(Math.min(250000,Math.max(1000,Number(req.body?.cap)||250000))));
    if(action==='receiver')return ok(res,await receiverCheck(String(req.body?.receiver||''),String(req.body?.owner||'')));
    if(action==='prepare'){const c=req.body?.candidate,env=c?.exactEnvelope;if(env?.stage!=='EXACT_PASS'||env?.exact?.status!=='PASS')return fail(res,new Error('fresh EXACT_PASS required'),409);const route={...c,chainKey:'base',optimalBorrow:Number(env.selectedBorrowUsd||c.borrowUsd||c.b)};return ok(res,await prepareLive({route,receiver:String(req.body?.receiver||''),from:String(req.body?.from||'')}))}
    if(action==='rpc'){const method=String(req.body?.method||''),allowed=new Set(['eth_getBalance','eth_getTransactionCount','eth_estimateGas','eth_gasPrice','eth_sendRawTransaction','eth_getTransactionReceipt','eth_chainId']);if(!allowed.has(method))return fail(res,new Error('RPC method blocked'),403);return ok(res,{ok:true,result:await rpc(method,Array.isArray(req.body?.params)?req.body.params:[],4200,{noDedupe:method==='eth_sendRawTransaction',cache:false})})}
    return fail(res,new Error('unknown action'),404);
  }catch(e){const s=sanitizeRpcError(e);console.error('v943-engine',s.code,s.message);return fail(res,e,503)}
}
