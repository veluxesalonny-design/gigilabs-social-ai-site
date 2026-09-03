import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { exactBase } from './exact.js';
import { prepareLive } from './prepare.js';

const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const APPROVED_RUNTIME='0x370c586265de600f83c972751bc334e493b07fe33ee100f84fb710763d732cad';
const RPCS=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.llamarpc.com'];
const RPC_LABEL='PublicNode + Base public + LlamaRPC · cooldown/failover · 1RPC removed';
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
const STABLES=new Set(['USDC','USDBC','USDC.E']);
const RX=parseAbi(['function owner() view returns(address)','function paused() view returns(bool)','function maxBorrowRaw() view returns(uint256)']);

let rpcCursor=0;
const rpcState=RPCS.map(()=>({coolUntil:0,failures:0}));
let blockCache={at:0,value:0};
const discoveryCache=new Map();
const scanCache=new Map();
const scanInflight=new Map();

function ok(res,data,status=200){res.status(status).json(data)}
function fail(res,message,status=500){res.status(status).json({ok:false,error:String(message)})}
function validAddress(x){return /^0x[0-9a-fA-F]{40}$/.test(String(x||''))}
function norm(x){return String(x||'').toLowerCase()}
function routeKey(r){return [r.assetSymbol,norm(r.buyPair),norm(r.sellPair)].join(':')}
function dexName(id){id=norm(id);return id.includes('aerodrome')?'Aerodrome':id.includes('uniswap')?'Uniswap':id.includes('sushi')?'Sushi':null}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function minThreshold(size){return Math.max(10,Number(size)*.0005)}

async function rpc(method,params=[]){
  let last='Base RPC unavailable';
  const now=Date.now(),start=rpcCursor++%RPCS.length;
  let tried=0;
  for(let pass=0;pass<2;pass++){
    for(let i=0;i<RPCS.length;i++){
      const idx=(start+i)%RPCS.length,state=rpcState[idx];
      if(pass===0&&state.coolUntil>now)continue;
      const url=RPCS[idx],c=new AbortController(),t=setTimeout(()=>c.abort(),4200);
      tried++;
      try{
        const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:c.signal});
        const text=await r.text();
        let j=null;
        try{j=JSON.parse(text)}catch{}
        if(r.ok&&j&&!j.error&&j.result!==undefined){state.failures=0;state.coolUntil=0;return j.result}
        const msg=j?.error?.message||text.slice(0,180)||`HTTP ${r.status}`;
        last=msg;
        state.failures++;
        if(r.status===429||/rate limit|over rate|usage limit|forbidden|too many|<!doctype|<html/i.test(msg))state.coolUntil=Date.now()+Math.min(60000,12000*state.failures);
      }catch(e){last=e?.message||String(e);state.failures++;state.coolUntil=Date.now()+Math.min(30000,5000*state.failures)}finally{clearTimeout(t)}
    }
    if(tried===0)await sleep(120);
  }
  throw Error(last);
}
async function call(to,data,block='latest'){return rpc('eth_call',[{to,data},block])}
async function latestBlock(force=false){
  if(!force&&blockCache.value&&Date.now()-blockCache.at<700)return blockCache.value;
  const value=Number(BigInt(await rpc('eth_blockNumber',[])));
  blockCache={at:Date.now(),value};
  return value;
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let next=0;
  async function worker(){while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i)}catch{out[i]=null}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));return out;
}

