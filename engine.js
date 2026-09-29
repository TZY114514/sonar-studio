// File-backed readers keep large recordings out of browser memory.
const CHUNK_BYTES = 8 * 1024 * 1024;
const RADIUS = 6356752.3142;
export const FEET_TO_METRES = 0.3048;
const BIN_WIDTH = {b:1,B:1,h:2,H:2,i:4,I:4,q:8,Q:8,f:4,d:8,c:2,C:2,e:4,E:4,L:4,M:1,n:4,N:16,Z:64};
export const CHANNEL_NAMES = {0:'primary',2:'downscan',5:'sidescan'};
export const CSV_COLUMNS = [
  'ping_id','channel_id','channel_name','sl3_frame_index','sl3_frame_offset_bytes',
  'sonar_time_ms','gps_week','gps_milliseconds_of_week','latitude_deg','longitude_deg',
  'gps_source','sl3_primary_latitude_deg','sl3_primary_longitude_deg',
  'sl3_header_latitude_deg','sl3_header_longitude_deg','bin_latitude_deg','bin_longitude_deg',
  'bin_sl3_difference_m','recorded_depth_m','sl3_header_depth_m','range_min_m',
  'range_max_m','sample_count','raw_intensity_mean_0_255','raw_intensity_max_0_255',
];

export class FileWindow {
  constructor(file) { this.file=file; this.start=-1; this.data=new Uint8Array(); }
  async bytes(position, length) {
    if (position < 0 || length < 0 || position + length > this.file.size) throw new Error(`Unexpected end of ${this.file.name}`);
    if (position < this.start || position + length > this.start + this.data.length) {
      this.start=position;
      this.data=new Uint8Array(await this.file.slice(position, Math.min(this.file.size, position + Math.max(CHUNK_BYTES,length))).arrayBuffer());
    }
    return this.data.subarray(position-this.start,position-this.start+length);
  }
}

const view = bytes => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
const textField = bytes => { let end=bytes.indexOf(0); if(end<0) end=bytes.length; return new TextDecoder('utf-8').decode(bytes.subarray(0,end)); };
export const validPosition = (lon,lat) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon)<=180 && Math.abs(lat)<=90 && (lon!==0 || lat!==0);
export const quantile = (array,p) => {
  if(!array.length) return null;
  const sorted=[...array].sort((a,b)=>a-b), x=(sorted.length-1)*p, i=Math.floor(x);
  return sorted[i]+(sorted[Math.min(i+1,sorted.length-1)]-sorted[i])*(x-i);
};
const lowerBound = (items,value,getter) => { let lo=0,hi=items.length; while(lo<hi){const mid=(lo+hi)>>1;if(getter(items[mid])<value)lo=mid+1;else hi=mid;}return lo; };
const distanceMetres = (lon1,lat1,lon2,lat2,lat0=lat1) => Math.hypot((lon1-lon2)*111320*Math.cos(lat0*Math.PI/180),(lat1-lat2)*111320);

export async function scanSl3(file,progress=()=>{}) {
  const reader=new FileWindow(file), opening=await reader.bytes(0,8);
  if(view(opening).getUint16(0,true)!==3) throw new Error('This is not a supported SL3 recording');
  const frames=[]; let position=8,lastProgress=0;
  while(position+128<=file.size){
    const raw=await reader.bytes(position,128), data=view(raw);
    const size=data.getUint16(8,true),channel=data.getUint16(12,true),header=channel<=5?168:128;
    if(size<header || position+size>file.size) throw new Error(`Invalid SL3 frame at byte ${position}`);
    const x=data.getInt32(92,true),y=data.getInt32(96,true);
    const lon=x/RADIUS*180/Math.PI,lat=(2*Math.atan(Math.exp(y/RADIUS))-Math.PI/2)*180/Math.PI;
    frames.push({offset:position,size,channel,index:data.getUint32(16,true),
      minRangeFt:data.getFloat32(20,true),maxRangeFt:data.getFloat32(24,true),
      depthM:data.getFloat32(48,true)*FEET_TO_METRES,lon,lat,timeMs:data.getUint32(124,true),
      pingOffset:position+header,pingSize:Math.min(data.getUint16(44,true),size-header)});
    position+=size;
    if(position-lastProgress>=16*1024*1024){progress(position/file.size);lastProgress=position;}
  }
  if(position!==file.size || !frames.length) throw new Error('SL3 recording ended with unreadable bytes');
  progress(1);
  return frames;
}

