// Crack screening: possible cracks, joints and displaced panels in a canal's lining, from the sidescan.
//
// A short stretch is laid out as a slant-corrected waterfall in the boat's own frame: one row per ping
// along the track, one column every ACROSS metres of ground distance across it (port on the positive
// side). GPS jitter moves whole pings, not the echoes within them, so in this frame a crack stays a clean
// line. Each echo is divided by the usual echo at that range, so 1 means ordinary bed.
//
// Lines are found with an oriented line filter: at each of ANGLES directions, the mean along a LINE_M
// segment is compared with parallel segments FLANK_M either side. Dark lines are gaps and shadows, bright
// lines are edges lit by the sonar. Each direction's responses are measured against that direction's own
// noise, then thinned, linked into straight segments and classified. What the sonar cannot show (hairline
// cracks, anything under sediment) is not found; everything found is a candidate to check on site.
// All positions below are in metres: x across the track (from the image's starboard edge), y along it.
import {readSurvey,slidingReference,groundRange,lonLatOf,REF_STEP} from './reconstruct.js';

export const ACROSS=.015;
const ANGLES=12,LINE_M=.3,FLANK_M=.045;
const yieldToBrowser=()=>new Promise(resolve=>setTimeout(resolve,0));
const median=values=>{const sorted=Float64Array.from(values).sort();return sorted.length?sorted[sorted.length>>1]:NaN;};
const cosine=degrees=>Math.cos(degrees*Math.PI/180);

// Means along lines at angle theta (0 runs across the track, pi/2 along it) over halfLen metres either
// side, skipping missing pixels. Pixels are px wide and py tall. Each pixel lies on exactly one digital
// line, so the work is proportional to the image size. A mean needs 80 % of its pixels: one missing ping
// is bridged, but next to a wider gap a mean of fewer pixels would be noisier than the rest and make lines.
function orientedMean(img,W,H,px,py,theta,halfLen,out){
  const c=Math.cos(theta)/px,s=Math.sin(theta)/py,acrossMajor=Math.abs(c)>=Math.abs(s);
  const n=acrossMajor?W:H,other=acrossMajor?H:W,t=acrossMajor?s/c:c/s,shift=new Int32Array(n);
  for(let k=0;k<n;k++)shift[k]=Math.round(k*t);
  const low=Math.min(0,shift[n-1]),high=Math.max(0,shift[n-1]);
  const L=Math.max(1,Math.round(halfLen*(acrossMajor?Math.abs(Math.cos(theta))/px:Math.abs(Math.sin(theta))/py)));
  const sum=new Float64Array(n+1),count=new Int32Array(n+1),need=.8*(2*L+1);
  for(let line=-high;line<other-low;line++){
    for(let k=0;k<n;k++){
      const m=line+shift[k],v=m>=0&&m<other?img[acrossMajor?m*W+k:k*W+m]:NaN,valid=v===v;
      sum[k+1]=sum[k]+(valid?v:0);count[k+1]=count[k]+(valid?1:0);
    }
    for(let k=0;k<n;k++){
      const m=line+shift[k];if(m<0||m>=other)continue;
      const a=Math.max(0,k-L),b=Math.min(n,k+L+1),valid=count[b]-count[a];
      out[acrossMajor?m*W+k:k*W+m]=valid>=need?(sum[b]-sum[a])/valid:NaN;
    }
  }
}

// Straight-line fit of points (x, y, weight) in metres: centre, unit direction, extent and scatter.
function fitLine(points,grain){
  let w=0,cx=0,cy=0;for(const p of points){w+=p[2];cx+=p[0]*p[2];cy+=p[1]*p[2];}cx/=w;cy/=w;
  let a=0,b=0,d=0;for(const p of points){const x=p[0]-cx,y=p[1]-cy;a+=x*x*p[2];b+=x*y*p[2];d+=y*y*p[2];}
  const angle=.5*Math.atan2(2*b,a-d),ux=Math.cos(angle),uy=Math.sin(angle);
  let lo=Infinity,hi=-Infinity,scatter=0;
  for(const p of points){const along=(p[0]-cx)*ux+(p[1]-cy)*uy,across=-(p[0]-cx)*uy+(p[1]-cy)*ux;lo=Math.min(lo,along);hi=Math.max(hi,along);scatter+=across*across*p[2];}
  return {cx,cy,ux,uy,lo,hi,length:hi-lo+grain,rms:Math.sqrt(scatter/w)};
}

