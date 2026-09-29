import {FileWindow,scanSl3,scanBin,combineFixes,findAlignment,matchedGpsForFrame,exportAligned,recordingSummary} from './engine.js';

const $=id=>document.getElementById(id);
const PREVIEW_SECONDS=30;
const state={sonar:null,bins:[],frames:null,summary:null,gps:null,sync:null,route:[],scanPoints:[],selectedScan:-1,previewStart:0,version:0,alignmentVersion:0,previewVersion:0,aligning:false,busy:false,urls:[]};
const count=value=>Number(value||0).toLocaleString('en-US');
const durationText=seconds=>{const s=Math.max(0,Math.round(seconds));return `${Math.floor(s/3600)}h ${String(Math.floor(s%3600/60)).padStart(2,'0')}m ${String(s%60).padStart(2,'0')}s`;};
const sizeText=bytes=>bytes>=1e9?`${(bytes/1e9).toFixed(2)} GB`:`${(bytes/1e6).toFixed(1)} MB`;

function status(mode,message,progress=null){
  const panel=$('results');panel.className=`results${mode==='error'?' is-error':mode==='working'?' is-working':''}`;
  const line=$('results-message');line.replaceChildren();
  if(mode==='working'){const spinner=document.createElement('span');spinner.className='spinner';spinner.setAttribute('aria-hidden','true');line.append(spinner);}
  line.append(document.createTextNode(message));
  $('results-content').replaceChildren();
  if(progress!==null){const bar=document.createElement('progress');bar.max=100;bar.value=Math.max(0,Math.min(100,Math.round(progress*100)));bar.setAttribute('aria-label','Processing progress');$('results-content').append(bar);}
}

function ready(){
  const channels=document.querySelectorAll('#channel-list input:checked').length;
  const okay=Boolean(state.sonar&&state.bins.length&&state.frames&&state.sync?.trusted&&channels&&!state.aligning&&!state.busy);
  $('export-button').disabled=!okay;
  $('sonar-input').disabled=state.busy||state.aligning;$('gps-input').disabled=state.busy||state.aligning;
  $('entire-file').disabled=state.busy;
  document.querySelectorAll('#channel-list input').forEach(input=>input.disabled=state.busy);
  $('start-seconds').disabled=state.busy||$('entire-file').checked;
  $('duration-seconds').disabled=state.busy||$('entire-file').checked;
  $('export-readiness').textContent=state.busy?'Writing the export…':state.aligning?'Matching sonar and GPS automatically…':!state.sonar?'Choose a sonar file':!state.bins.length?'Choose one or more GPS logs':!state.frames?'Reading sonar recording…':!state.sync?.trusted?'Waiting for a verified GPS match':!channels?'Select a sonar channel':'GPS match verified · ready to export';
}

function details(summary){
  const rows=[['Duration',durationText(summary.duration)],['Primary pings',count(summary.counts.primary)],['Downscan pings',count(summary.counts.downscan)],['Sidescan pings',count(summary.counts.sidescan)],['Typical recorded depth',summary.medianDepth==null?'Unavailable':`${summary.medianDepth.toFixed(2)} m`]];
  const list=$('recording-details');list.replaceChildren();
  for(const [label,value] of rows){const item=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;item.append(dt,dd);list.append(item);}
}

