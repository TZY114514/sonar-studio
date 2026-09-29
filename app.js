import {FileWindow,scanSl3,scanBin,combineFixes,findAlignment,matchedGpsForFrame,nearestSample,exportAligned,recordingSummary,trackGeoJson,trackGpx} from './engine.js?v=e671d690ea';
import {buildSeabedModel,seabedDepthAt,seabedBaseAt} from './reconstruct.js?v=e671d690ea';
import {inspectLining,candidatesGeoJson} from './inspect.js?v=e671d690ea';
import {createInspectView,CRACK_COLOURS} from './inspect-view.js?v=e671d690ea';
import {createRouteMap} from './route-map.js?v=e671d690ea';
import {renderScan} from './scan-image.js?v=e671d690ea';

const $=id=>document.getElementById(id);
const PREVIEW_SECONDS=30;
const state={sonar:null,bins:[],frames:null,summary:null,gps:null,sync:null,route:[],trackFixes:[],samples:[],scanPoints:[],selection:null,previewStart:0,previewWindow:null,previewChannel:null,previewScan:null,version:0,alignmentVersion:0,previewVersion:0,aligning:false,busy:false,urls:[],seabed:{viewer:null,module:null,model:null,building:false,version:0,selectedObject:-1},cracks:{view:null,result:null,running:false,version:0,selected:-1}};
const count=value=>Number(value||0).toLocaleString('en-US');
const durationText=seconds=>{const s=Math.max(0,Math.round(seconds));return `${Math.floor(s/3600)}h ${String(Math.floor(s%3600/60)).padStart(2,'0')}m ${String(s%60).padStart(2,'0')}s`;};
const clockText=seconds=>{const s=Math.max(0,Math.round(seconds)),h=Math.floor(s/3600),m=Math.floor(s%3600/60),rest=String(s%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${rest}`:`${m}:${rest}`;};
const CHANNEL_LABELS={5:'sidescan',2:'downscan'};
const CHANNEL_GUIDES={5:'Bright bands show stronger echoes. The dark center band is directly beneath the boat. Colors are enhanced for display.',
  2:'Bright bands show stronger echoes. The top edge is the water surface and depth increases downward. Colors are enhanced for display.'};
// Preview sidescan when the recording has it, otherwise downscan.
const previewChannel=summary=>summary?.counts.sidescan?5:summary?.counts.downscan?2:null;
const sizeText=bytes=>bytes>=1e9?`${(bytes/1e9).toFixed(2)} GB`:`${(bytes/1e6).toFixed(1)} MB`;
const metresBetween=(a,b)=>Math.hypot((a.lon-b.lon)*111320*Math.cos(a.lat*Math.PI/180),(a.lat-b.lat)*111320);

// Status lines carry a state (idle, working, ok, warn or error) that the stylesheet shows as an icon.
function setStatus(id,text,state='idle'){const line=$(id);line.textContent=text;line.dataset.state=state;}
const routeStatus=(text,state)=>setStatus('route-status',text,state);
const seabedStatus=(text,state)=>setStatus('seabed-status',text,state);
const crackStatus=(text,state)=>setStatus('crack-status',text,state);

function status(mode,message,progress=null){
  const panel=$('results');panel.className=`results is-${mode}`;
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
  // A tick on each loading step once it is done, and a solid picker once it holds a file.
  $('step-sonar').toggleAttribute('data-done',Boolean(state.frames));
  $('step-gps').toggleAttribute('data-done',Boolean(state.sync?.trusted));
  $('sonar-name').closest('.file-picker').toggleAttribute('data-loaded',Boolean(state.sonar));
  $('gps-name').closest('.file-picker').toggleAttribute('data-loaded',state.bins.length>0);
  $('download-gpx').disabled=$('download-geojson').disabled=!(state.trackFixes.length>=2&&!state.aligning);
  $('build-seabed').disabled=$('seabed-stretch').disabled=!(state.sync?.trusted&&state.trackFixes.length>=2&&!state.aligning&&!state.busy&&!state.seabed.building);
  $('find-cracks').disabled=$('crack-stretch').disabled=!(state.sync?.trusted&&state.trackFixes.length>=2&&!state.aligning&&!state.busy&&!state.cracks.running);
  $('sonar-input').disabled=state.busy||state.aligning;$('gps-input').disabled=state.busy||state.aligning;
  $('entire-file').disabled=state.busy;
  $('use-preview-window').disabled=state.busy||!state.selection;
  document.querySelectorAll('#channel-list input').forEach(input=>input.disabled=state.busy);
  $('start-seconds').disabled=state.busy||$('entire-file').checked;
  $('duration-seconds').disabled=state.busy||$('entire-file').checked;
  $('export-readiness').textContent=state.busy?'Writing the export…':state.aligning?'Matching sonar and GPS automatically…':!state.sonar?'Choose a sonar file':!state.bins.length?'Choose one or more GPS logs':!state.frames?'Reading sonar recording…':!state.sync?.trusted?'Waiting for a verified GPS match':!channels?'Select a sonar channel':'GPS match verified · ready to export';
}

function details(summary){
  const rows=[['Duration',durationText(summary.duration).replace(/^0h /,'')],['Typical depth',summary.medianDepth==null?'Unavailable':`${summary.medianDepth.toFixed(2)} m`],['Primary pings',count(summary.counts.primary)],['Downscan pings',count(summary.counts.downscan)],['Sidescan pings',count(summary.counts.sidescan)]];
  const list=$('recording-details');list.replaceChildren();list.hidden=false;
  for(const [label,value] of rows){const item=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;item.append(dt,dd);list.append(item);}
}

function drawRoute(){
  if(state.route.length<2){routeMap.clear(state.sonar&&state.bins.length?'No verified GPS route to show':'Choose files to see the route');return;}
  routeMap.showRoute(state.route,state.scanPoints,(scan,i)=>`Scan ${i+1} at ${durationText(scan.time)}; latitude ${scan.lat.toFixed(6)}, longitude ${scan.lon.toFixed(6)}`);
  routeMap.select(state.selection);
}

// Numbered scan points either side of the current preview time, for the ‹ › buttons.
function neighbourScan(direction){
  const time=state.selection?.time??state.previewStart+PREVIEW_SECONDS/2;
  const indices=state.scanPoints.map((_,i)=>i).filter(i=>direction<0?state.scanPoints[i].time<time-.5:state.scanPoints[i].time>time+.5);
  return indices.length?(direction<0?indices.at(-1):indices[0]):-1;
}

function channelChoices(){
  document.querySelectorAll('input[name="preview-channel"]').forEach(input=>{
    const channel=Number(input.value),counts=state.summary?.counts;
    input.disabled=!counts?.[CHANNEL_LABELS[channel]];input.checked=channel===state.previewChannel;
  });
}

// Recolour the cached preview with the current contrast and brightness; no file reads.
function drawPreview(){
  const canvas=$('sonar-canvas');
  renderScan(canvas,state.previewScan,{contrast:Number($('preview-contrast').value),brightness:Number($('preview-brightness').value)});
  canvas.hidden=false;$('preview-placeholder').hidden=true;$('save-image').disabled=false;
}

async function preview(){
  const {sonar,frames,summary,version}=state,previewVersion=++state.previewVersion;if(!sonar||!frames||!summary)return;
  const placeholder=$('preview-placeholder'),canvas=$('sonar-canvas');
  const start=Math.max(0,Math.round(state.previewStart)),end=Math.min(summary.duration,start+PREVIEW_SECONDS),channel=state.previewChannel;
  const selection=state.selection,windowText=`${clockText(start)}–${clockText(end)}`;
  state.previewWindow={start,end};$('use-preview-window').textContent=`Use preview window (${windowText})`;
  $('preview-caption').textContent=selection?.kind==='scan'?`Scan ${selection.index+1} of ${state.scanPoints.length} · ${windowText}`:selection?`Route point · ${windowText}`:`Preview ${windowText} · display enhanced`;
  routeMap.highlightWindow(state.samples.filter(sample=>sample.time>=start&&sample.time<=end));
  $('preview-channel').textContent=channel==null?'No image channel':`Enhanced ${CHANNEL_LABELS[channel]}`;
  $('preview-guide').textContent=CHANNEL_GUIDES[channel]??CHANNEL_GUIDES[5];
  $('preview-previous').disabled=state.scanPoints.length?neighbourScan(-1)<0:start<PREVIEW_SECONDS;
  $('preview-next').disabled=state.scanPoints.length?neighbourScan(1)<0:start+2*PREVIEW_SECONDS>=summary.duration;
  const key=`${version}:${channel}:${start}`;
  if(state.previewScan?.key===key){drawPreview();return;}
  canvas.hidden=true;placeholder.hidden=false;placeholder.textContent='Preparing the sonar preview…';$('save-image').disabled=true;
  try{
    if(channel==null)throw new Error('this recording has no sidescan or downscan pings');
    const matches=frames.filter(f=>{const t=f.timeMs/1000-summary.start;return f.channel===channel&&f.pingSize>1&&start<=t&&t<start+PREVIEW_SECONDS;});
    if(!matches.length)throw new Error(`no ${CHANNEL_LABELS[channel]} pings in this interval`);
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
    state.previewScan={key,intensities,width,height,sorted:sample.sort((a,b)=>a-b)};
    drawPreview();
  }catch(error){if(version===state.version&&previewVersion===state.previewVersion){placeholder.textContent=`Preview unavailable: ${error.message}`;canvas.hidden=true;placeholder.hidden=false;}}
}

function resetAlignment(){
  state.gps=null;state.sync=null;state.route=[];state.trackFixes=[];state.samples=[];state.scanPoints=[];state.selection=null;state.aligning=false;
  resetSeabed('Match the sonar and GPS files, then build the model.');
  resetCracks('Match the sonar and GPS files, then select a point on the route to screen the canal around it.');
  $('route-source').textContent='Waiting for files';
  routeStatus('Choose a sonar file and GPS logs to link the route to its scans.');
  $('scan-details').textContent='The scan time and GPS coordinates will appear here.';
  drawRoute();
}

// selection: {kind:'scan',index,time,lat,lon} for a numbered point, or {kind:'point',time,lat,lon} for a route
// click; a point may also carry object, the index of a detected object in the 3D model.
function select(selection){
  state.selection=selection;
  state.previewStart=Math.max(0,Math.min(Math.max(0,state.summary.duration-PREVIEW_SECONDS),selection.time-PREVIEW_SECONDS/2));
  const object=selection.object!=null?state.seabed.model?.objects[selection.object]:null;
  const crack=selection.crack!=null?state.cracks.result?.candidates[selection.crack]:null;
  const label=selection.kind==='scan'?`Scan ${selection.index+1}`:object?`Object ${object.id}`:crack?`Crack candidate ${crack.id}`:'Route point';
  $('scan-details').textContent=`${label} · Recording time ${durationText(selection.time)} · GPS ${Math.abs(selection.lat).toFixed(6)}° ${selection.lat<0?'S':'N'}, ${Math.abs(selection.lon).toFixed(6)}° ${selection.lon<0?'W':'E'}`;
  if(!object)markObject(-1);
  if(!crack)markCrack(-1);
  routeMap.select(selection);state.seabed.viewer?.select(selection.kind==='scan'?selection.index:-1);updateSection();preview();ready();
}
function selectScan(index){const scan=state.scanPoints[index];if(scan)select({kind:'scan',index,time:scan.time,lat:scan.lat,lon:scan.lon});}
function pickRoutePoint(lat,lon,slackM){
  const nearest=nearestSample(state.samples,lat,lon);
  if(nearest&&nearest.distanceM<=slackM){const {time,lat:sampleLat,lon:sampleLon}=nearest.sample;select({kind:'point',time,lat:sampleLat,lon:sampleLon});}
}

async function alignSelection(){
  if(!state.frames||!state.bins.length)return;
  const token=++state.alignmentVersion,bins=[...state.bins],frames=state.frames,summary=state.summary,channel=previewChannel(summary)??0;
  state.aligning=true;ready();$('route-source').textContent='Matching…';
  routeStatus('Reading GPS logs and matching their timeline to sonar…','working');
  try{
    const lists=[];
    for(let i=0;i<bins.length;i++){
      if(token!==state.alignmentVersion)return;
      routeStatus(`Reading GPS log ${i+1} of ${bins.length}…`,'working');
      lists.push(await scanBin(bins[i],fraction=>{if(token===state.alignmentVersion)routeStatus(`Reading GPS log ${i+1} of ${bins.length} · ${Math.round(fraction*100)}%`,'working');}));
    }
    if(token!==state.alignmentVersion)return;
    routeStatus('Matching sonar and GPS timelines…','working');
    await new Promise(resolve=>setTimeout(resolve,0));
    const gps=combineFixes(lists),sync=findAlignment(frames,gps);
    if(token!==state.alignmentVersion)return;
    state.gps=gps;state.sync=sync;
    if(!sync.trusted){$('route-source').textContent='No verified match';routeStatus(`GPS match could not be verified: ${sync.reason}. Choose logs from the same trip.`,'error');status('error',`GPS match could not be verified: ${sync.reason}`);drawRoute();return;}
    const start=frames[0].timeMs/1000+sync.offset_s,end=frames.at(-1).timeMs/1000+sync.offset_s;
    const fixes=gps.fixes.filter(fix=>fix.t>=start&&fix.t<=end);
    if(fixes.length<2)throw new Error('Too few GPS fixes overlap this sonar recording');
    const route=fixes.length>500?Array.from({length:500},(_,i)=>fixes[Math.floor(i*(fixes.length-1)/499)]):fixes;
    state.route=route.map(fix=>[fix.lon,fix.lat]);state.trackFixes=fixes;
    const primary=frames.filter(f=>f.channel===0&&Number.isFinite(f.lon)&&Number.isFinite(f.lat)&&Math.abs(f.lon)<=180&&Math.abs(f.lat)<=90&&(f.lon!==0||f.lat!==0));
    const pings=frames.filter(f=>f.channel===channel&&f.pingSize>1),candidates=[];
    const stride=Math.max(1,Math.floor(pings.length/1200));
    for(let i=0;i<pings.length;i+=stride){const frame=pings[i],match=matchedGpsForFrame(frame,primary,gps,sync);if(match)candidates.push({frame,...match,time:match.time-summary.start});}
    state.samples=candidates.map(({time,lat,lon})=>({time,lat,lon}));
    const points=candidates.length?[candidates[0]]:[];
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
    routeStatus(points.length?`GPS and sonar matched automatically · ${points.length} scan points. Click a numbered point, or anywhere on the route, to view its scan.`:'GPS and sonar matched, but no scan point passed the position check.',points.length?'ok':'warn');
    drawRoute();if(points.length)selectScan(0);
    status('ready',`GPS match verified · ${points.length} linked sonar scans ready`);
  }catch(error){
    if(token===state.alignmentVersion){state.gps=null;state.sync=null;state.route=[];state.trackFixes=[];state.samples=[];state.scanPoints=[];state.selection=null;$('route-source').textContent='Match unavailable';routeStatus(`Could not match the files: ${error.message}`,'error');drawRoute();status('error',`Could not match the files: ${error.message}`);}
  }finally{if(token===state.alignmentVersion){state.aligning=false;ready();}}
}

async function chooseSonar(file){
  const version=++state.version;state.alignmentVersion++;state.previewVersion++;state.sonar=file;state.frames=null;state.summary=null;state.previewScan=null;resetAlignment();$('recording-details').hidden=true;
  $('save-image').disabled=true;
  $('sonar-name').textContent=file?`${file.name} · ${sizeText(file.size)}`:'No file selected';
  $('sonar-name').title=file?.name||'';ready();
  if(!file){$('preview-placeholder').textContent='Choose a sonar file to see its echoes';return;}
  status('working','Reading SL3 frame headers…',0);
  try{
    const frames=await scanSl3(file,fraction=>{if(version===state.version)status('working',`Reading SL3 frame headers · ${Math.round(fraction*100)}%`,fraction);});
    if(version!==state.version)return;
    state.frames=frames;state.summary=recordingSummary(frames);state.previewStart=state.summary.previewStart;
    state.previewChannel=previewChannel(state.summary);channelChoices();
    details(state.summary);ready();status('ready',`${count(frames.length)} sonar frames ready · choose GPS logs to link scan points`);preview();
    if(state.bins.length)await alignSelection();
  }catch(error){if(version===state.version){status('error',`Could not read SL3 file: ${error.message}`);ready();}}
}

function setBins(files,{align=true}={}){state.alignmentVersion++;resetAlignment();state.bins=[...files];$('gps-name').textContent=state.bins.length?`${state.bins.length} GPS log${state.bins.length===1?'':'s'} selected`:'No files selected';const list=$('gps-list');list.replaceChildren();for(const file of state.bins){const item=document.createElement('span');item.textContent=`${file.name} · ${sizeText(file.size)}`;list.append(item);}ready();if(align&&state.frames&&state.bins.length)alignSelection();}

// Dropped files are sorted by extension: one SL3 recording and any number of BIN logs.
function dropFiles(files){
  const note=$('drop-note'),sonars=files.filter(file=>/\.sl3$/i.test(file.name)),bins=files.filter(file=>/\.bin$/i.test(file.name));
  const ignored=[...sonars.slice(1),...files.filter(file=>!/\.(sl3|bin)$/i.test(file.name))].map(file=>file.name);
  if(state.busy||state.aligning){note.textContent='Wait for the current step to finish, then drop the files again.';note.hidden=false;return;}
  note.textContent=ignored.length?`Ignored ${ignored.join(', ')}: drop one .sl3 recording and .BIN logs.`:'';note.hidden=!ignored.length;
  if(bins.length)setBins(bins,{align:!sonars.length});
  if(sonars.length)chooseSonar(sonars[0]);
}

const fileStem=()=>state.sonar.name.replace(/\.sl3$/i,'').replace(/[^\w.-]+/g,'_');
// One-off download; the object URL is released once the browser has had time to start saving.
function saveBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}

function saveImage(){
  const selection=state.selection,time=selection?.time??state.previewStart;
  const place=selection?`_${Math.abs(selection.lat).toFixed(5)}${selection.lat<0?'S':'N'}_${Math.abs(selection.lon).toFixed(5)}${selection.lon<0?'W':'E'}`:'';
  $('sonar-canvas').toBlob(blob=>{if(blob)saveBlob(blob,`${fileStem()}_${CHANNEL_LABELS[state.previewChannel]}_${durationText(time).replaceAll(' ','')}${place}.png`);},'image/png');
}

function saveRoute(format){
  const input={name:state.sonar.name,fixes:state.trackFixes,scans:state.scanPoints,offsetS:state.sync.offset_s,sonarStartS:state.summary.start,gpsOrigin:state.gps.origin};
  if(format==='gpx')saveBlob(new Blob([trackGpx(input)],{type:'application/gpx+xml'}),`${fileStem()}_route.gpx`);
  else saveBlob(new Blob([JSON.stringify(trackGeoJson(input),null,1)],{type:'application/geo+json'}),`${fileStem()}_route.geojson`);
}

// ---- 3D canal model ----
const seabedColour=()=>document.querySelector('input[name="seabed-colour"]:checked')?.value??'sonar';
function seabedTools(enabled){
  const model=state.seabed.model;
  for(const id of ['seabed-exaggeration','seabed-reset','seabed-save','seabed-contours','seabed-objects'])$(id).disabled=!enabled;
  $('seabed-shadows').disabled=!enabled||!model?.mosaic;
  $('seabed-cracks').disabled=!enabled||!state.cracks.result;
  document.querySelectorAll('input[name="seabed-colour"]').forEach(input=>{input.disabled=!enabled||input.value==='sonar'&&!model?.mosaic;});
}
function resetSeabed(message){
  const seabed=state.seabed;seabed.version++;seabed.building=false;seabed.model=null;seabed.selectedObject=-1;
  seabed.viewer?.clear();$('seabed-empty').hidden=false;seabedStatus(message);
  $('seabed-summary').textContent='Bed, banks, objects and shadows from sonar and GPS';$('build-seabed-label').textContent='Build 3D model';
  $('seabed-legend').replaceChildren();$('objects-table').tBodies[0].replaceChildren();$('section-chart').replaceChildren();
  seabedTools(false);
}

// The stretch to model: the chosen length of route centred on the selected point (or the preview
// window), as recording times from the first ping. null means the whole recording.
function stretchRange(choice,centreTime=null){
  const samples=state.samples;
  if(choice==='all'||samples.length<2)return null;
  // Distance along the route, stepping at least 3 m at a time so GPS jitter does not add up.
  const along=[0];let last=samples[0],base=0;
  for(let i=1;i<samples.length;i++){const d=metresBetween(last,samples[i]);if(d>=3){base+=d;last=samples[i];along.push(base);}else along.push(base+d);}
  for(let i=1;i<along.length;i++)along[i]=Math.max(along[i],along[i-1]);
  const centre=centreTime??state.selection?.time??state.previewStart+PREVIEW_SECONDS/2,total=along.at(-1);
  let k=0;for(let i=1;i<samples.length;i++)if(Math.abs(samples[i].time-centre)<Math.abs(samples[k].time-centre))k=i;
  let low=along[k]-Number(choice)/2,high=along[k]+Number(choice)/2;
  if(low<0){high=Math.min(total,high-low);low=0;}
  if(high>total){low=Math.max(0,low-(high-total));high=total;}
  const timeAt=d=>{let i=1;while(i<along.length-1&&along[i]<d)i++;const f=(d-along[i-1])/Math.max(1e-9,along[i]-along[i-1]);return samples[i-1].time+(samples[i].time-samples[i-1].time)*Math.max(0,Math.min(1,f));};
  return {start:timeAt(low),end:timeAt(high),length:high-low,centre};
}
// Enough vertical exaggeration for the relief to show: the depth range drawn at about 30 % of the canal's width.
function defaultExaggeration(model){
  const [port,starboard]=model.banks,width=port&&starboard?port.waterline+starboard.waterline:Math.min(model.maxU-model.minU,model.maxV-model.minV);
  return Math.min(20,Math.max(1,Math.round(width*.3/Math.max(.3,model.maxDepth-model.minDepth)*2)/2));
}

// centre: a recording time to centre the stretch on, instead of the selected point.
async function buildSeabed({centre=null}={}){
  const seabed=state.seabed,version=++seabed.version,{sonar,frames,gps,sync,scanPoints,summary}=state;
  const stretch=stretchRange($('seabed-stretch').value,centre),settings={draftM:Number($('seabed-draft').value),sensitivity:Number($('seabed-sensitivity').value),shading:Number($('seabed-shading').value)};
  seabed.building=true;ready();seabedTools(false);
  try{
    seabedStatus('Loading the 3D viewer…','working');
    const module=await import('./seabed-3d.js?v=e671d690ea');
    const timeRange=stretch&&[stretch.start+summary.start,stretch.end+summary.start];
    const model=await buildSeabedModel(sonar,frames,gps,sync,{scans:scanPoints,timeRange,...settings,progress:fraction=>{if(version===seabed.version)seabedStatus(`Reconstructing the canal from sonar and GPS · ${Math.round(fraction*100)}%`,'working');}});
    if(version!==seabed.version)return;
    try{seabed.viewer??=module.createSeabedViewer($('seabed-view'),{onSelectScan:index=>{selectScan(index);seabedStatus(`Scan ${index+1} is shown in the Sonar scan panel and the cross-section.`,'ok');},onSelectObject:selectObject,onSelectCrack:selectCrack});}
    catch(error){throw /webgl/i.test(error.message)?new Error('this browser has WebGL turned off'):error;}
    seabed.module=module;seabed.model=model;seabed.selectedObject=-1;
    const exaggeration=defaultExaggeration(model);
    $('seabed-exaggeration').value=String(exaggeration);$('seabed-exaggeration-value').textContent=`${exaggeration}×`;
    if(seabedColour()==='sonar'&&!model.mosaic)document.querySelector('input[name="seabed-colour"][value="depth"]').checked=true;
    $('seabed-empty').hidden=true;
    seabed.viewer.show(model,{exaggeration,colour:seabedColour(),overlays:{contours:$('seabed-contours').checked,shadows:$('seabed-shadows').checked&&Boolean(model.mosaic),objects:$('seabed-objects').checked,cracks:$('seabed-cracks').checked}});
    seabed.viewer.select(state.selection?.kind==='scan'?state.selection.index:-1);
    const length=model.sections.at(-1).along-model.sections[0].along,[port,starboard]=model.banks;
    $('seabed-summary').textContent=`${Math.round(length)} m of ${port||starboard?'canal':'survey'} · water up to ${model.maxDepth.toFixed(1)} m deep · ${model.objects.length} object${model.objects.length===1?'':'s'}`;
    const banks=port&&starboard?`banks found on both sides, waterline ${port.waterline.toFixed(1)} m to port and ${starboard.waterline.toFixed(1)} m to starboard`:port||starboard?`bank found to ${port?'port':'starboard'} only`:'no banks within sonar range';
    seabedStatus(`Built from ${count(model.pingsUsed)} ${model.mosaic?'sidescan pings':'soundings'} · ${banks}. Drag to rotate; click an object or a numbered point.`,'ok');
    $('build-seabed-label').textContent='Rebuild 3D model';
    seabed.viewer.setCracks(state.cracks.result,crackLines());
    drawLegend();drawObjects();updateSection();seabedTools(true);
    return true;
  }catch(error){if(version===seabed.version){seabedStatus(`Could not build the 3D model: ${error.message}`,'error');$('seabed-empty').hidden=false;}}
  finally{if(version===seabed.version){seabed.building=false;ready();}}
  return false;
}

// Colour key for the current colouring, plus the overlays that are switched on.
function drawLegend(){
  const box=$('seabed-legend'),{model,module}=state.seabed;box.replaceChildren();if(!model||!module)return;
  const colour=seabedColour()==='sonar'&&!model.mosaic?'depth':seabedColour(),legend=module.legendFor(colour,model);
  const key=(mark,text,extra)=>{const span=document.createElement('span');span.className=`key${extra?` ${extra}`:''}`;span.append(mark,document.createTextNode(text));box.append(span);};
  const swatch=(css,className='swatch')=>{const i=document.createElement('i');i.className=className;i.style.background=css;return i;};
  const chip=(css,kind)=>{const i=document.createElement('i');i.className=`chip chip-${kind}`;i.style.setProperty('--mark',css);return i;};
  if(legend.gradient){
    const span=document.createElement('span');span.className='key';
    span.append(document.createTextNode(legend.from),swatch(`linear-gradient(90deg,${legend.gradient.join(',')})`,'ramp'),document.createTextNode(legend.to));box.append(span);
    if(legend.note){const note=document.createElement('span');note.className='note';note.textContent=legend.note;box.append(note);}
  }
  for(const item of legend.items)key(swatch(item.color),item.label);
  const {OVERLAY_COLOURS:colours}=module;
  if($('seabed-contours').checked){key(chip('#ffffff','line'),`Contour every ${module.contourInterval(model)} m`);key(chip(colours.waterline,'line'),'Waterline');}
  if($('seabed-shadows').checked&&model.mosaic)key(chip(colours.shadow,'fill'),'Acoustic shadow');
  if($('seabed-objects').checked&&model.objects.length)key(chip(colours.marker,'label'),'Object, with height');
  if($('seabed-cracks').checked&&state.cracks.result){
    const kinds=new Set(shownCracks().map(({c})=>crackColour(c)));
    for(const [mark,text] of [[CRACK_COLOURS.crack,'Possible crack'],[CRACK_COLOURS.joint,'Joint'],[CRACK_COLOURS.edge,'Lit edge']])if(kinds.has(mark))key(chip(mark,'line'),text);
    key(chip('#f2f5f7','area'),colour==='sonar'?'Screened for cracks, at full detail':'Screened for cracks');
  }
}

// Detected objects, one row each; a row selects the object in 3D, the scan preview and the cross-section.
function drawObjects(){
  const body=$('objects-table').tBodies[0],objects=state.seabed.model?.objects??[];body.replaceChildren();
  for(const [index,object] of objects.entries()){
    const row=body.insertRow();row.tabIndex=0;row.dataset.index=String(index);row.setAttribute('aria-selected',String(index===state.seabed.selectedObject));
    const size=`${object.length.toFixed(1)} × ${object.width.toFixed(1)} m`;
    for(const text of [String(object.id),object.kind==='object'?'Raised':'Hollow',`${Math.round(object.height*100)} cm`,size,`${object.offsetM.toFixed(1)} m ${object.side}`,`${Math.round(object.alongM)} m`])row.insertCell().textContent=text;
    row.title=`Object ${object.id}: ${object.kind==='object'?'stands':'dips'} about ${Math.round(object.height*100)} cm ${object.kind==='object'?'above':'below'} the bed, seen in ${object.pings} pings`;
  }
  $('objects-caption').textContent=objects.length?`${objects.length} found · heights from shadow length`:'From their sonar shadows';
}
function markObject(index){
  state.seabed.selectedObject=index;
  for(const row of $('objects-table').tBodies[0].rows)row.setAttribute('aria-selected',String(Number(row.dataset.index)===index));
  state.seabed.viewer?.selectObject(index);
}
function selectObject(index){
  const object=state.seabed.model?.objects[index];if(!object)return;
  markObject(index);
  select({kind:'point',time:object.time-state.summary.start,lat:object.lat,lon:object.lon,object:index});
  state.seabed.viewer?.focusObject(index);
  seabedStatus(`Object ${object.id}: ${object.kind==='object'?'raised':'hollow'}, about ${Math.round(object.height*100)} cm. Its scan is in the Sonar scan panel.`,'ok');
}

// ---- Cross-section at the selected point ----
const SVG='http://www.w3.org/2000/svg';
function svg(name,attributes={},parent){const element=document.createElementNS(SVG,name);for(const [key,value] of Object.entries(attributes))element.setAttribute(key,String(value));parent?.append(element);return element;}
function niceStep(range,target){const raw=range/target,power=10**Math.floor(Math.log10(raw));return [1,2,2.5,5,10].map(m=>m*power).find(step=>step>=raw)??10*power;}

function updateSection(){
  const chart=$('section-chart'),{model,viewer}=state.seabed;chart.replaceChildren();
  if(!model)return;
  const time=state.selection?state.selection.time+state.summary.start:null,sections=model.sections;
  const inside=time!=null&&time>=sections[0].time-5&&time<=sections.at(-1).time+5;
  if(!inside){
    viewer?.setSection(null);$('section-caption').textContent='Select a point in this stretch';
    const note=document.createElement('p');note.className='empty';note.textContent=time==null?'Select a scan point, an object or a place on the route to see the canal’s cross-section there.':'The selected point is outside this model’s stretch. Rebuild the model around it, or pick a point inside.';chart.append(note);return;
  }
  const section=sections.reduce((best,s)=>Math.abs(s.time-time)<Math.abs(best.time-time)?s:best);
  const reach=side=>Math.min(20,side.open?side.reach:side.waterline+1.5),port=reach(section.sides[0]),starboard=reach(section.sides[1]);
  const at=o=>[section.x+o*section.lx,section.y+o*section.ly],points=[];
  for(let o=port;o>=-starboard-1e-9;o-=.1){const [x,y]=at(o),depth=seabedDepthAt(model,x,y);if(!Number.isNaN(depth))points.push({o,depth,base:seabedBaseAt(model,x,y)});}
  viewer?.setSection({x:section.x,y:section.y,lx:section.lx,ly:section.ly,port,starboard});
  if(points.length<3){const note=document.createElement('p');note.className='empty';note.textContent='No reconstructed canal at this point.';chart.append(note);return;}
  // Objects whose extent along the track crosses this section.
  const objects=model.objects.filter(o=>Math.abs(o.alongM-section.along)<=o.length/2+.4).map(o=>({...o,o:o.side==='port'?o.offsetM:-o.offsetM}));
  const [portBank,starboardBank]=section.sides,width=(portBank.open?null:portBank.waterline)!=null&&!starboardBank.open?portBank.waterline+starboardBank.waterline:null;
  drawSectionChart(chart,{points,section,objects,port,starboard,width});
}

function drawSectionChart(chart,{points,section,objects,port,starboard,width}){
  // Drawn at the width it is shown, so its text stays the same size on a phone.
  const W=Math.round(Math.max(300,Math.min(720,chart.clientWidth||560))),H=W<460?210:230,m={l:44,r:14,t:26,b:30},iw=W-m.l-m.r,ih=H-m.t-m.b;
  const top=Math.min(-.3,...points.map(p=>p.depth)),bottom=Math.max(...points.map(p=>p.depth),...points.map(p=>p.base).filter(Number.isFinite),section.D)*1.1+.05;
  const X=o=>m.l+(port-o)/(port+starboard)*iw,Y=d=>m.t+(d-top)/(bottom-top)*ih;
  const verticalScale=(ih/(bottom-top))/(iw/(port+starboard));
  const root=svg('svg',{viewBox:`0 0 ${W} ${H}`,role:'img',tabindex:0,'aria-label':`Cross-section of the canal at the selected point. Use the left and right arrow keys to read depths across it.`});
  // Depth grid and axis.
  const grid=svg('g',{class:'grid'},root),axis=svg('g',{class:'axis'},root),step=niceStep(bottom-Math.max(0,top),4);
  for(let d=0;d<=bottom;d+=step){svg('line',{x1:m.l,x2:W-m.r,y1:Y(d),y2:Y(d)},grid);svg('text',{x:m.l-6,y:Y(d)+3.5,'text-anchor':'end'},axis).textContent=`${+d.toFixed(2)} m`;}
  const across=niceStep(port+starboard,6);
  for(let o=-Math.floor(starboard/across)*across;o<=port+1e-9;o+=across){svg('line',{x1:X(o),x2:X(o),y1:H-m.b,y2:H-m.b+4},axis);svg('text',{x:X(o),y:H-m.b+15,'text-anchor':'middle'},axis).textContent=`${Math.abs(+o.toFixed(1))}`;}
  svg('text',{x:m.l,y:H-3,'text-anchor':'start'},axis).textContent='← Port (m from boat)';
  svg('text',{x:W-m.r,y:H-3,'text-anchor':'end'},axis).textContent='Starboard →';
  // Water above the bed, ground below it.
  const bedPath=points.map((p,i)=>`${i?'L':'M'}${X(p.o).toFixed(1)},${Y(p.depth).toFixed(1)}`).join('');
  svg('path',{d:`${bedPath}L${X(points.at(-1).o)},${Y(bottom)}L${X(points[0].o)},${Y(bottom)}Z`,fill:'var(--chart-ground)'},root);
  const wet=points.map(p=>({o:p.o,d:Math.max(0,p.depth)}));
  svg('path',{d:`${wet.map((p,i)=>`${i?'L':'M'}${X(p.o).toFixed(1)},${Y(p.d).toFixed(1)}`).join('')}L${X(wet.at(-1).o)},${Y(0)}L${X(wet[0].o)},${Y(0)}Z`,fill:'var(--chart-water)'},root);
  svg('line',{class:'surface-line',x1:m.l,x2:W-m.r,y1:Y(0),y2:Y(0)},root);
  // Waterline and toe marks.
  section.sides.forEach((side,k)=>{
    if(side.open)return;const sign=k===0?1:-1;
    for(const [distance,text] of [[side.waterline,'waterline'],[side.toe,'toe']]){
      if(distance==null||distance>(k===0?port:starboard))continue;
      const x=X(sign*distance),y=text==='waterline'?Y(0):Y(points.reduce((b,p)=>Math.abs(p.o-sign*distance)<Math.abs(b.o-sign*distance)?p:b).depth);
      svg('line',{x1:x,x2:x,y1:y-5,y2:y+5,stroke:'var(--muted)','stroke-width':1},root);
      svg('text',{class:'annotation',x:Math.max(m.l+26,Math.min(W-m.r-26,x)),y:text==='waterline'?y-8:y+15,'text-anchor':'middle'},root).textContent=text;
    }
  });
  // The smooth canal shape, then the reconstructed bed on top.
  const basePoints=points.filter(p=>Number.isFinite(p.base));
  if(basePoints.length>2)svg('path',{d:basePoints.map((p,i)=>`${i?'L':'M'}${X(p.o).toFixed(1)},${Y(p.base).toFixed(1)}`).join(''),fill:'none',stroke:'var(--chart-shape)','stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'},root);
  svg('path',{d:bedPath,fill:'none',stroke:'var(--chart-bed)','stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'},root);
  // Depth measured under the boat, labelled directly.
  svg('circle',{cx:X(0),cy:Y(section.D),r:4.5,fill:'var(--chart-measured)',stroke:'var(--surface-2)','stroke-width':2},root);
  svg('text',{class:'label',x:X(0)+8,y:Y(section.D)-8},root).textContent=`${section.D.toFixed(2)} m measured`;
  // Objects crossing this section, labelled with number and height.
  for(const o of objects){
    if(o.o>port||o.o<-starboard)continue;
    const x=X(o.o),y=Y(o.topDepth);
    svg('path',{d:`M${x},${y-2}l-5,-9h10z`,fill:'var(--ink)'},root);
    svg('text',{class:'label',x,y:y-15,'text-anchor':'middle'},root).textContent=`#${o.id} ${Math.round(o.height*100)} cm`;
  }
  // Hover and keyboard readout: a crosshair snapped to the nearest sample.
  const cross=svg('line',{y1:m.t,y2:H-m.b,stroke:'var(--muted)','stroke-width':1,visibility:'hidden'},root);
  const tip=document.createElement('div');tip.className='chart-tooltip';tip.hidden=true;
  let current=points.findIndex(p=>Math.abs(p.o)<.06);if(current<0)current=Math.floor(points.length/2);
  const show=index=>{
    current=Math.max(0,Math.min(points.length-1,index));const p=points[current],x=X(p.o);
    cross.setAttribute('x1',x);cross.setAttribute('x2',x);cross.setAttribute('visibility','visible');
    tip.replaceChildren();
    const where=document.createElement('div');where.textContent=Math.abs(p.o)<.05?'Under the boat':`${Math.abs(p.o).toFixed(1)} m to ${p.o>0?'port':'starboard'}`;tip.append(where);
    const row=(value,text,css)=>{const div=document.createElement('div');div.className='row';const key=document.createElement('i');key.style.borderColor=css;const strong=document.createElement('strong');strong.textContent=value;div.append(key,strong,document.createTextNode(` ${text}`));tip.append(div);};
    row(p.depth<0?`${(-p.depth).toFixed(2)} m`:`${p.depth.toFixed(2)} m`,p.depth<0?'above water (bank)':'deep, reconstructed','var(--chart-bed)');
    if(Number.isFinite(p.base)&&p.depth>=0)row(`${(p.base-p.depth>=0?'+':'−')}${Math.abs((p.base-p.depth)*100).toFixed(0)} cm`,'vs smooth shape','var(--chart-shape)');
    const box=chart.getBoundingClientRect(),scale=box.width/W;tip.hidden=false;
    tip.style.left=`${Math.min(box.width-tip.offsetWidth-4,Math.max(0,x*scale+10))}px`;tip.style.top=`${m.t*scale}px`;
  };
  const hide=()=>{cross.setAttribute('visibility','hidden');tip.hidden=true;};
  root.addEventListener('pointermove',event=>{const box=root.getBoundingClientRect(),x=(event.clientX-box.left)*W/box.width,o=port-(x-m.l)/iw*(port+starboard);let best=0;points.forEach((p,i)=>{if(Math.abs(p.o-o)<Math.abs(points[best].o-o))best=i;});show(best);});
  root.addEventListener('pointerleave',hide);root.addEventListener('focus',()=>show(current));root.addEventListener('blur',hide);
  root.addEventListener('keydown',event=>{const stepBy={ArrowLeft:-5,ArrowRight:5,Home:-points.length,End:points.length}[event.key];if(stepBy==null)return;event.preventDefault();show(current+stepBy);});
  const legend=document.createElement('div');legend.className='chart-legend';
  for(const [css,text,dot] of [['var(--chart-bed)','Reconstructed bed'],['var(--chart-shape)','Smooth canal shape'],['var(--chart-measured)','Measured under the boat',true]]){
    const span=document.createElement('span'),i=document.createElement('i');if(dot){i.className='dot';i.style.background=css;}else i.style.borderColor=css;span.append(i,document.createTextNode(text));legend.append(span);
  }
  chart.append(root,tip,legend);
  const label=state.selection?.kind==='scan'?`Scan ${state.selection.index+1}`:state.selection?.object!=null?`Object ${state.seabed.model.objects[state.selection.object].id}`:'Route point';
  $('section-caption').textContent=`${label}${width?` · ${width.toFixed(1)} m wide at the waterline`:''} · depth drawn ${verticalScale>=1.5?`${verticalScale.toFixed(0)}× exaggerated`:'to scale'}`;
}

