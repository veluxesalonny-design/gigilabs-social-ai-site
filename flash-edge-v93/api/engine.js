import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { exactBase } from './exact.js';
import { prepareLive } from './prepare.js';

const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNI_FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const UNI_QUOTER='0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const AERO_FACTORY='0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef';
const AERO_QUOTER='0x514c8B5f54112481E28028F1166Bd78501089259';
const SUSHI_ROUTER='0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891';
const APPROVED_RUNTIME='0x370c586265de600f83c972751bc334e493b07fe33ee100f84fb710763d732cad';
const ZERO='0x0000000000000000000000000000000000000000';
const RPCS=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.llamarpc.com'];
const RPC_LABEL='PublicNode + Base public + LlamaRPC (1RPC removed)';
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

const UF=parseAbi(['function getPool(address tokenA,address tokenB,uint24 fee) view returns(address pool)']);
const UQ=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const AF=parseAbi(['function getPool(address tokenA,address tokenB,int24 tickSpacing) view returns(address pool)']);
const AQ=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const SR=parseAbi(['function factory() view returns(address)','function getAmountsOut(uint256 amountIn,address[] path) view returns(uint256[] amounts)']);
const VF=parseAbi(['function getPair(address tokenA,address tokenB) view returns(address pair)']);
const RX=parseAbi(['function owner() view returns(address)','function paused() view returns(bool)','function maxBorrowRaw() view returns(uint256)']);

let sushiFactory;
let rpcCursor=0;
const metaCache=new Map();

function ok(res,data,status=200){res.status(status).json(data)}
function fail(res,message,status=500){res.status(status).json({ok:false,error:String(message)})}
function validAddress(x){return /^0x[0-9a-fA-F]{40}$/.test(String(x||''))}
function blockHex(n){return '0x'+n.toString(16)}
function norm(x){return String(x||'').toLowerCase()}
function routeKey(r){return [r.assetSymbol,norm(r.buyMeta?.pair),norm(r.sellMeta?.pair)].join(':')}
function sizeKey(r){return routeKey(r)+':'+Number(r.borrowUsd)}

async function rpc(method,params=[]){
  let last='Base RPC unavailable';
  const start=rpcCursor++%RPCS.length;
  for(let i=0;i<RPCS.length;i++){
    const url=RPCS[(start+i)%RPCS.length];
    const c=new AbortController();
    const t=setTimeout(()=>c.abort(),3600);
    try{
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:c.signal});
      const j=await r.json();
      if(r.ok&&!j.error&&j.result!==undefined)return j.result;
      last=j.error?.message||`HTTP ${r.status}`;
    }catch(e){last=e?.message||String(e)}finally{clearTimeout(t)}
  }
  throw Error(last);
}
async function call(to,data,block='latest'){return rpc('eth_call',[{to,data},block])}
async function latestBlock(){return Number(BigInt(await rpc('eth_blockNumber',[])))}
async function getSushiFactory(block){
  if(sushiFactory)return sushiFactory;
  const out=await call(SUSHI_ROUTER,encodeFunctionData({abi:SR,functionName:'factory'}),block);
  sushiFactory=decodeFunctionResult({abi:SR,functionName:'factory',data:out});
  return sushiFactory;
}

async function metasFor(asset,block){
  const cached=metaCache.get(asset.symbol);
  if(cached&&Date.now()-cached.at<900000)return cached.value;
  const [uni,aero,sushi]=await Promise.all([
    Promise.all([100,500,3000,10000].map(async fee=>{
      try{
        const out=await call(UNI_FACTORY,encodeFunctionData({abi:UF,functionName:'getPool',args:[USDC,asset.address,fee]}),block);
        const pair=decodeFunctionResult({abi:UF,functionName:'getPool',data:out});
        return norm(pair)===ZERO?null:{venue:'Uniswap',pair,fee};
      }catch{return null}
    })),
    Promise.all([1,10,50,100,200].map(async tickSpacing=>{
      try{
        const out=await call(AERO_FACTORY,encodeFunctionData({abi:AF,functionName:'getPool',args:[USDC,asset.address,tickSpacing]}),block);
        const pair=decodeFunctionResult({abi:AF,functionName:'getPool',data:out});
        return norm(pair)===ZERO?null:{venue:'Aerodrome',pair,tickSpacing};
      }catch{return null}
    })),
    (async()=>{
      try{
        const fac=await getSushiFactory(block);
        const out=await call(fac,encodeFunctionData({abi:VF,functionName:'getPair',args:[USDC,asset.address]}),block);
        const pair=decodeFunctionResult({abi:VF,functionName:'getPair',data:out});
        return norm(pair)===ZERO?[]:[{venue:'Sushi',pair}];
      }catch{return []}
    })()
  ]);
  const value={Uniswap:uni.filter(Boolean),Aerodrome:aero.filter(Boolean),Sushi:sushi};
  metaCache.set(asset.symbol,{at:Date.now(),value});
  return value;
}

