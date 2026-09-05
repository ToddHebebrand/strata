const root='/Users/toddhebebrand/Strata';
const {createQualifiedKernelSnapshot}=require(root+'/packages/live-compare/dist/tasks.js');
const {hydrateSnapshot}=require(root+'/packages/kernel-bridge/dist/snapshot.js');
const {begin,rollback,openTransactionOverlayCount}=require(root+'/packages/store/dist/index.js');
const {validate}=require(root+'/packages/verify/dist/index.js');
const {setTimeout:delay}=require('node:timers/promises');
const {Session}=require('node:inspector');
async function main(){
 const snapshot=createQualifiedKernelSnapshot(root+'/examples/medium');
 snapshot.generation=String(snapshot.generation);
 const db=hydrateSnapshot(snapshot);
 const sample=(kind,iteration)=>console.log(JSON.stringify({kind,iteration,...process.memoryUsage(),overlays:openTransactionOverlayCount()}));
 try{
  sample('start',0);
  for(let i=1;i<=24;i++){
   const tx=begin(db,'diagnostic','typecheck only, no mutation');
   try{const diagnostics=validate(db,tx,root+'/examples/medium');if(diagnostics.length)throw Error(JSON.stringify(diagnostics));}
   finally{rollback(db,tx);}
   await delay(200);sample('iteration',i);
  }
  const session=new Session();session.connect();
  await new Promise((resolve,reject)=>session.post('HeapProfiler.collectGarbage',error=>error?reject(error):resolve()));
  sample('afterForcedGc',24);session.disconnect();
 }finally{db.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
