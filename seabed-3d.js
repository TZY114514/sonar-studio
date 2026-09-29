// Rotatable 3D view of the seabed model from buildSeabedModel (engine.js). Loaded on demand with three.js.
// Axes: three.js x = east, y = up (depth is negative), z = south.
import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {color} from './scan-image.js';
import {seabedDepthAt} from './engine.js';

const NO_SONAR=[74,90,106];
const DEPTH_STOPS=[[0,[190,238,220]],[.35,[86,180,196]],[.7,[33,102,172]],[1,[18,44,110]]];
function depthColor(t){
  let i=1;while(i<DEPTH_STOPS.length-1&&t>DEPTH_STOPS[i][0])i++;
  const [x,a]=DEPTH_STOPS[i-1],[y,b]=DEPTH_STOPS[i],f=Math.max(0,Math.min(1,(t-x)/(y-x)));
  const [r,g,bl]=a.map((n,j)=>(n+(b[j]-n)*f)/255),linear=new THREE.Color().setRGB(r,g,bl,THREE.SRGBColorSpace);
  return [linear.r,linear.g,linear.b];
}

function labelTexture(number,fill){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;
  const g=canvas.getContext('2d');
  g.beginPath();g.arc(32,32,27,0,Math.PI*2);g.fillStyle=fill;g.fill();g.lineWidth=5;g.strokeStyle='#fff';g.stroke();
  g.fillStyle='#fff';g.font='700 28px "Segoe UI",Arial,sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(String(number),32,34);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}

function sonarTexture(mosaic){
  const rgba=new Uint8Array(mosaic.width*mosaic.height*4);
  for(let k=0;k<mosaic.values.length;k++){
    const [r,g,b]=mosaic.mask[k]?color(.12+.88*mosaic.values[k]/255):NO_SONAR;
    rgba[k*4]=r;rgba[k*4+1]=g;rgba[k*4+2]=b;rgba[k*4+3]=255;
  }
  const texture=new THREE.DataTexture(rgba,mosaic.width,mosaic.height);
  Object.assign(texture,{colorSpace:THREE.SRGBColorSpace,magFilter:THREE.LinearFilter,minFilter:THREE.LinearMipmapLinearFilter,generateMipmaps:true,anisotropy:4,needsUpdate:true});
  return texture;
}

function seabedGeometry(model){
  const {nx,ny,cell,minX,minY,depth,minDepth,maxDepth}=model,count=nx*ny;
  const positions=new Float32Array(count*3),uvs=new Float32Array(count*2),colors=new Float32Array(count*3),indices=[];
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const k=j*nx+i,d=depth[k],valid=!Number.isNaN(d);
    positions.set([minX+i*cell,valid?-d:0,-(minY+j*cell)],k*3);
    uvs.set([i/(nx-1),j/(ny-1)],k*2);
    colors.set(depthColor(valid?(d-minDepth)/Math.max(.01,maxDepth-minDepth):0),k*3);
  }
  const ok=k=>!Number.isNaN(depth[k]);
  for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){
    const a=j*nx+i,b=a+1,c=a+nx,d=c+1;
    if(ok(a)&&ok(b)&&ok(c)&&ok(d))indices.push(a,c,b,b,c,d);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));
  geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  return geometry;
}

function line(points,material){return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),material);}