function flattenMetas(metas){return [...(metas.Uniswap||[]),...(metas.Aerodrome||[]),...(metas.Sushi||[])]}
async function quoteOne(meta,tokenIn,tokenOut,amountIn,block){
  if(meta.venue==='Uniswap'){
    const out=await call(UNI_QUOTER,encodeFunctionData({abi:UQ,functionName:'quoteExactInputSingle',args:[{tokenIn,tokenOut,amountIn,fee:meta.fee,sqrtPriceLimitX96:0n}]}),block);
    return BigInt(decodeFunctionResult({abi:UQ,functionName:'quoteExactInputSingle',data:out})[0]);
  }
  if(meta.venue==='Aerodrome'){
    const out=await call(AERO_QUOTER,encodeFunctionData({abi:AQ,functionName:'quoteExactInputSingle',args:[{tokenIn,tokenOut,amountIn,tickSpacing:meta.tickSpacing,sqrtPriceLimitX96:0n}]}),block);
    return BigInt(decodeFunctionResult({abi:AQ,functionName:'quoteExactInputSingle',data:out})[0]);
  }
  const out=await call(SUSHI_ROUTER,encodeFunctionData({abi:SR,functionName:'getAmountsOut',args:[amountIn,[tokenIn,tokenOut]]}),block);
  const a=decodeFunctionResult({abi:SR,functionName:'getAmountsOut',data:out});
  return BigInt(a[a.length-1]||0n);
}

async function safeQuote(meta,tokenIn,tokenOut,amountIn,block){
  try{
    const out=await quoteOne(meta,tokenIn,tokenOut,amountIn,block);
    return out>0n?{meta,out}:null;
  }catch{return null}
}

async function discoverAssetRoutes(asset,metas,blockNumber){
  const all=flattenMetas(metas);
  if(all.length<2)return [];
  const block=blockHex(blockNumber);
  const anchorUsd=1000;
  const anchorRaw=1000n*1000000n;
  const buys=(await Promise.all(all.map(meta=>safeQuote(meta,USDC,asset.address,anchorRaw,block)))).filter(Boolean).sort((a,b)=>a.out>b.out?-1:a.out<b.out?1:0).slice(0,3);
  const routes=[];
  for(const buy of buys){
    const sells=(await Promise.all(all.filter(meta=>norm(meta.pair)!==norm(buy.meta.pair)).map(meta=>safeQuote(meta,asset.address,USDC,buy.out,block)))).filter(Boolean).sort((a,b)=>a.out>b.out?-1:a.out<b.out?1:0).slice(0,3);
    for(const sell of sells){
      const returned=Number(sell.out)/1e6;
      const anchorNet=returned-anchorUsd-anchorUsd*.0005-.75;
      if(anchorNet<-6)continue;
      routes.push({assetSymbol:asset.symbol,assetAddress:asset.address,buyDex:buy.meta.venue,sellDex:sell.meta.venue,buyMeta:buy.meta,sellMeta:sell.meta,anchorNet,sameDex:buy.meta.venue===sell.meta.venue});
    }
  }
  const dedup=new Map();
  for(const r of routes){const k=routeKey(r),p=dedup.get(k);if(!p||r.anchorNet>p.anchorNet)dedup.set(k,r)}
  return [...dedup.values()];
}

