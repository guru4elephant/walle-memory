import assert from 'node:assert/strict';
import {test} from 'node:test';
import {editModel,editedValue} from '../apps/workbench/edit-model.js';

test('field edits preserve unknown, nested, boolean, null and prototype-named JSON data',()=>{
 const original='{"title":"before","extra":{"nested":[1,2]},"enabled":true,"count":3,"optional":null,"__proto__":{"saved":"data"}}';
 const model=editModel(original);const values=new Map(model.fields.map(f=>[f.key,f.value]));values.set('title','after');
 const edited=JSON.parse(editedValue(model,key=>values.get(key)));
 assert.equal(edited.title,'after');assert.deepEqual(edited.extra,{nested:[1,2]});assert.equal(edited.enabled,true);assert.equal(edited.count,3);assert.equal(edited.optional,null);assert.deepEqual(edited.__proto__,{saved:'data'});assert.equal({}.saved,undefined);
});
test('invalid nested JSON and numbers block serialization, and an unchanged record retains its original bytes',()=>{
 const model=editModel('{ "title": "one", "count": 7, "other": [1, 2] }');const values=new Map(model.fields.map(f=>[f.key,f.value]));
 assert.equal(editedValue(model,key=>values.get(key)),model.value);
 values.set('other','{');assert.throws(()=>editedValue(model,key=>values.get(key)),/JSON/);
 values.set('other','[1,2]');values.set('count','');assert.throws(()=>editedValue(model,key=>values.get(key)),/有效数字/);
});
