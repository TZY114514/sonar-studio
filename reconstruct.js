// Canal and seabed reconstruction from Lowrance sonar and matched GPS.
//
// Measured and estimated parts:
// - Depth under the boat comes from the primary sonar (measured).
// - Each sidescan ping is read as a cross-section of the canal. Echoes stop where the bank meets the
//   waterline, and a bank facing the sonar echoes brighter than the bed, which locates the bank toe.
//   Between toe and waterline the bank is taken as a straight slope (estimated).
// - Raised objects and depressions are found from the acoustic shadows they cast. An object's height
//   comes from its shadow: h = H * L / R, with H the sonar's height above the bed, L the shadow length
//   and R the ground range to the far end of the shadow (the standard sidescan estimate).
// - The sidescan texture is laid on the reconstructed shape instead of a flat bed.
import {FileWindow,quantile,primaryValue,resolvePosition,validPosition,FEET_TO_METRES} from './engine.js';

// What each grid cell is based on.
export const SOURCE={none:0,measured:1,bed:2,bank:3,bankAssumed:4,object:5,depression:6,land:7};
const RANK=[0,6,2,4,3,7,7,1];   // a cell reached by several pings keeps its most specific source

export const localMetres=origin=>{const c=Math.cos(origin.lat*Math.PI/180);return (lon,lat)=>[(lon-origin.lon)*111320*c,(lat-origin.lat)*111320];};
export const lonLatOf=(origin,x,y)=>({lon:origin.lon+x/(111320*Math.cos(origin.lat*Math.PI/180)),lat:origin.lat+y/111320});
const yieldToBrowser=()=>new Promise(resolve=>setTimeout(resolve,0));

// The grid is rotated to the survey's main direction: u runs along it, v across. axis = [cos, sin].
const toGrid=(model,x,y)=>[x*model.axis[0]+y*model.axis[1],-x*model.axis[1]+y*model.axis[0]];
export const gridToLocal=(model,u,v)=>[u*model.axis[0]-v*model.axis[1],u*model.axis[1]+v*model.axis[0]];

// A grid value at a local position, bilinear between cells with data.
function sampleGrid(model,values,x,y){
  const [u,v]=toGrid(model,x,y),fx=(u-model.minU)/model.cell,fy=(v-model.minV)/model.cell,i=Math.floor(fx),j=Math.floor(fy);
  let sum=0,weight=0;
  for(const [di,dj] of [[0,0],[1,0],[0,1],[1,1]]){
    const ii=i+di,jj=j+dj;if(ii<0||jj<0||ii>=model.nx||jj>=model.ny)continue;
    const value=values[jj*model.nx+ii],w=(di?fx-i:1-(fx-i))*(dj?fy-j:1-(fy-j));
    if(!Number.isNaN(value)&&w>0){sum+=value*w;weight+=w;}
  }
  return weight>0?sum/weight:NaN;
}
// Depth (positive down, negative above water) at a local position.
export const seabedDepthAt=(model,x,y)=>sampleGrid(model,model.depth,x,y);
// The canal's smooth shape there: level bed and straight banks, without bed detail or objects.
export const seabedBaseAt=(model,x,y)=>model.base?sampleGrid(model,model.base,x,y):NaN;
export function seabedSourceAt(model,x,y){
  const [u,v]=toGrid(model,x,y),i=Math.round((u-model.minU)/model.cell),j=Math.round((v-model.minV)/model.cell);
  return i<0||j<0||i>=model.nx||j>=model.ny?SOURCE.none:model.source[j*model.nx+i];
}

export function smooth(values,k){
  const out=new Float32Array(values.length);let sum=0;
  for(let i=0;i<values.length+k;i++){
    if(i<values.length)sum+=values[i];
    if(i-2*k-1>=0)sum-=values[i-2*k-1];
    const centre=i-k;if(centre>=0&&centre<values.length)out[centre]=sum/(Math.min(values.length-1,i)-Math.max(0,i-2*k)+1);
  }
  return out;
}
// Quantile of echo values (0-255) from index a to b, counted in a histogram rather than sorted.
function echoQuantile(s,a,b,q){
  a=Math.max(0,a);b=Math.min(s.length,b);if(b<=a)return null;
  const counts=new Uint32Array(256);for(let i=a;i<b;i++)counts[Math.max(0,Math.min(255,Math.round(s[i])))]++;
  let target=q*(b-a),v=0;for(;v<255;v++){target-=counts[v];if(target<0)break;}
  return v;
}
// Splits an echo profile (from the bed out to the waterline) into two straight-line trends against
// ground range. Returns the ground range of the best break and how much of the one-line misfit the
// split removes (0-1), or null when the profile is too short.
function changePoint(s,skip,{first,end,dr,H,step,margin,from=0}){
  const xs=[],ys=[];
  for(let y=from+step/2;;y+=step){
    const a=Math.floor(Math.hypot(y-step/2,H)/dr),b=Math.min(end,Math.floor(Math.hypot(y+step/2,H)/dr));
    if(b>=end)break;if(a<first+2||b<=a)continue;
    let t=0,m=0;for(let i=a;i<b;i++)if(!skip[i]){t+=s[i];m++;}
    if(m)xs.push(y),ys.push(t/m);
  }
  const n=xs.length;if(n<Math.ceil(3*margin/step))return null;
  const sx=[0],sy=[0],sxx=[0],sxy=[0],syy=[0];
  for(let i=0;i<n;i++){sx.push(sx[i]+xs[i]);sy.push(sy[i]+ys[i]);sxx.push(sxx[i]+xs[i]*xs[i]);sxy.push(sxy[i]+xs[i]*ys[i]);syy.push(syy[i]+ys[i]*ys[i]);}
  const misfit=(a,b)=>{const m=b-a,X=sx[b]-sx[a],Y=sy[b]-sy[a],XX=sxx[b]-sxx[a],XY=sxy[b]-sxy[a],YY=syy[b]-syy[a],vx=XX-X*X/m,cov=XY-X*Y/m,vy=YY-Y*Y/m;return vx>1e-9?Math.max(0,vy-cov*cov/vx):Math.max(0,vy);};
  const whole=misfit(0,n),edge=Math.max(2,Math.round(margin/step));let best=Infinity,at=null;
  for(let k=edge;k<=n-edge;k++){const e=misfit(0,k)+misfit(k,n);if(e<best){best=e;at=(xs[k-1]+xs[k])/2;}}
  return at==null||!(whole>0)?null:{at,gain:1-best/whole};
}
// Ground distance from the boat of the echo at slant range r on a side's cross-section, or null.
export function groundRange(r,H,draft,side){
  if(r<=H)return null;
  const bed=Math.sqrt(r*r-H*H);
  if(side.open||bed<=side.toe)return side.open&&bed>side.reach?null:bed;
  const slope=(H+draft)/(side.waterline-side.toe),c=slope*side.waterline-draft,a=1+slope*slope,b=-2*c*slope,disc=b*b-4*a*(c*c-r*r);
  if(disc<0)return null;
  const y=(-b+Math.sqrt(disc))/(2*a);
  return y>side.waterline?null:y;
}

