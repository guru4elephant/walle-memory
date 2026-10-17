export const fieldNames={title:'事项',status:'记录状态',progress_note:'最新进展',completion_note:'完成情况',next_step:'下一步',deadline_text:'截止说明',due_before:'截止时间',scheduled_date:'计划日期',scheduled_at:'计划时间',completed_date:'完成日期',contact_name:'联系人',contact_title:'身份',scheduling_note:'时间安排',dependency_condition:'前置条件',dependency_status:'前置进度',preview_note:'预览说明',description:'摘要',note:'备注',original_request:'最初记录'};
export const stateNames={completed:'已完成',pending:'待完成',in_progress:'进行中',satisfied:'已满足',pending_validation:'待验证',awaiting_feedback:'待反馈',blocked:'受阻',cancelled:'已取消'};
export function editModel(value){
 let parsed;try{parsed=JSON.parse(value);}catch{return {kind:'text',value};}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {kind:Array.isArray(parsed)?'array':'text',value};
 return {kind:'object',value,original:parsed,fields:Object.entries(parsed).map(([key,item])=>({key,label:fieldNames[key]||key,type:item===null||typeof item==='object'?'json':typeof item,value:typeof item==='string'||typeof item==='boolean'?item:JSON.stringify(item,null,2)}))};
}
export function editedValue(model,read){
 if(model.kind!=='object'){
  const value=read('value');
  if(model.kind==='array'){let parsed;try{parsed=JSON.parse(value);}catch{throw Error('正文需要保持有效的 JSON 数组。');}if(!Array.isArray(parsed))throw Error('正文需要保持为 JSON 数组。');}
  return value;
 }
 const result=JSON.parse(model.value);
 for(const field of model.fields){
  const raw=read(field.key);
  if(field.type==='number'){
   if(String(raw).trim()===''||!Number.isFinite(Number(raw)))throw Error(field.label+'需要填写有效数字。');
   Object.defineProperty(result,field.key,{value:Number(raw),writable:true,enumerable:true,configurable:true});
  }else if(field.type==='json'){
   let value;try{value=JSON.parse(raw);}catch{throw Error(field.label+'需要填写有效 JSON。');}
   Object.defineProperty(result,field.key,{value,writable:true,enumerable:true,configurable:true});
  }else Object.defineProperty(result,field.key,{value:raw,writable:true,enumerable:true,configurable:true});
 }
 return JSON.stringify(result)===JSON.stringify(model.original)?model.value:JSON.stringify(result,null,2);
}
