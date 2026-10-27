// Real browser speech service probe. Only synthetic fixtures, never getUserMedia,
// getDisplayMedia, .env, DeepSeek, production meeting records or physical devices.
import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
const output = new URL('../test-output/speech-diagnostic/', import.meta.url);
await mkdir(output, { recursive: true });
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edge 语音服务隔离测试</title>
<style>body{max-width:940px;margin:32px auto;padding:0 24px;font:16px/1.8 system-ui;color:#163b32;background:#f5f7f2}h1{font-size:26px}section{background:white;border:1px solid #cedbd2;border-radius:10px;padding:20px;margin:15px 0}button,select{font:inherit;padding:8px 13px;margin-right:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}#status{padding:14px;background:#e6f1e9}#status[data-state=error]{background:#fbe5e1;color:#9b3026}#status[data-state=success]{background:#d9efdf}li{margin:8px 0}</style>
<h1>语音服务隔离测试</h1><p>只向浏览器识别服务输入本机生成的合成语音。不打开麦克风、不采集屏幕、不播放外放声音、不调用 DeepSeek。</p>
<section><label>测试语言 <select id="language"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
<label>识别模式 <select id="engine"><option value="online">浏览器在线服务</option><option value="local">浏览器本地模型</option><option value="webkit">在线服务（webkit 接口）</option></select></label>
<label>音轨格式 <select id="format"><option value="mono16">16kHz 单声道</option><option value="default">默认采样率、双声道</option></select></label>
<button id="start">测试合成语音音轨</button><button id="stop" disabled>停止测试</button>
<p id="status" role="status">就绪，尚未测试</p><p id="expected">中文句子：这是一段语音测试。小林，请确认明天上午十点四十分参加排练。</p></section>
<section><h2>浏览器能力</h2><pre id="capabilities"></pre><button id="local-check">检查本地模型是否可用</button><pre id="local-result">尚未检查本地模型</pre></section>
<section><h2>本次事件与识别结果</h2><pre id="events">尚无事件</pre></section>
<section><h2>已完成的测试</h2><ol id="runs"></ol></section>
<script>
const $=id=>document.getElementById(id), Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
let current=null;
$('capabilities').textContent=JSON.stringify({userAgent:navigator.userAgent,secureContext:isSecureContext,recognition:!!Recognition,audioContext:!!window.AudioContext,localAvailableMethod:typeof Recognition?.available,localInstallMethod:typeof Recognition?.install,processLocallyProperty:Recognition?'processLocally' in Recognition.prototype:false},null,2);
$('local-check').onclick=async()=>{const results={};for(const lang of ['zh-CN','en-US']){try{results[lang]=await Recognition.available({langs:[lang],processLocally:true})}catch(error){results[lang]={name:error.name,message:error.message}}}$('local-result').textContent=JSON.stringify(results,null,2)};
function draw(run){$('events').textContent=JSON.stringify(run,null,2)}
function log(run,type,detail={}){run.events.push({ms:Math.round(performance.now()-run.t0),type,...detail});draw(run)}
async function finish(run,outcome){
 if(current?.run!==run)return;
 const state=current;current=null;clearTimeout(state.timeout);
 state.rec.onstart=state.rec.onresult=state.rec.onerror=state.rec.onend=null;
 try{state.rec.abort()}catch{};try{state.source?.stop()}catch{};
 state.destination?.stream.getTracks().forEach(track=>track.stop());await state.context.close().catch(()=>{});
 run.outcome=outcome;run.elapsedMs=Math.round(performance.now()-run.t0);delete run.t0;
 $('start').disabled=false;$('stop').disabled=true;
 $('status').textContent=outcome==='recognized'?'成功：已取得识别文字':outcome==='stopped'?'测试已停止':'失败：'+outcome;
 $('status').dataset.state=outcome==='recognized'?'success':'error';draw(run);
 const li=document.createElement('li');li.textContent=run.language+' — '+outcome+' — '+run.elapsedMs+'ms — '+(run.transcripts.join(' / ')||'无识别文字');$('runs').append(li);
 await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(run)}).catch(()=>{});
}
$('start').onclick=async()=>{
 if(current)return;
 if(!Recognition){$('status').textContent='没有 SpeechRecognition 接口';return}
 $('start').disabled=true;$('stop').disabled=false;$('status').dataset.state='pending';$('status').textContent='正在加载本机合成语音';
 const language=$('language').value,engine=$('engine').value,format=$('format').value,context=new AudioContext(format==='mono16'?{sampleRate:16000}:{}),ChosenRecognition=engine==='webkit'?window.webkitSpeechRecognition:Recognition,rec=new ChosenRecognition();
 const run={startedAt:new Date().toISOString(),userAgent:navigator.userAgent,language,engine,format,input:'synthetic_audio_track_only',transcripts:[],events:[],t0:performance.now()};
 current={run,context,rec};
 try{
  await context.resume();
  const response=await fetch('/'+language+'.wav');if(!response.ok)throw new Error('Synthetic fixture unavailable');
  const buffer=await context.decodeAudioData(await response.arrayBuffer());if(current?.run!==run)return;
  const destination=context.createMediaStreamDestination(),source=context.createBufferSource();
  if(format==='mono16')destination.channelCount=1;
  source.buffer=buffer;source.connect(destination);current.destination=destination;current.source=source;
  const track=destination.stream.getAudioTracks()[0];
  let peak=0;for(const value of buffer.getChannelData(0))peak=Math.max(peak,Math.abs(value));
  log(run,'prepared',{durationSeconds:buffer.duration,peak,sampleRate:context.sampleRate,channels:destination.channelCount,trackState:track.readyState,trackSettings:track.getSettings(),contextState:context.state});
  rec.lang=language;rec.continuous=true;rec.interimResults=true;
  if(engine==='local')rec.processLocally=true;
  rec.onstart=()=>{if(current?.run!==run)return;log(run,'start');$('status').textContent='识别服务已启动，正在输入合成语音';source.start(context.currentTime+0.3)};
  source.onended=()=>{if(current?.run===run){log(run,'synthetic_audio_ended');setTimeout(()=>{if(current?.run===run)rec.stop()},1500)}};
  for(const type of ['audiostart','soundstart','speechstart','speechend','soundend','audioend'])rec.addEventListener(type,()=>{if(current?.run===run)log(run,type)});
  rec.onresult=event=>{if(current?.run!==run)return;for(let i=event.resultIndex;i<event.results.length;i++){const result=event.results[i],text=result[0].transcript.trim();log(run,'result',{text,final:result.isFinal});if(result.isFinal&&text)run.transcripts.push(text)}};
  rec.onerror=event=>{if(current?.run!==run)return;log(run,'error',{code:event.error,message:event.message||''});void finish(run,'error:'+event.error)};
  rec.onend=()=>{if(current?.run!==run)return;log(run,'end');void finish(run,run.transcripts.length?'recognized':'ended_without_text')};
  current.timeout=setTimeout(()=>{log(run,'timeout');void finish(run,run.transcripts.length?'recognized':'timeout')},25000);
  log(run,'calling_start_with_audio_track');rec.start(track);
 }catch(error){if(current?.run===run){log(run,'exception',{name:error.name,message:error.message});void finish(run,'exception:'+error.name)}}
};
$('stop').onclick=()=>{if(current)void finish(current.run,'stopped')};
addEventListener('beforeunload',()=>{if(current){try{current.rec.abort()}catch{};current.destination?.stream.getTracks().forEach(t=>t.stop());void current.context.close()}});
</script></html>`;
const integrationUtterances=[];
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  // Ensure no browser fallback can start the real microphone or screen capture.
  res.setHeader('Permissions-Policy','microphone=(), camera=(), display-capture=()');
  try{
    if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return}
    if(req.method==='GET'&&req.url==='/integration'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('../test/speech-live-integration.html',import.meta.url)));return}
    if(req.method==='GET'&&req.url==='/system-audio.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(await readFile(new URL('../public/system-audio.js',import.meta.url)));return}
    if(req.method==='GET'&&req.url==='/api/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({meetingId:'speech-diagnostic-integration',session:{status:'running',generation:1},utterances:integrationUtterances}));return}
    if(req.method==='POST'&&req.url==='/api/utterances'){
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768){res.writeHead(413).end();return}chunks.push(chunk)}
      const utterance=JSON.parse(Buffer.concat(chunks).toString());
      if(utterance.meetingId!=='speech-diagnostic-integration'||utterance.sessionGeneration!==1||typeof utterance.text!=='string'||!utterance.text.trim()){res.writeHead(400).end();return}
      integrationUtterances.push(utterance);
      await appendFile(new URL('integration-utterances.jsonl',output),JSON.stringify({at:new Date().toISOString(),...utterance})+'\n');
      res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;
    }
    if(req.method==='GET'&&/^\/(zh-CN|en-US)\.wav$/.test(req.url)){res.setHeader('Content-Type','audio/wav');res.end(await readFile(new URL(req.url.slice(1),output)));return}
    if(req.method==='POST'&&req.url==='/report'){
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768){res.writeHead(413).end();return}chunks.push(chunk)}
      const report=JSON.parse(Buffer.concat(chunks).toString());
      await appendFile(new URL('runs.jsonl',output),JSON.stringify(report)+'\n');
      console.log(JSON.stringify({language:report.language,outcome:report.outcome,elapsedMs:report.elapsedMs,errors:report.events?.filter(e=>e.type==='error')}));
      res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;
    }
    res.writeHead(404).end('Not found');
  }catch(error){res.writeHead(500).end(error.message)}
});
server.listen(0,'127.0.0.1',()=>console.log('DIAGNOSTIC_URL=http://127.0.0.1:'+server.address().port+'/'));
setTimeout(()=>server.close(),30*60*1000).unref();