// Reads one side of a sidescan ping (samples from the boat outward) as a cross-section.
// reference: the average echo every REF_STEP metres of slant range in the surrounding pings (see
// slidingReference); shadows are judged against it. With shadows false, only the waterline is found,
// and row holds this ping's echoes in the reference's format.
export function analyseSide(samples,{rangeM,H,draft,sensitivity,reference=null,shadows=true}){
  const n=samples.length,dr=rangeM/n,s=smooth(samples,2),first=Math.min(n-1,Math.max(0,Math.floor(H/dr)));
  const reach=Math.sqrt(Math.max(0,rangeM*rangeM-H*H));
  // Noise floor: the quieter of the water column and the faintest part of the ping (on many sonars the
  // water column near the transducer is far from silent, while the dry bank beyond the waterline is).
  const faintest=echoQuantile(s,0,n,.05),noise=first>6?Math.min(echoQuantile(s,1,first-1,.5),faintest):faintest;
  const side={open:true,reach,toe:null,waterline:null,assumed:false,features:[],shadowBins:[],first,dr,end:n};
  const prefix=new Float64Array(n+1);for(let i=0;i<n;i++)prefix[i+1]=prefix[i]+s[i];
  const mean=(a,b)=>{a=Math.max(0,a);b=Math.min(n,b);return b>a?(prefix[b]-prefix[a])/(b-a):0;};
  // The bed's echo level close to the boat, where the bed is surely under water.
  const near=Math.min(n,Math.floor(Math.hypot(2,H)/dr));
  const bedLevel=near>first+8?echoQuantile(s,first+2,near,.5):echoQuantile(s,first,n,.6);
  if(!(bedLevel>noise+4)){side.empty=true;return side;}
  // Waterline: where the echoes fade into the noise and stay there. Faint echoes beyond it (sound
  // reflected off the surface) and shadows on the bed are followed by brighter echoes, so a fade only
  // counts when the next 3 m and the rest of the ping stay dark too.
  const endThreshold=noise+.2*(bedLevel-noise),window=Math.max(3,Math.round(.5/dr)),ahead=Math.round(3/dr);
  let end=n;
  for(let i=first+window;i<n-window;i+=Math.max(1,window>>3)){
    if(mean(i,i+window)>=endThreshold)continue;
    if(mean(i,Math.min(n,i+ahead))<endThreshold&&mean(i,n)<endThreshold){end=i;break;}
  }
  side.open=end>=n-window;
  if(!side.open)side.waterline=Math.sqrt(Math.max(0,(end*dr)**2-draft*draft));
  if(!shadows){
    side.row=new Uint8Array(Math.ceil(rangeM/REF_STEP));const count=new Uint16Array(side.row.length),sum=new Float32Array(side.row.length);
    for(let i=first;i<end;i++){const b=Math.floor(i*dr/REF_STEP);sum[b]+=s[i];count[b]++;}
    for(let b=0;b<side.row.length;b++)if(count[b])side.row[b]=Math.min(255,Math.round(sum[b]/count[b])+1);
    side.end=end;return side;
  }
  // Shadows: dark runs inside the echoes, usually cast by something standing on the bed. A run followed
  // by clearly brighter echoes is a depression whose far wall faces the sonar. In shallow water, sound reflected
  // off the surface partly fills shadows, so a run also counts when it is much darker than the bed
  // usually is at that range (the reference), not only when it is close to silent. Without a reference,
  // the bed level is the 70th percentile over 2.5 m around the point.
  const level=echoQuantile(s,first,end,.6)??bedLevel;
  const shadowLevel=noise+(.18+.3*sensitivity)*(level-noise),ratio=.55+.2*sensitivity,minBins=Math.max(3,Math.round(.15/dr));
  let bedAt;
  if(reference)bedAt=i=>reference[Math.floor(i*dr/REF_STEP)]||level;
  else{
    const perBin=Math.max(1,Math.round(.05/dr)),lo=Math.floor(first/perBin),hi=Math.ceil(end/perBin),local=new Float32Array(Math.ceil(n/perBin)+1);
    const means=[];for(let b=lo;b<hi;b++)means.push(mean(b*perBin,(b+1)*perBin));
    for(let b=lo;b<hi;b+=5){const value=quantile(means.slice(Math.max(0,b-lo-25),b-lo+26),.7);local.fill(value,b,Math.min(hi,b+5));}
    bedAt=i=>local[Math.floor(i/perBin)];
  }
  // Speckle breaks shadows into pieces at centimetre resolution, so darkness is judged over about 15 cm
  // and gaps shorter than 10 cm are bridged.
  const broad=dr<.03?smooth(samples,Math.round(.07/dr)):s,gap=Math.round(.1/dr);
  const dark=i=>broad[i]<Math.max(shadowLevel,ratio*bedAt(i));
  const ground=(r,h=0)=>Math.sqrt(Math.max(0,r*r-(H-h)**2));
  const within=(a,b)=>mean(Math.max(first,a),Math.min(end,b));
  for(let i=first+3;i<end-3;){
    if(!dark(i)){i++;continue;}
    let j=i;
    for(;;){while(j<end-3&&dark(j))j++;let k=j;while(k<Math.min(end-3,j+gap)&&!dark(k))k++;if(k<end-3&&k<j+gap&&dark(k))j=k;else break;}
    const next=j;
    if(j-i>=minBins&&j<end-3){
      const span=Math.max(3,Math.round(.5/dr)),before=within(i-span,i),after=within(j,j+span),bedAround=bedAt(Math.floor((i+j)/2));
      // Shadow edges at half brightness, between the dark shadow and the echoes on either side.
      const floor=within(i,j);
      while(i>first+1&&s[i-1]<(floor+before)/2)i--;
      while(j<end-1&&s[j]<(floor+after)/2)j++;
      const yb=ground(j*dr);
      // On average the whole run must be clearly darker than the bed around it.
      if(yb>ground(i*dr)&&ground(i*dr)>.3&&floor<(ratio+.05)*bedAround){
        const contrast=Math.max(0,1-floor/bedAround);
        if(after<1.15*Math.max(before,bedAround)){
          // The shadow starts at the object's top, which stands h above the bed: solve h = H*L/R with
          // the top's ground range taken at that height (a few rounds converge).
          let h=0,ya=ground(i*dr);
          for(let round=0;round<4;round++){ya=ground(i*dr,h);h=Math.max(0,Math.min(H*.9,H*(yb-ya)/yb));}
          // The lit side: echoes brighter than the bed in front of the object. They come from the top
          // and the face turned to the sonar, so their start is placed at the top's height as well.
          const a=Math.max(first+2,i-Math.round(1.5/dr)),b=i-Math.round(.6/dr);
          const bed=b-a>=8?echoQuantile(s,a,b,.5):level;
          let k=i;while(k>first+2&&s[k-1]>bed*1.15&&i-k<Math.round(2/dr))k--;
          const lit=k<i-2?Math.max(.2,ya-ground(k*dr,h)):null;
          side.features.push({kind:'object',start:ya-(lit??.3),end:ya,lit,height:h,shadowStart:ya,shadowEnd:yb,contrast});
          side.shadowBins.push([i,j,ya,yb]);
        }else{const ya=ground(i*dr);side.features.push({kind:'depression',start:ya,end:yb,lit:yb-ya,height:H*(yb-ya)/ya,shadowStart:ya,shadowEnd:yb,contrast});side.shadowBins.push([i,j,ya,yb]);}
      }
    }
    i=Math.max(next,j);
  }
  // Bank toe: where the echoes change character between the bed and the waterline. A bank echoes
  // differently from the bed (brighter where it faces the sonar, darker where it is smooth or lined), so
  // the toe is the break that best splits the echoes into two straight-line trends against ground range.
  if(!side.open&&side.waterline>1){
    const skip=new Uint8Array(n);for(const [a,b] of side.shadowBins)skip.fill(1,Math.max(0,a-3),Math.min(n,b+3));
    // Echoes fade fast right beside the boat, so the search starts a metre (or a water depth) out.
    const toe=changePoint(s,skip,{first,end,dr,H,step:.1,margin:.4,from:Math.max(1,H)});
    if(toe!=null&&toe.gain>=.2&&toe.at<side.waterline-.2)side.toe=toe.at;
    else{side.toe=Math.max(.3,side.waterline-1.5*(H+draft));side.assumed=true;}
  }
  // Dark stretches on the bank slope are its own texture, not shadows of objects on the bed.
  if(side.toe!=null){
    const toeBin=Math.hypot(side.toe,H)/dr;
    side.features=side.features.filter(f=>f.start<side.toe);side.shadowBins=side.shadowBins.filter(([a])=>a<toeBin);
  }
  side.end=end;
  return side;
}