async function dexPairs(asset){
  const cached=discoveryCache.get(asset.symbol);
  if(cached&&Date.now()-cached.at<2500)return cached.value;
  const c=new AbortController(),t=setTimeout(()=>c.abort(),3500);
  try{
    const r=await fetch('https://api.dexscreener.com/token-pairs/v1/base/'+asset.address,{signal:c.signal,headers:{accept:'application/json'}});
    if(!r.ok)throw Error('DEX discovery '+r.status);
    const raw=await r.json(),value=(Array.isArray(raw)?raw:[]).map(x=>orientPair(x,asset)).filter(Boolean);
    discoveryCache.set(asset.symbol,{at:Date.now(),value});return value;
  }finally{clearTimeout(t)}
}
function orientPair(x,asset){
  if(!x?.pairAddress||!validAddress(x.pairAddress)||!(Number(x?.liquidity?.usd)>0))return null;
  const dex=dexName(x.dexId);if(!dex)return null;
  const ba=norm(x.baseToken?.address),qa=norm(x.quoteToken?.address),aa=norm(asset.address),usdc=norm(USDC);
  let px=0;
  if(ba===aa&&qa===usdc)px=Number(x.priceUsd);
  else if(qa===aa&&ba===usdc){const baseUsd=Number(x.priceUsd),native=Number(x.priceNative);if(baseUsd>0&&native>0)px=baseUsd/native}
  else return null;
  if(!(px>0))return null;
  return{pair:x.pairAddress,dex,px,liq:Number(x.liquidity.usd)};
}
function modelNet(buyPx,sellPx,size,liq){
  const gross=size*(sellPx/buyPx-1),flash=size*.0005,impact=size*Math.min(.015,(size/Math.max(liq,1))*.55),gas=.75;
  return{net:gross-flash-impact-gas,gross,flash,impact,gas};
}
function bestModel(route,cap){
  const max=Math.min(250000,cap,Math.max(1000,route.liq*.02));
  const sizes=[...new Set([...MASTER_SIZES.filter(x=>x<=max),Math.round(max)])].filter(x=>x>=1000&&x<=max);
  const curve=sizes.map(size=>({borrowUsd:size,...modelNet(route.buyPx,route.sellPx,size,route.liq)})).sort((a,b)=>b.net-a.net);
  return{best:curve[0],curve};
}
async function discoverRoutes(cap){
  const pairSets=(await mapLimit(ASSETS,3,async asset=>({asset,pairs:await dexPairs(asset)}))).filter(Boolean);
  const routes=[];
  for(const {asset,pairs} of pairSets){
    const p=pairs.filter(x=>x.liq>=50000);
    for(const buy of p)for(const sell of p){
      if(norm(buy.pair)===norm(sell.pair)||sell.px<=buy.px)continue;
      const spreadBps=(sell.px/buy.px-1)*10000;if(spreadBps<2)continue;
      const liq=Math.min(buy.liq,sell.liq),base={assetSymbol:asset.symbol,assetAddress:asset.address,buyDex:buy.dex,sellDex:sell.dex,buyPair:buy.pair,sellPair:sell.pair,buyPx:buy.px,sellPx:sell.px,liq,sameDex:buy.dex===sell.dex,spreadBps};
      const m=bestModel(base,cap);if(!m.best)continue;
      routes.push({...base,model:m.best,modelCurve:m.curve});
    }
  }
  const dedup=new Map();
  for(const r of routes){const k=routeKey(r),p=dedup.get(k);if(!p||r.model.net>p.model.net)dedup.set(k,r)}
  return [...dedup.values()].sort((a,b)=>b.model.net-a.model.net).slice(0,18);
}
function candidateFromRoute(r,blockNumber){
  const b=r.model.borrowUsd;
  return{id:routeKey(r),k:'base',chain:'Base',chainId:8453,blockNumber,assetSymbol:r.assetSymbol,assetAddress:r.assetAddress,quoteSymbol:'USDC',quoteAddress:USDC,buyDex:r.buyDex,sellDex:r.sellDex,bd:r.buyDex,sd:r.sellDex,buyPair:r.buyPair,sellPair:r.sellPair,sameDex:r.sameDex,borrowUsd:b,b,optimalBorrow:b,screenNet:r.model.net,spreadBps:r.spreadBps,gas:.75,testedSizes:r.modelCurve.map(x=>({borrowUsd:x.borrowUsd,net:x.net}))};
}
async function exactCandidate(c,curve){
  let best=await exactBase(c);
  if(best?.stage==='EXACT_PASS')return best;
  const n=Number(best?.exact?.netAfterGas);
  if(Number.isFinite(n)&&n>-2){
    const alt=curve.filter(x=>x.borrowUsd!==c.borrowUsd).sort((a,b)=>b.net-a.net)[0];
    if(alt){const test={...c,borrowUsd:alt.borrowUsd,b:alt.borrowUsd,optimalBorrow:alt.borrowUsd};const second=await exactBase(test);if((second?.exact?.netAfterGas??-Infinity)>(best?.exact?.netAfterGas??-Infinity)){c.borrowUsd=alt.borrowUsd;c.b=alt.borrowUsd;c.optimalBorrow=alt.borrowUsd;best=second}}
  }
  return best;
}
async function scan(cap){
  const started=Date.now(),blockNumber=await latestBlock(true),key=blockNumber+':'+cap;
  const cached=scanCache.get(key);if(cached&&Date.now()-cached.at<3000)return{...cached.value,cached:true};
  if(scanInflight.has(key))return scanInflight.get(key);
  const job=(async()=>{
    const routes=await discoverRoutes(cap);
    let candidates=routes.slice(0,14).map(r=>candidateFromRoute(r,blockNumber));
    const routeById=new Map(routes.map(r=>[routeKey(r),r]));
    const targets=candidates.filter(c=>c.screenNet>minThreshold(c.borrowUsd)+2).slice(0,4);
    await mapLimit(targets,1,async c=>{c.exactEnvelope=await exactCandidate(c,routeById.get(c.id)?.modelCurve||[]);return c});
    candidates.sort((a,b)=>(b.exactEnvelope?.exact?.netAfterGas??-999999)-(a.exactEnvelope?.exact?.netAfterGas??-999999)||b.screenNet-a.screenNet);
    const value={ok:true,engine:'Flash Edge V9.4.1',mode:'hybrid low-RPC discovery + adaptive $250K model + local exact/prepare',rpcPolicy:RPC_LABEL,blockNumber,latencyMs:Date.now()-started,assets:ASSETS.length,venues:3,searchCapUsd:cap,discoveredRoutes:routes.length,candidateCount:candidates.length,sameDexCandidates:candidates.filter(c=>c.sameDex).length,exactChecks:targets.length,exactPasses:candidates.filter(c=>c.exactEnvelope?.stage==='EXACT_PASS'&&c.exactEnvelope?.exact?.status==='PASS').length,candidates};
    scanCache.set(key,{at:Date.now(),value});
    for(const [k,v] of scanCache)if(Date.now()-v.at>10000)scanCache.delete(k);
    return value;
  })();
  scanInflight.set(key,job);try{return await job}finally{scanInflight.delete(key)}
}

