// Rotatable 3D view of the canal reconstruction from buildSeabedModel (reconstruct.js). Loaded on demand with three.js.
// Axes: three.js x = east, y = up (depth is negative), z = south.
import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {color} from './scan-image.js';
import {seabedDepthAt,gridToLocal,SOURCE} from './reconstruct.js';

// Colours. Depth is one blue ramp (shallow light, deep dark); relief diverges from a neutral grey,
// warm for raised and cool for lower than the canal's smooth shape; sources are three categories,
// validated for colour-vision deficiencies on the dark scene. Dry bank keeps one earth colour in every mode.
const DEPTH_RAMP=['#cde2fb','#86b6ef','#3987e5','#1c5cab','#104281'];
const RELIEF_RAMP=['#256abf','#86b6ef','#f0efec','#f0a09f','#e34948'];
const SOURCES=[
  {label:'Measured under the boat',color:'#3987e5',codes:[SOURCE.measured]},
  {label:'Reconstructed from sidescan',color:'#d95926',codes:[SOURCE.bed,SOURCE.bank,SOURCE.object,SOURCE.depression]},
  {label:'Bank toe assumed',color:'#199e70',codes:[SOURCE.bankAssumed]},
];
const LAND='#8a7d62',NO_SONAR=[118,130,142],SHADOW=[53,224,255];
// Object markers stay neutral (white) so they never read as one of the colour categories; their
// labels say what they are.
const MARKER='#ffffff',SELECTED='#f0b84f',WATERLINE='#f0b84f';