function decodeValue(data,offset,kind){
  switch(kind){
    case 'b':return data.getInt8(offset); case 'B': case 'M':return data.getUint8(offset);
    case 'h':return data.getInt16(offset,true);case 'H':return data.getUint16(offset,true);
    case 'i':return data.getInt32(offset,true);case 'I':return data.getUint32(offset,true);
    case 'q':return Number(data.getBigInt64(offset,true));case 'Q':return Number(data.getBigUint64(offset,true));
    case 'f':return data.getFloat32(offset,true);case 'd':return data.getFloat64(offset,true);
    case 'c':return data.getInt16(offset,true)/100;case 'C':return data.getUint16(offset,true)/100;
    case 'e':return data.getInt32(offset,true)/100;case 'E':return data.getUint32(offset,true)/100;
    case 'L':return data.getInt32(offset,true)/1e7;
    default:return null;
  }
}

export async function scanBin(file,progress=()=>{}) {
  const reader=new FileWindow(file),formats=new Map(),fixes=[];
  let position=0,lastProgress=0;
  while(position+3<=file.size){
    const head=await reader.bytes(position,3);
    if(head[0]!==0xa3 || head[1]!==0x95){position++;continue;}
    const code=head[2];
    if(code===128 && position+89<=file.size){
      const raw=await reader.bytes(position+3,86);
      const fmt={code:raw[0],length:raw[1],name:textField(raw.subarray(2,6)),types:textField(raw.subarray(6,22)),fields:textField(raw.subarray(22,86)).split(',')};
      if(fmt.length>=3 && fmt.name){formats.set(fmt.code,fmt);position+=89;continue;}
    }
    const fmt=formats.get(code);
    if(!fmt || fmt.length<3 || position+fmt.length>file.size){position++;continue;}
    if(fmt.name==='GPS'){
      const raw=await reader.bytes(position,fmt.length),data=view(raw),message={};let cursor=3,valid=true;
      for(let i=0;i<fmt.types.length;i++){
        const kind=fmt.types[i],width=BIN_WIDTH[kind];
        if(!width || cursor+width>fmt.length){valid=false;break;}
        if(fmt.fields[i])message[fmt.fields[i]]=decodeValue(data,cursor,kind);
        cursor+=width;
      }
      // Logs before ArduPilot 4.1 have no instance field; their second receiver logs as GPS2.
      if(valid && (message.I??0)===0 && message.Status>=3 && validPosition(message.Lng,message.Lat) &&
         Number.isFinite(message.GWk) && Number.isFinite(message.GMS)) {
        fixes.push({absoluteT:message.GWk*604800+message.GMS/1000,lon:message.Lng,lat:message.Lat,
          altitudeM:message.Alt,speedMps:message.Spd,satellites:message.NSats,hdop:message.HDop,status:message.Status});
      }
    }
    position+=fmt.length;
    if(position-lastProgress>=16*1024*1024){progress(position/file.size);lastProgress=position;}
  }
  progress(1);
  return fixes;
}

export function combineFixes(lists){
  const all=lists.flat().sort((a,b)=>a.absoluteT-b.absoluteT),unique=[];
  for(const fix of all)if(!unique.length || fix.absoluteT!==unique.at(-1).absoluteT)unique.push(fix);
  if(unique.length<10)throw new Error('Too few valid ArduPilot GPS fixes');
  const origin=unique[0].absoluteT;
  for(const fix of unique)fix.t=fix.absoluteT-origin;
  return {fixes:unique,origin};
}

function interpolate(items,time,timeOf){
  if(items.length<2 || time<timeOf(items[0]) || time>timeOf(items.at(-1)))return null;
  const i=Math.max(1,Math.min(items.length-1,lowerBound(items,time,timeOf)));
  const a=items[i-1],b=items[i],gap=timeOf(b)-timeOf(a);
  if(gap<=0 || gap>2)return null;
  return {a,b,weight:(time-timeOf(a))/gap};
}
const interpNumber=(pair,key)=>pair.a[key]+(pair.b[key]-pair.a[key])*pair.weight;
function interpolateGps(track,time){
  const pair=interpolate(track.fixes,time,item=>item.t);
  return pair?{lon:interpNumber(pair,'lon'),lat:interpNumber(pair,'lat')}:null;
}