// Calls visit(i, reference) for each ping in turn, with the average of the rows (see analyseSide) of the
// pings within halfWindow of it: the usual echo at each slant range around that ping. 0 means unknown.
export function slidingReference(rows,halfWindow,visit){
  const bins=Math.max(0,...rows.map(row=>row.length)),total=new Float64Array(bins),used=new Uint32Array(bins),reference=new Float32Array(bins);
  const add=(row,sign)=>{for(let b=0;b<row.length;b++)if(row[b]){total[b]+=sign*(row[b]-1);used[b]+=sign;}};
  for(let i=0;i<Math.min(halfWindow,rows.length);i++)add(rows[i],1);
  for(let i=0;i<rows.length;i++){
    if(i+halfWindow<rows.length)add(rows[i+halfWindow],1);
    if(i-halfWindow-1>=0)add(rows[i-halfWindow-1],-1);
    for(let b=0;b<bins;b++)reference[b]=used[b]?total[b]/used[b]:0;
    visit(i,reference);
  }
}

// Bed detail from shading. A slope facing the sonar echoes brighter than the average bed at the same
// range, a slope facing away echoes darker. The average comes from the surrounding pings, so the sonar's
// own gain curve cancels out. The brightness ratio gives the local slope, integrated across the bed and
// pinned to the known depths at both ends. Returns heights above the bed every RELIEF_STEP metres.
// reference holds the average echo every REF_STEP metres of slant range.
export const RELIEF_STEP=.1,REF_STEP=.05;
export function shadingRelief(s,reference,{first,dr,H,end,skip,features}){
  const reach=Math.sqrt(Math.max(0,(end*dr)**2-H*H)),count=Math.floor(reach/RELIEF_STEP);
  if(count<20)return null;
  const blocked=new Uint8Array(s.length);for(const [a,b] of skip)blocked.fill(1,Math.max(0,a-6),Math.min(s.length,b+6));
  const ratioAt=y=>{const r=Math.hypot(y,H),i=Math.floor(r/dr),ref=reference[Math.floor(r/REF_STEP)];return i>=first+3&&i<end&&!blocked[i]&&ref>1?s[i]/ref:NaN;};
  let usable=0;const slope=new Float32Array(count);
  for(let g=0;g<count;g++){
    const y=(g+.5)*RELIEF_STEP,ratio=ratioAt(y);if(Number.isNaN(ratio)||y<.5)continue;
    const flat=Math.atan2(y,H),c=Math.min(1,Math.max(0,ratio**(1/1.2)*Math.cos(flat)));
    slope[g]=Math.tan(Math.max(-.6,Math.min(.6,flat-Math.acos(c))));usable++;
  }
  if(usable<20)return null;
  const smoothSlope=smooth(slope,4),height=new Float32Array(count);
  for(let g=1;g<count;g++)height[g]=height[g-1]+smoothSlope[g]*RELIEF_STEP;
  // Depth is known under the boat and at the bank toe, so the relief is pinned to zero at both ends.
  const edge=Math.min(5,Math.floor(count/4)),start=height.subarray(0,edge).reduce((a,b)=>a+b,0)/edge,finish=height.subarray(count-edge).reduce((a,b)=>a+b,0)/edge;
  const relief=new Float32Array(count);
  for(let g=0;g<count;g++)relief[g]=height[g]-(start+(finish-start)*g/(count-1));
  // Over long open-water profiles, broad brightness patterns (patches of different bed material)
  // would build up into false slopes, so only features under about 12 m across are kept there.
  if(count*RELIEF_STEP>12){
    const broad=smooth(relief,60);for(let g=0;g<count;g++)relief[g]-=broad[g];
    const a=relief.subarray(0,edge).reduce((t,v)=>t+v,0)/edge,b=relief.subarray(count-edge).reduce((t,v)=>t+v,0)/edge;
    for(let g=0;g<count;g++)relief[g]-=a+(b-a)*g/(count-1);
  }
  for(let g=0;g<count;g++)relief[g]=Math.max(-1,Math.min(1,relief[g]));
  // Leave objects to their shadow-based heights.
  for(const f of features)for(let g=Math.max(0,Math.floor((f.start-.5)/RELIEF_STEP));g<Math.min(count,Math.ceil((f.shadowEnd+.3)/RELIEF_STEP));g++)relief[g]=0;
  return relief;
}

