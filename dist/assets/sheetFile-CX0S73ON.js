import{c,ev as d,ew as u,ex as y,ey as h}from"./index-DLXAk7zp.js";/**
 * @license lucide-react v0.468.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const p=c("Download",[["path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",key:"ih7n3h"}],["polyline",{points:"7 10 12 15 17 10",key:"2ggqvy"}],["line",{x1:"12",x2:"12",y1:"15",y2:"3",key:"1vk2je"}]]);/**
 * @license lucide-react v0.468.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=c("Upload",[["path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",key:"ih7n3h"}],["polyline",{points:"17 8 12 3 7 8",key:"t8dd8p"}],["line",{x1:"12",x2:"12",y1:"3",y2:"15",key:"widbto"}]]);let r=null;function l(){return r||(r=d(()=>import("./xlsx-D9UGuzH6.js"),[]).catch(t=>{throw r=null,t})),r}async function _(t){if(/\.xlsx?$/i.test(t.name)){let o;try{o=await l()}catch{throw new Error("Excel 解析元件載入失敗，請檢查網路連線後再試一次（CSV 檔不受影響）")}const e=await t.arrayBuffer(),a=o.read(e,{type:"array"}),s=a.Sheets[a.SheetNames[0]];if(!s)return[];const i=o.utils.sheet_to_json(s,{header:1,defval:""});return y(i)}const n=await t.text();return h(n)}function w(t,n){const o=new Blob(["\uFEFF"+u(t)],{type:"text/csv;charset=utf-8"}),e=URL.createObjectURL(o),a=document.createElement("a");a.href=e,a.download=n,a.click(),URL.revokeObjectURL(e)}async function f(t,n,o){try{const e=await l(),a=e.utils.aoa_to_sheet(t),s=e.utils.book_new();return e.utils.book_append_sheet(s,a,n),e.writeFile(s,`${o}.xlsx`),"xlsx"}catch{return w(t,`${o}.csv`),"csv"}}export{p as D,v as U,f as d,_ as r};
