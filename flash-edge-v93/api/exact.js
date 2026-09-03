import { parseAbi, encodeFunctionData, decodeFunctionResult } from 'viem';

const RPCS=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.llamarpc.com'];
const AAVE='0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const UNI_V2_ROUTER='0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
const SUSHI_V2_ROUTER='0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891';
const UNI_V3_FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const UNI_V3_QUOTER='0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const AERO_CLASSIC_FACTORY='0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const AERO_CL_FACTORY='0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef';
const AERO_CL_QUOTER='0x514c8B5f54112481E28028F1166Bd78501089259';
const norm=x=>String(x||'').toLowerCase();
const units=(n,d)=>BigInt(Math.round(Number(n)*1e6))*10n**BigInt(d)/1000000n;
const toNum=(n,d)=>Number(n)/10**d;
const minOut=x=>x*9980n/10000n;

const erc20=parseAbi(['function decimals() view returns(uint8)']);
const pairBase=parseAbi(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)']);
const v2Pair=parseAbi(['function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)']);
const router=parseAbi(['function factory() view returns(address)']);
const v3Pool=parseAbi(['function fee() view returns(uint24)']);
const v3Factory=parseAbi(['function getPool(address,address,uint24) view returns(address)']);
const v3Quoter=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const aeroClassic=parseAbi(['function stable() view returns(bool)','function getAmountOut(uint256 amountIn,address tokenIn) view returns(uint256)']);
const aeroClPool=parseAbi(['function tickSpacing() view returns(int24)']);
const aeroClFactory=parseAbi(['function getPool(address,address,int24) view returns(address)']);
const aeroClQuoter=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const sushiRouter=parseAbi(['function getAmountsOut(uint256,address[]) view returns(uint256[])']);

const providers=RPCS.map(url=>({url,fails:0,cooldownUntil:0}));let rpcCursor=0;
const decimalsCache=new Map(),poolCache=new Map(),routerFactoryCache=new Map();let flashCache={at:0,value:null},headCache={at:0,promise:null};
function rate(status,msg){return status===429||/rate|limit|too many|over rate|quota/i.test(String(msg||''))}
async function rpc(method,params=[],timeout=3600){
  const now=Date.now(),start=rpcCursor++%providers.length;let order=Array.from({length:providers.length},(_,i)=>providers[(start+i)%providers.length]);const live=order.filter(s=>s.cooldownUntil<=now);if(live.length)order=live;else order.sort((a,b)=>a.cooldownUntil-b.cooldownUntil);let last='Base RPC unavailable';
  for(const s of order){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{const r=await fetch(s.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:c.signal});const text=await r.text();let j;try{j=JSON.parse(text)}catch{j={error:{message:text||`HTTP ${r.status}`}}}if(r.ok&&!j.error&&j.result!==undefined){s.fails=0;s.cooldownUntil=0;return j.result}last=j.error?.message||`HTTP ${r.status}`;s.fails++;s.cooldownUntil=Date.now()+(rate(r.status,last)?Math.min(90000,15000*s.fails):Math.min(10000,1500*s.fails))}catch(e){last=e?.message||String(e);s.fails++;s.cooldownUntil=Date.now()+Math.min(10000,1500*s.fails)}finally{clearTimeout(t)}}throw Error(last)
}
async function call(block,to,abi,functionName,args=[]){const data=encodeFunctionData({abi,functionName,args}),out=await rpc('eth_call',[{to,data},block]);return decodeFunctionResult({abi,functionName,data:out})}
async function head(){if(headCache.promise&&Date.now()-headCache.at<600)return headCache.promise;headCache={at:Date.now(),promise:rpc('eth_blockNumber',[])};return headCache.promise}
async function decimals(token,block){const k=norm(token),c=decimalsCache.get(k);if(c&&Date.now()-c.at<3600000)return c.value;const v=Number(await call(block,token,erc20,'decimals'));decimalsCache.set(k,{at:Date.now(),value:v});return v}
async function flashFee(block){if(flashCache.value!=null&&Date.now()-flashCache.at<60000)return flashCache.value;const v=Number(BigInt(await rpc('eth_call',[{to:AAVE,data:'0x074b2e43'},block])));flashCache={at:Date.now(),value:v};return v}
async function routerFactory(addr,block){const k=norm(addr),c=routerFactoryCache.get(k);if(c)return c;const v=await call(block,addr,router,'factory');routerFactoryCache.set(k,v);return v}
function tokensMatch(t0,t1,tin,tout){return(norm(t0)===norm(tin)&&norm(t1)===norm(tout))||(norm(t0)===norm(tout)&&norm(t1)===norm(tin))}