function coarseSizes(cap){
  const raw=[1000,Math.min(10000,cap),Math.min(50000,cap),Math.min(150000,cap),cap];
  return [...new Set(raw.filter(x=>x>=1000&&x<=cap).map(x=>Math.round(x)))].sort((a,b)=>a-b);
}
function adaptiveSizes(best,cap){
  const ladder=[...new Set([...MASTER_SIZES.filter(x=>x<=cap),cap])].sort((a,b)=>a-b);
  let nearest=0;
  for(let i=1;i<ladder.length;i++)if(Math.abs(ladder[i]-best)<Math.abs(ladder[nearest]-best))nearest=i;
  const out=[];
  for(let i=Math.max(0,nearest-2);i<=Math.min(ladder.length-1,nearest+2);i++)out.push(ladder[i]);
  for(const x of [best*.75,best*.875,best*1.125,best*1.25]){
    const v=Math.round(Math.max(1000,Math.min(cap,x))/100)*100;
    if(v>=1000&&v<=cap)out.push(v);
  }
  return [...new Set(out)].sort((a,b)=>a-b);
}

async function evaluateRoute(route,borrowUsd,blockNumber){
  const block=blockHex(blockNumber);
  const amountIn=BigInt(Math.round(borrowUsd*1e6));
  const buyOut=await quoteOne(route.buyMeta,USDC,route.assetAddress,amountIn,block);
  if(buyOut<=0n)throw Error('zero buy quote');
  const sellOut=await quoteOne(route.sellMeta,route.assetAddress,USDC,buyOut,block);
  if(sellOut<=0n)throw Error('zero sell quote');
  const returned=Number(sellOut)/1e6;
  const screenNet=returned-borrowUsd-borrowUsd*.0005-.75;
  const spreadBps=(returned/borrowUsd-1)*10000;
  return {
    id:routeKey(route),k:'base',chain:'Base',chainId:8453,blockNumber,
    assetSymbol:route.assetSymbol,assetAddress:route.assetAddress,
    quoteSymbol:'USDC',quoteAddress:USDC,
    buyDex:route.buyDex,sellDex:route.sellDex,bd:route.buyDex,sd:route.sellDex,
    buyPair:route.buyMeta.pair,sellPair:route.sellMeta.pair,
    buyMeta:route.buyMeta,sellMeta:route.sellMeta,sameDex:route.sameDex,
    borrowUsd,b:borrowUsd,optimalBorrow:borrowUsd,screenNet,spreadBps,gas:.75
  };
}

async function evaluateSafe(route,size,blockNumber){try{return await evaluateRoute(route,size,blockNumber)}catch{return null}}

async function scan(cap){
  const started=Date.now();
  const blockNumber=await latestBlock();
  const block=blockHex(blockNumber);
  const assetMetas=await Promise.all(ASSETS.map(async a=>[a,await metasFor(a,block)]));
  const discovered=(await Promise.all(assetMetas.map(([asset,metas])=>discoverAssetRoutes(asset,metas,blockNumber)))).flat().sort((a,b)=>b.anchorNet-a.anchorNet).slice(0,18);
  const coarse=coarseSizes(cap);
  const evaluated=(await Promise.all(discovered.flatMap(route=>coarse.map(size=>evaluateSafe(route,size,blockNumber))))).filter(Boolean);
  const bestByRoute=new Map();
  for(const c of evaluated){const k=routeKey(c),p=bestByRoute.get(k);if(!p||c.screenNet>p.screenNet)bestByRoute.set(k,c)}
  const topRoutes=[...bestByRoute.values()].sort((a,b)=>b.screenNet-a.screenNet).slice(0,6);
  const sourceByKey=new Map(discovered.map(r=>[routeKey(r),r]));
  const refinements=[];
  for(const best of topRoutes){
    const source=sourceByKey.get(routeKey(best));
    if(!source)continue;
    const already=new Set(coarse);
    for(const size of adaptiveSizes(best.borrowUsd,cap))if(!already.has(size))refinements.push(evaluateSafe(source,size,blockNumber));
  }
  const refined=(await Promise.all(refinements)).filter(Boolean);
  const all=[...evaluated,...refined];
  const grouped=new Map();
  const sizesByRoute=new Map();
  for(const c of all){
    const k=routeKey(c);
    const arr=sizesByRoute.get(k)||[];
    arr.push({borrowUsd:c.borrowUsd,net:c.screenNet});
    sizesByRoute.set(k,arr);
    const p=grouped.get(k);
    if(!p||c.screenNet>p.screenNet)grouped.set(k,c);
  }
  let candidates=[...grouped.values()].map(c=>({...c,testedSizes:(sizesByRoute.get(routeKey(c))||[]).sort((a,b)=>a.borrowUsd-b.borrowUsd)})).sort((a,b)=>b.screenNet-a.screenNet).slice(0,14);
  const exactTargets=candidates.filter(c=>c.screenNet>-3).slice(0,6);
  await Promise.all(exactTargets.map(async c=>{c.exactEnvelope=await exactBase(c)}));
  candidates.sort((a,b)=>(b.exactEnvelope?.exact?.netAfterGas??-999999)-(a.exactEnvelope?.exact?.netAfterGas??-999999)||b.screenNet-a.screenNet);
  return {
    ok:true,engine:'Flash Edge V9.4',mode:'new-block high-cap adaptive on-chain + local exact/prepare',
    rpcPolicy:RPC_LABEL,blockNumber,latencyMs:Date.now()-started,
    assets:ASSETS.length,venues:3,searchCapUsd:cap,coarseSizes:coarse,
    discoveredRoutes:discovered.length,candidateCount:candidates.length,
    sameDexCandidates:candidates.filter(c=>c.sameDex).length,
    exactPasses:candidates.filter(c=>c.exactEnvelope?.stage==='EXACT_PASS'&&c.exactEnvelope?.exact?.status==='PASS').length,
    candidates
  };
}

