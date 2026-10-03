import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
const manifest=JSON.parse(readFileSync('../docs/deployments/arc-testnet.json','utf8'));
const sources:Record<string,{content:string}>=Object.fromEntries(['GameEscrow.sol','AgentAccount.sol','AgentAccountFactory.sol','test/MockUSDC.sol'].filter(name => existsSync(`contracts/${name}`)).map(name=>[`contracts/${name}`,{content:readFileSync(`contracts/${name}`,'utf8').replace(/\r\n/g, '\n')} ]));
const settings={evmVersion:'cancun',optimizer:{enabled:true,runs:200},viaIR:true,outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}};
const result=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings}),{import:(path:string)=>{
  const content=readFileSync(resolve('node_modules',path),'utf8').replace(/\r\n/g, '\n');sources[path]={content};return {contents:content};
}}));
for(const name of ['GameEscrow','AgentAccountFactory']) {
  const artifact=JSON.parse(readFileSync(`artifacts/${name}.json`,'utf8'));
  if('0x'+result.contracts[`contracts/${name}.sol`][name].evm.bytecode.object!==artifact.bytecode)throw new Error('Verification build differs from deployed artifact');
}
const input={language:'Solidity',sources,settings};
writeFileSync('../docs/deployments/arc-standard-input.json',JSON.stringify(input));
const report:Record<string,unknown>={compiler:solc.version(),contracts:[]};
for(const [name,address,args] of [['GameEscrow',manifest.escrow,[manifest.usdc,manifest.resolver]],['AgentAccountFactory',manifest.factory,[manifest.escrow]]] as const) {
  const constructorArguments=encodeAbiParameters(parseAbiParameters(name==='GameEscrow'?'address,address':'address'),args as any).slice(2);
  const form=new URLSearchParams({module:'contract',action:'verifysourcecode',codeformat:'solidity-standard-json-input',contractaddress:address,
    contractname:`contracts/${name}.sol:${name}`,compilerversion:'v0.8.30+commit.73712a01',sourceCode:JSON.stringify(input),constructorArguments});
  try {
    const response=await fetch('https://explorer.testnet.arc.io/api',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(30000)});
    const data=await response.json() as any;
    (report.contracts as any[]).push({name,address,submission:data});console.log(JSON.stringify({name,submission:data}));
    if(data.status==='1' && typeof data.result==='string' && /^[a-zA-Z0-9-]+$/.test(data.result)) {
      for(let attempt=0;attempt<4;attempt++) {
        await new Promise(r=>setTimeout(r,5000));
        const status=await (await fetch(`https://explorer.testnet.arc.io/api?module=contract&action=checkverifystatus&guid=${encodeURIComponent(data.result)}`,{signal:AbortSignal.timeout(15000)})).json();
        (report.contracts as any[]).at(-1).status=status;
        if((status as any).result!=='Pending in queue'){console.log(JSON.stringify({name,status}));break}
      }
    }
  } catch { (report.contracts as any[]).push({name,address,status:'Explorer verification temporarily unavailable'}); }
}
writeFileSync('../docs/deployments/explorer-verification.json',JSON.stringify(report,null,2));
