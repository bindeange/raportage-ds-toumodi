const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {saveReport} = require('./report-save');
const actor = {id: 2, role: 'USER'};
const payload = () => ({entite_id: 2, famille_id: 1, mois: 11, annee: 2026,
 stocks: [{medicament_id: 7, stock_initial: 10, quantite_recue: 5, quantite_distribuee: 3, pertes_ajustements: 0, stock_disponible: 12, commentaire: null}],
 indicateurs: [{indicateur_id: 8, val_unique: 3, val_nouvelle: 0, val_ancienne: 0}]});
function database({failIndicator=false,status=null,month='11',foreignLine=false}={}) {
 const db={old:'previous data',report:null}, log=[]; let draft;
 const client={async query(sql,p=[]) {
  log.push(sql);
  if(sql==='BEGIN') {draft=structuredClone(db);return {rows:[]};}
  if(sql==='COMMIT'){Object.assign(db,draft);return {rows:[]};}
  if(sql==='ROLLBACK'){draft=null;return {rows:[]};}
  if(sql.startsWith('SELECT id FROM entites')||sql.startsWith('SELECT id FROM familles'))return {rows:[{id:1}]};
  if(sql.startsWith('SELECT cle,valeur'))return {rows:[{cle:'mois_actif',valeur:month},{cle:'annee_active',valeur:'2026'}]};
  if(sql.startsWith('SELECT statut'))return {rows:status?[{statut:status}]:[]};
  if(sql.includes('id=ANY'))return {rows:foreignLine?[]:p[1].map(id=>({id}))};
  if(sql.startsWith('INSERT INTO rapports')){draft.report=9;return {rows:[{id:9}]};}
  if(sql.startsWith('DELETE')){draft.old=null;return {rows:[]};}
  if(sql.startsWith('INSERT INTO rapport_indicateurs')&&failIndicator)throw Object.assign(Error('simulated indicator failure'),{code:'22P02'});
  return {rows:[],rowCount:1};
 },release(){log.push('release');}};
 return {db,log,connect:async()=>client};
}
test('all report lines commit together and confirmation includes the saved counts',async()=>{
 const p=database();assert.deepEqual(await saveReport(p,actor,payload()),{ok:true,rapport_id:9,stocks:1,indicateurs:1});
 assert.equal(p.db.report,9);assert.equal(p.db.old,null);assert.deepEqual(p.log.slice(-2),['COMMIT','release']);
});
test('indicator failure rolls back stocks, header and deletion, with no success',async()=>{
 const p=database({failIndicator:true});await assert.rejects(saveReport(p,actor,payload()),/simulated/);
 assert.deepEqual(p.db,{old:'previous data',report:null});assert.ok(!p.log.includes('COMMIT'));assert.deepEqual(p.log.slice(-2),['ROLLBACK','release']);
});
test('other structure is denied before opening a connection',async()=>{
 const p=database();await assert.rejects(saveReport(p,{id:3,role:'USER'},payload()),e=>e.status===403);assert.equal(p.log.length,0);
});
test('locked reports, changed period and foreign family lines leave previous report intact',async()=>{
 for(const options of [{status:'TRANSMIS'},{month:'10'},{foreignLine:true}]){
  const p=database(options);await assert.rejects(saveReport(p,actor,payload()));assert.equal(p.db.old,'previous data');assert.ok(!p.log.some(q=>q.startsWith('DELETE')));
 }
});
test('district can correct a transmitted report',async()=>{
 const p=database({status:'TRANSMIS'});assert.equal((await saveReport(p,{id:1,role:'ADMIN'},payload())).ok,true);
});
test('duplicate and invalid lines cannot clear an old report',async()=>{
 for(const change of [b=>b.stocks.push(b.stocks[0]),b=>b.stocks[0].stock_disponible=999,b=>b.stocks[0].quantite_recue=NaN,b=>b.indicateurs[0].val_unique=-1]){
  const p=database(),b=payload();change(b);await assert.rejects(saveReport(p,actor,b));assert.equal(p.log.length,0);
 }
});
// Exercise the actual browser save function with a refused server response.
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const saveSource=html.slice(html.indexOf('async function saveData()'),html.indexOf('\ninit();',html.indexOf('async function saveData()')));
test('browser never shows success or navigates away on refusal, timeout or incomplete confirmation',async()=>{
 for(const kind of ['refused','timeout','partial','success']){
  const alerts=[],button={disabled:false},loaded=[];let navigated=false;
  const ctx={currentReadOnly:false,currentMeds:[],currentIndics:[],currentReportUser:null,user:{id:2},currentReportM:null,currentReportA:null,currentM:11,currentA:2026,currentFamilleId:1,
   document:{getElementById:()=>button,querySelectorAll:()=>[]},confirm:()=>true,loader:v=>loaded.push(v),isDistrict:()=>false,
   window:{clinicalToken:'test-token'},alert:m=>alerts.push(m),console:{error(){}},sessionExpired(){},showHome(){navigated=true;},
   fetch:async()=>{if(kind==='timeout')throw Error('network lost');return {ok:kind!=='refused',status:kind==='refused'?500:200,json:async()=>kind==='refused'?{error:'write refused'}:{ok:true,rapport_id:9,stocks:kind==='partial'?1:0,indicateurs:0}};}
  };
  vm.createContext(ctx);vm.runInContext(saveSource,ctx);await ctx.saveData();
  assert.equal(navigated,kind==='success');assert.equal(alerts.some(s=>s.includes('succes')),kind==='success');assert.equal(button.disabled,false);assert.equal(loaded.at(-1),false);
 }
});