function drawRoute(points=state.route){
  const svg=$('route-svg');svg.replaceChildren();
  if(points.length<2){const label=state.sonar&&state.bins.length?'No verified GPS route to show':'Choose files to see the route';const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('x','250');text.setAttribute('y','130');text.setAttribute('text-anchor','middle');text.setAttribute('class','route-empty');text.textContent=label;svg.append(text);return;}
  const lat0=points.reduce((sum,item)=>sum+item[1],0)/points.length,projectInput=p=>[p[0]*Math.cos(lat0*Math.PI/180),-p[1]],xy=points.map(projectInput);
  const xs=xy.map(p=>p[0]),ys=xy.map(p=>p[1]);const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const scale=Math.min(430/Math.max(maxX-minX,1e-6),190/Math.max(maxY-minY,1e-6));
  const project=p=>[250+(p[0]-(minX+maxX)/2)*scale,130+(p[1]-(minY+maxY)/2)*scale];
  const projected=xy.map(project),line=document.createElementNS('http://www.w3.org/2000/svg','polyline');
  line.setAttribute('points',projected.map(p=>p.map(v=>v.toFixed(1)).join(',')).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#07858e');line.setAttribute('stroke-width','3');line.setAttribute('stroke-linejoin','round');line.setAttribute('stroke-linecap','round');svg.append(line);
  for(const [p,color] of [[projected[0],'#1aa982'],[projected.at(-1),'#e45b4f']]){const marker=document.createElementNS('http://www.w3.org/2000/svg','circle');marker.setAttribute('cx',p[0]);marker.setAttribute('cy',p[1]);marker.setAttribute('r','6');marker.setAttribute('fill',color);marker.setAttribute('stroke','white');marker.setAttribute('stroke-width','2');svg.append(marker);}
  state.scanPoints.forEach((scan,i)=>{
    const [x,y]=project(projectInput([scan.lon,scan.lat]));
    const group=document.createElementNS('http://www.w3.org/2000/svg','g');
    group.setAttribute('class',`scan-marker${i===state.selectedScan?' is-selected':''}`);
    group.setAttribute('role','button');group.setAttribute('tabindex','0');group.setAttribute('data-scan-index',String(i));
    group.setAttribute('aria-label',`Scan ${i+1} at ${durationText(scan.time)}; latitude ${scan.lat.toFixed(6)}, longitude ${scan.lon.toFixed(6)}`);
    const title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=`Scan ${i+1} · ${durationText(scan.time)}`;
    const ring=document.createElementNS('http://www.w3.org/2000/svg','circle');ring.setAttribute('class','scan-marker-ring');ring.setAttribute('cx',x);ring.setAttribute('cy',y);ring.setAttribute('r','17');
    const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');circle.setAttribute('class','scan-marker-dot');circle.setAttribute('cx',x);circle.setAttribute('cy',y);circle.setAttribute('r','13');
    const number=document.createElementNS('http://www.w3.org/2000/svg','text');number.setAttribute('x',x);number.setAttribute('y',y+4);number.setAttribute('text-anchor','middle');number.setAttribute('class','scan-marker-number');number.textContent=String(i+1);
    group.append(title,ring,circle,number);
    group.addEventListener('click',()=>selectScan(i));
    group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectScan(i);}});
    svg.append(group);
  });
}

const colorStops=[[0,[8,11,34]],[.20,[58,15,95]],[.46,[139,26,104]],[.72,[230,80,55]],[.9,[249,169,42]],[1,[252,249,125]]];
function color(value){const v=Math.max(0,Math.min(1,value));let i=1;while(i<colorStops.length-1&&v>colorStops[i][0])i++;const [x,a]=colorStops[i-1],[y,b]=colorStops[i],t=(v-x)/(y-x);return a.map((n,j)=>Math.round(n+(b[j]-n)*t));}