// ---- Crack screening ----
const CRACK_LEVELS={high:'High',medium:'Medium',low:'Low'};
const crackColour=c=>c.kind==='joint'?CRACK_COLOURS.joint:c.polarity==='bright'?CRACK_COLOURS.edge:CRACK_COLOURS.crack;
const shortCrackLabel=c=>c.kind==='joint'?'Joint':c.polarity==='bright'?'Edge':'Crack';
function crackLabel(c){
  if(c.kind==='joint')return 'Joint';
  if(c.kind==='edge')return 'Lit edge';
  if(c.kind==='step')return c.detail.startsWith('raised')?'Raised edge':'Step up';
  return c.detail.startsWith('open crack')?'Open crack':c.direction==='along'?'Crack or step down':'Crack';
}
const shownCracks=()=>(state.cracks.result?.candidates??[]).map((c,index)=>({c,index})).filter(({c,index})=>c.confidence!=='low'||$('crack-show-low').checked||index===state.cracks.selected);
const crackLines=()=>shownCracks().map(({c,index})=>({index,local:c.local,colour:crackColour(c),selected:index===state.cracks.selected,
  label:c.confidence!=='low'||index===state.cracks.selected?`${shortCrackLabel(c)} ${c.id} · ${c.lengthM.toFixed(1)} m`:null}));