// Median of a window of a series, skipping missing values (null).
// Long windows are evaluated every few values and interpolated in between.
function rollingMedian(values,halfWindow){
  const at=i=>{const w=[];for(let k=Math.max(0,i-halfWindow);k<=Math.min(values.length-1,i+halfWindow);k++)if(values[k]!=null)w.push(values[k]);return w.length?quantile(w,.5):null;};
  const step=Math.max(1,Math.floor(halfWindow/8));if(step===1)return values.map((_,i)=>at(i));
  const out=new Array(values.length).fill(null),last=values.length-1;
  for(let i=0;i<=last;i+=step){
    const a=at(i),j=Math.min(last,i+step),b=j>i?at(j):a;
    for(let k=i;k<=j;k++)out[k]=a!=null&&b!=null?a+(b-a)*(k-i)/Math.max(1,j-i):(k-i<j-k?a:b)??a??b;
  }
  return out;
}

// The rotation that gives the smallest bounding box around the route.
export function bestAxis(points){
  let best=[1,0],bestArea=Infinity;
  for(let deg=0;deg<180;deg+=1){
    const a=deg*Math.PI/180,c=Math.cos(a),s=Math.sin(a);let u0=Infinity,u1=-Infinity,v0=Infinity,v1=-Infinity;
    for(const [x,y] of points){const u=x*c+y*s,v=-x*s+y*c;u0=Math.min(u0,u);u1=Math.max(u1,u);v0=Math.min(v0,v);v1=Math.max(v1,v);}
    const area=(u1-u0+1)*(v1-v0+1);if(area<bestArea){bestArea=area;best=[c,s];}
  }
  return best;
}

// Groups per-ping detections into objects: nearby detections of the same kind in consecutive pings.
// A group needs a few pings and a quarter of a metre of track, so speckle in densely spaced pings does not count.
function clusterFeatures(detections,{minPings=3,minHeight=.1,minSpan=.25}={}){
  const clusters=[];
  for(const d of detections){
    let target=null;
    for(let k=clusters.length-1;k>=0&&k>=clusters.length-12;k--){
      const c=clusters[k],last=c.items.at(-1);
      if(c.kind===d.kind&&Math.hypot(last.x-d.x,last.y-d.y)<1.2&&d.time-last.time<3){target=c;break;}
    }
    if(target)target.items.push(d);else clusters.push({kind:d.kind,items:[d]});
  }
  return clusters.filter(c=>c.items.length>=minPings).map(c=>{
    const n=c.items.length,first=c.items[0];
    // A right-angled frame from the outward direction, measured from the first detection.
    let ox=c.items.reduce((t,d)=>t+d.ox,0),oy=c.items.reduce((t,d)=>t+d.oy,0);const norm=Math.hypot(ox,oy)||1;ox/=norm;oy/=norm;
    let hx=oy,hy=-ox;if(hx*first.hx+hy*first.hy<0){hx=-hx;hy=-hy;}
    const x0=first.x,y0=first.y;
    // Along the track the object spans from its first to its last detection; across it, detections
    // mark the far top edge (objects) or the near edge (depressions).
    const along=c.items.map(d=>(d.x-x0)*hx+(d.y-y0)*hy),across=quantile(c.items.map(d=>(d.x-x0)*ox+(d.y-y0)*oy),.5);
    const a0=Math.min(...along),a1=Math.max(...along),length=Math.max(.3,a1-a0+.3),lits=c.items.map(d=>d.lit).filter(v=>v!=null);
    // Across the track, use the lit side when most pings saw one; otherwise assume it is about as wide as long.
    const width=Math.min(3,Math.max(.3,lits.length*2>=n?quantile(lits,.5):.75*length));
    // The shadow starts at a box's far edge but close to a rounded object's peak, so without a measured
    // side the centre is taken 30 % of the width back from where the shadow starts.
    const centreAcross=across+(c.kind==='object'?-1:1)*width*(lits.length*2>=n?.5:.3),centreAlong=(a0+a1)/2;
    return {kind:c.kind,x:x0+centreAlong*hx+centreAcross*ox,y:y0+centreAlong*hy+centreAcross*oy,height:quantile(c.items.map(d=>d.height),.75),width,length,
      span:a1-a0,heading:[hx,hy],time:quantile(c.items.map(d=>d.time),.5),pings:new Set(c.items.map(d=>d.time)).size,shadowM:quantile(c.items.map(d=>d.shadow),.5),contrast:quantile(c.items.map(d=>d.contrast),.5)};
  }).filter(o=>o.height>=minHeight&&o.span>=minSpan);
}

