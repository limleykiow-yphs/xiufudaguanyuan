(function(global){
"use strict";

const HEADERS=["题号","关卡序号","景点","代表人物","难度","类型","题目","选项A","选项B","选项C","选项D","答案字母","正确答案","解析","启用","标签"];

function normalizeText(v){
  return String(v??"").trim().replace(/\s+/g," ");
}
function normalizeQuestion(v){
  return normalizeText(v).toLowerCase().replace(/[，。！？、；：,.!?;:'"“”‘’（）()《》\s]/g,"");
}
function escapeHtml(v){
  return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function colIndex(ref){
  const m=String(ref).match(/[A-Z]+/i);
  if(!m)return 0;
  let n=0;
  for(const ch of m[0].toUpperCase())n=n*26+(ch.charCodeAt(0)-64);
  return n-1;
}
function u16(v,o){return v.getUint16(o,true)}
function u32(v,o){return v.getUint32(o,true)}

async function inflateRaw(bytes){
  if(typeof DecompressionStream==="undefined"){
    throw new Error("此浏览器不支持直接读取 XLSX，请改用最新版 Chrome、Edge 或 Firefox。");
  }
  const ds=new DecompressionStream("deflate-raw");
  const stream=new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function unzip(arrayBuffer){
  const view=new DataView(arrayBuffer);
  const bytes=new Uint8Array(arrayBuffer);
  let eocd=-1;
  const min=Math.max(0,bytes.length-65557);
  for(let i=bytes.length-22;i>=min;i--){
    if(u32(view,i)===0x06054b50){eocd=i;break;}
  }
  if(eocd<0)throw new Error("不是有效的 XLSX 文件。");
  const count=u16(view,eocd+10);
  let p=u32(view,eocd+16);
  const entries={};
  const decoder=new TextDecoder("utf-8");
  for(let i=0;i<count;i++){
    if(u32(view,p)!==0x02014b50)throw new Error("XLSX 压缩目录损坏。");
    const method=u16(view,p+10);
    const compSize=u32(view,p+20);
    const fnameLen=u16(view,p+28);
    const extraLen=u16(view,p+30);
    const commentLen=u16(view,p+32);
    const localOffset=u32(view,p+42);
    const name=decoder.decode(bytes.slice(p+46,p+46+fnameLen));
    entries[name]={method,compSize,localOffset};
    p+=46+fnameLen+extraLen+commentLen;
  }
  async function read(name){
    const e=entries[name];
    if(!e)return null;
    const lp=e.localOffset;
    if(u32(view,lp)!==0x04034b50)throw new Error("XLSX 文件项目损坏："+name);
    const fn=u16(view,lp+26),ex=u16(view,lp+28);
    const start=lp+30+fn+ex;
    const compressed=bytes.slice(start,start+e.compSize);
    let out;
    if(e.method===0)out=compressed;
    else if(e.method===8)out=await inflateRaw(compressed);
    else throw new Error("不支持的 XLSX 压缩方式："+e.method);
    return decoder.decode(out);
  }
  return {read,entries};
}
function parseXml(text){
  const doc=new DOMParser().parseFromString(text,"application/xml");
  if(doc.querySelector("parsererror"))throw new Error("Excel XML 内容无法解析。");
  return doc;
}
function getRelId(el){
  return el.getAttribute("r:id")||el.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships","id");
}
async function readXlsx(file){
  const zip=await unzip(await file.arrayBuffer());
  const sharedText=await zip.read("xl/sharedStrings.xml");
  const shared=[];
  if(sharedText){
    const doc=parseXml(sharedText);
    doc.querySelectorAll("si").forEach(si=>{
      shared.push([...si.querySelectorAll("t")].map(t=>t.textContent||"").join(""));
    });
  }

  let sheetPath="xl/worksheets/sheet1.xml";
  const wbText=await zip.read("xl/workbook.xml");
  const relText=await zip.read("xl/_rels/workbook.xml.rels");
  if(wbText&&relText){
    const wb=parseXml(wbText),rels=parseXml(relText);
    const targetSheet=[...wb.querySelectorAll("sheet")].find(s=>s.getAttribute("name")==="题库")||wb.querySelector("sheet");
    if(targetSheet){
      const id=getRelId(targetSheet);
      const rel=[...rels.querySelectorAll("Relationship")].find(r=>r.getAttribute("Id")===id);
      if(rel){
        let target=rel.getAttribute("Target")||"worksheets/sheet1.xml";
        target=target.replace(/^\/+/,"");
        sheetPath=target.startsWith("xl/")?target:"xl/"+target;
      }
    }
  }
  const sheetText=await zip.read(sheetPath);
  if(!sheetText)throw new Error("找不到“题库”工作表。");
  const doc=parseXml(sheetText);
  const rows=[];
  doc.querySelectorAll("row").forEach(rowEl=>{
    const row=[];
    rowEl.querySelectorAll("c").forEach(c=>{
      const idx=colIndex(c.getAttribute("r")||"A1");
      const t=c.getAttribute("t");
      let val="";
      if(t==="inlineStr")val=[...c.querySelectorAll("t")].map(x=>x.textContent||"").join("");
      else{
        const v=c.querySelector("v")?.textContent??"";
        val=t==="s"?shared[Number(v)]??"":v;
      }
      row[idx]=val;
    });
    rows.push(row);
  });
  return rows;
}
async function readHtmlXls(file){
  const text=await file.text();
  const doc=new DOMParser().parseFromString(text,"text/html");
  const table=doc.querySelector("table");
  if(!table)throw new Error("无法读取此 XLS 文件。");
  return [...table.querySelectorAll("tr")].map(tr=>[...tr.querySelectorAll("th,td")].map(td=>td.textContent.trim()));
}
async function readQuestionRows(file){
  const name=file.name.toLowerCase();
  const rows=name.endsWith(".xlsx")?await readXlsx(file):await readHtmlXls(file);
  if(!rows.length)throw new Error("Excel 内没有资料。");
  const header=rows[0].map(normalizeText);
  const map={};
  HEADERS.forEach(h=>map[h]=header.indexOf(h));
  const required=["景点","难度","题目","选项A","选项B","选项C","选项D","答案字母","解析"];
  const missing=required.filter(h=>map[h]<0);
  if(missing.length)throw new Error("Excel 缺少栏位："+missing.join("、"));
  return rows.slice(1).map((r,i)=>{
    const obj={_row:i+2};
    HEADERS.forEach(h=>obj[h]=map[h]>=0?(r[map[h]]??""):"");
    return obj;
  });
}
function applyRowsToConfig(rows,config){
  const report={totalRows:rows.length,imported:0,skipped:0,errors:[],duplicates:[]};
  const stageMap=new Map(config.stages.map(s=>[normalizeText(s.name),s]));
  const newQuestions=new Map(config.stages.map(s=>[s,[]]));
  const seen=new Map();

  for(const row of rows){
    const enabled=normalizeText(row["启用"]||"是");
    const qtext=normalizeText(row["题目"]);
    if(!qtext){report.skipped++;continue;}
    if(enabled==="否"){report.skipped++;continue;}

    const stage=stageMap.get(normalizeText(row["景点"]));
    if(!stage){report.errors.push(`第${row._row}行：找不到景点“${row["景点"]}”`);continue;}
    const opts=["选项A","选项B","选项C","选项D"].map(k=>normalizeText(row[k]));
    if(opts.some(x=>!x)){report.errors.push(`第${row._row}行：四个选项不可留空`);continue;}
    if(new Set(opts).size<4){report.errors.push(`第${row._row}行：选项有重复`);continue;}
    const letter=normalizeText(row["答案字母"]).toUpperCase();
    if(!["A","B","C","D"].includes(letter)){report.errors.push(`第${row._row}行：答案字母必须是 A、B、C 或 D`);continue;}
    const level=normalizeText(row["难度"])||"初级";
    if(!["初级","中级","高级"].includes(level)){report.errors.push(`第${row._row}行：难度必须是初级、中级或高级`);continue;}

    const key=normalizeQuestion(qtext);
    if(seen.has(key)){
      report.duplicates.push(`第${row._row}行与第${seen.get(key)}行：${qtext}`);
    }else seen.set(key,row._row);

    newQuestions.get(stage).push({
      q:qtext,
      a:opts,
      c:["A","B","C","D"].indexOf(letter),
      level,
      type:normalizeText(row["类型"])||"综合",
      exp:normalizeText(row["解析"])
    });
    report.imported++;
  }

  if(report.imported===0)throw new Error("没有任何有效题目可导入。");
  for(const [stage,qs] of newQuestions){
    if(qs.length)stage.questions=qs;
  }
  return report;
}
function configRows(config){
  const rows=[];
  let id=1;
  config.stages.forEach(stage=>{
    stage.questions.forEach(q=>{
      rows.push([
        id++,stage.n,stage.name,stage.person,q.level||"初级",q.type||"综合",q.q,
        q.a[0]||"",q.a[1]||"",q.a[2]||"",q.a[3]||"",
        ["A","B","C","D"][q.c]||"A",q.a[q.c]||"",q.exp||"","是",""
      ]);
    });
  });
  return rows;
}
function exportConfigAsExcel(config,filename){
  const rows=[HEADERS,...configRows(config)];
  const table=rows.map((r,ri)=>"<tr>"+r.map(v=>(ri===0?"<th>":"<td>")+escapeHtml(v)+(ri===0?"</th>":"</td>")).join("")+"</tr>").join("");
  const html=`\ufeff<html><head><meta charset="UTF-8"><style>
  table{border-collapse:collapse;font-family:Microsoft YaHei}th{background:#8e3d31;color:white}
  th,td{border:1px solid #cdb38b;padding:6px;white-space:pre-wrap}td:nth-child(6),td:nth-child(13){min-width:260px}
  </style></head><body><table>${table}</table></body></html>`;
  const blob=new Blob([html],{type:"application/vnd.ms-excel;charset=utf-8"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}
function checkConfig(config){
  const report={total:0,errors:[],duplicates:[],answerCounts:{A:0,B:0,C:0,D:0}};
  const seen=new Map();
  config.stages.forEach(stage=>{
    stage.questions.forEach((q,i)=>{
      report.total++;
      const label=`${stage.name} 第${i+1}题`;
      if(!normalizeText(q.q)||!Array.isArray(q.a)||q.a.length!==4||q.a.some(x=>!normalizeText(x))){
        report.errors.push(label+"：题目或选项不完整");
      }else if(new Set(q.a.map(normalizeText)).size<4){
        report.errors.push(label+"：选项有重复");
      }
      if(!Number.isInteger(q.c)||q.c<0||q.c>3)report.errors.push(label+"：正确答案位置错误");
      else report.answerCounts[["A","B","C","D"][q.c]]++;
      const key=normalizeQuestion(q.q);
      if(key){
        if(seen.has(key))report.duplicates.push(label+" 与 "+seen.get(key)+" 疑似重复");
        else seen.set(key,label);
      }
    });
  });
  return report;
}

global.ExcelIO={readQuestionRows,applyRowsToConfig,exportConfigAsExcel,checkConfig};
})(window);