function crackTools(enabled){
  for(const id of ['crack-contrast','crack-show-low','crack-download','crack-3d'])$(id).disabled=!enabled||!state.cracks.result;
  $('seabed-cracks').disabled=!state.seabed.model||!state.cracks.result;
}
function resetCracks(message){
  const cracks=state.cracks;cracks.version++;cracks.running=false;cracks.result=null;cracks.selected=-1;
  cracks.view?.clear();$('crack-empty').hidden=false;crackStatus(message);
  $('crack-summary').textContent='Possible cracks, joints and displaced panels in the lining';$('find-cracks-label').textContent='Find possible cracks';
  $('crack-table').tBodies[0].replaceChildren();$('crack-legend').replaceChildren();delete $('crack-table').parentElement.dataset.screened;crackTools(false);
  state.seabed.viewer?.setCracks(null,[]);if(state.seabed.model)drawLegend();
}
async function findCracks(){
  const cracks=state.cracks,version=++cracks.version,{sonar,frames,gps,sync,summary}=state,stretch=stretchRange($('crack-stretch').value);
  cracks.centre=stretch?.centre??null;
  cracks.running=true;ready();crackTools(false);
  try{
    const timeRange=stretch&&[stretch.start+summary.start,stretch.end+summary.start];
    const result=await inspectLining(sonar,frames,gps,sync,{timeRange,draftM:Number($('seabed-draft').value),sensitivity:Number($('crack-sensitivity').value),minLengthM:Number($('crack-min-length').value),
      progress:fraction=>{if(version===cracks.version)crackStatus(`Screening the lining at full detail · ${Math.round(fraction*100)}%`,'working');}});
    if(version!==cracks.version)return;
    cracks.result=result;cracks.selected=-1;
    cracks.view??=createInspectView($('crack-view'),{onSelect:selectCrack,onPick:pickTime});
    $('crack-empty').hidden=true;
    cracks.view.setContrast(Number($('crack-contrast').value));cracks.view.setShowLow($('crack-show-low').checked);cracks.view.show(result);
    const count=level=>result.candidates.filter(c=>c.confidence===level).length;
    $('crack-summary').textContent=`${Math.round(result.stats.lengthM)} m screened · ${count('high')} high and ${count('medium')} medium confidence`;
    crackStatus(`Screened ${count('high')+count('medium')?`${Math.round(result.stats.lengthM)} m of canal: ${count('high')} high and ${count('medium')} medium-confidence lines to check`:`${Math.round(result.stats.lengthM)} m of canal: no clear lines`}${count('low')?` · ${count('low')} faint lines hidden`:''}. Click a line or a row to see its scan.`,'ok');
    $('find-cracks-label').textContent='Screen again';
    $('crack-table').parentElement.dataset.screened='';
    const faint=count('low');
    $('crack-none').textContent=faint?`No clear lines in this stretch. ${faint} faint ${faint===1?'one is':'ones are'} hidden: tick Show faint lines to see ${faint===1?'it':'them'}.`:'No lines stand out of the speckle in this stretch.';
    drawCracks();drawCrackLegend();crackTools(true);
    state.seabed.viewer?.setCracks(result,crackLines());if(state.seabed.model)drawLegend();
  }catch(error){if(version===cracks.version){crackStatus(`Could not screen this stretch: ${error.message}`,'error');}}
  finally{if(version===cracks.version){cracks.running=false;ready();}}
}
function drawCracks(){
  const body=$('crack-table').tBodies[0];body.replaceChildren();
  for(const {c,index} of shownCracks()){
    const row=body.insertRow();row.tabIndex=0;row.dataset.index=String(index);row.setAttribute('aria-selected',String(index===state.cracks.selected));
    row.insertCell().textContent=String(c.id);
    const what=row.insertCell(),kind=document.createElement('span'),mark=document.createElement('i');kind.className='kind';mark.style.setProperty('--mark',crackColour(c));kind.append(mark,document.createTextNode(crackLabel(c)));what.append(kind);
    for(const text of [c.direction==='along'?'Along':c.direction==='across'?'Across':'Diagonal',`${c.lengthM.toFixed(1)} m`,c.sizeCm!=null?`≈${c.sizeCm} cm`:'—',c.side==='both'?'Both sides':`${c.offsetM.toFixed(1)} m ${c.side}`,`${Math.round(c.alongM)} m`])row.insertCell().textContent=text;
    const level=row.insertCell(),span=document.createElement('span');span.className=`level level-${c.confidence}`;span.append(document.createElement('i'),document.createTextNode(CRACK_LEVELS[c.confidence]));level.append(span);
    row.title=`${c.id}: ${c.detail}`;
  }
}
function drawCrackLegend(){
  const box=$('crack-legend');box.replaceChildren();
  const key=(style,text)=>{const span=document.createElement('span'),i=document.createElement('i');span.className='key';i.className='chip chip-line';i.style.setProperty('--mark',style.colour);if(style.dash)i.dataset.dash=style.dash;span.append(i,document.createTextNode(text));box.append(span);};
  key({colour:CRACK_COLOURS.crack},'Dark line: crack, gap or shadow');key({colour:CRACK_COLOURS.joint},'Joint');key({colour:CRACK_COLOURS.edge},'Lit edge');
  for(const [dash,text] of [['solid','High confidence'],['dashed','Medium'],['dotted','Low']])key({colour:'var(--viz-ink)',dash},text);
}
function markCrack(index){
  state.cracks.selected=index;
  for(const row of $('crack-table').tBodies[0].rows)row.setAttribute('aria-selected',String(Number(row.dataset.index)===index));
  if(state.cracks.result){state.cracks.view?.select(index);state.seabed.viewer?.setCrackLines(crackLines());}
}
function selectCrack(index){
  const c=state.cracks.result?.candidates[index];if(!c)return;
  markCrack(index);drawCracks();
  const [[lon0,lat0],[lon1,lat1]]=c.lonlat;
  select({kind:'point',time:c.time-state.summary.start,lat:(lat0+lat1)/2,lon:(lon0+lon1)/2,crack:index});
  const in3d=state.seabed.viewer?.focusLine(c.local,c.side);
  crackStatus(`Line ${c.id}: ${c.detail}, ${c.lengthM.toFixed(1)} m long. Its scan is in the Sonar scan panel${in3d?', and the 3D model shows it':''}.`,'ok');
  if(in3d)seabedStatus(`${shortCrackLabel(c)} ${c.id}: ${c.lengthM.toFixed(1)} m, ${c.side==='both'?'across the canal':`${c.offsetM.toFixed(1)} m to ${c.side}`}. Its scan is in the Sonar scan panel.`,'ok');
}
// Shows the screened stretch (or the selected line) in the 3D model, building a model around it if needed.
async function viewCracksIn3D(){
  const cracks=state.cracks,result=cracks.result;if(!result)return;
  const rows=result.track.length/4,middle=Math.floor(rows/2)*4,reaches=()=>[0,middle,(rows-1)*4].every(t=>state.seabed.viewer?.covers(result.track[t],result.track[t+1]));
  if(!state.seabed.model||!reaches()){
    if(state.seabed.building)return;
    $('seabed-view').scrollIntoView({behavior:'smooth',block:'center'});
    if(!await buildSeabed({centre:cracks.centre})||cracks.result!==result)return;
  }
  if(!$('seabed-cracks').checked){$('seabed-cracks').checked=true;state.seabed.viewer.setOverlay('cracks',true);drawLegend();}
  $('seabed-view').scrollIntoView({behavior:'smooth',block:'center'});
  const c=result.candidates[cracks.selected];
  if(c)state.seabed.viewer.focusLine(c.local,c.side);else state.seabed.viewer.focusCrackArea();
  seabedStatus(`The screened stretch is outlined on the bed${seabedColour()==='sonar'?' and shown at full detail':''}. Click a numbered line to see its scan.`,'ok');
}
// A click on the inspection image shows the scan recorded there.
function pickTime(time){
  const t=time-state.summary.start,samples=state.samples;if(!samples.length)return;
  const nearest=samples.reduce((best,s)=>Math.abs(s.time-t)<Math.abs(best.time-t)?s:best);
  select({kind:'point',time:t,lat:nearest.lat,lon:nearest.lon});
}

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
    const stem=fileStem();
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

