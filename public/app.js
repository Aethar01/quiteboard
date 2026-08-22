import * as pdfjsLib from '/pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

const socket = io();
const canvas = document.querySelector('#board');
const ctx = canvas.getContext('2d');
const viewport = document.querySelector('#viewport');
const boardName = document.querySelector('#boardName');
const presenceEl = document.querySelector('#presence');
const cursorsEl = document.querySelector('#cursors');
const toastEl = document.querySelector('#toast');
const zoomValue = document.querySelector('#zoomValue');
const boardsDialog = document.querySelector('#boardsDialog');
const boardList = document.querySelector('#boardList');
const imageInput = document.querySelector('#imageInput');
const pdfInput = document.querySelector('#pdfInput');

let boardId = location.hash.replace('#','');
let objects = [];
let tool = 'select';
let selectedId = null;
let drawing = null;
let dragging = null;
let panning = null;
let camera = { x: 0, y: 0, zoom: 1 };
let renderQueued = false;
const imageCache = new Map();
const remoteCursors = new Map();

const username = localStorage.getItem('quiteboard-name') || `Guest ${Math.floor(Math.random()*900+100)}`;
const userColor = localStorage.getItem('quiteboard-color') || `hsl(${Math.floor(Math.random()*360)} 70% 45%)`;
localStorage.setItem('quiteboard-name', username);
localStorage.setItem('quiteboard-color', userColor);

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function uuid() { return crypto.randomUUID(); }

function worldPoint(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (clientX - r.left - camera.x) / camera.zoom,
    y: (clientY - r.top - camera.y) / camera.zoom
  };
}

function resizeCanvas() {
  const dpr = devicePixelRatio || 1;
  const r = viewport.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(r.width * dpr));
  canvas.height = Math.max(1, Math.floor(r.height * dpr));
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  render();
}

new ResizeObserver(resizeCanvas).observe(viewport);

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function loadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const img = new Image();
  const promise = new Promise((resolve, reject) => {
    img.onload = () => { scheduleRender(); resolve(img); };
    img.onerror = reject;
  });
  img.src = url;
  imageCache.set(url, promise);
  return promise;
}

function drawObject(o) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (o.type === 'stroke') {
    ctx.globalAlpha = o.opacity ?? 1;
    ctx.strokeStyle = o.color || '#111827';
    ctx.lineWidth = o.width || 4;
    ctx.beginPath();
    const pts = o.points || [];
    for (let i=0;i<pts.length;i+=2) {
      if (i===0) ctx.moveTo(pts[i],pts[i+1]);
      else ctx.lineTo(pts[i],pts[i+1]);
    }
    ctx.stroke();
  } else if (o.type === 'rect') {
    ctx.strokeStyle = o.color || '#111827';
    ctx.lineWidth = o.width || 3;
    ctx.strokeRect(o.x,o.y,o.w,o.h);
  } else if (o.type === 'text') {
    ctx.fillStyle = o.color || '#111827';
    ctx.font = `${o.size || 28}px system-ui`;
    ctx.textBaseline = 'top';
    ctx.fillText(o.text || '', o.x, o.y);
  } else if (o.type === 'image') {
    const cached = imageCache.get(o.url);
    if (!cached) loadImage(o.url).catch(()=>{});
    else cached.then(img => {
      ctx.save();
      ctx.globalAlpha = o.opacity ?? 1;
      ctx.drawImage(img,o.x,o.y,o.w,o.h);
      ctx.restore();
    }).catch(()=>{});
  }

  if (o.id === selectedId) {
    const b = bounds(o);
    if (b) {
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2 / camera.zoom;
      ctx.setLineDash([8/camera.zoom,5/camera.zoom]);
      ctx.strokeRect(b.x,b.y,b.w,b.h);
    }
  }
  ctx.restore();
}

function render() {
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.setTransform(dpr*camera.zoom,0,0,dpr*camera.zoom,dpr*camera.x,dpr*camera.y);
  for (const o of objects) drawObject(o);
  if (drawing) drawObject(drawing);
  zoomValue.textContent = `${Math.round(camera.zoom*100)}%`;
}

