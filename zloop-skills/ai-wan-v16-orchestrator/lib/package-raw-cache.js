'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CONTRACT_VERSION = 'ai-wan-v1.5.5-fetch';
const SCRIPTS = ['category_daily_avg','category_summary','category_fulfill_daily_avg','category_fulfill_summary','model_daily_avg','model_summary'];
const OPTIONAL_EMPTY_SCRIPTS = new Set(['category_fulfill_daily_avg','category_fulfill_summary']);
function ensureDir(d){fs.mkdirSync(d,{recursive:true});}
function sha256File(f){return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}
function sha256Text(s){return crypto.createHash('sha256').update(String(s),'utf8').digest('hex');}
function writeJson(f,v){ensureDir(path.dirname(f));fs.writeFileSync(f,`${JSON.stringify(v,null,2)}\n`,'utf8');}
function parseArgs(argv=process.argv.slice(2)){const a={};for(let i=0;i<argv.length;i++){const t=argv[i];if(t==='--help'||t==='-h')a.help=true;else if(t.startsWith('--')){const k=t.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());const n=argv[i+1];if(!n||n.startsWith('--'))throw new Error(`Missing value for ${t}`);a[k]=n;i++;}else throw new Error(`Unknown argument: ${t}`);}return a;}
function run(cmd,args,opts={}){const r=spawnSync(cmd,args,{encoding:'utf8',...opts});if(r.status!==0)throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr||r.stdout}`);return r;}
function zipDir(src,out,entries=['.']){run('sh',['-lc','command -v zip >/dev/null']);ensureDir(path.dirname(out));if(fs.existsSync(out))fs.rmSync(out,{force:true});run('zip',['-qr',path.resolve(out),...entries],{cwd:src});}
function splitCsvLine(line){const out=[];let cur='';let q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(ch===','&&!q){out.push(cur);cur='';}else cur+=ch;}out.push(cur);return out;}
function inspectCsv(file){const text=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');const lines=text.split(/\r?\n/).filter(Boolean);return {row_count:Math.max(0,lines.length-1),column_count:lines.length?splitCsvLine(lines[0]).length:0,bytes:fs.statSync(file).size,sha256:sha256File(file)};}
function findInputFile(inputDir, script, ext){const exact=path.join(inputDir,`${script}.${ext}`);if(fs.existsSync(exact))return exact;const hit=fs.readdirSync(inputDir).find(f=>f===`${script}_${ext}`||f.startsWith(`${script}_`)&&f.endsWith(`.${ext}`));return hit?path.join(inputDir,hit):'';}
function packageRawCache(options={}){
 const runDt=options.runDt;if(!/^\d{4}-\d{2}-\d{2}$/.test(String(runDt||'')))throw new Error(`runDt must be YYYY-MM-DD, got ${runDt}`);
 const inputDir=path.resolve(options.inputDir||'.');const outDir=path.resolve(options.outDir||inputDir);const runId=options.runId||`fetch_${runDt}_${crypto.randomBytes(4).toString('hex')}`;ensureDir(outDir);
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),`ai-wan-fetch-${runDt}-`));
 try{ensureDir(path.join(tmp,'raw'));ensureDir(path.join(tmp,'sql'));const scripts={};const rawFiles=[];
  for(const script of SCRIPTS){const csv=findInputFile(inputDir,script,'csv');if(!csv)throw new Error(`missing raw csv for ${script} in ${inputDir}`);const sql=findInputFile(inputDir,script,'sql');const rawRel=`raw/${script}_${runDt}.csv`;const sqlRel=`sql/${script}_${runDt}.sql`;fs.copyFileSync(csv,path.join(tmp,rawRel));let sqlText=sql?fs.readFileSync(sql,'utf8'):`-- SQL text unavailable for ${script}; packaged by package-raw-cache.js\n`;fs.writeFileSync(path.join(tmp,sqlRel),sqlText,'utf8');const csvInfo=inspectCsv(path.join(tmp,rawRel));const emptyOptional=csvInfo.row_count===0&&OPTIONAL_EMPTY_SCRIPTS.has(script);scripts[script]={execute_id:options.executeId||'',status:csvInfo.row_count>0?'SUCCESS':(emptyOptional?'WARN':'FAILED'),row_count:csvInfo.row_count,column_count:csvInfo.column_count,bytes:csvInfo.bytes,sha256:csvInfo.sha256,raw_csv:rawRel,rendered_sql:sqlRel,rendered_sql_sha256:sha256Text(sqlText),started_at:options.startedAt||'',finished_at:options.finishedAt||new Date().toISOString(),error_summary:csvInfo.row_count>0?'':(emptyOptional?'empty csv accepted as fulfillment known gap':'empty csv')};rawFiles.push({script,path:rawRel,...csvInfo});}
  const values=Object.values(scripts);const status=values.every(s=>s.status==='SUCCESS')?'success':(values.some(s=>s.status==='FAILED')?'failed':'warn');
  const sqlStatus={contract_version:CONTRACT_VERSION,stage:'fetch',run_id:runId,run_dt:runDt,sql_scope:'all',status,scripts,generated_at:new Date().toISOString()};
  const knownGaps=options.knownGaps?String(options.knownGaps).split(',').filter(Boolean):[];for(const [script,info] of Object.entries(scripts)){if(info.status==='WARN'&&!knownGaps.includes(`${script}_empty`))knownGaps.push(`${script}_empty`);}
  const rawManifest={contract_version:CONTRACT_VERSION,stage:'fetch',run_id:runId,run_dt:runDt,target_month:runDt.slice(0,7),raw_files:rawFiles,known_gaps:knownGaps,generated_at:new Date().toISOString()};
  writeJson(path.join(tmp,`sql_status_${runDt}.json`),sqlStatus);writeJson(path.join(tmp,`raw_manifest_${runDt}.json`),rawManifest);
  writeJson(path.join(outDir,`sql_status_${runDt}.json`),sqlStatus);writeJson(path.join(outDir,`raw_manifest_${runDt}.json`),rawManifest);
  const rawCache=path.join(outDir,`raw_cache_${runDt}.zip`);zipDir(tmp,rawCache,['raw','sql',`sql_status_${runDt}.json`,`raw_manifest_${runDt}.json`]);
  const active={contract_version:CONTRACT_VERSION,stage:'fetch',status,run_id:runId,run_dt:runDt,target_month:runDt.slice(0,7),raw_cache:path.basename(rawCache),raw_cache_sha256:sha256File(rawCache),sha256:sha256File(rawCache),sql_status:`sql_status_${runDt}.json`,raw_manifest:`raw_manifest_${runDt}.json`,known_gaps:rawManifest.known_gaps,generated_at:new Date().toISOString()};
  writeJson(path.join(outDir,'active_fetch_manifest.json'),active);
  return {ok:status==='success'||status==='warn',active_manifest:active,raw_cache:rawCache,sql_status:sqlStatus,raw_manifest:rawManifest};
 }finally{if(options.keepWorkDir!==true)fs.rmSync(tmp,{recursive:true,force:true});}
}
module.exports={packageRawCache,parseArgs,inspectCsv,sha256File,SCRIPTS};