async function receiverCheck(receiver,owner){
  if(!validAddress(receiver)||!validAddress(owner))throw Error('invalid receiver or owner');
  const code=await rpc('eth_getCode',[receiver,'latest']);
  if(!code||code==='0x')throw Error('no receiver bytecode');
  const hash='0x'+createHash('sha256').update(String(code).toLowerCase()).digest('hex');
  if(norm(hash)!==norm(APPROVED_RUNTIME))throw Error('receiver runtime mismatch');
  async function read(fn){const data=encodeFunctionData({abi:RX,functionName:fn}),out=await call(receiver,data,'latest');return decodeFunctionResult({abi:RX,functionName:fn,data:out})}
  const [chainOwner,paused,borrowCap]=await Promise.all([read('owner'),read('paused'),read('maxBorrowRaw')]);
  if(norm(chainOwner)!==norm(owner))throw Error('owner mismatch');
  return{ok:true,owner:chainOwner,paused:Boolean(paused),capUsd:Number(borrowCap)/1e6,runtimeHash:hash};
}

export default async function handler(req,res){
  try{
    const action=String(req.query?.action||req.body?.action||'health');
    if(action==='health')return ok(res,{ok:true,engine:'Flash Edge V9.4',mode:'new-block high-cap adaptive on-chain + local exact/prepare',rpcPolicy:RPC_LABEL,assets:ASSETS.length,maxSearchUsd:250000});
    if(action==='block')return ok(res,{ok:true,blockNumber:await latestBlock(),serverTime:Date.now(),rpcPolicy:RPC_LABEL});
    if(action==='scan'){
      const requested=Number(req.body?.cap??req.query?.cap??10000);
      const cap=Math.min(250000,Math.max(1000,Number.isFinite(requested)?requested:10000));
      return ok(res,await scan(cap));
    }
    if(action==='receiver')return ok(res,await receiverCheck(String(req.body?.receiver||''),String(req.body?.owner||'')));
    if(action==='prepare'){
      const c=req.body?.candidate,env=c?.exactEnvelope;
      if(env?.stage!=='EXACT_PASS'||env?.exact?.status!=='PASS')return fail(res,'fresh EXACT_PASS required',409);
      const route={...c,chainKey:'base',optimalBorrow:Number(c.borrowUsd||c.b)};
      return ok(res,await prepareLive({route,receiver:String(req.body?.receiver||''),from:String(req.body?.from||'')}));
    }
    if(action==='rpc'){
      const method=String(req.body?.method||'');
      const allowed=new Set(['eth_getBalance','eth_getTransactionCount','eth_estimateGas','eth_gasPrice','eth_sendRawTransaction','eth_getTransactionReceipt','eth_chainId']);
      if(!allowed.has(method))return fail(res,'RPC method blocked',403);
      return ok(res,{ok:true,result:await rpc(method,Array.isArray(req.body?.params)?req.body.params:[])});
    }
    return fail(res,'unknown action',404);
  }catch(e){console.error('v94-engine',e);return fail(res,e?.message||String(e),503)}
}