function bounds(o) {
  if (['rect','image'].includes(o.type)) return {x:o.x,y:o.y,w:o.w,h:o.h};
  if (o.type === 'text') return {x:o.x,y:o.y,w:Math.max(60,(o.text||'').length*(o.size||28)*.6),h:(o.size||28)*1.3};
  if (o.type === 'stroke' && o.points?.length >= 2) {
    const xs=[],ys=[];
    for(let i=0;i<o.points.length;i+=2){xs.push(o.points[i]);ys.push(o.points[i+1]);}
    const pad=(o.width||4)+8;
    return {x:Math.min(...xs)-pad,y:Math.min(...ys)-pad,w:Math.max(...xs)-Math.min(...xs)+pad*2,h:Math.max(...ys)-Math.min(...ys)+pad*2};
  }
  return null;
}

function hitTest(p) {
  for (let i=objects.length-1;i>=0;i--) {
    const o=objects[i], b=bounds(o);
    if (!b) continue;
    if (p.x>=b.x && p.x<=b.x+b.w && p.y>=b.y && p.y<=b.y+b.h) return o;
  }
  return null;
}

function upsertLocal(object, emit=true) {
  const i=objects.findIndex(o=>o.id===object.id);
  if(i>=0) objects[i]=structuredClone(object); else objects.push(structuredClone(object));
  if(emit && boardId) socket.emit('object:upsert',{boardId,object});
  scheduleRender();
}

function removeLocal(id, emit=true) {
  objects=objects.filter(o=>o.id!==id);
  if(selectedId===id) selectedId=null;
  if(emit && boardId) socket.emit('object:remove',{boardId,objectId:id});
  scheduleRender();
}

function setTool(next) {
  tool=next;
  document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));
  canvas.style.cursor = tool==='pan' ? 'grab' : tool==='select' ? 'default' : 'crosshair';
}

document.querySelectorAll('.tool').forEach(btn=>btn.addEventListener('click',()=>setTool(btn.dataset.tool)));

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  const p=worldPoint(e.clientX,e.clientY);
  const color=document.querySelector('#color').value;
  const size=Number(document.querySelector('#size').value);

  if (tool==='pan' || e.button===1 || e.altKey) {
    panning={sx:e.clientX,sy:e.clientY,cx:camera.x,cy:camera.y};
    return;
  }
  if (tool==='pen' || tool==='highlighter') {
    drawing={id:uuid(),type:'stroke',points:[p.x,p.y],color:tool==='highlighter'?'#fde047':color,width:tool==='highlighter'?Math.max(16,size*4):size,opacity:tool==='highlighter'?.45:1};
    return;
  }
  if (tool==='rect') {
    drawing={id:uuid(),type:'rect',x:p.x,y:p.y,w:0,h:0,color,width:size};
    return;
  }
  if (tool==='text') {
    const text=prompt('Text');
    if(text) upsertLocal({id:uuid(),type:'text',x:p.x,y:p.y,text,color,size:Math.max(18,size*5)});
    return;
  }
  if (tool==='eraser') {
    const hit=hitTest(p); if(hit && !hit.locked) removeLocal(hit.id);
    return;
  }
  if (tool==='select') {
    const hit=hitTest(p);
    selectedId=hit?.id || null;
    if(hit && !hit.locked) dragging={id:hit.id,start:p,original:structuredClone(hit)};
    scheduleRender();
  }
});

canvas.addEventListener('pointermove', e => {
  const p=worldPoint(e.clientX,e.clientY);
  if(boardId) socket.emit('cursor',{boardId,x:p.x,y:p.y});

  if(panning){camera.x=panning.cx+(e.clientX-panning.sx);camera.y=panning.cy+(e.clientY-panning.sy);scheduleRender();return;}
  if(drawing?.type==='stroke'){drawing.points.push(p.x,p.y);scheduleRender();return;}
  if(drawing?.type==='rect'){drawing.w=p.x-drawing.x;drawing.h=p.y-drawing.y;scheduleRender();return;}
  if(dragging){
    const o=objects.find(x=>x.id===dragging.id); if(!o)return;
    const dx=p.x-dragging.start.x,dy=p.y-dragging.start.y;
    if(o.type==='stroke'){
      o.points=dragging.original.points.map((v,i)=>v+(i%2===0?dx:dy));
    }else{o.x=dragging.original.x+dx;o.y=dragging.original.y+dy;}
    scheduleRender();
  }
});