async function preview(){
  const {sonar,frames,summary,version}=state,previewVersion=++state.previewVersion;if(!sonar||!frames||!summary)return;
  const placeholder=$('preview-placeholder'),canvas=$('sonar-canvas');canvas.hidden=true;placeholder.hidden=false;placeholder.textContent='Preparing the sonar preview…';
  const start=Math.max(0,Math.round(state.previewStart));
  const selected=state.scanPoints[state.selectedScan];
  $('preview-caption').textContent=selected?`Scan ${state.selectedScan+1} of ${state.scanPoints.length} · 30 s around ${durationText(selected.time)}`:`Preview at ${durationText(start)} · display enhanced`;
  $('preview-previous').disabled=selected?state.selectedScan===0:start<PREVIEW_SECONDS;
  $('preview-next').disabled=selected?state.selectedScan===state.scanPoints.length-1:start+2*PREVIEW_SECONDS>=summary.duration;
  try{
    const matches=frames.filter(f=>f.channel===5&&f.pingSize>1&&start<=f.timeMs/1000&&f.timeMs/1000<start+PREVIEW_SECONDS);
    if(!matches.length)throw new Error('No side-scan pings in this interval');
    const width=Math.min(540,matches.length),height=240,reader=new FileWindow(sonar);
    const intensities=new Uint8Array(width*height),sample=[];
    for(let x=0;x<width;x++){
      const frame=matches[Math.floor(x*(matches.length-1)/Math.max(1,width-1))];
      const payload=await reader.bytes(frame.pingOffset,frame.pingSize);
      for(let y=0;y<height;y++){
        const value=payload[Math.floor(y*(payload.length-1)/(height-1))];
        intensities[y*width+x]=value;if(x%6===0&&y%5===0)sample.push(value);
      }
    }
    if(version!==state.version||previewVersion!==state.previewVersion)return;
    sample.sort((a,b)=>a-b);const low=sample[Math.floor(sample.length*.02)],high=sample[Math.floor(sample.length*.98)];
    canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d'),image=context.createImageData(width,height);
    for(let i=0;i<intensities.length;i++){
      const contrast=(intensities[i]-low)/Math.max(1,high-low),[r,g,b]=color(Math.pow(Math.max(0,contrast),.8));
      image.data[i*4]=r;image.data[i*4+1]=g;image.data[i*4+2]=b;image.data[i*4+3]=255;
    }
    context.putImageData(image,0,0);canvas.hidden=false;placeholder.hidden=true;
  }catch(error){if(version===state.version&&previewVersion===state.previewVersion){placeholder.textContent=`Preview unavailable: ${error.message}`;canvas.hidden=true;placeholder.hidden=false;}}
}

function resetAlignment(){
  state.gps=null;state.sync=null;state.route=[];state.scanPoints=[];state.selectedScan=-1;state.aligning=false;
  $('route-source').textContent='Waiting for files';
  $('route-status').textContent='Choose a sonar file and GPS logs to link the route to its scans.';
  $('scan-details').textContent='The scan time and GPS coordinates will appear here.';
  drawRoute();
}

function selectScan(index){
  const scan=state.scanPoints[index];if(!scan)return;
  state.selectedScan=index;
  state.previewStart=Math.max(0,Math.min(Math.max(0,state.summary.duration-PREVIEW_SECONDS),scan.time-PREVIEW_SECONDS/2));
  $('scan-details').textContent=`Scan ${index+1} · Recording time ${durationText(scan.time)} · GPS ${scan.lat.toFixed(6)}° N, ${Math.abs(scan.lon).toFixed(6)}° ${scan.lon<0?'W':'E'}`;
  drawRoute();preview();
}