// Reads the sonar pings of a survey (or of the stretch in timeRange, in recording seconds) with their
// positions and headings, and analyses each side of each sidescan ping as a cross-section of the canal:
// waterline, bank toe and shadows. Pings whose direction is unreliable are left out. Shared by the 3D
// model and the crack screening. Each side keeps its row (see analyseSide) for slidingReference.
export async function readSurvey(file,frames,gps,sync,{draftM=.2,sensitivity=.5,maxPings=8000,timeRange=null,progress=()=>{}}={}){
  const primary=frames.filter(f=>f.channel===0&&validPosition(f.lon,f.lat));
  if(primary.length<20)throw new Error('Too few SL3 positions in this recording');
  const origin={lon:quantile(primary.map(f=>f.lon),.5),lat:quantile(primary.map(f=>f.lat),.5)},local=localMetres(origin);
  // Depth under the sonar, with spikes that disagree with their neighbours removed.
  const plausible=primary.filter(f=>f.depthM>.2&&f.depthM<200);
  const depthPrimary=plausible.filter((f,i)=>{const around=quantile(plausible.slice(Math.max(0,i-7),i+8).map(g=>g.depthM),.5);return Math.abs(f.depthM-around)<=Math.max(.5,.25*around);});
  if(depthPrimary.length<20)throw new Error('Too few valid depth readings in this recording');
  const inRange=f=>!timeRange||f.timeMs/1000>=timeRange[0]&&f.timeMs/1000<=timeRange[1];
  const sidescan=frames.filter(f=>f.channel===5&&f.pingSize>=16&&f.maxRangeFt>0&&inRange(f));
  const pingFrames=sidescan.length?sidescan:depthPrimary.filter(inRange),stride=Math.max(1,Math.ceil(pingFrames.length/maxPings)),reader=new FileWindow(file);
  const at=(time,f)=>resolvePosition(primary,gps,sync,time,f);
  const swathM=sidescan.length?Math.min(150,quantile(sidescan.map(f=>f.maxRangeFt*FEET_TO_METRES),.5)):10;

  // 1. Read every analysed ping as a cross-section.
  const pings=[];
  for(let n=0;n<pingFrames.length;n+=stride){
    const f=pingFrames[n],time=f.timeMs/1000;
    if(n/stride%150===0){progress(.75*n/pingFrames.length);await yieldToBrowser();}
    // Heading over 5 s of track: GPS positions wander by a metre or so, which over a shorter span
    // would twist each cross-section by several degrees.
    const p=at(time,f),a=at(time-2.5,f),b=at(time+2.5,f);
    if(p.lon==null||a.lon==null||b.lon==null)continue;
    const [x,y]=local(p.lon,p.lat),[ax,ay]=local(a.lon,a.lat),[bx,by]=local(b.lon,b.lat),length=Math.hypot(bx-ax,by-ay);
    const before=Math.hypot(x-ax,y-ay),after=Math.hypot(bx-x,by-y);
    // Below about 0.25 m/s the track says little about which way the boat faces (it may be pivoting).
    if(before<.6||after<.6)continue;
    // While the boat turns, or where the GPS jumps (under bridges, for example), a ping's direction is
    // unreliable and it would be laid across its neighbours, so such pings are left out.
    if(((x-ax)*(bx-x)+(y-ay)*(by-y))/(before*after)<Math.cos(25*Math.PI/180)||Math.max(before,after)>2.2*Math.min(before,after))continue;
    // The ping must also lie close to the line through its neighbours.
    if(Math.abs((x-ax)*(by-ay)-(y-ay)*(bx-ax))/length>1)continue;
    const hx=(bx-ax)/length,hy=(by-ay)/length,H=primaryValue(depthPrimary,time,'depthM',f.depthM);
    if(!(H>.1))continue;
    const ping={time,x,y,hx,hy,lx:-hy,ly:hx,H,D:H+draftM};
    if(f.channel===5){
      const payload=await reader.bytes(f.pingOffset,f.pingSize),half=payload.length>>1,rangeM=f.maxRangeFt*FEET_TO_METRES;
      const port=payload.slice(0,half).reverse(),starboard=payload.slice(half,2*half);
      ping.rangeM=rangeM;ping.samples=[port,starboard];
      ping.sides=[port,starboard].map(samples=>analyseSide(samples,{rangeM,H,draft:draftM,sensitivity,shadows:false}));
    }else ping.sides=[0,1].map(()=>({open:true,reach:swathM,features:[],shadowBins:[]}));
    pings.push(ping);
  }
  // GPS glitches: pings whose position or direction disagrees with the median track around them.
  if(pings.length>=10){
    const perSecond=pings.length/Math.max(1,pings.at(-1).time-pings[0].time),half=Math.max(2,Math.round(3*perSecond));
    const mx=rollingMedian(pings.map(p=>p.x),half),my=rollingMedian(pings.map(p=>p.y),half),q=Math.max(1,half>>1);
    const keep=pings.filter((p,i)=>{
      if(Math.hypot(p.x-mx[i],p.y-my[i])>1.5)return false;
      const a=Math.max(0,i-q),b=Math.min(pings.length-1,i+q),tx=mx[b]-mx[a],ty=my[b]-my[a],l=Math.hypot(tx,ty);
      return l<.3||(tx*p.hx+ty*p.hy)/l>Math.cos(30*Math.PI/180);
    });
    // Lone pings or short runs between gaps are too few to trust.
    const runs=[];for(const p of keep){const last=runs.at(-1)?.at(-1);if(last&&Math.hypot(p.x-last.x,p.y-last.y)<1.5&&p.time-last.time<2)runs.at(-1).push(p);else runs.push([p]);}
    const length=run=>{let l=0;for(let i=1;i<run.length;i++)l+=Math.hypot(run[i].x-run[i-1].x,run[i].y-run[i-1].y);return l;};
    pings.splice(0,pings.length,...runs.filter(run=>length(run)>=3).flat());
  }
  if(pings.length<10)throw new Error('Too few sonar pings with a known position and heading');
  {
    const span=Math.max(1,Math.round(pings.length/Math.max(1,(pings.at(-1).time-pings[0].time))*1)),hx=pings.map(p=>p.hx),hy=pings.map(p=>p.hy);
    pings.forEach((p,i)=>{let sx=0,sy=0;for(let k=Math.max(0,i-span);k<=Math.min(pings.length-1,i+span);k++){sx+=hx[k];sy+=hy[k];}const l=Math.hypot(sx,sy)||1;p.hx=sx/l;p.hy=sy/l;p.lx=-p.hy;p.ly=p.hx;});
  }

  // Distance along the survey, counted in the direction of travel so that GPS jitter across the track
  // does not add up (across a gap, the straight distance).
  let along=0;pings.forEach((p,i)=>{if(i){const q=pings[i-1],dx=p.x-q.x,dy=p.y-q.y;along+=p.time-q.time>2?Math.hypot(dx,dy):Math.max(0,dx*p.hx+dy*p.hy);}p.along=along;});
  const spacing=along/Math.max(1,pings.length-1),halfWindow=Math.max(3,Math.round(15/Math.max(.01,spacing)));
  // 2. Shadows and bank toes, judged against the usual echo at each range over the surrounding 30 m of
  // survey. Pings are compared in metres, so a change of the sonar's range setting does not upset it.
  const sonarPings=pings.filter(p=>p.rangeM);
  for(const k of [0,1])slidingReference(sonarPings.map(p=>p.sides[k].row),halfWindow,(i,reference)=>{
    const p=sonarPings[i],row=p.sides[k].row;
    p.sides[k]=analyseSide(p.samples[k],{rangeM:p.rangeM,H:p.H,draft:draftM,sensitivity,reference});p.sides[k].row=row;
  });
  progress(.7);await yieldToBrowser();

  // 3. Smooth bank lines (over about 5 m of track) and the bed level along the survey; keep local bumps near the route.
  const bankWindow=Math.max(15,Math.round(2.5/Math.max(.01,spacing)));
  for(const k of [0,1]){
    const closed=pings.map(p=>p.sides[k].open?null:p.sides[k].waterline),share=rollingMedian(pings.map(p=>p.sides[k].open?0:1),bankWindow);
    const waterline=rollingMedian(closed,bankWindow),toe=rollingMedian(pings.map(p=>p.sides[k].open?null:p.sides[k].toe),bankWindow);
    const assumed=rollingMedian(pings.map(p=>p.sides[k].open?null:p.sides[k].assumed?1:0),bankWindow);
    pings.forEach((p,i)=>{
      const side=p.sides[k];
      if(share[i]>=.5&&waterline[i]!=null){side.open=false;side.waterline=waterline[i];side.toe=Math.min(toe[i]??waterline[i]-2*p.D,waterline[i]-.3);side.assumed=assumed[i]>=.5;}
      else{side.open=true;side.reach=side.reach??swathM;}
    });
  }
  const baseline=rollingMedian(pings.map(p=>p.D),halfWindow);
  pings.forEach((p,i)=>{p.baseline=baseline[i];p.anomaly=p.D-baseline[i];});
  return {origin,local,primary,depthPrimary,sidescan,swathM,pings,sonarPings,spacing,halfWindow};
}

