const root = '/Users/toddhebebrand/Strata';
const {startKernelService} = require(root+'/packages/live-compare/dist/service.js');
const {CoordinationClient} = require(root+'/packages/coordination-client/dist/index.js');
const {createRssSampler,waitForPersistentWorkerPid,persistentMemoryVerdict} = require(root+'/packages/live-compare/dist/persistence/memory-guard.js');
const {credentialFreeEnv} = require(root+'/packages/live-compare/dist/gate1.js');
const {randomUUID} = require('node:crypto');
const {setTimeout:delay} = require('node:timers/promises');
async function main() {
 const count = Number(process.argv[2] || 48);
 const force = process.argv.includes('--gc');
 const env = credentialFreeEnv();
 env.NODE_OPTIONS = '--require=/tmp/strata-memory-diagnosis.tz1u4Z/preload.cjs';
 env.STRATA_DIAGNOSTIC_OUTPUT = `/tmp/strata-memory-diagnosis.tz1u4Z/worker-${force?'gc':'natural'}.jsonl`;
 const service = await startKernelService(root+'/examples/medium',{env,extraArgs:['--persistent-bridge']});
 const client = new CoordinationClient({socketPath:service.socketPath,clientId:'memory-diagnostic:'+randomUUID()});
 try {
  await client.hello(120000);
  const worker = await waitForPersistentWorkerPid(service.child.pid,30000);
  const sampler = createRssSampler({daemon:service.child.pid,worker});
  const high=[];
  console.log(JSON.stringify({kind:'start',node:process.version,count,force,daemon:service.child.pid,worker}));
  for(let i=0;i<count;i++) {
   const from=i%2?'Account':'User', to=i%2?'User':'Account';
   const found=await client.findDeclarations(from,{kind:'interface'},120000);
   const begun=await client.beginChangeSet('diagnose persistent memory',120000);
   await client.addIntent(begun.changeSetId,{type:'rename_symbol',declarationId:found.declarations[0].nodeId,newName:to},120000);
   await client.submitChangeSet(begun.changeSetId,120000);
   let result;
   for(let j=0;j<8;j++) {result=await client.advanceChangeSet(begun.changeSetId,120000); if(result.state==='published')break;}
   if(result.state!=='published')throw Error(JSON.stringify(result));
   const sampled=await sampler.sampleIteration('iteration-'+(i+1));
   high.push(sampled.highWaterBytes);
   console.log(JSON.stringify({kind:'iteration',iteration:i+1,at:Date.now(),generation:result.graphGeneration,sample:sampled,samples:sampler.samples().slice(-2)}));
   if(force) {process.kill(worker,'SIGUSR2');await delay(100);}
  }
  console.log(JSON.stringify({kind:'verdict12',verdict:persistentMemoryVerdict({mediumHighWaterBytes:high.slice(0,12)}),continuity:sampler.continuityHeld()}));
  process.kill(worker,'SIGUSR2');await delay(500);
 } finally {client.close(); await service.stop();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