canvas.addEventListener('pointerup', () => {
  if(drawing){
    if(drawing.type==='rect' && drawing.w<0){drawing.x+=drawing.w;drawing.w=Math.abs(drawing.w);}
    if(drawing.type==='rect' && drawing.h<0){drawing.y+=drawing.h;drawing.h=Math.abs(drawing.h);}
    upsertLocal(drawing); drawing=null;
  }
  if(dragging){const o=objects.find(x=>x.id===dragging.id);if(o)upsertLocal(o);dragging=null;}
  panning=null;
});

viewport.addEventListener('wheel', e => {
  e.preventDefault();
  const r=canvas.getBoundingClientRect();
  const sx=e.clientX-r.left,sy=e.clientY-r.top;
  const wx=(sx-camera.x)/camera.zoom,wy=(sy-camera.y)/camera.zoom;
  const factor=e.deltaY<0?1.1:.9;
  camera.zoom=Math.min(4,Math.max(.15,camera.zoom*factor));
  camera.x=sx-wx*camera.zoom; camera.y=sy-wy*camera.zoom;
  scheduleRender();
},{passive:false});

async function uploadBlob(blob,name) {
  const fd=new FormData(); fd.append('file',blob,name);
  const r=await fetch('/api/assets',{method:'POST',body:fd});
  if(!r.ok) throw new Error('Upload failed');
  return r.json();
}

async function addImageFile(file,x=100,y=100) {
  const uploaded=await uploadBlob(file,file.name);
  const bitmap=await createImageBitmap(file);
  const maxW=1200;
  const scale=Math.min(1,maxW/bitmap.width);
  const object={id:uuid(),type:'image',url:uploaded.url,x,y,w:bitmap.width*scale,h:bitmap.height*scale,locked:false};
  upsertLocal(object);
  return object;
}

document.querySelector('#imageBtn').addEventListener('click',()=>imageInput.click());
imageInput.addEventListener('change',async()=>{if(imageInput.files[0]){try{await addImageFile(imageInput.files[0]);toast('Image added');}catch(e){toast(e.message);}imageInput.value='';}});

document.querySelector('#pdfBtn').addEventListener('click',()=>pdfInput.click());
pdfInput.addEventListener('change',async()=>{
  const file=pdfInput.files[0]; if(!file)return;
  try{
    toast('Rendering PDF…');
    const bytes=new Uint8Array(await file.arrayBuffer());
    const pdf=await pdfjsLib.getDocument({data:bytes}).promise;
    let y=100;
    for(let n=1;n<=pdf.numPages;n++){
      const page=await pdf.getPage(n);
      const viewportPdf=page.getViewport({scale:2});
      const c=document.createElement('canvas'); c.width=Math.ceil(viewportPdf.width);c.height=Math.ceil(viewportPdf.height);
      await page.render({canvasContext:c.getContext('2d'),viewport:viewportPdf}).promise;
      const blob=await new Promise(resolve=>c.toBlob(resolve,'image/jpeg',.92));
      const uploaded=await uploadBlob(blob,`${file.name.replace(/\.pdf$/i,'')}-page-${n}.jpg`);
      const width=1000, height=width*(c.height/c.width);
      upsertLocal({id:uuid(),type:'image',url:uploaded.url,x:100,y,w:width,h:height,locked:true,pdfPage:n,pdfName:file.name});
      y+=height+40;
    }
    toast(`${pdf.numPages} PDF pages added`);
    fitBoard();
  }catch(e){console.error(e);toast(`PDF failed: ${e.message}`);}finally{pdfInput.value='';}
});

function fitBoard(){
  if(!objects.length){camera={x:0,y:0,zoom:1};scheduleRender();return;}
  const bs=objects.map(bounds).filter(Boolean);
  const minX=Math.min(...bs.map(b=>b.x)),minY=Math.min(...bs.map(b=>b.y));
  const maxX=Math.max(...bs.map(b=>b.x+b.w)),maxY=Math.max(...bs.map(b=>b.y+b.h));
  const r=viewport.getBoundingClientRect(),pad=50;
  camera.zoom=Math.min(1.5,Math.max(.15,Math.min((r.width-pad*2)/(maxX-minX||1),(r.height-pad*2)/(maxY-minY||1))));
  camera.x=(r.width-(maxX-minX)*camera.zoom)/2-minX*camera.zoom;
  camera.y=(r.height-(maxY-minY)*camera.zoom)/2-minY*camera.zoom;
  scheduleRender();
}