const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
function ramp(stops,t){
  const f=Math.max(0,Math.min(1,t))*(stops.length-1),i=Math.min(stops.length-2,Math.floor(f)),a=rgb(stops[i]),b=rgb(stops[i+1]),w=f-i;
  return a.map((v,k)=>v+(b[k]-v)*w);
}
const linear=([r,g,b])=>{const c=new THREE.Color().setRGB(r/255,g/255,b/255,THREE.SRGBColorSpace);return [c.r,c.g,c.b];};
const cssOf=([r,g,b])=>`rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;

// Relief: how far the reconstruction stands above (+) or below (-) the canal's smooth shape.
function reliefRange(model){
  const values=[];for(let k=0;k<model.depth.length;k+=3){const d=model.depth[k],b=model.base?.[k];if(d>=0&&b>=0)values.push(Math.abs(b-d));}
  values.sort((a,b)=>a-b);return Math.max(.1,values[Math.floor(values.length*.98)]??.1);
}
export function contourInterval(model){
  const range=Math.max(.01,model.maxDepth-model.minDepth);
  return [.05,.1,.2,.25,.5,1,2,5,10].find(step=>range/step<=12)??20;
}

// What each colour means, for the page's legend.
export function legendFor(mode,model){
  const land={color:LAND,label:'Dry bank'};
  if(mode==='depth')return {gradient:DEPTH_RAMP,from:`${model.minDepth.toFixed(1)} m`,to:`${model.maxDepth.toFixed(1)} m deep`,items:[land]};
  if(mode==='relief'){const r=reliefRange(model);return {gradient:RELIEF_RAMP,from:`${(r*100).toFixed(0)} cm lower`,to:`${(r*100).toFixed(0)} cm higher`,note:'than the canal’s smooth shape',items:[land]};}
  if(mode==='source')return {items:[...SOURCES.map(({label,color})=>({color,label})),land]};
  return {gradient:[cssOf(color(.12)),cssOf(color(.55)),cssOf(color(1))],from:'weak echo',to:'strong echo',items:[land]};
}
export const OVERLAY_COLOURS={shadow:cssOf(SHADOW),waterline:WATERLINE,marker:MARKER};

function textSprite(lines,{selected=false}){
  const canvas=document.createElement('canvas'),g=canvas.getContext('2d'),scale=2,font=`600 ${13*scale}px system-ui,"Segoe UI",sans-serif`;
  g.font=font;const width=Math.ceil(Math.max(...lines.map(line=>g.measureText(line).width)))+22*scale,height=(lines.length*17+10)*scale;
  canvas.width=width;canvas.height=height;
  g.fillStyle=selected?'#ffffff':'rgba(9,20,32,.88)';g.strokeStyle=selected?SELECTED:MARKER;g.lineWidth=(selected?3:2)*scale;
  g.beginPath();g.roundRect(1.5*scale,1.5*scale,width-3*scale,height-3*scale,7*scale);g.fill();g.stroke();
  g.fillStyle=selected?'#0b1826':'#ffffff';g.font=font;g.textBaseline='top';
  lines.forEach((line,i)=>g.fillText(line,11*scale,(6+i*17)*scale));
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,sizeAttenuation:false,depthTest:false,transparent:true}));
  sprite.center.set(.5,0);sprite.renderOrder=12;sprite.userData.pixels=[width/scale,height/scale];
  return sprite;
}
function labelTexture(number,fill){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;
  const g=canvas.getContext('2d');
  g.beginPath();g.arc(32,32,27,0,Math.PI*2);g.fillStyle=fill;g.fill();g.lineWidth=5;g.strokeStyle='#fff';g.stroke();
  g.fillStyle='#fff';g.font='700 28px "Segoe UI",Arial,sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(String(number),32,34);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}

// The mosaic as a texture; where there is no sonar, dry bank takes the land colour.
function sonarTexture(model){
  const {mosaic}=model,rgba=new Uint8Array(mosaic.width*mosaic.height*4),land=rgb(LAND);
  for(let b=0;b<mosaic.height;b++)for(let a=0;a<mosaic.width;a++){
    const k=b*mosaic.width+a;let c;
    if(mosaic.mask[k])c=color(.12+.88*mosaic.values[k]/255);
    else{const i=Math.round(a*mosaic.texel/model.cell),j=Math.round(b*mosaic.texel/model.cell),d=model.depth[Math.min(model.ny-1,j)*model.nx+Math.min(model.nx-1,i)];c=d<0?land:NO_SONAR;}
    rgba.set([c[0],c[1],c[2],255],k*4);
  }
  return dataTexture(rgba,mosaic.width,mosaic.height,true);
}
function shadowTexture(mosaic){
  const rgba=new Uint8Array(mosaic.width*mosaic.height*4);
  for(let k=0;k<mosaic.shadow.length;k++)if(mosaic.shadow[k])rgba.set([...SHADOW,235],k*4);
  return dataTexture(rgba,mosaic.width,mosaic.height,false);
}
function dataTexture(rgba,width,height,mipmaps){
  const texture=new THREE.DataTexture(rgba,width,height);
  Object.assign(texture,{colorSpace:THREE.SRGBColorSpace,magFilter:THREE.LinearFilter,minFilter:mipmaps?THREE.LinearMipmapLinearFilter:THREE.LinearFilter,generateMipmaps:mipmaps,anisotropy:4,needsUpdate:true});
  return texture;
}

// One vertex per grid cell, in three.js space; the colour of each mode is kept to swap in later.
function seabedGeometry(model){
  const {nx,ny,cell,minU,minV,depth,base,source}=model,count=nx*ny;
  const positions=new Float32Array(count*3),uvs=new Float32Array(count*2),indices=[];
  const colours={depth:new Float32Array(count*3),relief:new Float32Array(count*3),source:new Float32Array(count*3),sonar:new Float32Array(count*3).fill(1)};
  const land=linear(rgb(LAND)),sourceColour=new Map(),range=reliefRange(model),span=Math.max(.01,model.maxDepth-model.minDepth);
  for(const s of SOURCES)for(const code of s.codes)sourceColour.set(code,linear(rgb(s.color)));
  const mosaic=model.mosaic,tw=mosaic?.width??1,th=mosaic?.height??1,texel=mosaic?.texel??cell;
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const k=j*nx+i,d=depth[k],valid=!Number.isNaN(d),[x,y]=gridToLocal(model,minU+i*cell,minV+j*cell);
    positions.set([x,valid?-d:0,-y],k*3);
    uvs.set([(i*cell/texel+.5)/tw,(j*cell/texel+.5)/th],k*2);
    if(!valid)continue;
    if(d<0){colours.depth.set(land,k*3);colours.relief.set(land,k*3);colours.source.set(land,k*3);continue;}
    colours.depth.set(linear(ramp(DEPTH_RAMP,(d-model.minDepth)/span)),k*3);
    const b=base?.[k];colours.relief.set(linear(ramp(RELIEF_RAMP,.5+(Number.isNaN(b)||b==null?0:(b-d)/range/2))),k*3);
    colours.source.set(sourceColour.get(source[k])??linear(rgb(DEPTH_RAMP[2])),k*3);
  }
  const ok=k=>!Number.isNaN(depth[k]);
  for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){
    const a=j*nx+i,b=a+1,c=a+nx,d=c+1;
    if(ok(a)&&ok(b)&&ok(c)&&ok(d))indices.push(a,b,c,b,d,c);   // counter-clockwise from above: faces point up
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));
  geometry.setAttribute('color',new THREE.BufferAttribute(colours.depth.slice(),3));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  return {geometry,colours};
}

// Contour lines by marching squares: every interval metres of depth, and the waterline (depth 0).
function contourLines(model,interval){
  const {nx,ny,cell,minU,minV,depth}=model,minor=[],water=[];
  const point=(fi,fj,level)=>{const [x,y]=gridToLocal(model,minU+fi*cell,minV+fj*cell);return [x,-level,-y];};
  for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){
    const v=[depth[j*nx+i],depth[j*nx+i+1],depth[(j+1)*nx+i+1],depth[(j+1)*nx+i]];
    if(v.some(Number.isNaN))continue;
    const low=Math.min(...v),high=Math.max(...v),corners=[[i,j],[i+1,j],[i+1,j+1],[i,j+1]];
    for(let n=Math.ceil(low/interval);n*interval<=high;n++){
      const level=n*interval;if(level===low||level>high)continue;
      const hits=[];
      for(let e=0;e<4;e++){
        const a=v[e],b=v[(e+1)%4];
        if((a<level)!==(b<level)){const t=(level-a)/(b-a),[ai,aj]=corners[e],[bi,bj]=corners[(e+1)%4];hits.push(point(ai+(bi-ai)*t,aj+(bj-aj)*t,level));}
      }
      const target=level===0?water:minor;
      if(hits.length===2)target.push(...hits[0],...hits[1]);
      else if(hits.length===4)target.push(...hits[0],...hits[1],...hits[2],...hits[3]);
    }
  }
  const lines=(values,material)=>{const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(values,3));return new THREE.LineSegments(geometry,material);};
  const group=new THREE.Group();
  group.add(lines(minor,new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.42,depthWrite:false})));
  group.add(lines(water,new THREE.LineBasicMaterial({color:WATERLINE,transparent:true,opacity:.95})));
  return group;
}

function line(points,material){return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),material);}

export function createSeabedViewer(container,{onSelectScan,onSelectObject=()=>{}}){
  // preserveDrawingBuffer lets "Save PNG" read the rendered view.
  const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));
  renderer.domElement.className='seabed-canvas';
  renderer.domElement.setAttribute('role','img');
  container.append(renderer.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color('#0d1d2c');
  // A soft sky-and-ground fill plus a low key light from across the canal: slopes facing it brighten and
  // the far sides of bumps darken, so the relief reads even without colour.
  scene.add(new THREE.HemisphereLight(0xdfeeff,0x2a2218,1.1));
  const sun=new THREE.DirectionalLight(0xfff4e0,2.6);scene.add(sun,sun.target);
  const camera=new THREE.PerspectiveCamera(45,1,.05,1e6);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.maxPolarAngle=Math.PI/2-.02;
  const render=()=>renderer.render(scene,camera);
  controls.addEventListener('change',render);

  let content=null,vertical=null,seabed=null,overlay=null,contours=null,section=null,materials=null,colours=null,markers=[],objectMarkers=[],model=null;
  let exaggeration=1,home=null,moved=false,mode='sonar',flight=0;
  const shown={contours:true,shadows:false,objects:true};
  controls.addEventListener('start',()=>{moved=true;cancelAnimationFrame(flight);});

  // Labels keep their size in pixels: without size attenuation, a sprite's scale is measured at one unit
  // from the camera, so a pixel is 2·tan(fov/2)/height of it.
  function sizeLabels(){
    const perPixel=2*Math.tan(THREE.MathUtils.degToRad(camera.fov)/2)/(container.clientHeight||540);
    for(const marker of objectMarkers){const [w,h]=marker.label.userData.pixels;marker.label.scale.set(w*perPixel,h*perPixel,1);}
  }
  function resize(){
    const width=container.clientWidth,height=container.clientHeight;if(!width||!height)return;
    renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();sizeLabels();
    // Until the user moves the camera, keep the whole survey framed as the view changes shape.
    if(model&&!moved)fit();else render();
  }
  new ResizeObserver(resize).observe(container);

  function dispose(){
    if(!content)return;
    content.traverse(object=>{object.geometry?.dispose();for(const material of [object.material].flat())if(material){material.map?.dispose();material.dispose();}});
    for(const material of Object.values(materials??{})){material?.map?.dispose();material?.dispose();}
    for(const marker of markers)for(const texture of marker.textures)texture.dispose();
    scene.remove(content);content=null;markers=[];objectMarkers=[];section=null;
  }

  // Local (east, north) metres and grid axes in three.js space.
  const toScene=(x,y,depth)=>new THREE.Vector3(x,-depth,-y);
  const axes=()=>{const [c,s]=model.axis;return {along:new THREE.Vector3(c,0,-s),across:new THREE.Vector3(-s,0,-c)};};
  const centre=()=>{const [x,y]=gridToLocal(model,(model.minU+model.maxU)/2,(model.minV+model.maxV)/2);return [x,y];};

  function placeMarkers(){
    for(const marker of markers){
      const floor=-marker.scan.depth*exaggeration;
      marker.dot.position.y=floor;
      marker.plumb.geometry.setFromPoints([new THREE.Vector3(marker.scan.x,0,-marker.scan.y),new THREE.Vector3(marker.scan.x,floor,-marker.scan.y)]);
      marker.plumb.computeLineDistances();
    }
    for(const marker of objectMarkers){
      const {object}=marker,top=-object.topDepth*exaggeration,above=Math.max(.6,.6*exaggeration);
      marker.stem.geometry.setFromPoints([new THREE.Vector3(object.x,top,-object.y),new THREE.Vector3(object.x,above,-object.y)]);
      marker.label.position.set(object.x,above,-object.y);
    }
  }

  function fit(){
    const width=model.maxU-model.minU,height=model.maxV-model.minV,extent=Math.max(width,height),[cx,cy]=centre();
    let target=toScene(cx,cy,(model.minDepth+model.maxDepth)/2*exaggeration);
    const vertical=THREE.MathUtils.degToRad(camera.fov),horizontal=2*Math.atan(Math.tan(vertical/2)*camera.aspect);
    const {along,across}=axes();let direction,distance;
    const long=Math.max(width,height),short=Math.min(width,height);
    if(long>3*short){
      // A long stretch of canal: look along it from low over one end, so the near part shows the canal's
      // shape and relief and the rest recedes into the distance. The grid's long side may be either axis.
      const alongU=width>=height,[nx,ny]=alongU?gridToLocal(model,model.minU+.3*width,(model.minV+model.maxV)/2):gridToLocal(model,(model.minU+model.maxU)/2,model.minV+.3*height);
      const forward=alongU?along:across,side=alongU?across:along;
      target=toScene(nx,ny,(model.minDepth+model.maxDepth)/2*exaggeration);
      direction=forward.clone().multiplyScalar(-.84).add(side.clone().multiplyScalar(.38)).add(new THREE.Vector3(0,.4,0)).normalize();
      distance=Math.max(3*short,.3*long)/(camera.aspect<1?.7:1);
    }else{
      // Back off far enough for the survey to fit the narrower of the two fields of view, so tall phone views fit too.
      direction=across.clone().multiplyScalar(.72).add(along.clone().multiplyScalar(-.28)).add(new THREE.Vector3(0,.64,0)).normalize();
      distance=.8*(camera.aspect<1?1.18:1)*Math.hypot(width,height)/2/Math.tan(Math.min(vertical,horizontal)/2);
    }
    home={target,position:target.clone().add(direction.multiplyScalar(distance))};
    controls.target.copy(home.target);camera.position.copy(home.position);
    controls.minDistance=Math.min(1,extent*.01);controls.maxDistance=extent*6;
    placeSun(target,extent);
    controls.update();moved=false;render();
  }
  function placeSun(target,extent){
    // Low sun from across the canal, raking along the bed.
    const {along,across}=axes(),from=across.clone().multiplyScalar(-.8).add(along.clone().multiplyScalar(.35)).add(new THREE.Vector3(0,.5,0)).normalize();
    sun.position.copy(target).add(from.multiplyScalar(extent));sun.target.position.copy(target);sun.target.updateMatrixWorld();
  }

  function show(next,{exaggeration:scale=3,colour='sonar',overlays={}}={}){
    dispose();model=next;exaggeration=scale;Object.assign(shown,overlays);
    content=new THREE.Group();vertical=new THREE.Group();vertical.scale.y=exaggeration;content.add(vertical);
    const extent=Math.max(model.maxU-model.minU,model.maxV-model.minV),dotRadius=Math.max(.12,Math.min(extent*.004,1.2));
    const built=seabedGeometry(model);colours=built.colours;
    // Pushed back a little so contour lines and the shadow overlay draw on top of it.
    const surface={roughness:.88,metalness:0,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1};
    materials={colour:new THREE.MeshStandardMaterial({vertexColors:true,...surface}),
      sonar:model.mosaic?new THREE.MeshStandardMaterial({map:sonarTexture(model),...surface}):null};
    seabed=new THREE.Mesh(built.geometry,materials.colour);vertical.add(seabed);
    overlay=model.mosaic?new THREE.Mesh(built.geometry,new THREE.MeshBasicMaterial({map:shadowTexture(model.mosaic),transparent:true,depthWrite:false,side:THREE.DoubleSide})):null;
    if(overlay){overlay.renderOrder=2;vertical.add(overlay);}
    contours=contourLines(model,contourInterval(model));vertical.add(contours);

    // Route: at the water surface, and draped just above the seabed.
    content.add(line(model.route.map(([x,y])=>new THREE.Vector3(x,0,-y)),new THREE.LineBasicMaterial({color:0x3fe0d0})));
    const draped=[];
    for(const [x,y] of model.route){const d=seabedDepthAt(model,x,y);if(!Number.isNaN(d))draped.push(new THREE.Vector3(x,-d+.02,-y));}
    vertical.add(line(draped,new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.5})));
    for(const [[x,y],hex] of [[model.route[0],0x1aa982],[model.route.at(-1),0xe45b4f]]){
      const end=new THREE.Mesh(new THREE.SphereGeometry(dotRadius*1.2,16,12),new THREE.MeshBasicMaterial({color:hex}));
      end.position.set(x,0,-y);content.add(end);
    }

    // Scan points: a numbered label on the surface, a plumb line, and a dot on the seabed.
    markers=model.scans.map((scan,index)=>{
      const textures=[labelTexture(scan.number,'#087f87'),labelTexture(scan.number,'#cf6d1c')];
      const label=new THREE.Sprite(new THREE.SpriteMaterial({map:textures[0],sizeAttenuation:false,depthTest:false,transparent:true}));
      label.scale.set(.045,.045,1);label.position.set(scan.x,0,-scan.y);label.renderOrder=10;label.userData={scan:index};
      const top=new THREE.Vector3(scan.x,0,-scan.y),plumb=line([top,top.clone()],new THREE.LineDashedMaterial({color:0xfff2c2,dashSize:dotRadius,gapSize:dotRadius*.8,transparent:true,opacity:.8}));
      plumb.frustumCulled=false;   // its length follows the vertical exaggeration
      const dot=new THREE.Mesh(new THREE.SphereGeometry(dotRadius,16,12),new THREE.MeshBasicMaterial({color:0xf2a93b}));
      dot.position.set(scan.x,0,-scan.y);dot.userData={scan:index};
      // Scan points outside this stretch of canal are not drawn.
      label.visible=plumb.visible=dot.visible=!Number.isNaN(seabedDepthAt(model,scan.x,scan.y));
      content.add(label,plumb,dot);
      return {scan,label,plumb,dot,textures};
    });
    // Objects: a stem from the object's top up above the water and a label with its number and height.
    objectMarkers=model.objects.map((object,index)=>{
      const stem=line([new THREE.Vector3(),new THREE.Vector3()],new THREE.LineBasicMaterial({color:MARKER,transparent:true,opacity:.9}));
      stem.frustumCulled=false;
      const text=[`${object.id} · ${object.kind==='object'?'raised':'hollow'} ${Math.round(object.height*100)} cm`];
      const label=textSprite(text,{});label.userData.object=index;
      const group=new THREE.Group();group.add(stem,label);content.add(group);
      return {object,stem,label,group,text};
    });
    selectedObject=-1;placeMarkers();applyMode();applyOverlays();
    scene.add(content);resize();fit();
  }

  function applyMode(){
    if(!seabed)return;
    if(mode==='sonar'&&materials.sonar){seabed.material=materials.sonar;}
    else{
      const target=seabed.geometry.getAttribute('color');target.array.set(colours[mode==='sonar'?'depth':mode]);target.needsUpdate=true;
      seabed.material=materials.colour;
    }
  }
  function applyOverlays(){
    if(contours)contours.visible=shown.contours;
    if(overlay)overlay.visible=shown.shadows;
    for(const marker of objectMarkers)marker.group.visible=shown.objects;
  }
  function setColour(next){mode=next;applyMode();render();}
  function setOverlay(name,on){shown[name]=on;applyOverlays();render();}
  function setExaggeration(scale){
    exaggeration=scale;if(!model)return;
    vertical.scale.y=scale;placeMarkers();if(section)drawSection(section.userData.section);render();
  }
  function select(index){
    for(const [i,marker] of markers.entries()){marker.label.material.map=marker.textures[i===index?1:0];marker.label.material.needsUpdate=true;}
    render();
  }
  let selectedObject=-1;
  function selectObject(index){
    if(selectedObject===index)return;
    for(const [i,marker] of objectMarkers.entries()){
      if(i!==selectedObject&&i!==index)continue;
      const next=textSprite(marker.text,{selected:i===index});next.userData.object=i;next.position.copy(marker.label.position);
      marker.group.remove(marker.label);marker.label.material.map.dispose();marker.label.material.dispose();marker.label=next;marker.group.add(next);
    }
    selectedObject=index;sizeLabels();render();
  }
  // Moves the camera to look at an object from a few metres away, across the canal.
  function focusObject(index){
    const object=model?.objects[index];if(!object)return;
    const target=toScene(object.x,object.y,(object.topDepth??model.maxDepth)*exaggeration),{along,across}=axes();
    const distance=Math.max(4,object.width*6,object.length*6),side=object.side==='starboard'?-1:1;
    // From above, a little behind along the track: the object and the shadow it casts away from the route
    // show side by side.
    const position=target.clone().add(along.clone().multiplyScalar(-.62).add(across.clone().multiplyScalar(side*.18)).add(new THREE.Vector3(0,.76,0)).normalize().multiplyScalar(distance));
    flyTo(target,position);selectObject(index);
  }
  function flyTo(target,position){
    cancelAnimationFrame(flight);moved=true;
    const fromTarget=controls.target.clone(),fromPosition=camera.position.clone(),start=performance.now(),duration=650;
    const step=now=>{
      const t=Math.min(1,(now-start)/duration),e=t<.5?2*t*t:1-(-2*t+2)**2/2;
      controls.target.lerpVectors(fromTarget,target,e);camera.position.lerpVectors(fromPosition,position,e);controls.update();render();
      if(t<1)flight=requestAnimationFrame(step);
    };
    flight=requestAnimationFrame(step);
  }
  // A line across the canal where the cross-section chart is drawn, laid on the seabed.
  function drawSection(s){
    if(section){vertical.remove(section);section.geometry.dispose();section.material.dispose();section=null;}
    if(!s||!model)return;
    const points=[];
    for(let o=-s.starboard;o<=s.port;o+=Math.max(.05,model.cell/2)){const x=s.x+o*s.lx,y=s.y+o*s.ly,d=seabedDepthAt(model,x,y);if(!Number.isNaN(d))points.push(new THREE.Vector3(x,-d+.03,-y));}
    if(points.length<2)return;
    section=line(points,new THREE.LineBasicMaterial({color:0xffffff,depthTest:false,transparent:true}));section.renderOrder=11;section.userData={section:s};
    vertical.add(section);
  }
  function setSection(s){drawSection(s);render();}
  function resetView(){if(model){cancelAnimationFrame(flight);fit();}}

  // A click (not a drag) on a label or seabed dot selects that scan point; on an object label, that object.
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();let down=null;
  const hit=event=>{
    const box=renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1);
    raycaster.setFromCamera(pointer,camera);
    const targets=[...markers.filter(marker=>marker.dot.visible).flatMap(marker=>[marker.label,marker.dot]),...(shown.objects?objectMarkers.map(marker=>marker.label):[])];
    return raycaster.intersectObjects(targets,false)[0]?.object.userData??null;
  };
  renderer.domElement.addEventListener('pointerdown',event=>{down={x:event.clientX,y:event.clientY};});
  renderer.domElement.addEventListener('pointerup',event=>{
    if(!down||Math.hypot(event.clientX-down.x,event.clientY-down.y)>5)return;
    const found=hit(event);if(found?.scan!=null)onSelectScan(found.scan);else if(found?.object!=null)onSelectObject(found.object);
  });
  renderer.domElement.addEventListener('pointermove',event=>{if(!event.buttons&&(markers.length||objectMarkers.length))renderer.domElement.style.cursor=hit(event)?'pointer':'';});

  // Where a scan label (or an object label) is drawn, in CSS pixels from the canvas corner.
  const project=object=>{const point=object.getWorldPosition(new THREE.Vector3()).project(camera),box=renderer.domElement.getBoundingClientRect();return {x:(point.x+1)/2*box.width,y:(1-point.y)/2*box.height};};
  const screenPosition=index=>project(markers[index].label);
  const objectScreenPosition=index=>{const {label}=objectMarkers[index],p=project(label);return {x:p.x,y:p.y-6};};
  const toBlob=()=>new Promise(resolve=>{render();renderer.domElement.toBlob(resolve,'image/png');});
  function clear(){dispose();model=null;render();}
  const state=()=>({mode:seabed?.material===materials?.sonar?'sonar':mode,overlays:{...shown},objects:objectMarkers.length,exaggeration,selectedObject});

  const api={show,clear,setExaggeration,setColour,setOverlay,select,selectObject,focusObject,setSection,resetView,screenPosition,objectScreenPosition,toBlob,state};
  container.seabedViewer=api;   // reachable from the page for tests and debugging
  return api;
}