export function createSeabedViewer(container,{onSelectScan}){
  // preserveDrawingBuffer lets "Save PNG" read the rendered view.
  const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));
  renderer.domElement.className='seabed-canvas';
  renderer.domElement.setAttribute('role','img');
  container.append(renderer.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color('#0d1d2c');
  scene.add(new THREE.HemisphereLight(0xe4f2ff,0x1d2a38,1.4));
  const sun=new THREE.DirectionalLight(0xffffff,1.9);scene.add(sun,sun.target);
  const camera=new THREE.PerspectiveCamera(45,1,.1,1e6);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.maxPolarAngle=Math.PI/2-.02;
  const render=()=>renderer.render(scene,camera);
  controls.addEventListener('change',render);

  let content=null,vertical=null,seabed=null,materials=null,markers=[],model=null,exaggeration=1,home=null,moved=false;
  controls.addEventListener('start',()=>{moved=true;});

  function resize(){
    const width=container.clientWidth,height=container.clientHeight;if(!width||!height)return;
    renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();
    // Until the user moves the camera, keep the whole survey framed as the view changes shape.
    if(model&&!moved)fit();else render();
  }
  new ResizeObserver(resize).observe(container);

  function dispose(){
    if(!content)return;
    content.traverse(object=>{object.geometry?.dispose();for(const material of [object.material].flat())if(material){material.map?.dispose();material.dispose();}});
    for(const material of Object.values(materials??{})){material?.map?.dispose();material?.dispose();}
    for(const marker of markers)for(const texture of marker.textures)texture.dispose();
    scene.remove(content);content=null;markers=[];
  }

  function placeMarkers(){
    for(const marker of markers){
      const floor=-marker.scan.depth*exaggeration;
      marker.dot.position.y=floor;
      marker.plumb.geometry.setFromPoints([new THREE.Vector3(marker.scan.x,0,-marker.scan.y),new THREE.Vector3(marker.scan.x,floor,-marker.scan.y)]);
    }
  }

  function fit(){
    const width=model.maxX-model.minX,height=model.maxY-model.minY,extent=Math.max(width,height);
    const target=new THREE.Vector3((model.minX+model.maxX)/2,-(model.minDepth+model.maxDepth)/2*exaggeration,-(model.minY+model.maxY)/2);
    // Back off far enough for the survey to fit the narrower of the two fields of view, so tall phone views fit too.
    const vertical=THREE.MathUtils.degToRad(camera.fov),horizontal=2*Math.atan(Math.tan(vertical/2)*camera.aspect);
    const distance=.86*(camera.aspect<1?1.18:1)*Math.hypot(width,height)/2/Math.tan(Math.min(vertical,horizontal)/2);
    home={target,position:target.clone().add(new THREE.Vector3(.45,.62,.8).normalize().multiplyScalar(distance))};
    controls.target.copy(home.target);camera.position.copy(home.position);
    controls.minDistance=extent*.03;controls.maxDistance=extent*6;
    sun.position.copy(target).add(new THREE.Vector3(-.6*extent,extent,.25*extent));sun.target.position.copy(target);
    controls.update();moved=false;render();
  }

  function show(next,{exaggeration:scale=5,texture='sonar'}={}){
    dispose();model=next;exaggeration=scale;
    content=new THREE.Group();vertical=new THREE.Group();vertical.scale.y=exaggeration;content.add(vertical);
    const extent=Math.max(model.maxX-model.minX,model.maxY-model.minY),dotRadius=extent*.006;
    materials={depth:new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide}),
      sonar:model.mosaic?new THREE.MeshLambertMaterial({map:sonarTexture(model.mosaic),side:THREE.DoubleSide}):null};
    seabed=new THREE.Mesh(seabedGeometry(model),materials[texture]??materials.depth);
    vertical.add(seabed);

    // Route: at the water surface, and draped just above the seabed.
    const surface=model.route.map(([x,y])=>new THREE.Vector3(x,0,-y));
    content.add(line(surface,new THREE.LineBasicMaterial({color:0x3fe0d0})));
    const draped=[];
    for(const [x,y] of model.route){const d=seabedDepthAt(model,x,y);if(!Number.isNaN(d))draped.push(new THREE.Vector3(x,-d+.04,-y));}
    vertical.add(line(draped,new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.55})));
    for(const [[x,y],hex] of [[model.route[0],0x1aa982],[model.route.at(-1),0xe45b4f]]){
      const end=new THREE.Mesh(new THREE.SphereGeometry(dotRadius*1.2,16,12),new THREE.MeshBasicMaterial({color:hex}));
      end.position.set(x,0,-y);content.add(end);
    }
    const water=new THREE.Mesh(new THREE.PlaneGeometry(model.maxX-model.minX,model.maxY-model.minY),
      new THREE.MeshBasicMaterial({color:0x7fd6e0,transparent:true,opacity:.07,depthWrite:false,side:THREE.DoubleSide}));
    water.rotation.x=-Math.PI/2;water.position.set((model.minX+model.maxX)/2,0,-(model.minY+model.maxY)/2);content.add(water);

    // Scan points: a numbered label on the surface, a plumb line, and a dot on the seabed.
    markers=model.scans.map((scan,index)=>{
      const textures=[labelTexture(scan.number,'#087f87'),labelTexture(scan.number,'#cf6d1c')];
      const label=new THREE.Sprite(new THREE.SpriteMaterial({map:textures[0],sizeAttenuation:false,depthTest:false,transparent:true}));
      label.scale.set(.05,.05,1);label.position.set(scan.x,0,-scan.y);label.renderOrder=10;label.userData={index};
      const top=new THREE.Vector3(scan.x,0,-scan.y),plumb=line([top,top.clone()],new THREE.LineDashedMaterial({color:0xfff2c2,dashSize:dotRadius,gapSize:dotRadius*.8,transparent:true,opacity:.8}));
      plumb.frustumCulled=false;   // its length follows the vertical exaggeration
      const dot=new THREE.Mesh(new THREE.SphereGeometry(dotRadius,16,12),new THREE.MeshBasicMaterial({color:0xf2a93b}));
      dot.position.set(scan.x,0,-scan.y);dot.userData={index};
      content.add(label,plumb,dot);
      return {scan,label,plumb,dot,textures};
    });
    placeMarkers();for(const marker of markers)marker.plumb.computeLineDistances();
    scene.add(content);resize();fit();
  }

  function setExaggeration(scale){
    exaggeration=scale;if(!model)return;
    vertical.scale.y=scale;placeMarkers();for(const marker of markers)marker.plumb.computeLineDistances();render();
  }
  function setTexture(kind){if(seabed&&materials[kind]){seabed.material=materials[kind];render();}}
  function select(index){
    for(const [i,marker] of markers.entries()){marker.label.material.map=marker.textures[i===index?1:0];marker.label.material.needsUpdate=true;}
    render();
  }
  function resetView(){if(model)fit();}

  // A click (not a drag) on a label or seabed dot selects that scan point.
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();let down=null;
  const hit=event=>{
    const box=renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1);
    raycaster.setFromCamera(pointer,camera);
    return raycaster.intersectObjects(markers.flatMap(marker=>[marker.label,marker.dot]),false)[0]?.object.userData.index??-1;
  };
  renderer.domElement.addEventListener('pointerdown',event=>{down={x:event.clientX,y:event.clientY};});
  renderer.domElement.addEventListener('pointerup',event=>{
    if(!down||Math.hypot(event.clientX-down.x,event.clientY-down.y)>5)return;
    const index=hit(event);if(index>=0)onSelectScan(index);
  });
  renderer.domElement.addEventListener('pointermove',event=>{if(!event.buttons&&markers.length)renderer.domElement.style.cursor=hit(event)>=0?'pointer':'';});

  // Where a scan label is drawn, in CSS pixels from the canvas corner.
  function screenPosition(index){
    const point=markers[index].label.position.clone().project(camera),box=renderer.domElement.getBoundingClientRect();
    return {x:(point.x+1)/2*box.width,y:(1-point.y)/2*box.height};
  }
  const toBlob=()=>new Promise(resolve=>{render();renderer.domElement.toBlob(resolve,'image/png');});
  function clear(){dispose();model=null;render();}

  const api={show,clear,setExaggeration,setTexture,select,resetView,screenPosition,toBlob};
  container.seabedViewer=api;   // reachable from the page for tests and debugging
  return api;
}
