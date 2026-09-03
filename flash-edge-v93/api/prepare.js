import { createHash } from 'node:crypto';
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import { exactBase } from './exact.js';

const RPCS=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.llamarpc.com'];
const APPROVED_RUNTIME='0x370c586265de600f83c972751bc334e493b07fe33ee100f84fb710763d732cad';
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AAVE='0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const UNI3F='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AEROCLF='0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef';
const GPO='0x420000000000000000000000000000000000000F';
const WETH='0x4200000000000000000000000000000000000006';
const norm=x=>String(x||'').toLowerCase();
const addr=x=>/^0x[0-9a-fA-F]{40}$/.test(String(x||''));
const num=x=>Number.isFinite(Number(x))?Number(x):0;
let rpcCursor=0;

const receiverAbi=[{type:'function',name:'executeArbitrage',stateMutability:'nonpayable',inputs:[{name:'p',type:'tuple',components:[{name:'quoteToken',type:'address'},{name:'borrow',type:'uint256'},{name:'minProfit',type:'uint256'},{name:'deadline',type:'uint64'},{name:'buy',type:'tuple',components:[{name:'kind',type:'uint8'},{name:'venue',type:'uint8'},{name:'pair',type:'address'},{name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'stable',type:'bool'},{name:'minOut',type:'uint256'}]},{name:'sell',type:'tuple',components:[{name:'kind',type:'uint8'},{name:'venue',type:'uint8'},{name:'pair',type:'address'},{name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'stable',type:'bool'},{name:'minOut',type:'uint256'}]}]}],outputs:[]}];
const viewAbi=parseAbi(['function owner() view returns(address)','function paused() view returns(bool)','function maxBorrowRaw() view returns(uint256)','function authorizedQuote() view returns(address)','function aavePool() view returns(address)','function uniV3Factory() view returns(address)','function aeroClFactory() view returns(address)']);
const feeAbi=parseAbi(['function getL1FeeUpperBound(uint256) view returns(uint256)','function getOperatorFee(uint256) view returns(uint256)']);

async function rpc(method,params=[],ms=3800){
  let last='Base RPC unavailable';
  const start=rpcCursor++%RPCS.length;
  for(let i=0;i<RPCS.length;i++){
    const url=RPCS[(start+i)%RPCS.length];
    const c=new AbortController();
    const t=setTimeout(()=>c.abort(),ms);
    try{
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:c.signal});
      const d=await r.json();
      if(r.ok&&!d.error&&d.result!=null)return d.result;
      last=d.error?.message||`HTTP ${r.status}`;
    }catch(e){last=e?.message||String(e)}finally{clearTimeout(t)}
  }
  throw Error(last);
}
async function call(to,abi,functionName,args=[]){const data=encodeFunctionData({abi,functionName,args}),r=await rpc('eth_call',[{to,data},'latest']);return decodeFunctionResult({abi,functionName,data:r})}
async function ethUsd(){const c=new AbortController(),t=setTimeout(()=>c.abort(),3000);try{const r=await fetch('https://api.dexscreener.com/token-pairs/v1/base/'+WETH,{signal:c.signal,headers:{accept:'application/json'}});if(!r.ok)throw Error('price');const a=await r.json(),p=a.filter(x=>num(x.priceUsd)>0).sort((x,y)=>num(y.liquidity?.usd)-num(x.liquidity?.usd))[0];if(!p)throw Error('price');return num(p.priceUsd)}catch{return 10000}finally{clearTimeout(t)}}
function kind(m){if(m?.kind==='V2')return 0;if(m?.kind==='V3')return 1;if(m?.kind==='AERO_V2')return 2;if(m?.kind==='AERO_CL')return 3;throw Error('unsupported adapter')}
function leg(m,tin,tout){if(!m||!addr(m.pair)||!addr(tin)||!addr(tout))throw Error('invalid leg');return{kind:kind(m),venue:Number(m.venue||0),pair:m.pair,tokenIn:tin,tokenOut:tout,fee:Number(m.fee||0),tickSpacing:Number(m.tickSpacing||0),stable:Boolean(m.stable),minOut:BigInt(m.minOutRaw)}}
function txData(route,exact,minProfitRaw,deadline){const plan={quoteToken:route.quoteAddress,borrow:BigInt(exact.borrowRaw),minProfit:minProfitRaw,deadline:BigInt(deadline),buy:leg(exact.buyMeta,route.quoteAddress,route.assetAddress),sell:leg(exact.sellMeta,route.assetAddress,route.quoteAddress)};return encodeFunctionData({abi:receiverAbi,functionName:'executeArbitrage',args:[plan]})}
async function receiverState(receiver,from,borrow){const code=await rpc('eth_getCode',[receiver,'latest']);if(!code||code==='0x')throw Error('receiver has no bytecode');const hash='0x'+createHash('sha256').update(String(code).toLowerCase()).digest('hex');if(norm(hash)!==norm(APPROVED_RUNTIME))throw Error('receiver runtime mismatch');const[owner,paused,maxBorrow,quote,aave,uv3,aero]=await Promise.all([call(receiver,viewAbi,'owner'),call(receiver,viewAbi,'paused'),call(receiver,viewAbi,'maxBorrowRaw'),call(receiver,viewAbi,'authorizedQuote'),call(receiver,viewAbi,'aavePool'),call(receiver,viewAbi,'uniV3Factory'),call(receiver,viewAbi,'aeroClFactory')]);if(norm(owner)!==norm(from))throw Error('receiver owner mismatch');if(paused)throw Error('receiver paused');if(BigInt(maxBorrow)<borrow)throw Error('receiver cap below route size');if(norm(quote)!==norm(USDC)||norm(aave)!==norm(AAVE)||norm(uv3)!==norm(UNI3F)||norm(aero)!==norm(AEROCLF))throw Error('receiver constants mismatch');return hash}
async function estimateFees(data,gas){const gasPrice=BigInt(await rpc('eth_gasPrice',[])),size=BigInt(Math.ceil((data.length-2)/2)+220);let l1=0n,op=0n;try{l1=BigInt(await call(GPO,feeAbi,'getL1FeeUpperBound',[size]))}catch{}try{op=BigInt(await call(GPO,feeAbi,'getOperatorFee',[gas]))}catch{}const total=gas*gasPrice+l1+op,px=await ethUsd();return{gasPriceWei:gasPrice.toString(),gasUnits:gas.toString(),l1FeeWei:l1.toString(),operatorFeeWei:op.toString(),totalGasWei:total.toString(),ethUsd:px,gasUsd:Number(total)/1e18*px}}

