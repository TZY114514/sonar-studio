// Zoomable view of a crack-screening result (inspect.js): the stretch as a slant-corrected waterfall,
// along the track from left to right with port at the top, and the candidate lines drawn over it.
// Leaflet (vendor/leaflet) is loaded as a classic script before the app module.
const L=globalThis.L;

// One colour per kind of line (validated for colour-vision deficiencies); each line also has a dark
// outline, so it stands out on the grey sonar image, and a number that matches the table.
export const CRACK_COLOURS={crack:'#eb6834',joint:'#1baf7a',edge:'#2a78d6'};
const colourOf=c=>c.kind==='joint'?CRACK_COLOURS.joint:c.polarity==='bright'?CRACK_COLOURS.edge:CRACK_COLOURS.crack;

export function createInspectView(element,{onSelect,onPick}){
  const map=L.map(element,{crs:L.CRS.Simple,zoomSnap:.25,zoomDelta:.5,wheelPxPerZoomLevel:90,minZoom:-4,maxZoom:7,attributionControl:false});
  const layers=L.layerGroup().addTo(map);
  let result=null,image=null,lines=[],bounds=null,showLow=false,contrast=50,selected=-1;

  // The image, drawn at its pixels, with contrast applied: 1 (ordinary bed) is mid-grey.
  function imageUrl(){
    const {width:W,height:H,values,valid}=result.image,canvas=document.createElement('canvas');
    canvas.width=H;canvas.height=W;
    const g=canvas.getContext('2d'),data=g.createImageData(H,W),gain=2**((contrast-50)/25);
    for(let j=0;j<H;j++)for(let i=0;i<W;i++){
      const k=j*W+i,o=((W-1-i)*H+j)*4;
      if(!valid[k]){data.data[o+3]=0;continue;}
      const v=Math.max(0,Math.min(255,Math.round(128+(values[k]-110)*gain)));
      data.data[o]=data.data[o+1]=data.data[o+2]=v;data.data[o+3]=255;
    }
    g.putImageData(data,0,0);return canvas.toDataURL('image/png');
  }
  // Leaflet's simple coordinates: [metres across (port up), metres along].
  const point=([i,j])=>[i*result.image.px-result.image.maxOffset,j*result.image.py];

  function draw(){
    layers.clearLayers();lines=[];if(!result)return;
    image=L.imageOverlay(imageUrl(),bounds,{className:'inspect-image',interactive:true}).addTo(layers);
    image.on('click',event=>{const row=Math.round(event.latlng.lng/result.image.py),time=result.rowTimes[row];if(time===time)onPick(time,event.latlng.lat);});
    result.candidates.forEach((c,index)=>{
      if(c.confidence==='low'&&!showLow&&index!==selected)return;
      const latlngs=c.raster.map(point),active=index===selected,colour=colourOf(c);
      const dash=c.confidence==='high'?null:c.confidence==='medium'?'8 5':'2 5';
      const casing=L.polyline(latlngs,{color:active?'#ffffff':'#101418',weight:active?9:6,opacity:.85,lineCap:'round',interactive:false}).addTo(layers);
      const line=L.polyline(latlngs,{color:colour,weight:active?5:3,opacity:1,dashArray:dash,lineCap:'round',className:`inspect-line inspect-${c.confidence}`}).addTo(layers);
      const hit=L.polyline(latlngs,{color:'#000',weight:16,opacity:0,className:'inspect-hit'}).addTo(layers);
      hit.on('click',event=>{L.DomEvent.stopPropagation(event);onSelect(index);});
      hit.bindTooltip(`${c.id} · ${c.detail}`,{sticky:true,className:'inspect-tooltip'});
      if(c.confidence!=='low'||active){
        // The number sits just above the line (above its upper end), so it never hides a short line.
        const [a,b]=latlngs,top=Math.abs(a[0]-b[0])<1e-9?[a[0],(a[1]+b[1])/2]:a[0]>b[0]?a:b;
        const label=L.marker(top,{interactive:false,keyboard:false,
          icon:L.divIcon({className:`inspect-label${active?' is-selected':''}`,html:`<span style="--mark:${colour}">${c.id}</span>`,iconSize:null})}).addTo(layers);
        lines.push({index,line,casing,label});
      }else lines.push({index,line,casing});
    });
  }
  const fit=()=>{if(bounds)map.fitBounds(bounds,{padding:[10,10]});};

  function show(next){
    result=next;selected=-1;
    const {width:W,height:H,px,py,maxOffset}=result.image;
    bounds=L.latLngBounds([-maxOffset-px*.5,-py*.5],[W*px-maxOffset-px*.5,H*py-py*.5]);
    map.setMaxBounds(bounds.pad(.5));draw();map.invalidateSize();fit();
  }
  function select(index){
    selected=index;draw();
    const c=result?.candidates[index];if(!c)return;
    const [a,b]=c.raster.map(point),centre=[(a[0]+b[0])/2,(a[1]+b[1])/2];
    // A short line is zoomed in on until it is about 120 px long (a pixel is 2^-zoom metres).
    const zoom=Math.min(map.getMaxZoom(),Math.max(map.getZoom(),Math.log2(120/Math.max(c.lengthM,.1))));
    if(zoom>map.getZoom()+.1)map.setView(centre,zoom);
    else if(!map.getBounds().pad(-.1).contains(centre))map.panTo(centre);
  }
  function setShowLow(on){showLow=on;draw();}
  function setContrast(value){contrast=value;draw();}
  function clear(){result=null;layers.clearLayers();}
  new ResizeObserver(()=>{map.invalidateSize();}).observe(element);

  const api={show,select,setShowLow,setContrast,clear,fit,visibleLines:()=>lines.length};
  element.inspectView=api;   // reachable from the page for tests and debugging
  return api;
}
