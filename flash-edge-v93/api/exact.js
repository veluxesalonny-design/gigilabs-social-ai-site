import { parseAbi, encodeFunctionData, decodeFunctionResult } from 'viem';

const RPCS=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.llamarpc.com'];
const AAVE='0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const UNI_FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const UNI_QUOTER='0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const AERO_FACTORY='0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef';
const AERO_QUOTER='0x514c8B5f54112481E28028F1166Bd78501089259';
const SUSHI_ROUTER='0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891';
const norm=x=>String(x||'').toLowerCase();
const units=(n,d)=>BigInt(Math.round(Number(n)*1e6))*10n**BigInt(d)/1000000n;
const toNum=(n,d)=>Number(n)/10**d;
const minOut=x=>x*9980n/10000n;
let rpcCursor=0;

const erc20=parseAbi(['function decimals() view returns(uint8)']);
const uniPool=parseAbi(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function fee() view returns(uint24)']);
const uniFactory=parseAbi(['function getPool(address,address,uint24) view returns(address)']);
const uniQuoter=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const aeroPool=parseAbi(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function tickSpacing() view returns(int24)']);
const aeroFactory=parseAbi(['function getPool(address,address,int24) view returns(address)']);
const aeroQuoter=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const sushiPair=parseAbi(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)']);
const sushiRouter=parseAbi(['function factory() view returns(address)','function getAmountsOut(uint256,address[]) view returns(uint256[])']);

async function rpc(method,params=[],timeout=3400){
  let last='Base RPC unavailable';
  const start=rpcCursor++%RPCS.length;
  for(let i=0;i<RPCS.length;i++){
    const url=RPCS[(start+i)%RPCS.length];
    const c=new AbortController();
    const t=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:c.signal});
      const j=await r.json();
      if(r.ok&&!j.error&&j.result!==undefined)return j.result;
      last=j.error?.message||`HTTP ${r.status}`;
    }catch(e){last=e?.message||String(e)}finally{clearTimeout(t)}
  }
  throw Error(last);
}
async function call(block,to,abi,functionName,args=[]){
  const data=encodeFunctionData({abi,functionName,args});
  const out=await rpc('eth_call',[{to,data},block]);
  return decodeFunctionResult({abi,functionName,data:out});
}
function tokensMatch(t0,t1,tin,tout){return(norm(t0)===norm(tin)&&norm(t1)===norm(tout))||(norm(t0)===norm(tout)&&norm(t1)===norm(tin))}

async function quoteUni(block,pair,tin,tout,amountIn){
  const [t0,t1,factory,feeRaw]=await Promise.all([
    call(block,pair,uniPool,'token0'),call(block,pair,uniPool,'token1'),call(block,pair,uniPool,'factory'),call(block,pair,uniPool,'fee')
  ]);
  const fee=Number(feeRaw);
  if(norm(factory)!==norm(UNI_FACTORY))throw Error('Uniswap factory mismatch');
  if(!tokensMatch(t0,t1,tin,tout))throw Error('Uniswap token mismatch');
  if(![100,500,3000,10000].includes(fee))throw Error('unsupported Uniswap fee');
  const canonical=await call(block,UNI_FACTORY,uniFactory,'getPool',[tin,tout,fee]);
  if(norm(canonical)!==norm(pair))throw Error('Uniswap pool mismatch');
  const q=await call(block,UNI_QUOTER,uniQuoter,'quoteExactInputSingle',[{tokenIn:tin,tokenOut:tout,amountIn,fee,sqrtPriceLimitX96:0n}]);
  const out=BigInt(q[0]);
  if(out<=0n)throw Error('zero Uniswap quote');
  return{out,minOut:minOut(out),kind:'V3',venue:0,pair,factory,fee,tickSpacing:0,stable:false};
}
async function quoteAero(block,pair,tin,tout,amountIn){
  const [t0,t1,factory,tickRaw]=await Promise.all([
    call(block,pair,aeroPool,'token0'),call(block,pair,aeroPool,'token1'),call(block,pair,aeroPool,'factory'),call(block,pair,aeroPool,'tickSpacing')
  ]);
  const tickSpacing=Number(tickRaw);
  if(norm(factory)!==norm(AERO_FACTORY))throw Error('Aerodrome current factory mismatch');
  if(!tokensMatch(t0,t1,tin,tout))throw Error('Aerodrome token mismatch');
  if(!Number.isFinite(tickSpacing)||tickSpacing<=0)throw Error('invalid Aerodrome tick spacing');
  const canonical=await call(block,AERO_FACTORY,aeroFactory,'getPool',[tin,tout,tickSpacing]);
  if(norm(canonical)!==norm(pair))throw Error('Aerodrome pool mismatch');
  const q=await call(block,AERO_QUOTER,aeroQuoter,'quoteExactInputSingle',[{tokenIn:tin,tokenOut:tout,amountIn,tickSpacing,sqrtPriceLimitX96:0n}]);
  const out=BigInt(q[0]);
  if(out<=0n)throw Error('zero Aerodrome quote');
  return{out,minOut:minOut(out),kind:'AERO_CL',venue:0,pair,factory,fee:0,tickSpacing,stable:false};
}
async function quoteSushi(block,pair,tin,tout,amountIn){
  const [t0,t1,pairFactory,routerFactory]=await Promise.all([
    call(block,pair,sushiPair,'token0'),call(block,pair,sushiPair,'token1'),call(block,pair,sushiPair,'factory'),call(block,SUSHI_ROUTER,sushiRouter,'factory')
  ]);
  if(norm(pairFactory)!==norm(routerFactory))throw Error('Sushi factory mismatch');
  if(!tokensMatch(t0,t1,tin,tout))throw Error('Sushi token mismatch');
  const amounts=await call(block,SUSHI_ROUTER,sushiRouter,'getAmountsOut',[amountIn,[tin,tout]]);
  const out=BigInt(amounts[amounts.length-1]);
  if(out<=0n)throw Error('zero Sushi quote');
  return{out,minOut:minOut(out),kind:'V2',venue:1,pair,factory:pairFactory,fee:0,tickSpacing:0,stable:false};
}
async function quoteLeg(block,dex,pair,tin,tout,amountIn){
  if(dex==='Uniswap')return quoteUni(block,pair,tin,tout,amountIn);
  if(dex==='Aerodrome')return quoteAero(block,pair,tin,tout,amountIn);
  if(dex==='Sushi')return quoteSushi(block,pair,tin,tout,amountIn);
  throw Error('unsupported venue');
}