async function poolMeta(block,dex,pair,tin,tout){
  const key=[dex,norm(pair),norm(tin),norm(tout)].join(':');const cached=poolCache.get(key);if(cached&&Date.now()-cached.at<3600000)return cached.value;
  const[t0,t1,factory]=await Promise.all([call(block,pair,pairBase,'token0'),call(block,pair,pairBase,'token1'),call(block,pair,pairBase,'factory')]);if(!tokensMatch(t0,t1,tin,tout))throw Error(dex+' token mismatch');
  let meta;
  if(dex==='Uniswap'){
    const uv2=await routerFactory(UNI_V2_ROUTER,block);
    if(norm(factory)===norm(uv2))meta={kind:'V2',venue:0,pair,factory,t0,t1,fee:0,tickSpacing:0,stable:false};
    else if(norm(factory)===norm(UNI_V3_FACTORY)){
      const fee=Number(await call(block,pair,v3Pool,'fee'));if(![100,500,3000,10000].includes(fee))throw Error('unsupported Uniswap fee');const canonical=await call(block,UNI_V3_FACTORY,v3Factory,'getPool',[tin,tout,fee]);if(norm(canonical)!==norm(pair))throw Error('Uniswap V3 pool mismatch');meta={kind:'V3',venue:0,pair,factory,t0,t1,fee,tickSpacing:0,stable:false};
    } else throw Error('Uniswap factory unsupported');
  }else if(dex==='Sushi'){
    const sf=await routerFactory(SUSHI_V2_ROUTER,block);if(norm(factory)!==norm(sf))throw Error('Sushi factory mismatch');meta={kind:'V2',venue:1,pair,factory,t0,t1,fee:0,tickSpacing:0,stable:false};
  }else if(dex==='Aerodrome'){
    if(norm(factory)===norm(AERO_CLASSIC_FACTORY)){const stable=Boolean(await call(block,pair,aeroClassic,'stable'));meta={kind:'AERO_V2',venue:0,pair,factory,t0,t1,fee:0,tickSpacing:0,stable}}
    else if(norm(factory)===norm(AERO_CL_FACTORY)){const tickSpacing=Number(await call(block,pair,aeroClPool,'tickSpacing'));if(!Number.isFinite(tickSpacing)||tickSpacing<=0)throw Error('invalid Aerodrome tick spacing');const canonical=await call(block,AERO_CL_FACTORY,aeroClFactory,'getPool',[tin,tout,tickSpacing]);if(norm(canonical)!==norm(pair))throw Error('Aerodrome CL pool mismatch');meta={kind:'AERO_CL',venue:0,pair,factory,t0,t1,fee:0,tickSpacing,stable:false}}
    else throw Error('Aerodrome factory unsupported');
  }else throw Error('unsupported venue');
  poolCache.set(key,{at:Date.now(),value:meta});return meta;
}
async function quoteMeta(block,meta,tin,tout,amountIn){
  let out=0n;
  if(meta.kind==='V2'){
    if(meta.venue===1){const amounts=await call(block,SUSHI_V2_ROUTER,sushiRouter,'getAmountsOut',[amountIn,[tin,tout]]);out=BigInt(amounts[amounts.length-1]||0n)}
    else{const rs=await call(block,meta.pair,v2Pair,'getReserves'),r0=BigInt(rs[0]),r1=BigInt(rs[1]),ri=norm(tin)===norm(meta.t0)?r0:r1,ro=norm(tin)===norm(meta.t0)?r1:r0,awf=amountIn*997n;out=awf*ro/(ri*1000n+awf)}
  }else if(meta.kind==='V3'){const q=await call(block,UNI_V3_QUOTER,v3Quoter,'quoteExactInputSingle',[{tokenIn:tin,tokenOut:tout,amountIn,fee:meta.fee,sqrtPriceLimitX96:0n}]);out=BigInt(q[0])}
  else if(meta.kind==='AERO_V2')out=BigInt(await call(block,meta.pair,aeroClassic,'getAmountOut',[amountIn,tin]));
  else if(meta.kind==='AERO_CL'){const q=await call(block,AERO_CL_QUOTER,aeroClQuoter,'quoteExactInputSingle',[{tokenIn:tin,tokenOut:tout,amountIn,tickSpacing:meta.tickSpacing,sqrtPriceLimitX96:0n}]);out=BigInt(q[0])}
  if(out<=0n)throw Error('zero '+meta.kind+' quote');return{...meta,out,minOut:minOut(out)};
}
async function quoteLeg(block,dex,pair,tin,tout,amountIn){const meta=await poolMeta(block,dex,pair,tin,tout);return quoteMeta(block,meta,tin,tout,amountIn)}

