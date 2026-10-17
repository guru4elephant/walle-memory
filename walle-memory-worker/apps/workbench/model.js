export const categories=[['','全部记忆','◫'],['tasks/','待办与进展','☑'],['events/','日程安排','◷'],['user/','个人与偏好','◇'],['project/','项目上下文','▣'],['context/','随手记录','▤']];
export const labels={completed:'已完成',pending:'待办',in_progress:'进行中',needs_validation:'待验证',awaiting_feedback:'待反馈',scheduled:'日程',unknown:'未标明'};
export function statusFor(entry){
 const d=entry.description||'';
 if(/开发已完成[，,、\s]*待验证|^待验证/.test(d))return 'needs_validation';
 if(/^已完成[：:]/.test(d))return 'completed';
 if(/^待反馈|^等待反馈/.test(d))return 'awaiting_feedback';
 if(/^进行中|^已发起|^开发中/.test(d))return 'in_progress';
 if(/^待办|^待完成|^待安排|^未完成/.test(d))return 'pending';
 if(entry.key.startsWith('events/')||/^日程/.test(d))return 'scheduled';
 return 'unknown';
}
export function titleFor(entry){return (entry.description||entry.key).replace(/^(开发已完成[，,]待验证|已完成|待验证|待反馈|待办|待完成|待安排|进行中|日程)[：:]\s*/,'').split(/[；;\n]/)[0];}
export function formatValue(value){try{return JSON.stringify(JSON.parse(value),null,2);}catch{return value;}}