async function alignSelection(){
  if(!state.frames||!state.bins.length)return;
  const token=++state.alignmentVersion,bins=[...state.bins],frames=state.frames;
  state.aligning=true;ready();$('route-source').textContent='Matching…';
  $('route-status').textContent='Reading GPS logs and matching their timeline to sonar…';
  try{
    const lists=[];
    for(let i=0;i<bins.length;i++){
      if(token!==state.alignmentVersion)return;
      $('route-status').textContent=`Reading GPS log ${i+1} of ${bins.length}…`;
      lists.push(await scanBin(bins[i],fraction=>{if(token===state.alignmentVersion)$('route-status').textContent=`Reading GPS log ${i+1} of ${bins.length} · ${Math.round(fraction*100)}%`; }));
    }
    if(token!==state.alignmentVersion)return;
    $('route-status').textContent='Matching sonar and GPS timelines…';
    await new Promise(resolve=>setTimeout(resolve,0));
    const gps=combineFixes(lists),sync=findAlignment(frames,gps);
    if(token!==state.alignmentVersion)return;
    state.gps=gps;state.sync=sync;
    if(!sync.trusted){$('route-source').textContent='No verified match';$('route-status').textContent=`GPS match could not be verified: ${sync.reason}. Choose logs from the same trip.`;status('error',`GPS match could not be verified: ${sync.reason}`);drawRoute();return;}
    const start=frames[0].timeMs/1000+sync.offset_s,end=frames.at(-1).timeMs/1000+sync.offset_s;
    const fixes=gps.fixes.filter(fix=>fix.t>=start&&fix.t<=end);
    if(fixes.length<2)throw new Error('Too few GPS fixes overlap this sonar recording');
    const route=fixes.length>500?Array.from({length:500},(_,i)=>fixes[Math.floor(i*(fixes.length-1)/499)]):fixes;
    state.route=route.map(fix=>[fix.lon,fix.lat]);
    const primary=frames.filter(f=>f.channel===0&&Number.isFinite(f.lon)&&Number.isFinite(f.lat)&&Math.abs(f.lon)<=180&&Math.abs(f.lat)<=90&&(f.lon!==0||f.lat!==0));
    const sidescan=frames.filter(f=>f.channel===5&&f.pingSize>1),candidates=[];
    const stride=Math.max(1,Math.floor(sidescan.length/1200));
    for(let i=0;i<sidescan.length;i+=stride){const frame=sidescan[i],match=matchedGpsForFrame(frame,primary,gps,sync);if(match)candidates.push({frame,...match});}
    const points=candidates.length?[candidates[0]]:[];
    const metresBetween=(a,b)=>Math.hypot((a.lon-b.lon)*111320*Math.cos(a.lat*Math.PI/180),(a.lat-b.lat)*111320);
    while(points.length<Math.min(8,candidates.length)){
      let best=null,bestDistance=-1;
      for(const candidate of candidates){
        if(points.some(point=>Math.abs(point.time-candidate.time)<PREVIEW_SECONDS))continue;
        const distance=Math.min(...points.map(point=>metresBetween(point,candidate)));
        if(distance>bestDistance){best=candidate;bestDistance=distance;}
      }
      if(!best)break;
      points.push(best);
    }
    state.scanPoints=points.sort((a,b)=>a.time-b.time);
    $('route-source').textContent='ArduPilot BIN GPS';
    $('route-status').textContent=points.length?`GPS and sonar matched automatically · ${points.length} scan points. Click a numbered point to view its image.`:'GPS and sonar matched, but no side-scan point passed the position check.';
    drawRoute();if(points.length)selectScan(0);
    status('ready',`GPS match verified · ${points.length} linked sonar scans ready`);
  }catch(error){
    if(token===state.alignmentVersion){state.gps=null;state.sync=null;state.route=[];state.scanPoints=[];state.selectedScan=-1;$('route-source').textContent='Match unavailable';$('route-status').textContent=`Could not match the files: ${error.message}`;drawRoute();status('error',`Could not match the files: ${error.message}`);}
  }finally{if(token===state.alignmentVersion){state.aligning=false;ready();}}
}

async function chooseSonar(file){
  const version=++state.version;state.alignmentVersion++;state.previewVersion++;state.sonar=file;state.frames=null;state.summary=null;resetAlignment();
  $('sonar-name').textContent=file?`${file.name} · ${sizeText(file.size)}`:'No file selected';
  $('sonar-name').title=file?.name||'';ready();
  if(!file){$('preview-placeholder').textContent='Choose a sonar file to see its echoes';return;}
  status('working','Reading SL3 frame headers…',0);
  try{
    const frames=await scanSl3(file,fraction=>{if(version===state.version)status('working',`Reading SL3 frame headers · ${Math.round(fraction*100)}%`,fraction);});
    if(version!==state.version)return;
    state.frames=frames;state.summary=recordingSummary(frames);state.previewStart=state.summary.previewStart;
    details(state.summary);ready();status('ready',`${count(frames.length)} sonar frames ready · choose GPS logs to link scan points`);preview();
    if(state.bins.length)await alignSelection();
  }catch(error){if(version===state.version){status('error',`Could not read SL3 file: ${error.message}`);ready();}}
}

