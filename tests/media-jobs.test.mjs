import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MediaJob, handleMediaJobs } from '../worker/media-jobs.js';
const {wavBlob}=createRequire(import.meta.url)('../docs/studio/media.js');
const ID='12345678-1234-4123-8123-123456789abc',origin='https://prompter.neuralforge.tech';
function environment(){
  const data=new Map(),storage={async get(key){return Array.isArray(key)?new Map(key.filter(k=>data.has(k)).map(k=>[k,structuredClone(data.get(k))])):structuredClone(data.get(key));},async put(key,value){if(typeof key==='object')for(const[k,v]of Object.entries(key))data.set(k,structuredClone(v));else data.set(key,structuredClone(value));},async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])data.delete(key);},async transaction(fn){return fn(storage);},async setAlarm(){},async deleteAll(){data.clear();}};
  const env={GITHUB_TOKEN:'private-github',GITHUB_OWNER:'owner',GITHUB_REPO:'repo',NVIDIA_API_KEY:'private-nvidia',WHISPER_BRIDGE_KEY:'private-bridge',ALLOWED_ORIGIN:origin,AI_JOBS:{idFromName:v=>v,get:()=>({fetch:async url=>Response.json(url.endsWith('/admit')?{allowed:true}:{wait:0})})}};
  const object=new MediaJob({storage,blockConcurrencyWhile:fn=>fn()},env);env.MEDIA_JOBS={idFromName:v=>v,get:()=>({fetch:(...args)=>object.fetch(new Request(...args))})};return {object,env,data,storage};
}
const internal=(path,body,headers={})=>new Request('https://internal'+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:typeof body==='string'||body instanceof Blob?body:JSON.stringify(body)})});
async function create(object,email='person@example.com',count=2){return object.fetch(internal('/create',{id:ID,token:'private-upload',email,model:'parakeet',language:'en',translate_to:null,name:'A recording',chunk_count:count}));}
test('complete-upload seal, private recipients, protected audio, idempotency and result cleanup',async()=>{
  const {object,env,data}=environment();await create(object);let dispatches=0;const original=globalThis.fetch;
  globalThis.fetch=async(_url,options)=>{dispatches++;assert.deepEqual(JSON.parse(options.body),{event_type:'uploaded-media',client_payload:{job_id:ID}});return new Response(null,{status:204});};
  try{
    const auth={'X-Upload-Token':'private-upload'};
    assert.equal((await object.fetch(internal('/start','{}',auth))).status,409);assert.equal(dispatches,0);
    assert.equal((await object.fetch(internal('/chunks/0',wavBlob(new Float32Array(16000))))).status,403);
    for(const i of [0,0,1])assert.equal((await object.fetch(internal('/chunks/'+i,wavBlob(new Float32Array(16000)),auth))).status,200);
    assert.equal((await object.fetch(internal('/start','{}',auth))).status,202);await object.fetch(internal('/start','{}',auth));assert.equal(dispatches,1);
    const status=await(await object.fetch(internal('/status'))).json();assert.equal(status.uploaded.length,2);assert.ok(!JSON.stringify(status).includes('person@example.com'));assert.ok(!JSON.stringify(status).includes('private-upload'));
    const url='https://relay/speech/jobs/'+ID+'/manifest';assert.equal((await handleMediaJobs(new Request(url),env)).status,403);
    const manifest=await(await handleMediaJobs(new Request(url,{headers:{Authorization:'Bearer private-bridge'}}),env)).json();assert.equal(manifest.email,'person@example.com');
    const result={cues:[{start:0,end:1,text:'Hello'}],translated_cues:[],files:{'transcript.txt':'Hello','subtitles.srt':'1\n00:00:00,000 --> 00:00:01,000\nHello'},timing_quality:'word'};
    assert.equal((await object.fetch(internal('/result',result,{'X-Runner':'yes'}))).status,200);
    assert.ok(!data.has('audio0:count'));assert.ok(!data.has('audio1:0'));
    await object.fetch(internal('/notification',{status:'sent'},{'X-Runner':'yes'}));const ready=await(await object.fetch(internal('/status'))).json();assert.equal(ready.notification,'sent');assert.equal((await object.fetch(internal('/files/transcript.txt'))).status,200);assert.equal(data.get('private').email,'');
  }finally{globalThis.fetch=original;}
});
test('project creation validates recipient, origin and recording limits before dispatch',async()=>{
  const {env}=environment();const request=(value,from=origin)=>new Request('https://relay/speech/jobs',{method:'POST',headers:{Origin:from,'Content-Type':'application/json'},body:JSON.stringify(value)});
  const body={model:'parakeet',language:'en',chunk_count:1,email:'valid@example.com'};
  assert.equal((await handleMediaJobs(request(body,'https://evil.test'),env)).status,403);
  assert.equal((await handleMediaJobs(request({...body,email:'bad\r\nBcc: others@example.com'}),env)).status,400);
  assert.equal((await handleMediaJobs(request({...body,chunk_count:21}),env)).status,400);
  assert.equal((await handleMediaJobs(request({...body,model:'parakeet',language:'ur'}),env)).status,400);
  const created=await handleMediaJobs(request(body),env);assert.equal(created.status,201);assert.ok((await created.json()).upload_token);
});
test('translation must retain every original timestamp and partial results are not published',async()=>{
  const {object}=environment();await create(object,'',1);
  const bad={cues:[{start:0,end:1,text:'Hello'}],translated_cues:[{start:2,end:3,text:'Translated'}],files:{'transcript.txt':'Hello'}};
  // State can only advance through a sealed job.
  assert.equal((await object.fetch(internal('/result',bad,{'X-Runner':'yes'}))).status,409);
});