// Builds a canal (or open-water) seabed from the matched sonar and GPS, in local metres
// (x east, y north, depth positive down and negative above the water).
// sensitivity (0-1): how faint a shadow still counts. shading (0-1): how much bed detail from shading to add.
// timeRange ([start, end] in recording seconds) limits the model to one stretch of the survey.
export async function buildSeabedModel(file,frames,gps,sync,{scans=[],draftM=.2,sensitivity=.5,shading=.8,maxCells=200000,maxPings=8000,timeRange=null,progress=()=>{}}={}){
  const {origin,local,depthPrimary,sidescan,swathM,pings,sonarPings,spacing,halfWindow}=await readSurvey(file,frames,gps,sync,{draftM,sensitivity,maxPings,timeRange,progress});
  // 4. Bed detail from shading, against the same reference.
  for(const k of [0,1])slidingReference(sonarPings.map(p=>p.sides[k].row),halfWindow,(i,reference)=>{
    const p=sonarPings[i],side=p.sides[k];if(side.empty)return;
    // Stop half a metre short of the toe, so a toe placed slightly too far out cannot let bank echoes in.
    const smoothed=smooth(p.samples[k],2),end=side.open?smoothed.length:Math.min(side.end,Math.floor(Math.hypot(Math.max(0,side.toe-.5),p.H)/side.dr));
    side.relief=shadingRelief(smoothed,reference,{first:side.first,dr:side.dr,H:p.H,end,skip:side.shadowBins,features:side.features});
  });
  for(const p of sonarPings)for(const side of p.sides)delete side.row;
  // Shading relief, averaged over about 0.6 m of track and weighted by the chosen strength.
  const reliefWindow=Math.max(3,Math.round(.3/Math.max(.01,spacing)));
  for(const k of [0,1])pings.forEach((p,i)=>{
    const own=p.sides[k].relief;if(!own)return;
    const mean=new Float32Array(own.length),weight=new Float32Array(own.length);
    for(let d=-reliefWindow;d<=reliefWindow;d++){const other=pings[i+d]?.sides[k].relief;if(!other)continue;for(let g=0;g<own.length&&g<other.length;g++){mean[g]+=other[g];weight[g]++;}}
    for(let g=0;g<own.length;g++)mean[g]=weight[g]?shading*mean[g]/weight[g]:0;
    p.sides[k].smoothRelief=mean;
  });
  // The bed: the smoothed level plus the depth measured under the boat. With shading relief, the
  // measured difference fades linearly to the end of the relief (the relief is relative to that line);
  // without it, it fades within a metre or two of the route.
  const bedDepth=(p,offset)=>{
    const side=p.sides[offset>=0?0:1],r=side.smoothRelief,a=Math.abs(offset);
    if(!r)return p.baseline+p.anomaly*Math.exp(-.5*(a/1.2)**2);
    const reach=r.length*RELIEF_STEP,g=Math.floor(a/RELIEF_STEP);
    return p.baseline+p.anomaly*Math.max(0,1-a/reach)-(g<r.length?r[g]:0);
  };

  // 3. Grid, rotated to the survey's main direction, with cells as fine as the cell budget allows.
  const extent=p=>p.sides.map(s=>s.open?s.reach:s.waterline+1.5);
  const outline=[];for(const p of pings){const [port,starboard]=extent(p);outline.push([p.x+port*p.lx,p.y+port*p.ly],[p.x-starboard*p.lx,p.y-starboard*p.ly],[p.x,p.y]);}
  const axis=bestAxis(pings.filter((_,i)=>i%Math.max(1,Math.floor(pings.length/1500))===0).map(p=>[p.x,p.y]));
  let minU=Infinity,maxU=-Infinity,minV=Infinity,maxV=-Infinity;
  for(const [x,y] of outline){const u=x*axis[0]+y*axis[1],v=-x*axis[1]+y*axis[0];minU=Math.min(minU,u);maxU=Math.max(maxU,u);minV=Math.min(minV,v);maxV=Math.max(maxV,v);}
  let cell=Math.max(.2,Math.sqrt((maxU-minU)*(maxV-minV)/maxCells)),nx,ny;
  for(;;cell*=1.01){nx=Math.round((maxU-minU)/cell)+1;ny=Math.round((maxV-minV)/cell)+1;if(nx*ny<=maxCells)break;}
  const model={origin,axis,cell,nx,ny,minU,minV,maxU:minU+(nx-1)*cell,maxV:minV+(ny-1)*cell,swathM,draftM};
  const sum=new Float64Array(nx*ny),baseSum=new Float64Array(nx*ny),weights=new Float64Array(nx*ny),count=new Uint16Array(nx*ny),source=new Uint8Array(nx*ny);
  const cellOf=(x,y)=>{const u=x*axis[0]+y*axis[1],v=-x*axis[1]+y*axis[0],i=Math.round((u-minU)/cell),j=Math.round((v-minV)/cell);return i<0||j<0||i>=nx||j>=ny?-1:j*nx+i;};
  // Where swaths overlap, each cross-section counts more close to its own line, so depth blends
  // smoothly from one line to the next.
  const put=(k,depth,base,src,offset)=>{if(k<0)return;const w=1/(1+(offset/5)**2);sum[k]+=depth*w;baseSum[k]+=base*w;weights[k]+=w;count[k]++;if(RANK[src]>RANK[source[k]])source[k]=src;};

  // 4. Lay each cross-section into the grid: bed, bank slopes up to the waterline, and a strip of dry bank.
  // base is the smooth canal shape alone (level bed and straight banks), without bed detail or objects.
  const step=cell/2,LAND=.35;
  const valueAt=(p,o)=>{
    const side=p.sides[o>=0?0:1],a=Math.abs(o);
    if(side.open||a<=side.toe)return {depth:bedDepth(p,o),base:p.baseline,src:a<.6?SOURCE.measured:SOURCE.bed};
    if(a<=side.waterline){const depth=p.baseline*(side.waterline-a)/(side.waterline-side.toe);return {depth,base:depth,src:side.assumed?SOURCE.bankAssumed:SOURCE.bank};}
    const depth=-LAND*Math.min(1,(a-side.waterline)/.6);return {depth,base:depth,src:SOURCE.land};
  };
  pings.forEach((p,n)=>{
    const [port,starboard]=extent(p);
    for(let o=-starboard;o<=port;o+=step){const v=valueAt(p,o);put(cellOf(p.x+o*p.lx,p.y+o*p.ly),v.depth,v.base,v.src,Math.abs(o));}
    // Where a few pings were left out (up to 2 m), blend cross-sections across the gap.
    const q=pings[n-1],gap=q?Math.hypot(p.x-q.x,p.y-q.y):0;
    if(!q||gap<=cell*.7||gap>2||p.time-q.time>5)return;
    const [qPort,qStarboard]=extent(q);
    for(let t=step/gap;t<1;t+=step/gap){
      const x=q.x+(p.x-q.x)*t,y=q.y+(p.y-q.y)*t,lx=q.lx+(p.lx-q.lx)*t,ly=q.ly+(p.ly-q.ly)*t,l=Math.hypot(lx,ly)||1;
      for(let o=-Math.max(starboard,qStarboard);o<=Math.max(port,qPort);o+=step){
        const inP=o<=port&&o>=-starboard,inQ=o<=qPort&&o>=-qStarboard,a=inQ?valueAt(q,o):null,b=inP?valueAt(p,o):null;
        const v=a&&b?{depth:a.depth+(b.depth-a.depth)*t,base:a.base+(b.base-a.base)*t,src:t<.5?a.src:b.src}:a??b;
        put(cellOf(x+o*lx/l,y+o*ly/l),v.depth,v.base,v.src,Math.abs(o));
      }
    }
  });
  progress(.8);await yieldToBrowser();
  let depth=new Float32Array(nx*ny).fill(NaN),base=new Float32Array(nx*ny).fill(NaN);
  for(let k=0;k<nx*ny;k++)if(count[k]){depth[k]=sum[k]/weights[k];base[k]=baseSum[k]/weights[k];}
  // Close gaps between pings, up to about a metre where a few pings were left out.
  for(let pass=0;pass<Math.ceil(Math.max(spacing,.8)/cell)+1;pass++){
    const next=depth.slice(),nextBase=base.slice();
    for(let j=1;j<ny-1;j++)for(let i=1;i<nx-1;i++){
      const k=j*nx+i;if(!Number.isNaN(depth[k]))continue;
      let t=0,tb=0,m=0,best=0;for(const d of [-1,1,-nx,nx]){const value=depth[k+d];if(!Number.isNaN(value)){t+=value;tb+=base[k+d];m++;if(RANK[source[k+d]]>RANK[best])best=source[k+d];}}
      if(m>=2){next[k]=t/m;nextBase[k]=tb/m;source[k]=best;}
    }
    depth=next;base=nextBase;
  }

  // 5. Objects and depressions from their shadows, stamped into the grid.
  const detections=[];
  for(const p of pings)p.sides.forEach((side,k)=>{const sign=k===0?1:-1;for(const f of side.features){
    // Objects are anchored at their far top edge, where the shadow starts; depressions at their near edge.
    const edge=f.kind==='object'?f.end:f.start,ox=sign*p.lx,oy=sign*p.ly;
    if(edge<(side.open?Infinity:side.toe))detections.push({kind:f.kind,x:p.x+edge*ox,y:p.y+edge*oy,ox,oy,height:f.height,lit:f.lit,time:p.time,shadow:f.shadowEnd-f.shadowStart,contrast:f.contrast,hx:p.hx,hy:p.hy});
  }});
  // Anything shorter than 8 % of the water depth (at least 5 cm) is left out as too uncertain.
  // Each object also records which side of the route it is on, how far out, and how far along the stretch.
  const objects=clusterFeatures(detections,{minHeight:Math.max(.05,.08*quantile(pings.map(p=>p.H),.5))}).map((o,i)=>{
    const {lon,lat}=lonLatOf(origin,o.x,o.y),baseDepth=seabedDepthAt({...model,depth},o.x,o.y);
    const p=pings.reduce((best,q)=>Math.abs(q.time-o.time)<Math.abs(best.time-o.time)?q:best),offset=(o.x-p.x)*p.lx+(o.y-p.y)*p.ly;
    return {...o,id:i+1,lon,lat,bedDepth:baseDepth,topDepth:o.kind==='object'?baseDepth-o.height:baseDepth+o.height,
      side:offset>=0?'port':'starboard',offsetM:Math.abs(offset),alongM:p.along+((o.x-p.x)*p.hx+(o.y-p.y)*p.hy)};
  });
  for(const o of objects){
    const [hx,hy]=o.heading,halfL=o.length/2+.1,halfW=o.width/2+.1,r=Math.max(halfL,halfW)+cell;
    const [cu,cv]=[o.x*axis[0]+o.y*axis[1],-o.x*axis[1]+o.y*axis[0]];
    for(let j=Math.floor((cv-r-minV)/cell);j<=Math.ceil((cv+r-minV)/cell);j++)for(let i=Math.floor((cu-r-minU)/cell);i<=Math.ceil((cu+r-minU)/cell);i++){
      if(i<0||j<0||i>=nx||j>=ny)continue;
      const k=j*nx+i;if(Number.isNaN(depth[k]))continue;
      const [x,y]=gridToLocal(model,minU+i*cell,minV+j*cell),dx=x-o.x,dy=y-o.y,al=(dx*hx+dy*hy)/halfL,ac=(-dx*hy+dy*hx)/halfW,rr=Math.hypot(al,ac);
      if(rr>=1)continue;
      const shape=Math.min(1,(1-rr)/.2);   // flat top, tapering over the outer fifth
      depth[k]+=o.kind==='object'?-o.height*shape:o.height*shape;source[k]=o.kind==='object'?SOURCE.object:SOURCE.depression;
    }
  }
  let minDepth=Infinity,maxDepth=-Infinity;
  for(let k=0;k<nx*ny;k++)if(depth[k]>=0){minDepth=Math.min(minDepth,depth[k]);maxDepth=Math.max(maxDepth,depth[k]);}
  Object.assign(model,{depth,base,source,minDepth,maxDepth,objects});

  // 6. Sidescan texture draped on the reconstructed cross-sections, with the shadows marked.
  model.mosaic=sidescan.length?await drape(model,pings,progress):null;

  // Route, scan points and a light record of each cross-section for the profile chart.
  model.route=[];for(let i=0;i<pings.length;i+=Math.max(1,Math.ceil(pings.length/2000)))model.route.push([pings[i].x,pings[i].y]);
  model.sections=pings.filter((_,i)=>i%Math.max(1,Math.ceil(pings.length/2000))===0).map(p=>({time:p.time,x:p.x,y:p.y,lx:p.lx,ly:p.ly,H:p.H,D:p.D,baseline:p.baseline,along:p.along,
    sides:p.sides.map(s=>({open:s.open,reach:s.reach,toe:s.toe,waterline:s.waterline,assumed:s.assumed}))}));
  // Scan points outside the model (in a turn, say) take the depth of the nearest sounding.
  const soundings=depthPrimary.map(f=>[...local(f.lon,f.lat),f.depthM+draftM]);
  const nearestSounding=(x,y)=>soundings.reduce((best,s)=>(s[0]-x)**2+(s[1]-y)**2<(best[0]-x)**2+(best[1]-y)**2?s:best)[2];
  model.scans=scans.map((scan,i)=>{const [x,y]=local(scan.lon,scan.lat),d=seabedDepthAt(model,x,y);return {x,y,depth:Number.isNaN(d)?nearestSounding(x,y):d,number:i+1};});
  model.soundings=depthPrimary.length;model.pingsUsed=pings.length;
  model.banks=[0,1].map(k=>{const closed=pings.filter(p=>!p.sides[k].open);return closed.length/pings.length>=.5?{waterline:quantile(closed.map(p=>p.sides[k].waterline),.5),toe:quantile(closed.map(p=>p.sides[k].toe),.5),assumed:closed.filter(p=>p.sides[k].assumed).length>closed.length/2,slope:quantile(closed.map(p=>p.baseline/Math.max(.1,p.sides[k].waterline-p.sides[k].toe)),.5)}:null;});
  progress(1);
  return model;
}

