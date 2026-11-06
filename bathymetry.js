// Lake/pond view: recorded under-boat depth, bounded local interpolation, and no sidescan-derived height.
import {quantile,resolvePosition,validPosition} from './engine.js?v=hover-20261106a';
import {localMetres,SOURCE,seabedDepthAt} from './reconstruct.js?v=hover-20261106a';

// Estimate only inside the surrounding samples, within a user-visible radius. Never extrapolate.
export function localDepthEstimate(x,y,neighbours,radius){
  const nearby=neighbours.map(p=>({...p,d:Math.hypot(p.x-x,p.y-y)})).filter(p=>p.d<=radius&&Number.isFinite(p.depth));
  const exact=nearby.find(p=>p.d<1e-9);if(exact)return exact.depth;
  if(nearby.length<3)return NaN;
  const angles=nearby.map(p=>Math.atan2(p.y-y,p.x-x)).sort((a,b)=>a-b);
  let gap=angles[0]+2*Math.PI-angles.at(-1);
  for(let i=1;i<angles.length;i++)gap=Math.max(gap,angles[i]-angles[i-1]);
  if(gap>=Math.PI-.01)return NaN;
  let total=0,weight=0;for(const p of nearby){const w=1/(p.d*p.d);total+=w*p.depth;weight+=w;}
  return total/weight;
}

export async function buildLakeModel(file,frames,gps,sync,{draftM=.2,interpolationM=2,maxCells=200000,timeRange=null,scans=[],progress=()=>{}}={}){
  const primary=frames.filter(f=>f.channel===0&&validPosition(f.lon,f.lat));
  const valid=primary.filter(f=>f.depthM>.2&&f.depthM<200);
  const accepted=valid.filter((f,i)=>{
    const median=quantile(valid.slice(Math.max(0,i-7),i+8).map(p=>p.depthM),.5);
    return Math.abs(f.depthM-median)<=Math.max(.5,.25*median)&&(!timeRange||f.timeMs/1000>=timeRange[0]&&f.timeMs/1000<=timeRange[1]);
  });
  if(accepted.length<3)throw new Error('Too few valid under-boat depth readings in this time range.');
  const origin={lon:quantile(accepted.map(f=>f.lon),.5),lat:quantile(accepted.map(f=>f.lat),.5)},local=localMetres(origin);
  const samples=[],positionSources={};
  for(const f of accepted){
    const p=resolvePosition(primary,gps,sync,f.timeMs/1000,f);if(!validPosition(p.lon,p.lat))continue;
    const [x,y]=local(p.lon,p.lat);samples.push({x,y,depth:f.depthM+draftM,H:f.depthM,time:f.timeMs/1000});
    positionSources[p.source]=(positionSources[p.source]??0)+1;
  }
  if(samples.length<3)throw new Error('Too few depth readings with a valid GPS position.');
  progress(.2);await new Promise(resolve=>setTimeout(resolve,0));
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const p of samples){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
  let cell=Math.max(1,Math.sqrt((maxX-minX+4)*(maxY-minY+4)/Math.max(16,maxCells-1))),nx,ny,minU,minV;
  for(;;cell*=1.01){minU=Math.floor(minX/cell)*cell-cell;minV=Math.floor(minY/cell)*cell-cell;nx=Math.ceil((maxX-minU)/cell)+2;ny=Math.ceil((maxY-minV)/cell)+2;if(nx*ny<=maxCells)break;}
  const groups=new Map(),indexOf=(x,y)=>Math.round((y-minV)/cell)*nx+Math.round((x-minU)/cell);
  for(const p of samples){const k=indexOf(p.x,p.y);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(p);}
  const depth=new Float32Array(nx*ny).fill(NaN),source=new Uint8Array(nx*ny),points=[];
  for(const [k,items] of groups){
    const value=quantile(items.map(p=>p.depth),.5),x=minU+(k%nx)*cell,y=minV+Math.floor(k/nx)*cell;
    depth[k]=value;source[k]=SOURCE.measured;
    points.push({x,y,depth:value,count:items.length,spread:quantile(items.map(p=>p.depth),.9)-quantile(items.map(p=>p.depth),.1)});
  }
  const measured=depth.slice(),radius=Math.max(0,Math.min(5,interpolationM)),reach=Math.ceil(radius/cell);
  let estimatedCells=0;
  for(let j=0;j<ny;j++){
    if(j%40===0){progress(.25+.65*j/ny);await new Promise(resolve=>setTimeout(resolve,0));}
    for(let i=0;i<nx;i++){
      const k=j*nx+i;if(source[k]||radius===0)continue;
      const nearby=[];
      for(let dj=-reach;dj<=reach;dj++)for(let di=-reach;di<=reach;di++){
        const a=i+di,b=j+dj;if(a<0||b<0||a>=nx||b>=ny)continue;
        const value=measured[b*nx+a];if(Number.isFinite(value))nearby.push({x:minU+a*cell,y:minV+b*cell,depth:value});
      }
      const value=localDepthEstimate(minU+i*cell,minV+j*cell,nearby,radius);
      if(Number.isFinite(value)){depth[k]=value;source[k]=SOURCE.interpolated;estimatedCells++;}
    }
  }
  const model={mode:'lake',origin,axis:[1,0],cell,nx,ny,minU,minV,maxU:minU+(nx-1)*cell,maxV:minV+(ny-1)*cell,
    depth,base:depth.slice(),source,draftM,objects:[],banks:[null,null],mosaic:null,route:[],sections:[],
    minDepth:quantile(samples.map(p=>p.depth),0),maxDepth:quantile(samples.map(p=>p.depth),1),points,
    soundings:samples.length,pingsUsed:samples.length,interpolationM:radius,positionSources,
    coverage:{measuredCells:points.length,estimatedCells,unknownCells:nx*ny-points.length-estimatedCells,cellM:cell,
      sampledAreaM2:points.length*cell*cell,estimatedAreaM2:estimatedCells*cell*cell,extentAreaM2:(nx-1)*(ny-1)*cell*cell},
    profile:samples.filter((_,i)=>i%Math.max(1,Math.ceil(samples.length/1200))===0),
    depthSpreadP90:quantile(points.map(p=>p.spread),.9)};
  model.scans=scans.map((scan,i)=>{const [x,y]=local(scan.lon,scan.lat);return {x,y,depth:seabedDepthAt(model,x,y),number:i+1};});
  progress(1);return model;
}