// Screens a stretch of the survey (timeRange, in recording seconds) for lining defects.
// sensitivity (0-1): how faint a line still counts. minLengthM: shortest line reported.
export async function inspectLining(file,frames,gps,sync,{timeRange=null,draftM=.2,sensitivity=.5,minLengthM=.6,progress=()=>{}}={}){
  const survey=await readSurvey(file,frames,gps,sync,{draftM,timeRange,progress:f=>progress(.35*f)});
  const pings=survey.sonarPings;
  if(pings.length<20)throw new Error('Too few sidescan pings with a known position in this stretch');
  const reach=side=>side.empty?0:side.open?side.reach:side.waterline;
  const maxOffset=Math.min(20,Math.max(...pings.flatMap(p=>p.sides.map(reach)))+.1);
  // Distance along the stretch from a smoothed speed (GPS jitter would bunch and spread the pings), then
  // one row per ping, with blank rows only where pings are missing.
  const along=smoothAlong(pings),steps=along.slice(1).map((a,i)=>a-along[i]).filter(g=>g>0);
  const px=ACROSS,py=Math.min(.1,Math.max(.01,median(steps)||.05)),rowOf=new Int32Array(pings.length);
  for(let n=1;n<pings.length;n++){const gap=along[n]-along[n-1];rowOf[n]=rowOf[n-1]+(gap>1.5*py?Math.round(gap/py):1);}
  const W=Math.ceil(2*maxOffset/px)+1,H=rowOf[pings.length-1]+1,lengthM=along.at(-1);
  if(W*H>6e6)throw new Error('This stretch is too long to screen at full detail; choose a shorter one');
  const column=offset=>Math.round((offset+maxOffset)/px);

  // 1. Each ping's echoes, divided by the usual echo at that range, per column. The usual echo is smoothed
  // over half a metre of range, so a long crack along the canal does not darken it at the crack's own range.
  // Compact objects and their shadows, the bank toe and the bright band along the waterline are known
  // features, left out.
  const profiles=pings.map(()=>new Float32Array(W).fill(NaN)),shown=pings.map(()=>new Float32Array(W).fill(NaN));
  const objects=compactObjects(pings);
  for(const k of [0,1])slidingReference(pings.map(p=>p.sides[k].row),survey.halfWindow,(n,reference)=>{
    const p=pings[n],side=p.sides[k],samples=p.samples[k],dr=p.rangeM/samples.length,sign=k===0?1:-1;
    if(side.empty)return;
    const smoothRef=new Float32Array(reference.length);
    for(let b=0;b<reference.length;b++){let t=0,m=0;for(let q=Math.max(0,b-5);q<=Math.min(reference.length-1,b+5);q++)if(reference[q]>0){t+=reference[q];m++;}smoothRef[b]=m?t/m:0;}
    const sum=new Float32Array(W),count=new Uint16Array(W),all=new Float32Array(W),allCount=new Uint16Array(W),mine=objects.filter(o=>o.k===k&&Math.abs(p.along-o.along)<=o.half);
    for(let i=side.first;i<samples.length;i++){
      const r=(i+.5)*dr,g=groundRange(r,p.H,draftM,side),ref=smoothRef[Math.floor(r/REF_STEP)];
      if(g==null||!(ref>2)||g>(side.open?side.reach:side.waterline))continue;
      const c=column(sign*g),v=samples[i]/ref;if(c<0||c>=W)continue;
      all[c]+=v;allCount[c]++;   // the picture shows everything; only the lining is screened
      if(g<Math.max(.3,.3*p.H))continue;
      if(!side.open&&(Math.abs(g-side.toe)<.3||g>side.waterline-.5))continue;
      if(mine.some(o=>g>=o.from&&g<=o.to))continue;
      sum[c]+=v;count[c]++;
    }
    for(const [profile,total,number] of [[profiles[n],sum,count],[shown[n],all,allCount]]){
      for(let c=0;c<W;c++)if(number[c])profile[c]=total[c]/number[c];
      // Far out, a sample can be a little wider than a column: fill single gaps between filled columns.
      for(let c=1;c<W-1;c++)if(profile[c]!==profile[c]&&profile[c-1]===profile[c-1]&&profile[c+1]===profile[c+1])profile[c]=(profile[c-1]+profile[c+1])/2;
    }
  });
  progress(.4);await yieldToBrowser();

  // 2. The image.
  const img=new Float32Array(W*H).fill(NaN),rowPing=new Int32Array(H).fill(-1);
  pings.forEach((_,n)=>{rowPing[rowOf[n]]=n;img.set(profiles[n],rowOf[n]*W);});

  // 3. Oriented line filter. Along the track the pings are further apart than the columns, so the noise
  // differs with direction: each direction's responses become z, how many of that direction's own
  // spreads they stand out, and each pixel keeps its strongest direction.
  const S=new Float32Array(W*H),R=new Float32Array(W*H),bestDark=new Float32Array(W*H),bestBright=new Float32Array(W*H),angleDark=new Uint8Array(W*H),angleBright=new Uint8Array(W*H);
  const flank=theta=>{let di=Math.round(-Math.sin(theta)*FLANK_M/px),dj=Math.round(Math.cos(theta)*FLANK_M/py);if(!di&&!dj){if(Math.abs(Math.sin(theta))*py>Math.abs(Math.cos(theta))*px)di=-Math.sign(Math.sin(theta));else dj=Math.sign(Math.cos(theta));}return [di,dj];};
  let noise=0;
  for(let a=0;a<ANGLES;a++){
    const theta=a*Math.PI/ANGLES,[di,dj]=flank(theta);
    orientedMean(img,W,H,px,py,theta,LINE_M/2,S);R.fill(NaN);
    const sample=[];
    for(let j=Math.abs(dj);j<H-Math.abs(dj);j++)for(let i=Math.abs(di);i<W-Math.abs(di);i++){
      const k=j*W+i,centre=S[k],p1=S[k+dj*W+di],p2=S[k-dj*W-di];
      if(!(centre===centre&&p1===p1&&p2===p2))continue;
      R[k]=(p1+p2)/2-centre;if(k%5===0)sample.push(R[k]);
    }
    if(sample.length<100)continue;
    const m=median(sample),spread=1.4826*median(sample.map(v=>Math.abs(v-m)));if(!(spread>0))continue;
    if(a===0)noise=spread;
    for(let k=0;k<W*H;k++){
      const r=R[k];if(r!==r)continue;const z=(r-m)/spread;
      if(z>bestDark[k]){bestDark[k]=z;angleDark[k]=a;}
      if(-z>bestBright[k]){bestBright[k]=-z;angleBright[k]=a;}
    }
    progress(.4+.45*(a+1)/ANGLES);await yieldToBrowser();
  }
  if(!(noise>0))throw new Error('This stretch has too little sidescan to screen');

  // 4. Thin to the ridge of each line, link neighbouring pixels of similar direction, fit straight segments.
  const high=6-3*sensitivity,low=high-1.5,segments=[],grain=Math.min(px,py);
  for(const [z,angles,polarity] of [[bestDark,angleDark,'dark'],[bestBright,angleBright,'bright']]){
    const keep=new Uint8Array(W*H);
    for(let j=1;j<H-1;j++)for(let i=1;i<W-1;i++){
      const k=j*W+i;if(z[k]<low)continue;
      const theta=angles[k]*Math.PI/ANGLES,nx=-Math.sin(theta)/px,ny=Math.cos(theta)/py,scale=Math.max(Math.abs(nx),Math.abs(ny));
      const di=Math.round(nx/scale),dj=Math.round(ny/scale);
      if(z[k]>=z[k+dj*W+di]&&z[k]>=z[k-dj*W-di])keep[k]=1;
    }
    const seen=new Uint8Array(W*H);
    for(let k=0;k<W*H;k++){
      if(!keep[k]||seen[k]||z[k]<high)continue;
      const stack=[k],points=[];seen[k]=1;
      while(stack.length){
        const q=stack.pop(),qi=q%W,qj=(q-qi)/W;points.push([qi*px,qj*py,z[q]]);
        for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){
          const i=qi+di,j=qj+dj,m=j*W+i;
          if(i<0||j<0||i>=W||j>=H||seen[m]||!keep[m])continue;
          const turn=Math.abs(angles[m]-angles[q]);if(Math.min(turn,ANGLES-turn)>1)continue;
          seen[m]=1;stack.push(m);
        }
      }
      if(points.length<4)continue;
      const fit=fitLine(points,grain);if(fit.length>=.15)segments.push({polarity,points,...fit});
    }
  }
  progress(.9);await yieldToBrowser();

  // 5. Join pieces of the same line (over gaps up to 50 cm), then keep long, straight lines. Lines across the canal are cut by
  // the strip under the boat and around the bank toes, so their pieces are joined over gaps up to 2.5 m.
  const across=s=>Math.abs(s.uy)<Math.sin(20*Math.PI/180);
  const merged=mergeCollinear(mergeCollinear(segments,{grain,gapM:.5,lateral:.08}),{grain,gapM:2.5,lateral:Math.max(.08,1.5*py),only:across});
  // A dark line makes the bed just either side of it look bright to the filter (and a bright line the
  // reverse). Dark lines are what cracks, joints and shadows look like, so a bright line alongside a dark
  // one is its echo; a dark line alongside a bright one is an echo only if the bright one is far stronger.
  const strength=s=>s.points.reduce((t,p)=>t+p[2],0);
  const beside=(s,o)=>o!==s&&o.polarity!==s.polarity&&Math.abs(o.ux*s.ux+o.uy*s.uy)>=cosine(12)
    &&Math.abs(-(s.cx-o.cx)*o.uy+(s.cy-o.cy)*o.ux)<=FLANK_M+Math.max(.03,py)&&Math.abs((s.cx-o.cx)*o.ux+(s.cy-o.cy)*o.uy)<=(o.hi-o.lo)/2;
  const echo=s=>merged.some(o=>beside(s,o)&&(s.polarity==='bright'?o.length>=.5*s.length:strength(o)>2*strength(s)));
  const lines=merged.filter(s=>!echo(s)&&s.length>=minLengthM&&s.rms<=.035);
  const toPing=y=>pings[nearestRow(rowPing,Math.min(H-1,Math.max(0,Math.round(y/py))))];
  const candidates=[];
  for(const line of lines){
    const meanZ=line.points.reduce((t,p)=>t+p[2],0)/line.points.length;
    const alongDeg=Math.acos(Math.min(1,Math.abs(line.uy)))*180/Math.PI;
    const direction=alongDeg<=20?'along':alongDeg>=70?'across':'diagonal';
    const describe=describeLine(line,{img,W,H,px,py,maxOffset,rowPing,pings,direction});
    if(describe.artefact)continue;
    const ends=[line.lo,line.hi].map(t=>{
      const x=line.cx+t*line.ux,y=line.cy+t*line.uy,p=toPing(y),offset=x-maxOffset;
      return {raster:[x/px,y/py],local:[p.x+offset*p.lx,p.y+offset*p.ly]};
    });
    const centreOffset=line.cx-maxOffset,score=meanZ*Math.sqrt(line.length/.3),centre=toPing(line.cy);
    // A line that reaches well out on both sides (a joint across the canal) passes under the boat.
    const endOffsets=[line.lo,line.hi].map(t=>line.cx+t*line.ux-maxOffset),both=Math.min(...endOffsets)<-.3&&Math.max(...endOffsets)>.3;
    candidates.push({kind:describe.kind,polarity:line.polarity,direction,angleDeg:Math.round(alongDeg),lengthM:line.length,sizeCm:describe.sizeCm??null,detail:describe.detail,
      side:both?'both':centreOffset>=0?'port':'starboard',offsetM:Math.abs(centreOffset),alongM:along[pings.indexOf(centre)],time:centre.time,score,contrast:meanZ,
      raster:ends.map(e=>e.raster),local:ends.map(e=>e.local),lonlat:ends.map(e=>{const {lon,lat}=lonLatOf(survey.origin,...e.local);return [lon,lat];})});
  }
  markJoints(candidates);
  // Confidence from how far the line stands out of the noise on average. A line along the canal close to
  // the bank toe may be the toe itself or the edge of sediment at its foot, so it is never more than medium.
  // Lines are numbered by confidence, then by score (longer and clearer first).
  for(const c of candidates){
    c.confidence=c.contrast>=1.8*high?'high':c.contrast>=1.35*high?'medium':'low';
    const p=pings[nearestRow(rowPing,Math.min(H-1,Math.max(0,Math.round((c.raster[0][1]+c.raster[1][1])/2))))],side=p.sides[c.side==='port'?0:1];
    if(c.direction==='along'&&!side.open&&Math.abs(c.offsetM-side.toe)<.8){c.nearToe=true;c.detail+=' (close to the bank toe: may be the toe or a sediment edge)';if(c.confidence==='high')c.confidence='medium';}
  }
  const rank={high:0,medium:1,low:2};
  candidates.sort((a,b)=>rank[a.confidence]-rank[b.confidence]||b.score-a.score).forEach((c,i)=>{c.id=i+1;});

  // The picture, with every echo (1, ordinary bed, is mid-grey). Gaps of up to 4 missing pings, narrower
  // than one ping's footprint along the track, are filled in from the pings either side.
  const picture=new Float32Array(W*H).fill(NaN);
  pings.forEach((_,n)=>picture.set(shown[n],rowOf[n]*W));
  for(let n=1;n<pings.length;n++){
    const a=rowOf[n-1],b=rowOf[n];if(b-a<2||b-a>5)continue;
    for(let j=a+1;j<b;j++){const t=(j-a)/(b-a);for(let i=0;i<W;i++)picture[j*W+i]=picture[a*W+i]*(1-t)+picture[b*W+i]*t;}
  }
  const values=new Uint8Array(W*H),valid=new Uint8Array(W*H);
  for(let k=0;k<W*H;k++)if(picture[k]===picture[k]){valid[k]=1;values[k]=Math.max(0,Math.min(255,Math.round(picture[k]*110)));}
  const rowTimes=Float64Array.from(rowPing,n=>n>=0?pings[n].time:NaN);
  progress(1);
  return {image:{width:W,height:H,px,py,maxOffset,values,valid},rowTimes,candidates,origin:survey.origin,
    stats:{pings:pings.length,lengthM,noise,threshold:high}};
}

