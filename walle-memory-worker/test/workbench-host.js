import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const frame=document.querySelector('iframe');
const bridge=new AppBridge(null,{name:'Walle Memory 本地验收宿主',version:'1.0.0'},{serverTools:{},logging:{}},{hostContext:{theme:'light',displayMode:'inline',availableDisplayModes:['inline']}});
async function call(params){const r=await fetch('/fixture/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)});if(!r.ok)throw new Error('Fixture request failed');return r.json();}
bridge.oncalltool=call;
bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult(await call({name:'memory_workbench',arguments:{}}));};
bridge.onsizechange=()=>{};
async function start(){await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/fixture/app';} start();