document.querySelector('#fitBtn').addEventListener('click',fitBoard);
document.querySelector('#deleteBtn').addEventListener('click',()=>{if(selectedId){const o=objects.find(x=>x.id===selectedId);if(o&&!o.locked)removeLocal(selectedId);}});
document.querySelector('#lockBtn').addEventListener('click',()=>{const o=objects.find(x=>x.id===selectedId);if(o){o.locked=!o.locked;upsertLocal(o);toast(o.locked?'Locked':'Unlocked');}});

document.addEventListener('keydown',e=>{
  if(['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;
  if((e.key==='Delete'||e.key==='Backspace')&&selectedId){const o=objects.find(x=>x.id===selectedId);if(o&&!o.locked)removeLocal(selectedId);}
  if(e.key==='v')setTool('select'); if(e.key==='p')setTool('pen'); if(e.key==='h')setTool('highlighter');
});

socket.on('board:snapshot',board=>{objects=board.objects||[];boardName.value=board.name||'Untitled board';selectedId=null;scheduleRender();setTimeout(fitBoard,50);});
socket.on('object:upsert',object=>upsertLocal(object,false));
socket.on('object:remove',id=>removeLocal(id,false));
socket.on('board:meta',meta=>{if(meta.name)boardName.value=meta.name;});
socket.on('presence',users=>{presenceEl.innerHTML='';for(const u of users){const el=document.createElement('div');el.className='presence-dot';el.style.background=u.color;el.title=u.name;el.textContent=(u.name||'?').slice(0,2).toUpperCase();presenceEl.append(el);}});
socket.on('cursor',({user,x,y})=>{remoteCursors.set(user.id,{user,x,y,at:Date.now()});drawRemoteCursors();});

function drawRemoteCursors(){
  cursorsEl.innerHTML='';
  const now=Date.now();
  for(const [id,c] of remoteCursors){
    if(now-c.at>5000){remoteCursors.delete(id);continue;}
    const el=document.createElement('div');el.className='remote-cursor';el.style.background=c.user.color;el.style.left=`${camera.x+c.x*camera.zoom}px`;el.style.top=`${camera.y+c.y*camera.zoom}px`;el.textContent=c.user.name;cursorsEl.append(el);
  }
}
setInterval(drawRemoteCursors,1000);

let renameTimer;
boardName.addEventListener('input',()=>{clearTimeout(renameTimer);renameTimer=setTimeout(async()=>{if(boardId)await fetch(`/api/boards/${boardId}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name:boardName.value})});},400);});

async function loadBoards(){
  const boards=await fetch('/api/boards').then(r=>r.json());
  boardList.innerHTML='';
  if(!boards.length){boardList.textContent='No boards yet.';return;}
  for(const b of boards){
    const row=document.createElement('div');row.className='board-row';
    const meta=document.createElement('div');meta.className='meta';meta.innerHTML=`<div class="name"></div><div class="date"></div>`;meta.querySelector('.name').textContent=b.name;meta.querySelector('.date').textContent=new Date(b.updatedAt).toLocaleString();
    const open=document.createElement('button');open.textContent='Open';open.addEventListener('click',()=>{location.hash=b.id;location.reload();});
    const del=document.createElement('button');del.className='danger';del.textContent='Delete';del.addEventListener('click',async()=>{if(confirm(`Delete ${b.name}?`)){await fetch(`/api/boards/${b.id}`,{method:'DELETE'});loadBoards();}});
    row.append(meta,open,del);boardList.append(row);
  }
}

document.querySelector('#boardsBtn').addEventListener('click',()=>{loadBoards();boardsDialog.showModal();});
document.querySelector('#createBoardBtn').addEventListener('click',async()=>{
  const name=document.querySelector('#newBoardName').value||'Untitled board';
  const b=await fetch('/api/boards',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})}).then(r=>r.json());
  location.hash=b.id; location.reload();
});

if(boardId){socket.emit('board:join',{boardId,user:{name:username,color:userColor}});}else{loadBoards();boardsDialog.showModal();}
resizeCanvas();