function setBins(files){state.alignmentVersion++;resetAlignment();state.bins=[...files];$('gps-name').textContent=state.bins.length?`${state.bins.length} GPS log${state.bins.length===1?'':'s'} selected`:'No files selected';const list=$('gps-list');list.replaceChildren();for(const file of state.bins){const item=document.createElement('span');item.textContent=`${file.name} · ${sizeText(file.size)}`;list.append(item);}ready();if(state.frames&&state.bins.length)alignSelection();}

function downloadBlob(blob,name,label){const url=URL.createObjectURL(blob);state.urls.push(url);const link=document.createElement('a');link.href=url;link.download=name;link.textContent=label;return link;}

async function exportFiles(){
  if(!state.sonar||!state.frames||!state.gps||!state.sync?.trusted)return;
  const sonar=state.sonar,frames=state.frames,bins=[...state.bins],gps=state.gps,sync=state.sync;
  const channels=new Set([...document.querySelectorAll('#channel-list input:checked')].map(input=>Number(input.value)));
  if(!channels.size){status('error','Select at least one sonar channel');return;}
  const entire=$('entire-file').checked,start=entire?0:Number($('start-seconds').value),duration=entire?null:Number($('duration-seconds').value);
  if(!Number.isFinite(start)||start<0||start>=state.summary.duration||!entire&&(!Number.isFinite(duration)||duration<=0)){status('error','Enter a valid time range within this recording');return;}
  state.busy=true;ready();for(const url of state.urls)URL.revokeObjectURL(url);state.urls=[];
  try{
    status('working','Writing GPS-linked sonar CSV…',0);
    const {csv,report}=await exportAligned(sonar,frames,gps,sync,{channels,start,duration,binNames:bins.map(file=>file.name)},fraction=>status('working',`Writing aligned pings · ${Math.round(fraction*100)}%`,fraction));
    const stem=sonar.name.replace(/\.sl3$/i,'').replace(/[^\w.-]+/g,'_');
    status('complete',`Export complete · ${count(report.exported_pings)} sonar pings aligned`);
    const links=document.createElement('div');links.className='result-links';
    links.append(downloadBlob(csv,`${stem}_aligned.csv`,'Download aligned CSV'));
    links.append(downloadBlob(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),`${stem}_quality.json`,'Download quality JSON'));
    $('results-content').append(links);
    const note=document.createElement('p');note.className='result-meta';
    note.textContent=`BIN GPS adopted for ${Math.round(report.bin_position_adoption_fraction*100)}% of pings${report.bin_sl3_position_difference_median_m==null?'':` · median track difference ${report.bin_sl3_position_difference_median_m.toFixed(1)} m`}. This difference is not absolute position accuracy.`;
    $('results-content').append(note);
  }catch(error){status('error',`Export failed: ${error.message}`);}
  finally{state.busy=false;ready();}
}

$('sonar-input').addEventListener('change',event=>chooseSonar(event.target.files[0]||null));
$('gps-input').addEventListener('change',event=>setBins(event.target.files));
$('entire-file').addEventListener('change',event=>{$('start-seconds').disabled=event.target.checked;$('duration-seconds').disabled=event.target.checked;});
document.querySelectorAll('#channel-list input').forEach(input=>input.addEventListener('change',ready));
$('export-button').addEventListener('click',exportFiles);
$('preview-previous').addEventListener('click',()=>{if(state.scanPoints.length)selectScan(state.selectedScan-1);else{state.previewStart=Math.max(0,state.previewStart-PREVIEW_SECONDS);preview();}});
$('preview-next').addEventListener('click',()=>{if(state.scanPoints.length)selectScan(state.selectedScan+1);else{state.previewStart=Math.min(Math.max(0,state.summary.duration-PREVIEW_SECONDS),state.previewStart+PREVIEW_SECONDS);preview();}});
window.addEventListener('beforeunload',()=>state.urls.forEach(url=>URL.revokeObjectURL(url)));