// Distance along the track for each ping, from its time and the speed over the surrounding four seconds
// (straight-line distance, which GPS jitter barely affects over that span).
function smoothAlong(pings){
  const n=pings.length,span=Math.max(2,Math.round(2*n/Math.max(1,pings.at(-1).time-pings[0].time))),speed=new Float64Array(n);
  for(let i=0;i<n;i++){const a=Math.max(0,i-span),b=Math.min(n-1,i+span),dt=pings[b].time-pings[a].time;speed[i]=dt>0?Math.hypot(pings[b].x-pings[a].x,pings[b].y-pings[a].y)/dt:0;}
  const out=new Float64Array(n);for(let i=1;i<n;i++)out[i]=out[i-1]+Math.max(0,(speed[i]+speed[i-1])/2*(pings[i].time-pings[i-1].time));
  return out;
}

function nearestRow(rowPing,row){
  for(let d=0;d<rowPing.length;d++){if(rowPing[row-d]>=0)return rowPing[row-d];if(rowPing[row+d]>=0)return rowPing[row+d];}
  return 0;
}

// Compact objects (echo shadows seen in consecutive pings over less than 3 m of track) are known
// features: their outlines must not be read as cracks. A long run of shadows is left in, as it may be one.
// The lit face in front of an object's shadow can be wider than the object's estimated start suggests,
// so more is left out on the side facing the sonar.
function compactObjects(pings){
  const found=[];
  for(const k of [0,1]){
    const items=[];for(const p of pings)for(const f of p.sides[k].features??[])items.push({along:p.along,from:f.start-.6,to:f.shadowEnd+.3});
    const groups=[];
    for(const item of items){
      const group=groups.find(g=>item.along-g.last<.3&&item.from<g.to&&item.to>g.from);
      if(group){group.last=item.along;group.from=Math.min(group.from,item.from);group.to=Math.max(group.to,item.to);group.count++;}
      else groups.push({first:item.along,last:item.along,from:item.from,to:item.to,count:1});
    }
    for(const g of groups)if(g.count>=3&&g.last-g.first<=3)found.push({k,along:(g.first+g.last)/2,half:(g.last-g.first)/2+.3,from:g.from,to:g.to});
  }
  return found;
}