export async function prepareLive(b){
  const route=b?.route,receiver=b?.receiver,from=b?.from;
  if(!route||route.chainKey!=='base'||route.chainId!==8453)throw Error('Base execution only');
  if(!addr(receiver)||!addr(from)||!addr(route.quoteAddress)||!addr(route.assetAddress)||norm(route.quoteAddress)!==norm(USDC))throw Error('invalid Base USDC execution request');
  const fresh=await exactBase(route);
  if(fresh?.stage!=='EXACT_PASS'||fresh?.exact?.status!=='PASS')throw Error('fresh server EXACT_PASS required');
  const exact=fresh.exact;
  const borrow=BigInt(exact.borrowRaw),baseThreshold=borrow*5n/10000n>10000000n?borrow*5n/10000n:10000000n;
  if(borrow<1000000000n||borrow>250000000000n)throw Error('borrow outside policy');
  const runtimeHash=await receiverState(receiver,from,borrow);
  const head=BigInt(await rpc('eth_blockNumber',[])),proofBlock=BigInt(fresh.blockNumber||0);
  if(!proofBlock||head>proofBlock+2n)throw Error('fresh exact moved more than 2 blocks; retry');
  const deadline=Math.floor(Date.now()/1000)+75;
  let required=baseThreshold,data=txData(route,exact,required,deadline),gas=BigInt(await rpc('eth_estimateGas',[{from,to:receiver,data,value:'0x0'}],6500)),fees=await estimateFees(data,gas);
  required=baseThreshold+BigInt(Math.ceil((fees.gasUsd+.35)*1e6));
  data=txData(route,exact,required,deadline);
  await rpc('eth_call',[{from,to:receiver,data,value:'0x0'},'latest'],8500);
  gas=BigInt(await rpc('eth_estimateGas',[{from,to:receiver,data,value:'0x0'}],8500));
  fees=await estimateFees(data,gas);
  const required2=baseThreshold+BigInt(Math.ceil((fees.gasUsd+.35)*1e6));
  if(required2!==required){required=required2;data=txData(route,exact,required,deadline);await rpc('eth_call',[{from,to:receiver,data,value:'0x0'},'latest'],8500);gas=BigInt(await rpc('eth_estimateGas',[{from,to:receiver,data,value:'0x0'}],8500));fees=await estimateFees(data,gas)}
  const thresholdUsd=Number(baseThreshold)/1e6,minimumPostGasProfitUsd=Number(required)/1e6-fees.gasUsd;
  if(minimumPostGasProfitUsd<thresholdUsd)throw Error('post-gas profit gate failed');
  return{ready:true,chainId:8453,receiver,deadline,proofBlock:Number(proofBlock),currentBlock:Number(head),thresholdUsd,requiredPreGasProfitUsd:Number(required)/1e6,minimumPostGasProfitUsd,expectedPostGasProfitUsd:fresh.exact.netBeforeGas-fees.gasUsd,gas:fees,transaction:{to:receiver,data,value:'0x0',gas:'0x'+gas.toString(16)},freshExact:{...fresh,proofSource:'server'},runtimeHash,rpcPolicy:'PublicNode + Base public + LlamaRPC (1RPC removed)',proofSummary:{freshServerExact:true,receiverRuntime:true,receiverConstants:true,liveEthCall:true,liveEstimateGas:true,protectedGasCap:true,postGasGate:true}};
}

export default async function handler(req,res){if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});try{return res.status(200).json(await prepareLive(req.body||{}))}catch(e){console.error('prepare-v94',e);return res.status(409).json({ready:false,error:'prepare_failed',message:String(e?.message||e).slice(0,500)})}}