export async function exactBase(o){
  let phase='HEAD';
  try{
    const block=await head();phase='META';
    const[flashFeeBps,quoteDecimals,assetDecimals]=await Promise.all([flashFee(block),decimals(o.quoteAddress,block),decimals(o.assetAddress,block)]);
    if(quoteDecimals<0||quoteDecimals>36||assetDecimals<0||assetDecimals>36)throw Error('invalid token decimals');
    const borrowUsd=Number(o.optimalBorrow||o.borrowUsd||o.b);if(!Number.isFinite(borrowUsd)||borrowUsd<=0)throw Error('invalid borrow');const borrowRaw=units(borrowUsd,quoteDecimals);
    phase='BUY';const buy=await quoteLeg(block,o.buyDex,o.buyPair,o.quoteAddress,o.assetAddress,borrowRaw);
    phase='SELL';const sell=await quoteLeg(block,o.sellDex,o.sellPair,o.assetAddress,o.quoteAddress,buy.out);
    const roundTrip=toNum(sell.out,quoteDecimals),flash=toNum(borrowRaw*BigInt(Math.max(0,Math.round(flashFeeBps)))/10000n,quoteDecimals),gasUsd=Math.max(.01,Number(o.gas)||.75),netBeforeGas=roundTrip-borrowUsd-flash,netAfterGas=netBeforeGas-gasUsd,thresholdUsd=Math.max(10,borrowUsd*.0005),stage=netAfterGas>thresholdUsd?'EXACT_PASS':netAfterGas>0?'WATCHLIST_EXACT':'EXACT_REJECT';
    return{stage,chainKey:'base',chain:'Base',blockNumber:Number(BigInt(block)),exactAt:Date.now(),aaveFlashFeeBps:flashFeeBps,thresholdUsd,executionEligible:stage==='EXACT_PASS',exact:{status:'PASS',netAfterGas,netBeforeGas,gasUsd,flashFee:flash,roundTrip,roundTripBps:(roundTrip/borrowUsd-1)*10000,borrowRaw:borrowRaw.toString(),quoteDecimals,assetDecimals,buyMeta:{kind:buy.kind,venue:buy.venue,pair:buy.pair,factory:buy.factory,fee:buy.fee,tickSpacing:buy.tickSpacing,stable:buy.stable,minOutRaw:buy.minOut.toString()},sellMeta:{kind:sell.kind,venue:sell.venue,pair:sell.pair,factory:sell.factory,fee:sell.fee,tickSpacing:sell.tickSpacing,stable:sell.stable,minOutRaw:sell.minOut.toString()}}};
  }catch(e){return{stage:'UNAVAILABLE',chainKey:'base',chain:'Base',executionEligible:false,exact:{status:'BLOCKED',reason:'SERVER '+phase+' · '+(e?.message||'Base exact unavailable')}}}
}
export default async function handler(req,res){if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});return res.status(200).json(await exactBase(req.body||{}))}
