// Interactive map of the verified GPS route with numbered, clickable sonar scan points.
// Leaflet (vendor/leaflet) is loaded as a classic script before the app module.
const L=globalThis.L;

export function createRouteMap(element,{onSelectScan,onPick}){
  const map=L.map(element,{zoomSnap:.25,zoomDelta:.5,wheelPxPerZoomLevel:90,maxZoom:22,worldCopyJump:true}).setView([0,0],2);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  // Start and end dots sit above the scan pins, whose tips point at the same places.
  map.createPane('endpoints').style.zIndex=640;
  const layers=L.layerGroup().addTo(map),empty=element.parentElement.querySelector('.route-empty');
  let bounds=null,markers=[],routeShown=false,basemapOn=false,tiles=null;
  // Tiles are fetched only once the user opts in and a route is on screen, so an empty page never contacts OpenStreetMap.
  function syncTiles(){
    if(basemapOn&&routeShown){
      tiles??=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxNativeZoom:19,maxZoom:22,className:'route-tiles',
        attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'});
      tiles.addTo(map);
    }else tiles?.remove();
  }
  const windowLine=L.polyline([],{color:'#e18b24',weight:8,opacity:.55,lineCap:'round',lineJoin:'round',interactive:false,className:'route-window'});
  const pick=L.circleMarker([0,0],{pane:'endpoints',radius:7,color:'#fff',weight:2.5,fillColor:'#cf6d1c',fillOpacity:1,interactive:false,className:'route-pick-marker'});
  // A click near the route picks the ping recorded there; 20 px of slack, converted to metres at this zoom.
  map.on('click',event=>{
    if(!routeShown)return;
    const point=map.latLngToContainerPoint(event.latlng),slack=map.distance(event.latlng,map.containerPointToLatLng(point.add([20,0])));
    onPick(event.latlng.lat,event.latlng.lng,slack);
  });

  const fit=()=>{if(bounds)map.fitBounds(bounds,{paddingTopLeft:[28,50],paddingBottomRight:[28,20],maxZoom:19});};
  const FitControl=L.Control.extend({options:{position:'topleft'},onAdd(){
    const bar=L.DomUtil.create('div','leaflet-bar'),button=L.DomUtil.create('a','route-fit',bar);
    button.href='#';button.setAttribute('role','button');button.title='Fit route';button.setAttribute('aria-label','Fit the whole route in view');button.textContent='⤢';
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(button,'click',event=>{L.DomEvent.preventDefault(event);fit();});
    return bar;
  }});
  new FitControl().addTo(map);

  function clear(message){
    layers.clearLayers();markers=[];bounds=null;routeShown=false;
    empty.textContent=message;empty.hidden=false;syncTiles();
  }

  function showRoute(route,scanPoints,label){
    layers.clearLayers();empty.hidden=true;routeShown=true;
    const latlngs=route.map(([lon,lat])=>[lat,lon]);
    bounds=L.latLngBounds(latlngs);
    L.polyline(latlngs,{color:'#07858e',weight:3,lineJoin:'round',lineCap:'round',interactive:false}).addTo(layers);
    windowLine.setLatLngs([]).addTo(layers);
    for(const [latlng,name,color] of [[latlngs[0],'start','#1aa982'],[latlngs.at(-1),'end','#e45b4f']])
      L.circleMarker(latlng,{pane:'endpoints',radius:6,color:'#fff',weight:2,fillColor:color,fillOpacity:1,interactive:false,className:`route-${name}-marker`}).addTo(layers);
    markers=scanPoints.map((scan,i)=>{
      const marker=L.marker([scan.lat,scan.lon],{keyboard:true,riseOnHover:true,
        icon:L.divIcon({className:'scan-marker',html:`<span class="scan-marker-dot">${i+1}</span>`,iconSize:[30,40],iconAnchor:[15,40]})}).addTo(layers);
      const icon=marker.getElement();
      icon.dataset.scanIndex=String(i);
      icon.setAttribute('aria-label',label(scan,i));
      icon.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelectScan(i);}});
      marker.on('click',()=>onSelectScan(i));
      return marker;
    });
    map.invalidateSize();fit();syncTiles();
  }

  // selection: {kind:'scan',index} highlights a numbered pin; {kind:'point',lat,lon} drops the pick dot.
  function select(selection){
    const index=selection?.kind==='scan'?selection.index:-1;
    markers.forEach((marker,i)=>{marker.getElement()?.classList.toggle('is-selected',i===index);marker.setZIndexOffset(i===index?1000:0);});
    if(selection?.kind==='point'&&routeShown)pick.setLatLng([selection.lat,selection.lon]).addTo(layers);else pick.remove();
  }

  // Samples ({lat,lon}) inside the previewed time window, drawn as a thick band along the route.
  function highlightWindow(samples){windowLine.setLatLngs(samples.map(sample=>[sample.lat,sample.lon]));}

  function setBasemap(on){basemapOn=on;element.classList.toggle('has-basemap',on);syncTiles();}

  return {map,clear,showRoute,select,highlightWindow,setBasemap,fit};
}