// Joins pieces of the same line: same polarity and direction, within lateral of one line (a long line
// drifts a little as the boat moves across the canal), with gaps up to gapM.
// Pieces are found through a grid of their end points, so this stays quick with many pieces.
function mergeCollinear(segments,{grain,gapM=.3,lateral=.05,only=()=>true}){
  const cell=Math.max(.3,gapM),grid=new Map(),parent=segments.map((_,i)=>i),find=i=>{while(parent[i]!==i)i=parent[i]=parent[parent[i]];return i;};
  const ends=s=>[[s.cx+s.lo*s.ux,s.cy+s.lo*s.uy],[s.cx+s.hi*s.ux,s.cy+s.hi*s.uy]],key=(x,y)=>`${Math.floor(x/cell)},${Math.floor(y/cell)}`;
  segments.forEach((s,n)=>{for(const [x,y] of ends(s)){const k=key(x,y);if(!grid.has(k))grid.set(k,[]);grid.get(k).push(n);}});
  segments.forEach((A,a)=>{
    for(const [x,y] of ends(A))for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const b of grid.get(key(x+dx*cell,y+dy*cell))??[]){
      if(b<=a||find(a)===find(b))continue;const B=segments[b];if(A.polarity!==B.polarity||!only(A)||!only(B))continue;
      if(Math.abs(A.ux*B.ux+A.uy*B.uy)<cosine(12))continue;
      if(Math.abs(-(B.cx-A.cx)*A.uy+(B.cy-A.cy)*A.ux)>lateral)continue;
      const t=(B.cx-A.cx)*A.ux+(B.cy-A.cy)*A.uy,half=(B.hi-B.lo)/2,gap=Math.max(0,Math.max(t-half,A.lo)-Math.min(t+half,A.hi));
      if(gap<=gapM)parent[find(b)]=find(a);
    }
  });
  const groups=new Map();segments.forEach((s,n)=>{const r=find(n);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(s);});
  return [...groups.values()].map(group=>{if(group.length===1)return group[0];const points=group.flatMap(s=>s.points);return {polarity:group[0].polarity,points,...fitLine(points,grain)};});
}

