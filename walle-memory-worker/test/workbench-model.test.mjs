import test from 'node:test';
import assert from 'node:assert/strict';
import {statusFor,titleFor,formatValue} from '../apps/workbench/model.js';
const record=(description,key='tasks/example')=>({key,description});
test('partial delivery awaiting verification is never counted as completed',()=>{
 assert.equal(statusFor(record('开发已完成，待验证：多节点弹性训练')),'needs_validation');
 assert.equal(statusFor(record('待办：重启 continual RFT')),'pending');
 assert.equal(statusFor(record('未完成：整理实验数据')),'pending');
 assert.equal(statusFor(record('没有已完成证据，请核对')),'unknown');
});
test('a completed assignment remains a completed stage with follow-up visible in its summary',()=>{
 const r=record('已完成：27B小模型送评分发；评测结果待反馈');
 assert.equal(statusFor(r),'completed');assert.equal(titleFor(r),'27B小模型送评分发');
 assert.equal(statusFor(record('偏好：自然表达','user/preferences/style')),'unknown');
 assert.equal(statusFor(record('实践课时间','events/2026-10-22/course')),'scheduled');
});
test('plain text and untrusted JSON remain literal detail text',()=>{
 const malicious='<img src=x onerror=alert(1)>';
 assert.equal(formatValue(malicious),malicious);
 assert.match(formatValue(JSON.stringify({note:malicious})),/<img src=x/);
 assert.equal(titleFor(record('待办：'+malicious)),malicious);
});
