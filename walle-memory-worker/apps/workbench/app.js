import {App,applyDocumentTheme,applyHostStyleVariables} from '@modelcontextprotocol/ext-apps';
import {categories,labels,statusFor,titleFor,formatValue} from './model.js';
import {editModel,editedValue,fieldNames,stateNames} from './edit-model.js';
const $=id=>document.getElementById(id);
const app=new App({name:'Walle Memory',version:'1.0.0'});
let snapshot=null,selectedKey=null,tab='entries',prefix='',generation=0,detailGeneration=0,inFlight=false,debounce,timer,selectedEntry=null,editor=null,saving=false;
const preview=window.__WALLE_PREVIEW__;
const date=(ms,full=false)=>ms==null?'—':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',...(full?{year:'numeric'}:{})}).format(ms);
const day=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
function node(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function empty(target,message){target.replaceChildren(node('p',message,'empty'));}
function badge(entry){const status=statusFor(entry);return node('span',labels[status],'badge '+status);}
function error(message){$('error').textContent=message;$('error').hidden=!message;}
function clearDetails(){selectedKey=null;selectedEntry=null;editor=null;$('edit-entry').hidden=true;$('detail-heading').textContent='条目详情';detailGeneration++;$('detail-panel').classList.remove('active');empty($('detail'),'选择一条记忆，查看正文、状态与更新时间');}
function hostContext(ctx){if(ctx?.theme){applyDocumentTheme(ctx.theme);document.body.dataset.theme=ctx.theme;}if(ctx?.styles?.variables)applyHostStyleVariables(ctx.styles.variables);if(ctx?.availableDisplayModes?.includes('fullscreen'))$('expand').hidden=false;}
async function call(name,args){const r=preview?await preview.call(name,args):await app.callServerTool({name,arguments:args});if(r.isError)throw new Error('当前操作未成功，请确认连接及空间权限后重试。');const data=r.structuredContent;if(!data)throw new Error('没有收到有效数据。');return data;}
function renderNavigation(){const nav=$('categories');nav.replaceChildren();categories.forEach(([value,label,icon])=>{const b=node('button');b.setAttribute('aria-pressed',String(value===prefix));b.setAttribute('aria-label',label);b.title=label;const symbol=node('span',icon,'nav-icon');symbol.setAttribute('aria-hidden','true');b.append(symbol,node('span',label,'nav-text'));b.onclick=async()=>{if(!await mayLeave())return;prefix=value;$('status-filter').value='all';clearDetails();renderNavigation();load();};nav.append(b);});}
function render(){if(!snapshot)return;const s=snapshot;
 const old=$('workspace').value;$('workspace').replaceChildren();s.workspaces.forEach(w=>{const o=node('option',w.display_name||w.name);o.value=w.id;$('workspace').append(o);});$('workspace').value=s.workspace.id||old;
 $('workspace-type').textContent=s.workspace.memory_type||'general';$('subtitle').textContent=s.workspace.display_name||s.workspace.name;
 $('total').textContent=s.total;$('done').textContent=s.entries.filter(e=>statusFor(e)==='completed').length;$('pending').textContent=s.entries.filter(e=>['pending','in_progress','needs_validation','awaiting_feedback'].includes(statusFor(e))).length;$('today').textContent=s.entries.filter(e=>day(e.updated_at)===day(s.refreshed_at)).length;
 const visible=s.entries.filter(e=>$('status-filter').value==='all'||statusFor(e)===$('status-filter').value);$('visible-count').textContent=tab==='entries'?visible.length+' 条已显示':'最近 '+s.changes.length+' 条';
 $('entries').replaceChildren();visible.forEach(entry=>{const row=node('button',undefined,'row'+(entry.key===selectedKey?' selected':''));const top=node('div',undefined,'row-top');top.append(node('span',titleFor(entry),'row-title'),badge(entry));row.append(top,node('p',entry.description,'row-desc'));const foot=node('div',undefined,'row-foot');const k=node('span',entry.key,'key');k.title=entry.key;foot.append(k,node('span',date(entry.updated_at),'timestamp'));row.append(foot);row.onclick=()=>select(entry);$('entries').append(row);});
 if(!visible.length)empty($('entries'),s.total?'当前已加载条目中没有匹配的状态，可加载更多或调整筛选。':'没有匹配的记忆。');
 $('changes').replaceChildren();s.changes.forEach(change=>{const item=node('div',undefined,'activity');const action={created:'新增了记忆',updated:'更新了记忆',deleted:'删除了记忆'}[change.operation]||'记忆变更';item.append(node('div',action+' · '+date(change.changed_at),'activity-label'),node('div',titleFor(change),'row-title'),node('div',change.key,'key'),node('p',change.description,'row-desc'));if(change.operation!=='deleted'){const b=node('button','查看条目');b.style.marginTop='8px';b.onclick=()=>select(change);item.append(b);}$('changes').append(item);});if(!s.changes.length)empty($('changes'),'还没有记录到新的变更。已有记忆可在“记忆条目”中查看。');
 $('history-note').textContent=s.history_note;$('sync-time').textContent='最近同步 '+date(s.refreshed_at);$('page-info').textContent='已加载 '+s.entries.length+' / '+s.total+' 条 · 状态来自摘要';$('more').hidden=!s.has_more||tab!=='entries';setTab(tab);
}
function detailValue(entry){
 let value;try{value=JSON.parse(entry.value);}catch{return node('pre',entry.value,'value');}
 if(!value || typeof value!=='object' || Array.isArray(value))return node('pre',formatValue(entry.value),'value');
 const box=node('div');const names=fieldNames;
 const fields=node('dl',undefined,'detail-meta');
 for(const [key,label]of Object.entries(names)){if(value[key]==null)continue;const item=value[key];const text=typeof item==='string'&&Object.hasOwn(stateNames,item)?stateNames[item]:typeof item==='object'?JSON.stringify(item):String(item);fields.append(node('dt',label),node('dd',text));}box.append(fields);
 const raw=node('details');raw.style.marginTop='16px';raw.append(node('summary','查看原始记录','small muted'),node('pre',formatValue(entry.value),'value'));box.append(raw);return box;
}
function setTab(value){tab=value;$('entries').hidden=tab!=='entries';$('controls').hidden=tab!=='entries';$('changes').hidden=tab!=='changes';$('history-note').hidden=tab!=='changes';$('list-footer').hidden=tab!=='entries';$('entries-tab').setAttribute('aria-selected',String(tab==='entries'));$('changes-tab').setAttribute('aria-selected',String(tab==='changes'));if(snapshot)$('visible-count').textContent=tab==='changes'?'最近 '+snapshot.changes.length+' 条':snapshot.entries.filter(e=>$('status-filter').value==='all'||statusFor(e)===$('status-filter').value).length+' 条已显示';}
async function load(more=false){if(saving)return;const version=++generation;const workspace=$('workspace').value;const workspaceId=snapshot?.workspaces.some(w=>w.id===workspace)?workspace:undefined;const switching=snapshot&&workspaceId&&workspaceId!==snapshot.workspace.id;
 if(switching){snapshot=null;clearDetails();empty($('entries'),'正在切换空间…');$('changes').replaceChildren();['total','done','pending','today'].forEach(id=>$(id).textContent='—');}
 inFlight=true;$('refresh').disabled=true;$('more').disabled=true;error('');
 try{const data=await call('memory_workbench',{...(workspaceId?{workspace_id:workspaceId}:{}),prefix,query:$('search').value.trim(),offset:more&&snapshot?snapshot.entries.length:0,limit:100});if(version!==generation)return;if(more&&snapshot)data.entries=[...snapshot.entries,...data.entries];snapshot=data;render();}
 catch(e){if(version===generation)error(e.message||'连接中断，请刷新重试。');}
 finally{if(version===generation){inFlight=false;$('refresh').disabled=false;$('more').disabled=false;}}
}
function canEdit(){return snapshot?.permissions?.includes('memory:write');}
function renderDetail(entry,notice=''){
 selectedEntry=entry;editor=null;$('detail-heading').textContent='条目详情';$('edit-entry').hidden=!canEdit();$('edit-entry').disabled=false;
 const detail=$('detail');detail.replaceChildren();if(notice){const message=node('p',notice,'edit-notice');message.id='save-notice';message.setAttribute('role','status');detail.append(message);}
 detail.append(badge(entry),node('h3',titleFor(entry)),node('div',entry.key,'detail-key'),node('p',entry.description,'row-desc'));
 const meta=node('dl',undefined,'detail-meta');[['最近更新',date(entry.updated_at,true)],['到期时间',entry.expires_at?date(entry.expires_at,true):'永久保留'],['读取次数',String(entry.access_count)],['当前空间',snapshot.workspace.display_name||snapshot.workspace.name]].forEach(([k,v])=>meta.append(node('dt',k),node('dd',v)));detail.append(meta,detailValue(entry));
}
async function mayLeave(){
 if(saving)return false;if(!editor?.dirty)return true;
 const dialog=$('discard-dialog');if(dialog.open)return false;dialog.returnValue='';dialog.showModal();
 return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='discard'),{once:true}));
}
async function select(summary,skipLeave=false){if(!snapshot||saving||(!skipLeave&&!await mayLeave()))return;editor=null;selectedEntry=null;$('edit-entry').hidden=true;$('detail-heading').textContent='条目详情';const workspace=snapshot.workspace.id;const version=++detailGeneration;selectedKey=summary.key;render();$('detail-panel').classList.add('active');if(window.innerWidth<=850)$('detail-panel').scrollIntoView({behavior:'smooth',block:'start'});empty($('detail'),'正在读取记忆…');
 try{const data=await call('memory_get',{workspace_id:workspace,key:summary.key});if(version!==detailGeneration||snapshot?.workspace.id!==workspace)return;if(!data.entry){empty($('detail'),'这条记忆已删除或已过期。');return;}renderDetail(data.entry);}
 catch(e){if(version===detailGeneration)empty($('detail'),e.message||'正文读取失败。');}
}
function beginEdit(){
 if(!selectedEntry||!canEdit()||saving)return;
 const entry=selectedEntry,model=editModel(entry.value),inputs=new Map();
 editor={entry,workspace:snapshot.workspace.id,model,dirty:false,blocked:false,inputs};$('edit-entry').hidden=true;$('detail-heading').textContent='编辑条目';
 const detail=$('detail');detail.replaceChildren(node('div',entry.key,'detail-key edit-key'));
 const notice=node('p','','edit-notice');notice.id='edit-notice';notice.hidden=true;notice.setAttribute('role','status');detail.append(notice);
 const form=node('div',undefined,'edit-form');form.id='edit-form';
 function field(label,id,value,type='string',key,target=form){
  const box=node('label',undefined,'edit-field');box.append(node('span',label));let input;
  if(key==='status'&&type==='string'&&Object.hasOwn(stateNames,value)){
   input=node('select');Object.entries(stateNames).forEach(([state,text])=>{const option=node('option',text);option.value=state;input.append(option);});input.value=value;
  }else if(type==='boolean'){input=node('input');input.type='checkbox';input.checked=value;}
  else if(type==='number'){input=node('input');input.type='number';input.step='any';input.value=value;}
  else {input=node('textarea');input.rows=type==='json'?5:label==='正文'?12:2;input.value=value;if(type==='json')input.className='json-field';}
  input.id=id;box.append(input);target.append(box);inputs.set(key??id,input);input.oninput=()=>{if(editor)editor.dirty=true;};return input;
 }
 const description=field('摘要','edit-description',entry.description);description.maxLength=8192;
 form.append(node('p','摘要用于列表和状态标签；修改状态时请同步摘要。','edit-help'));
 if(model.kind==='object'){
  const primary=new Set(['title','status','progress_note','completion_note','next_step','deadline_text','due_before','scheduled_date','scheduled_at','completed_date','contact_name','contact_title','scheduling_note','dependency_condition','dependency_status','description','note']);
  const hasPrimary=model.fields.some(item=>primary.has(item.key));const extra=node('details');const extraFields=node('div',undefined,'edit-form');let extraCount=0;
  for(const item of model.fields){const advanced=hasPrimary&&!primary.has(item.key);field(item.label,'edit-field-'+item.key,item.value,item.type,item.key,advanced?extraFields:form);if(advanced)extraCount++;}
  if(extraCount){extra.append(node('summary','其他字段（'+extraCount+'）','small muted'),extraFields);form.append(extra);}
 }
 else field(model.kind==='array'?'正文（JSON 数组）':'正文','edit-value',model.value,model.kind==='array'?'json':'string','value');
 form.append(node('p','保存到当前空间；保留原 key 和到期时间。','edit-help'));
 const actions=node('div',undefined,'edit-actions');const save=node('button','保存修改','primary');save.id='save-edit';save.type='button';save.onclick=saveEdit;const cancel=node('button','取消');cancel.id='cancel-edit';cancel.type='button';cancel.onclick=async()=>{if(await mayLeave())renderDetail(entry);};
 const reload=node('button','重新读取');reload.id='reload-entry';reload.type='button';reload.hidden=true;reload.onclick=async()=>{if(await mayLeave())select({key:entry.key},true);};actions.append(save,cancel,reload);form.prepend(actions);detail.append(form);description.focus();
}
function editorNotice(message,problem=false){const el=$('edit-notice');if(el){el.textContent=message;el.hidden=false;el.classList.toggle('problem',problem);}}
async function saveEdit(event){
 event.preventDefault();if(!editor||saving||editor.blocked)return;const draft=editor;
 let value,description;try{
  value=editedValue(draft.model,key=>{const input=draft.inputs.get(key);return input.type==='checkbox'?input.checked:input.value;});description=$('edit-description').value;
  const bytes=new TextEncoder();if(bytes.encode(value).length>256*1024||bytes.encode(description).length>8192)throw Error('正文最多 256 KB，摘要最多 8 KB。');if(value.includes('\0')||description.includes('\0'))throw Error('内容含有不支持的空字符。');
 }catch(e){editorNotice(e.message,true);return;}
 if(value===draft.entry.value&&description===draft.entry.description){renderDetail(draft.entry,'内容未改变，无需保存。');return;}
 saving=true;for(const input of $('edit-form').querySelectorAll('input,textarea,select,button'))input.disabled=true;editorNotice('正在保存…');let submitted=false;
 try{
  const result=await call('memory_update',{workspace_id:draft.workspace,key:draft.entry.key,value,description,expected_updated_at:draft.entry.updated_at});
  if(!result.ok){draft.blocked=true;editorNotice(result.reason==='conflict'?'云端已被其他会话修改，未覆盖新内容。草稿已保留，请重新读取后再编辑。':'条目已删除或过期，未重新创建。草稿已保留。',true);return;}
  submitted=true;const current=await call('memory_get',{workspace_id:draft.workspace,key:draft.entry.key});
  if(!current.entry){draft.blocked=true;editorNotice('修改已提交，但条目现已删除或过期。',true);return;}
  const matches=current.entry.value===value&&current.entry.description===description&&current.entry.expires_at===draft.entry.expires_at;
  renderDetail(current.entry,matches?'已保存，并重新读取确认。':'修改已提交；此条目随后又有更新，已显示最新内容。');
 }catch{draft.blocked=true;editorNotice(submitted?'修改已提交，暂未能重新读取。草稿已保留，请重新读取确认。':'未能确认保存结果，草稿已保留。请重新读取核对后再编辑。',true);}
 finally{
  saving=false;if(editor===draft){for(const input of $('edit-form').querySelectorAll('input,textarea,select,button'))input.disabled=false;$('save-edit').disabled=draft.blocked;$('reload-entry').hidden=!draft.blocked;}
  if(submitted)await load();
 }
}
app.ontoolresult=result=>{const data=result.structuredContent;if(generation===0&&data?.workspace&&Array.isArray(data.entries)){snapshot=data;clearDetails();render();}};
app.onhostcontextchanged=hostContext;app.onteardown=async()=>{generation++;detailGeneration++;clearInterval(timer);clearTimeout(debounce);snapshot=null;clearDetails();$('entries').replaceChildren();$('changes').replaceChildren();return {};};
$('workspace').onchange=async()=>{if(!await mayLeave()){$('workspace').value=snapshot?.workspace.id??'';return;}clearDetails();load();};$('edit-entry').onclick=beginEdit;$('refresh').onclick=()=>load();$('more').onclick=()=>load(true);$('status-filter').onchange=render;$('entries-tab').onclick=()=>setTab('entries');$('changes-tab').onclick=()=>setTab('changes');$('close-detail').onclick=async()=>{if(await mayLeave())clearDetails();};$('search').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(()=>load(),350);};$('expand').onclick=async()=>{try{await app.requestDisplayMode({mode:'fullscreen'});}catch{error('此宿主暂不支持展开显示。');}};
$('discard-keep').onclick=()=>$('discard-dialog').close('keep');$('discard-confirm').onclick=()=>$('discard-dialog').close('discard');
$('sidebar-toggle').onclick=()=>{const collapsed=document.querySelector('.shell').classList.toggle('sidebar-collapsed');const label=collapsed?'展开侧栏':'收起侧栏';$('sidebar-toggle').setAttribute('aria-expanded',String(!collapsed));$('sidebar-toggle').setAttribute('aria-label',label);$('sidebar-toggle').title=label;};
renderNavigation();
async function start(){try{if(preview){document.body.dataset.preview='true';snapshot=preview.initial;render();}else{await app.connect();hostContext(app.getHostContext());if(!snapshot)await load();}timer=setInterval(()=>{if($('auto-refresh').checked&&document.visibilityState==='visible'&&!inFlight&&!editor&&!saving)load();},45000);}catch{empty($('entries'),'请在支持 MCP Apps 的对话中打开 Walle Memory。');error('尚未连接 MCP Apps 宿主。');}}
start();