// Colour theme: match this device, light or dark. The choice is remembered in this browser only.
const THEME_KEY='sonar-studio-theme';
function setTheme(choice){
  if(choice==='auto')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=choice;
  try{if(choice==='auto')localStorage.removeItem(THEME_KEY);else localStorage.setItem(THEME_KEY,choice);}catch{}
}
document.querySelectorAll('input[name="theme"]').forEach(input=>{
  input.checked=input.value===(document.documentElement.dataset.theme??'auto');
  input.addEventListener('change',()=>setTheme(input.value));
});

const routeMap=createRouteMap($('route-map'),{onSelectScan:selectScan,onPick:pickRoutePoint});
// The map background is opt-in; remember the choice in this browser only.
const BASEMAP_KEY='sonar-studio-basemap';
function setBasemap(on){
  routeMap.setBasemap(on);$('basemap-toggle').checked=on;
  $('basemap-note').textContent=on?'Map © OpenStreetMap contributors':'Diagram of GPS track · no basemap';
  try{if(on)localStorage.setItem(BASEMAP_KEY,'1');else localStorage.removeItem(BASEMAP_KEY);}catch{}
}
try{if(localStorage.getItem(BASEMAP_KEY)==='1')setBasemap(true);}catch{}
$('basemap-toggle').addEventListener('change',event=>setBasemap(event.target.checked));
// A dialog that ends with no files (cancelled, or cleared by the browser) keeps the files already loaded.
$('sonar-input').addEventListener('change',event=>{if(event.target.files.length)chooseSonar(event.target.files[0]);});
$('gps-input').addEventListener('change',event=>{if(event.target.files.length)setBins(event.target.files);});
$('entire-file').addEventListener('change',event=>{$('start-seconds').disabled=event.target.checked;$('duration-seconds').disabled=event.target.checked;});
document.querySelectorAll('#channel-list input').forEach(input=>input.addEventListener('change',ready));
$('export-button').addEventListener('click',exportFiles);
$('use-preview-window').addEventListener('click',()=>{
  const {start,end}=state.previewWindow;
  $('entire-file').checked=false;$('start-seconds').value=String(start);$('duration-seconds').value=String(end-start);ready();
});
const dragHasFiles=event=>[...(event.dataTransfer?.types??[])].includes('Files');
document.addEventListener('dragover',event=>{if(!dragHasFiles(event))return;event.preventDefault();event.dataTransfer.dropEffect='copy';$('drop-overlay').hidden=false;});
document.addEventListener('dragleave',event=>{if(!event.relatedTarget)$('drop-overlay').hidden=true;});
document.addEventListener('drop',event=>{if(!dragHasFiles(event))return;event.preventDefault();$('drop-overlay').hidden=true;dropFiles([...event.dataTransfer.files]);});
$('preview-previous').addEventListener('click',()=>{if(state.scanPoints.length)selectScan(neighbourScan(-1));else{state.previewStart=Math.max(0,state.previewStart-PREVIEW_SECONDS);preview();}});
$('preview-next').addEventListener('click',()=>{if(state.scanPoints.length)selectScan(neighbourScan(1));else{state.previewStart=Math.min(Math.max(0,state.summary.duration-PREVIEW_SECONDS),state.previewStart+PREVIEW_SECONDS);preview();}});
document.querySelectorAll('input[name="preview-channel"]').forEach(input=>input.addEventListener('change',()=>{state.previewChannel=Number(input.value);preview();}));
for(const id of ['preview-contrast','preview-brightness'])$(id).addEventListener('input',()=>{if(state.previewScan&&!$('sonar-canvas').hidden)drawPreview();});
$('save-image').addEventListener('click',saveImage);
$('download-gpx').addEventListener('click',()=>saveRoute('gpx'));
$('build-seabed').addEventListener('click',()=>buildSeabed());
$('seabed-exaggeration').addEventListener('input',event=>{const value=Number(event.target.value);$('seabed-exaggeration-value').textContent=`${value}×`;state.seabed.viewer?.setExaggeration(value);});
document.querySelectorAll('input[name="seabed-colour"]').forEach(input=>input.addEventListener('change',()=>{state.seabed.viewer?.setColour(input.value);drawLegend();}));
for(const [id,name] of [['seabed-contours','contours'],['seabed-shadows','shadows'],['seabed-objects','objects'],['seabed-cracks','cracks']])$(id).addEventListener('change',event=>{state.seabed.viewer?.setOverlay(name,event.target.checked);drawLegend();});
for(const [id,format] of [['seabed-draft',v=>`${v.toFixed(2)} m`],['seabed-sensitivity',v=>`${Math.round(v*100)}%`],['seabed-shading',v=>`${Math.round(v*100)}%`]]){
  $(id).addEventListener('input',event=>{$(`${id}-value`).textContent=format(Number(event.target.value));if(state.seabed.model)seabedStatus('Settings changed · rebuild the model to apply them.','warn');});
}
// Redraw the cross-section when its panel changes width.
{let width=0;new ResizeObserver(([entry])=>{const next=Math.round(entry.contentRect.width);if(Math.abs(next-width)>16&&state.seabed.model){width=next;updateSection();}else width=next;}).observe($('section-chart'));}
$('find-cracks').addEventListener('click',findCracks);
for(const [id,format] of [['crack-sensitivity',v=>`${Math.round(v*100)}%`],['crack-min-length',v=>`${v.toFixed(1)} m`]]){
  $(id).addEventListener('input',event=>{$(`${id}-value`).textContent=format(Number(event.target.value));if(state.cracks.result)crackStatus('Settings changed · screen again to apply them.','warn');});
}
$('crack-contrast').addEventListener('input',event=>{$('crack-contrast-value').textContent=event.target.value;state.cracks.view?.setContrast(Number(event.target.value));});
$('crack-show-low').addEventListener('change',event=>{state.cracks.view?.setShowLow(event.target.checked);drawCracks();state.seabed.viewer?.setCrackLines(crackLines());if(state.seabed.model)drawLegend();});
$('crack-3d').addEventListener('click',viewCracksIn3D);
// The download holds the lines listed in the table (faint ones only while they are shown).
$('crack-download').addEventListener('click',()=>{const result=state.cracks.result;if(result)saveBlob(new Blob([JSON.stringify(candidatesGeoJson({...result,candidates:shownCracks().map(({c})=>c)},{name:state.sonar.name}),null,1)],{type:'application/geo+json'}),`${fileStem()}_crack_candidates.geojson`);});
$('crack-table').addEventListener('click',event=>{const row=event.target.closest('tr[data-index]');if(row)selectCrack(Number(row.dataset.index));});
$('crack-table').addEventListener('keydown',event=>{const row=event.target.closest('tr[data-index]');if(!row)return;
  if(event.key==='Enter'||event.key===' '){event.preventDefault();selectCrack(Number(row.dataset.index));}
  else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();(event.key==='ArrowDown'?row.nextElementSibling:row.previousElementSibling)?.focus();}});
$('objects-table').addEventListener('click',event=>{const row=event.target.closest('tr[data-index]');if(row)selectObject(Number(row.dataset.index));});
$('objects-table').addEventListener('keydown',event=>{const row=event.target.closest('tr[data-index]');if(!row)return;
  if(event.key==='Enter'||event.key===' '){event.preventDefault();selectObject(Number(row.dataset.index));}
  else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();(event.key==='ArrowDown'?row.nextElementSibling:row.previousElementSibling)?.focus();}});
$('seabed-reset').addEventListener('click',()=>state.seabed.viewer?.resetView());
$('seabed-save').addEventListener('click',async()=>{const blob=await state.seabed.viewer?.toBlob();if(blob)saveBlob(blob,`${fileStem()}_seabed_3d.png`);});
$('download-geojson').addEventListener('click',()=>saveRoute('geojson'));
window.addEventListener('beforeunload',()=>state.urls.forEach(url=>URL.revokeObjectURL(url)));