function scoreOffset(offset,samples,gps,lat0){
  const distances=[];let covered=0;
  for(const frame of samples){
    const bin=interpolateGps(gps,frame.timeMs/1000+offset);
    if(!bin)continue;
    covered++;
    distances.push(distanceMetres(frame.lon,frame.lat,bin.lon,bin.lat,lat0));
  }
  const coverage=covered/samples.length;
  if(coverage<.7)return {score:Infinity,coverage,p50:Infinity,p90:Infinity};
  const p50=quantile(distances,.5),p90=quantile(distances,.9);
  return {score:p50+.3*p90+100*(1-coverage),coverage,p50,p90};
}

export function findAlignment(frames,gps){
  const primary=frames.filter(f=>f.channel===0 && validPosition(f.lon,f.lat));
  if(primary.length<20)return {trusted:false,reason:'Too few SL3 GPS positions'};
  const count=Math.min(primary.length,240),samples=Array.from({length:count},(_,i)=>primary[Math.floor(i*(primary.length-1)/(count-1))]);
  const firstTime=samples[0].timeMs/1000,lastTime=samples.at(-1).timeMs/1000,lat0=quantile(samples.map(x=>x.lat),.5);
  const searchStart=-Math.max(900,lastTime-firstTime+60),searchEnd=gps.fixes.at(-1).t-firstTime+30;
  let best=0,bestScore=Infinity;
  for(let offset=searchStart;offset<=searchEnd+5;offset+=5){
    const score=scoreOffset(offset,samples,gps,lat0).score;
    if(score<bestScore){bestScore=score;best=offset;}
  }
  if(!Number.isFinite(bestScore))return {trusted:false,reason:'No overlapping GPS track found'};
  let fineBest=best;
  for(let offset=best-5;offset<=best+5.001;offset+=.25){
    const score=scoreOffset(offset,samples,gps,lat0).score;
    if(score<bestScore){bestScore=score;fineBest=offset;}
  }
  const result=scoreOffset(fineBest,samples,gps,lat0),trusted=result.coverage>=.7 && result.p90<=12;
  return {trusted,offset_s:fineBest,median_position_error_m:result.p50,
    p90_position_error_m:result.p90,gps_coverage_fraction:result.coverage,
    reason:trusted?'Spatial time alignment verified against both GPS tracks':'Route match failed accuracy or coverage check'};
}

export function primaryValue(primary,time,key,fallback){
  const pair=interpolate(primary,time,item=>item.timeMs/1000);
  return pair?interpNumber(pair,key):fallback;
}
// Position rule shared by the CSV and the 3D model: interpolated BIN GPS where fixes bracket the ping within two
// seconds and agree with the SL3 primary track within eight metres; otherwise the SL3 primary-channel position.
export function resolvePosition(primary,gps,sync,time,fallback){
  const sl3Lon=primaryValue(primary,time,'lon',fallback.lon),sl3Lat=primaryValue(primary,time,'lat',fallback.lat),sl3Valid=validPosition(sl3Lon,sl3Lat);
  const bin=sync.trusted?interpolateGps(gps,time+sync.offset_s):null;
  const difference=bin&&sl3Valid?distanceMetres(sl3Lon,sl3Lat,bin.lon,bin.lat):null,useBin=difference!=null&&difference<=8;
  return {lon:useBin?bin.lon:sl3Valid?sl3Lon:null,lat:useBin?bin.lat:sl3Valid?sl3Lat:null,
    source:useBin?'ardupilot_bin':sl3Valid?'sl3_embedded':'missing',sl3Lon,sl3Lat,sl3Valid,bin,difference};
}
export function matchedGpsForFrame(frame,primary,gps,sync){
  if(!sync?.trusted)return null;
  const time=frame.timeMs/1000;
  const bin=interpolateGps(gps,time+sync.offset_s);
  if(!bin)return null;
  const lon=primaryValue(primary,time,'lon',frame.lon),lat=primaryValue(primary,time,'lat',frame.lat);
  if(!validPosition(lon,lat))return null;
  const differenceM=distanceMetres(lon,lat,bin.lon,bin.lat);
  return differenceM<=8?{...bin,time,differenceM}:null;
}
// GPS time is ahead of UTC by the leap seconds added since 1980: 18 since 2017, and none announced since.
export const GPS_UTC_LEAP_SECONDS=18;
const GPS_EPOCH_MS=Date.UTC(1980,0,6);
const gpsSecondsToUtc=seconds=>new Date(GPS_EPOCH_MS+Math.round((seconds-GPS_UTC_LEAP_SECONDS)*1000)).toISOString();
const xmlText=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]);
const degrees=value=>value.toFixed(7);