async function drape(model,pings,progress){
  const {nx,ny,cell,minU,minV,axis,draftM}=model,width=(nx-1)*cell,height=(ny-1)*cell;
  const texel=Math.max(cell/2,width/4095,height/4095),tw=Math.round(width/texel)+1,th=Math.round(height/texel)+1;
  const sum=new Float32Array(tw*th),count=new Uint16Array(tw*th),shade=new Uint16Array(tw*th);
  pings.forEach((p,n)=>{
    if(!p.rangeM)return;
    p.sides.forEach((side,k)=>{
      const samples=p.samples[k],dr=p.rangeM/samples.length,sign=k===0?1:-1,step=Math.max(1,Math.floor(samples.length/512));
      // A shadow runs on the bed from behind the object (where it starts, at the object's top) to where
      // the bed shows again, rather than where a flat bed would put it, which is under the object.
      const shadowGround=new Float32Array(samples.length).fill(NaN);
      for(const [a,b,from,to] of side.shadowBins??[])for(let i=a;i<b;i++)shadowGround[i]=from+(to-from)*(i-a)/Math.max(1,b-a);
      for(let i=0;i+step<=samples.length;i+=step){
        const inShadow=!Number.isNaN(shadowGround[i]),g=inShadow?shadowGround[i]:groundRange((i+step/2)*dr,p.H,draftM,side);if(g==null)continue;
        let value=0;for(let q=0;q<step;q++)value+=samples[i+q];
        const x=p.x+sign*g*p.lx,y=p.y+sign*g*p.ly,u=x*axis[0]+y*axis[1],v=-x*axis[1]+y*axis[0];
        const a=Math.round((u-minU)/texel),b=Math.round((v-minV)/texel);
        if(a>=0&&b>=0&&a<tw&&b<th){const t=b*tw+a;sum[t]+=value/step;count[t]++;if(inShadow)shade[t]++;}
      }
    });
    if(n%300===0)progress(.82+.16*n/pings.length);
  });
  await yieldToBrowser();
  const mean=new Float32Array(tw*th).fill(NaN);
  for(let t=0;t<tw*th;t++)if(count[t])mean[t]=sum[t]/count[t];
  for(let pass=0;pass<Math.max(2,Math.ceil(.5/texel));pass++){
    const next=mean.slice();
    for(let b=1;b<th-1;b++)for(let a=1;a<tw-1;a++){
      const t=b*tw+a;if(!Number.isNaN(mean[t]))continue;
      let total=0,m=0;for(const d of [-1,1,-tw,tw,-tw-1,-tw+1,tw-1,tw+1]){const value=mean[t+d];if(!Number.isNaN(value)){total+=value;m++;}}
      if(m>=3)next[t]=total/m;
    }
    mean.set(next);
  }
  const covered=[];for(let t=0;t<tw*th;t+=7)if(!Number.isNaN(mean[t]))covered.push(mean[t]);
  if(!covered.length)return null;
  const low=quantile(covered,.02),high=quantile(covered,.98),values=new Uint8Array(tw*th),mask=new Uint8Array(tw*th),shadow=new Uint8Array(tw*th);
  for(let t=0;t<tw*th;t++)if(!Number.isNaN(mean[t])){mask[t]=1;values[t]=Math.max(0,Math.min(255,Math.round((mean[t]-low)/Math.max(1e-6,high-low)*255)));shadow[t]=count[t]&&shade[t]*2>=count[t]?1:0;}
  return {width:tw,height:th,texel,values,mask,shadow,pings:pings.filter(p=>p.rangeM).length};
}
