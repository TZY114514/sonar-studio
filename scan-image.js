// Colours raw sonar intensities (0-255) for display. Only the display is enhanced; exports keep raw values.
const COLOR_STOPS=[[0,[8,11,34]],[.20,[58,15,95]],[.46,[139,26,104]],[.72,[230,80,55]],[.9,[249,169,42]],[1,[252,249,125]]];

export function color(value){
  const v=Math.max(0,Math.min(1,value));let i=1;
  while(i<COLOR_STOPS.length-1&&v>COLOR_STOPS[i][0])i++;
  const [x,a]=COLOR_STOPS[i-1],[y,b]=COLOR_STOPS[i],t=(v-x)/(y-x);
  return a.map((n,j)=>Math.round(n+(b[j]-n)*t));
}

// Sliders run 0-100 with 50 as the default look: 2 % of samples clipped at each end, gamma 0.8.
export const displaySettings=({contrast=50,brightness=50}={})=>({clip:.02*4**((contrast-50)/50),gamma:.8*2**((50-brightness)/50)});

// sorted: ascending sample of intensities, used to pick the clip levels.
export function colorize(intensities,sorted,settings){
  const {clip,gamma}=displaySettings(settings),at=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
  const low=at(clip),high=at(1-clip),rgba=new Uint8ClampedArray(intensities.length*4),lookup=[];
  for(let value=0;value<256;value++)lookup.push(color(Math.pow(Math.max(0,(value-low)/Math.max(1,high-low)),gamma)));
  for(let i=0;i<intensities.length;i++){const [r,g,b]=lookup[intensities[i]];rgba[i*4]=r;rgba[i*4+1]=g;rgba[i*4+2]=b;rgba[i*4+3]=255;}
  return rgba;
}

export function renderScan(canvas,{intensities,width,height,sorted},settings){
  canvas.width=width;canvas.height=height;
  canvas.getContext('2d').putImageData(new ImageData(colorize(intensities,sorted,settings),width,height),0,0);
}