// Route and scan points in GPS time. fixes: BIN fixes (absoluteT in GPS seconds);
// scans: {time,lat,lon} with time in seconds from the first sonar ping.
function routeTimes({fixes,scans,offsetS,sonarStartS,gpsOrigin}){
  const scanSeconds=scan=>gpsOrigin+sonarStartS+scan.time+offsetS;
  return {fixes,scans:scans.map((scan,i)=>({...scan,number:i+1,gpsSeconds:scanSeconds(scan)}))};
}

export function trackGeoJson(input){
  const {fixes,scans}=routeTimes(input);
  const line={type:'Feature',geometry:{type:'LineString',coordinates:fixes.map(fix=>[fix.lon,fix.lat])},
    properties:{name:input.name,source:'ArduPilot BIN GPS',start_time_utc:gpsSecondsToUtc(fixes[0].absoluteT),end_time_utc:gpsSecondsToUtc(fixes.at(-1).absoluteT)}};
  const points=scans.map(scan=>{const [week,weekMs]=gpsWeekMs(scan.gpsSeconds);return {type:'Feature',geometry:{type:'Point',coordinates:[scan.lon,scan.lat]},
    properties:{name:`Scan ${scan.number}`,scan:scan.number,recording_time_s:scan.time,gps_week:week,gps_milliseconds_of_week:weekMs,time_utc:gpsSecondsToUtc(scan.gpsSeconds)}};});
  return {type:'FeatureCollection',features:[line,...points]};
}