// What a line is, from its profile across (for lines along the track, where the sonar looks across them).
// At the low angles of a shallow canal, a narrow open crack and a small step down away from the sonar both
// show as a short shadow, so a dark line alone is reported as either; with its far wall lit it is an open
// crack. Lit then dark is a raised edge casting a shadow; lit alone is a step up facing the sonar. A
// shadow's width gives the size of what casts it: h = H * w / R (rough: a narrow crack may be deeper
// than its shadow shows). Lines along the track that keep the same range from the boat while the boat
// weaves between the banks follow the boat, so they are sonar artefacts.
function describeLine(line,{img,W,H,px,py,maxOffset,rowPing,pings,direction}){
  const dark=line.polarity==='dark';
  if(direction!=='along')return {kind:dark?'crack':'edge',detail:dark?'dark line':'lit edge'};
  const y0=line.cy+Math.min(line.lo*line.uy,line.hi*line.uy),y1=line.cy+Math.max(line.lo*line.uy,line.hi*line.uy);
  const j0=Math.max(0,Math.floor(y0/py)),j1=Math.min(H-1,Math.ceil(y1/py));
  const outward=line.cx-maxOffset>=0?1:-1,profile=new Float64Array(17),counts=new Float64Array(17),offsets=[],wobble=[],heights=[];
  const rows=new Map();for(const p of line.points){const j=Math.round(p[1]/py);if(!rows.has(j))rows.set(j,[]);rows.get(j).push(p[0]);}
  for(let j=j0;j<=j1;j++){
    const i=Math.round((line.cx+(j*py-line.cy)*line.ux/(line.uy||1e-9))/px);
    for(let m=-8;m<=8;m++){const c=i+outward*m,v=c>=0&&c<W?img[j*W+c]:NaN;if(v===v){profile[m+8]+=v;counts[m+8]++;}}
    const n=rowPing[j];if(n<0)continue;
    const [port,starboard]=pings[n].sides,own=rows.get(j);
    if(own&&!port.open&&!starboard.open){offsets.push(own.reduce((t,x)=>t+x,0)/own.length);wobble.push((port.waterline-starboard.waterline)/2);}
    heights.push(pings[n].H);
  }
  for(let m=0;m<17;m++)profile[m]=counts[m]?profile[m]/counts[m]:NaN;
  let artefact=false;
  if(wobble.length>=10){
    const mw=wobble.reduce((a,b)=>a+b,0)/wobble.length,mo=offsets.reduce((a,b)=>a+b,0)/offsets.length;
    let cov=0,vw=0;for(let q=0;q<wobble.length;q++){cov+=(offsets[q]-mo)*(wobble[q]-mw);vw+=(wobble[q]-mw)**2;}
    if(Math.sqrt(vw/wobble.length)>=.05&&cov/vw<.5)artefact=true;
  }
  const mean=(a,b)=>{let t=0,n=0;for(let m=a;m<=b;m++){const v=profile[m+8];if(v===v){t+=v;n++;}}return n?t/n:NaN;};
  const base=(mean(-8,-6)+mean(6,8))/2,inner=Math.max(mean(-4,-2),mean(-3,-1)),outer=Math.max(mean(2,4),mean(1,2)),lift=.08;
  const litInner=inner>base+lift,litOuter=outer>base+lift;
  if(!dark)return {kind:'step',detail:'step up facing the sonar: the far side stands higher',artefact};
  // Shadow width: the dark deficit in the core, as an equivalent width of full shadow.
  let deficit=0;const floor=Math.min(...Array.from(profile).filter(v=>v===v));
  for(let m=-3;m<=4;m++){const v=profile[m+8];if(v===v)deficit+=Math.max(0,base-v);}
  const width=deficit/Math.max(.05,base-floor)*px,range=Math.abs(line.cx-maxOffset)+width;
  const h=heights.length?heights.reduce((a,b)=>a+b,0)/heights.length:null,sizeCm=h?Math.round(h*width/range*1000)/10:null;
  if(litOuter&&!litInner)return {kind:'crack',detail:'open crack: a gap with its far wall lit',sizeCm,artefact};
  if(litInner)return {kind:'step',detail:'raised edge casting a shadow',sizeCm,artefact};
  return {kind:'crack',detail:'crack, or a step down where the far side sits lower',sizeCm,artefact};
}