async function receiverCheck(receiver,owner){
  if(!validAddress(receiver)||!validAddress(owner))throw Error('invalid receiver or owner');
  const code=await rpc('eth_getCode',[receiver,'latest']);if(!code||code==='0x')throw Error('no receiver bytecode');
  const hash='0x'+createHash('sha256').update(String(code).toLowerCase()).digest('hex');if(norm(hash)!==norm(APPROVED_RUNTIME))throw Error('receiver runtime mismatch');
  async function read(fn){const data=encodeFunctionData({abi:RX,functionName:fn}),out=await call(receiver,data,'latest');return decodeFunctionResult({abi:RX,functionName:fn,data:out})}
  const [chainOwner,paused,borrowCap]=await Promise.all([read('owner'),read('paused'),read('maxBorrowRaw')]);if(norm(chainOwner)!==norm(owner))throw Error('owner mismatch');
  return{ok:true,owner:chainOwner,paused:Boolean(paused),capUsd:Number(borrowCap)/1e6,runtimeHash:hash};
}

export default async function handler(req,res){
  try{
    const action=String(req.query?.action||req.body?.action||'health');
    if(action==='health')return ok(res,{ok:true,engine:'Flash Edge V9.4.1',mode:'hybrid low-RPC discovery + adaptive sizing + local exact/prepare',rpcPolicy:RPC_LABEL,assets:ASSETS.length,maxSearchUsd:250000});
    if(action==='block')return ok(res,{ok:true,blockNumber:await latestBlock(),serverTime:Date.now(),rpcPolicy:RPC_LABEL});
    if(action==='scan'){const requested=Number(req.body?.cap??req.query?.cap??10000),cap=Math.min(250000,Math.max(1000,Number.isFinite(requested)?requested:10000));return ok(res,await scan(cap))}
    if(action==='receiver')return ok(res,await receiverCheck(String(req.body?.receiver||''),String(req.body?.owner||'')));
    if(action==='prepare'){
      const c=req.body?.candidate,env=c?.exactEnvelope;if(env?.stage!=='EXACT_PASS'||env?.exact?.status!=='PASS')return fail(res,'fresh EXACT_PASS required',409);
      const route={...c,chainKey:'base',optimalBorrow:Number(c.borrowUsd||c.b)};return ok(res,await prepareLive({route,receiver:String(req.body?.receiver||''),from:String(req.body?.from||'')}));
    }
    if(action==='rpc'){
      const method=String(req.body?.method||''),allowed=new Set(['eth_getBalance','eth_getTransactionCount','eth_estimateGas','eth_gasPrice','eth_sendRawTransaction','eth_getTransactionReceipt','eth_chainId']);
      if(!allowed.has(method))return fail(res,'RPC method blocked',403);return ok(res,{ok:true,result:await rpc(method,Array.isArray(req.body?.params)?req.body.params:[])});
    }
    return fail(res,'unknown action',404);
  }catch(e){console.error('v94-engine',e);return fail(res,e?.message||String(e),503)}
}