export function trackGpx(input){
  const {fixes,scans}=routeTimes(input),name=xmlText(input.name);
  const waypoints=scans.map(scan=>`  <wpt lat="${degrees(scan.lat)}" lon="${degrees(scan.lon)}"><time>${gpsSecondsToUtc(scan.gpsSeconds)}</time><name>Scan ${scan.number}</name><desc>${scan.time.toFixed(1)} s from the first sonar ping</desc></wpt>\n`);
  const points=fixes.map(fix=>`      <trkpt lat="${degrees(fix.lat)}" lon="${degrees(fix.lon)}">${Number.isFinite(fix.altitudeM)?`<ele>${fix.altitudeM.toFixed(2)}</ele>`:''}<time>${gpsSecondsToUtc(fix.absoluteT)}</time></trkpt>\n`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Sonar Studio Web" xmlns="http://www.topografix.com/GPX/1/1">\n`+
    `  <metadata><name>${name}</name><time>${gpsSecondsToUtc(fixes[0].absoluteT)}</time></metadata>\n`+waypoints.join('')+
    `  <trk><name>${name}</name><src>ArduPilot BIN GPS</src><trkseg>\n${points.join('')}  </trkseg></trk>\n</gpx>\n`;
}

// The track sample ({lat,lon,...}) closest to a position, with its distance in metres.
export function nearestSample(samples,lat,lon){
  let best=null,distanceM=Infinity;
  for(const sample of samples){const d=distanceMetres(sample.lon,sample.lat,lon,lat,lat);if(d<distanceM){best=sample;distanceM=d;}}
  return best?{sample:best,distanceM}:null;
}
const maybe=(number)=>Number.isFinite(number)?number:null;
const gpsWeekMs=(seconds)=>{if(!Number.isFinite(seconds))return [null,null];const ms=Math.round(seconds*1000);return [Math.floor(ms/604800000),ms%604800000];};
const csvCell=value=>value==null || !Number.isFinite(value) && typeof value==='number'?'':String(value);

export async function exportAligned(file,allFrames,gps,sync,settings,progress=()=>{}){
  const primary=allFrames.filter(f=>f.channel===0 && validPosition(f.lon,f.lat));
  if(!primary.length)throw new Error('No primary-channel positions are available');
  const depthPrimary=primary.filter(f=>f.depthM>0 && f.depthM<10);
  // The SL3 clock need not start at zero; the time window counts from the first ping.
  const origin=recordingStart(allFrames),end=settings.duration==null?Infinity:settings.start+settings.duration;
  const frames=allFrames.filter(f=>{const t=f.timeMs/1000-origin;return settings.channels.has(f.channel)&&f.pingSize>0&&settings.start<=t&&t<end;});
  if(!frames.length)throw new Error('No sonar pings in the selected channels and time window');
  const reader=new FileWindow(file),chunks=[CSV_COLUMNS.join(',')+'\r\n'];let rows=[],differences=[],binValidCount=0,binUsedCount=0;
  const channelCounts={},sourceCounts={};
  for(let i=0;i<frames.length;i++){
    const f=frames[i],time=f.timeMs/1000;
    const depth=depthPrimary.length>=2?primaryValue(depthPrimary,time,'depthM',null):(f.depthM>0&&f.depthM<10?f.depthM:null);
    const {lon,lat,source,sl3Lon,sl3Lat,sl3Valid,bin,difference}=resolvePosition(primary,gps,sync,time,f);
    if(bin)binValidCount++;
    if(difference!=null)differences.push(difference);
    if(source==='ardupilot_bin')binUsedCount++;
    const [week,weekMs]=gpsWeekMs(sync.trusted?gps.origin+time+sync.offset_s:null);
    const bytes=await reader.bytes(f.pingOffset,f.pingSize);let sum=0,max=0;
    for(const sample of bytes){sum+=sample;if(sample>max)max=sample;}
    const name=CHANNEL_NAMES[f.channel];
    const row=[i+1,f.channel,name,f.index,f.offset,f.timeMs,week,weekMs,lat,lon,source,
      sl3Valid?sl3Lat:null,sl3Valid?sl3Lon:null,validPosition(f.lon,f.lat)?f.lat:null,validPosition(f.lon,f.lat)?f.lon:null,
      bin?.lat??null,bin?.lon??null,difference,maybe(depth),maybe(f.depthM),f.minRangeFt*FEET_TO_METRES,
      f.maxRangeFt*FEET_TO_METRES,f.pingSize,sum/f.pingSize,max];
    rows.push(row.map(csvCell).join(',')+'\r\n');
    channelCounts[name]=(channelCounts[name]||0)+1;sourceCounts[source]=(sourceCounts[source]||0)+1;
    if(rows.length>=2000){chunks.push(rows.join(''));rows=[];progress((i+1)/frames.length);}
  }
  if(rows.length)chunks.push(rows.join(''));
  progress(1);
  const report={format:'Aligned SL3 sonar and ArduPilot GPS web export',sonar_file:file.name,
    bin_files:settings.binNames,time_window_s:{start:settings.start,duration:settings.duration,first_ping_sonar_time_ms:origin*1000},
    exported_pings:frames.length,gps_fixes:gps.fixes.length,channels:channelCounts,gps_sources:sourceCounts,
    time_alignment:sync,bin_temporal_coverage_fraction:binValidCount/frames.length,
    bin_position_adoption_fraction:binUsedCount/frames.length,
    bin_sl3_position_difference_median_m:quantile(differences,.5),
    bin_sl3_position_difference_p90_m:quantile(differences,.9),
    gps_time_note:'GPS week and milliseconds of week are inferred by spatially aligning the SL3 route with BIN GPS. They use the GPS time scale, not UTC.',
    position_rule:'Use interpolated BIN GPS only where fixes bracket the ping within two seconds and it is within eight metres of the SL3 primary-channel position; otherwise use the SL3 position.',
    limitations:['Web CSV contains ping metadata and intensity summaries, not original sample bytes. Use the desktop edition for lossless SQLite.',
      'Spatial alignment does not establish survey-grade absolute positioning accuracy.',
      'Depth and range use the reverse-engineered SL3 feet-to-metres assumption.',
      'No transducer offset, layback, attitude, tide, or pixel georectification is applied.']};
  return {csv:new Blob(chunks,{type:'text/csv;charset=utf-8'}),report};
}

function recordingStart(frames){let first=Infinity;for(const f of frames)if(f.timeMs<first)first=f.timeMs;return first/1000;}

export function recordingSummary(frames){
  const counts={primary:0,downscan:0,sidescan:0},depth=[],route=[];
  let first=Infinity,last=-Infinity;
  for(const f of frames){if(CHANNEL_NAMES[f.channel])counts[CHANNEL_NAMES[f.channel]]++;
    const t=f.timeMs/1000;if(t<first)first=t;if(t>last)last=t;
    if(f.channel===0){if(f.depthM>0&&f.depthM<20)depth.push(f.depthM);if(validPosition(f.lon,f.lat))route.push([f.lon,f.lat]);}}
  const selected=route.length>180?Array.from({length:180},(_,i)=>route[Math.floor(i*(route.length-1)/179)]):route;
  return {start:first,duration:last-first,counts,medianDepth:quantile(depth,.5),route:selected,previewStart:Math.max(0,Math.min(last-first-90,(last-first)*.5-45))};
}