export async function exactBase(o){
  let phase='HEAD';
  try{
    const block=await rpc('eth_blockNumber',[]);
    phase='META';
    const [feeRaw,quoteDecimalsRaw,assetDecimalsRaw]=await Promise.all([
      rpc('eth_call',[{to:AAVE,data:'0x074b2e43'},block]),
      call(block,o.quoteAddress,erc20,'decimals'),
      call(block,o.assetAddress,erc20,'decimals')
    ]);
    const flashFeeBps=Number(BigInt(feeRaw));
    const quoteDecimals=Number(quoteDecimalsRaw),assetDecimals=Number(assetDecimalsRaw);
    const borrowUsd=Number(o.optimalBorrow||o.borrowUsd||o.b);
    if(!Number.isFinite(borrowUsd)||borrowUsd<=0)throw Error('invalid borrow');
    const borrowRaw=units(borrowUsd,quoteDecimals);
    phase='BUY';
    const buy=await quoteLeg(block,o.buyDex,o.buyPair,o.quoteAddress,o.assetAddress,borrowRaw);
    phase='SELL';
    const sell=await quoteLeg(block,o.sellDex,o.sellPair,o.assetAddress,o.quoteAddress,buy.out);
    const roundTrip=toNum(sell.out,quoteDecimals);
    const flashFee=toNum(borrowRaw*BigInt(Math.max(0,Math.round(flashFeeBps)))/10000n,quoteDecimals);
    const gasUsd=Math.max(.01,Number(o.gas)||.75);
    const netBeforeGas=roundTrip-borrowUsd-flashFee;
    const netAfterGas=netBeforeGas-gasUsd;
    const thresholdUsd=Math.max(10,borrowUsd*.0005);
    const stage=netAfterGas>thresholdUsd?'EXACT_PASS':netAfterGas>0?'WATCHLIST_EXACT':'EXACT_REJECT';
    return{stage,chainKey:'base',chain:'Base',blockNumber:Number(BigInt(block)),exactAt:Date.now(),aaveFlashFeeBps:flashFeeBps,thresholdUsd,executionEligible:stage==='EXACT_PASS',exact:{status:'PASS',netAfterGas,netBeforeGas,gasUsd,flashFee,roundTrip,roundTripBps:(roundTrip/borrowUsd-1)*10000,borrowRaw:borrowRaw.toString(),quoteDecimals,assetDecimals,buyMeta:{kind:buy.kind,venue:buy.venue,pair:buy.pair,factory:buy.factory,fee:buy.fee,tickSpacing:buy.tickSpacing,stable:buy.stable,minOutRaw:buy.minOut.toString()},sellMeta:{kind:sell.kind,venue:sell.venue,pair:sell.pair,factory:sell.factory,fee:sell.fee,tickSpacing:sell.tickSpacing,stable:sell.stable,minOutRaw:sell.minOut.toString()}}};
  }catch(e){
    return{stage:'UNAVAILABLE',chainKey:'base',chain:'Base',executionEligible:false,exact:{status:'BLOCKED',reason:'SERVER '+phase+' · '+(e?.message||'Base exact unavailable')}};
  }
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
  return res.status(200).json(await exactBase(req.body||{}));
}