// Three or more lines across the canal at regular spacing are construction joints rather than cracks.
function markJoints(candidates){
  const across=candidates.filter(c=>c.direction==='across'&&c.polarity==='dark').sort((a,b)=>a.alongM-b.alongM);
  for(let start=0;start<across.length;start++){
    for(let end=across.length-1;end>=start+2;end--){
      const run=across.slice(start,end+1),gaps=run.slice(1).map((c,i)=>c.alongM-run[i].alongM),m=gaps.reduce((a,b)=>a+b,0)/gaps.length;
      if(m<1.5||m>10)continue;
      const spread=Math.sqrt(gaps.reduce((t,g)=>t+(g-m)**2,0)/gaps.length)/m;
      if(spread<=.15){for(const c of run){c.kind='joint';c.jointSpacingM=m;c.detail=`joint, one of ${run.length} about ${m.toFixed(1)} m apart`;}start=end;break;}
    }
  }
}

// The candidates as GeoJSON lines, for checking on site.
export function candidatesGeoJson(result,{name=''}={}){
  return {type:'FeatureCollection',name,features:result.candidates.map(c=>({type:'Feature',
    geometry:{type:'LineString',coordinates:c.lonlat.map(([lon,lat])=>[+lon.toFixed(7),+lat.toFixed(7)])},
    properties:{id:c.id,kind:c.kind,detail:c.detail,direction:c.direction,length_m:+c.lengthM.toFixed(2),size_cm:c.sizeCm,
      side:c.side,offset_m:+c.offsetM.toFixed(2),along_m:+c.alongM.toFixed(1),confidence:c.confidence,recording_time_s:+c.time.toFixed(2),
      note:'Candidate from sidescan screening; check on site.'}}))};
}
