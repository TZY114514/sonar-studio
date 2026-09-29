import {FileWindow,scanSl3,scanBin,combineFixes,findAlignment,matchedGpsForFrame,nearestSample,exportAligned,recordingSummary,trackGeoJson,trackGpx,buildSeabedModel} from './engine.js';
import {createRouteMap} from './route-map.js';
import {renderScan} from './scan-image.js';

const $=id=>document.getElementById(id);
const PREVIEW_SECONDS=30;
const state={sonar:null,bins:[],frames:null,summary:null,gps:null,sync:null,route:[],trackFixes:[],samples:[],scanPoints:[],selection:null,previewStart:0,previewWindow:null,previewChannel:null,previewScan:null,version:0,alignmentVersion:0,previewVersion:0,aligning:false,busy:false,urls:[],seabed:{viewer:null,model:null,building:false,version:0}};
const count=value=>Number(value||0).toLocaleString('en-US');
const durationText=seconds=>{const s=Math.max(0,Math.round(seconds));return `${Math.floor(s/3600)}h ${String(Math.floor(s%3600/60)).padStart(2,'0')}m ${String(s%60).padStart(2,'0')}s`;};
const clockText=seconds=>{const s=Math.max(0,Math.round(seconds)),h=Math.floor(s/3600),m=Math.floor(s%3600/60),rest=String(s%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${rest}`:`${m}:${rest}`;};
const CHANNEL_LABELS={5:'sidescan',2:'downscan'};
const CHANNEL_GUIDES={5:'Bright bands show stronger echoes. The dark center band is directly beneath the boat. Colors are enhanced for display.',
  2:'Bright bands show stronger echoes. The top edge is the water surface and depth increases downward. Colors are enhanced for display.'};
// Preview sidescan when the recording has it, otherwise downscan.
const previewChannel=summary=>summary?.counts.sidescan?5:summary?.counts.downscan?2:null;
const sizeText=bytes=>bytes>=1e9?`${(bytes/1e9).toFixed(2)} GB`:`${(bytes/1e6).toFixed(1)} MB`;

// Status lines carry a state (idle, working, ok, warn or error) that the stylesheet shows as an icon.
function setStatus(id,text,state='idle'){const line=$(id);line.textContent=text;line.dataset.state=state;}
const routeStatus=(text,state)=>setStatus('route-status',text,state);
const seabedStatus=(text,state)=>setStatus('seabed-status',text,state);

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
  $('build-seabed').disabled=!(state.sync?.trusted&&state.trackFixes.length>=2&&!state.aligning&&!state.busy&&!state.seabed.building);
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
  $('route-source').textContent='Waiting for files';
  routeStatus('Choose a sonar file and GPS logs to link the route to its scans.');
  $('scan-details').textContent='The scan time and GPS coordinates will appear here.';
  drawRoute();
}

// selection: {kind:'scan',index,time,lat,lon} for a numbered point, or {kind:'point',time,lat,lon} for a route click.
function select(selection){
  state.selection=selection;
  state.previewStart=Math.max(0,Math.min(Math.max(0,state.summary.duration-PREVIEW_SECONDS),selection.time-PREVIEW_SECONDS/2));
  const label=selection.kind==='scan'?`Scan ${selection.index+1}`:'Route point';
  $('scan-details').textContent=`${label} · Recording time ${durationText(selection.time)} · GPS ${Math.abs(selection.lat).toFixed(6)}° ${selection.lat<0?'S':'N'}, ${Math.abs(selection.lon).toFixed(6)}° ${selection.lon<0?'W':'E'}`;
  routeMap.select(selection);state.seabed.viewer?.select(selection.kind==='scan'?selection.index:-1);preview();ready();
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

// ---- 3D seabed model ----
function seabedTools(enabled){
  for(const id of ['seabed-exaggeration','seabed-reset','seabed-save'])$(id).disabled=!enabled;
  document.querySelectorAll('input[name="seabed-texture"]').forEach(input=>{input.disabled=!enabled||input.value==='sonar'&&!state.seabed.model?.mosaic;});
}
function resetSeabed(message){
  const seabed=state.seabed;seabed.version++;seabed.building=false;seabed.model=null;
  seabed.viewer?.clear();$('seabed-empty').hidden=false;seabedStatus(message);
  $('seabed-summary').textContent='Sonar depth, sidescan and GPS combined';seabedTools(false);
}
async function buildSeabed(){
  const seabed=state.seabed,version=++seabed.version,{sonar,frames,gps,sync,scanPoints}=state;
  seabed.building=true;ready();seabedTools(false);
  try{
    seabedStatus('Loading the 3D viewer…','working');
    const {createSeabedViewer}=await import('./seabed-3d.js');
    const model=await buildSeabedModel(sonar,frames,gps,sync,{scans:scanPoints,progress:fraction=>{if(version===seabed.version)seabedStatus(`Building the seabed from sonar and GPS · ${Math.round(fraction*100)}%`,'working');}});
    if(version!==seabed.version)return;
    try{seabed.viewer??=createSeabedViewer($('seabed-view'),{onSelectScan:index=>{selectScan(index);seabedStatus(`Scan ${index+1} is shown in the Sonar scan panel.`,'ok');}});}
    catch(error){throw /webgl/i.test(error.message)?new Error('this browser has WebGL turned off'):error;}
    seabed.model=model;
    // Start with enough vertical exaggeration for the relief to show: about a tenth of the survey's width.
    const width=model.maxX-model.minX,height=model.maxY-model.minY,relief=Math.max(.5,model.maxDepth-model.minDepth);
    const exaggeration=Math.min(20,Math.max(1,Math.round(Math.max(width,height)*.1/relief*2)/2));
    $('seabed-exaggeration').value=String(exaggeration);$('seabed-exaggeration-value').textContent=`${exaggeration}×`;
    const texture=model.mosaic?'sonar':'depth';
    document.querySelectorAll('input[name="seabed-texture"]').forEach(input=>{input.checked=input.value===texture;});
    $('seabed-empty').hidden=true;
    seabed.viewer.show(model,{exaggeration,texture});
    seabed.viewer.select(state.selection?.kind==='scan'?state.selection.index:-1);
    $('seabed-summary').textContent=`${Math.round(width)} × ${Math.round(height)} m · depth ${model.minDepth.toFixed(1)}–${model.maxDepth.toFixed(1)} m${model.mosaic?' · sidescan mosaic':' · no sidescan'}`;
    seabedStatus(`Built from ${count(model.soundings)} depth readings${model.mosaic?` and ${count(model.mosaic.pings)} sidescan pings`:''}. Drag to rotate; click a numbered point to preview its scan.`,'ok');
    seabedTools(true);
  }catch(error){if(version===seabed.version){seabedStatus(`Could not build the 3D model: ${error.message}`,'error');$('seabed-empty').hidden=false;}}
  finally{if(version===seabed.version){seabed.building=false;ready();}}
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
$('build-seabed').addEventListener('click',buildSeabed);
$('seabed-exaggeration').addEventListener('input',event=>{const value=Number(event.target.value);$('seabed-exaggeration-value').textContent=`${value}×`;state.seabed.viewer?.setExaggeration(value);});
document.querySelectorAll('input[name="seabed-texture"]').forEach(input=>input.addEventListener('change',()=>state.seabed.viewer?.setTexture(input.value)));
$('seabed-reset').addEventListener('click',()=>state.seabed.viewer?.resetView());
$('seabed-save').addEventListener('click',async()=>{const blob=await state.seabed.viewer?.toBlob();if(blob)saveBlob(blob,`${fileStem()}_seabed_3d.png`);});
$('download-geojson').addEventListener('click',()=>saveRoute('geojson'));
window.addEventListener('beforeunload',()=>state.urls.forEach(url=>URL.revokeObjectURL(url)));
