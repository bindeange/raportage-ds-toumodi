const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const source = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const loading = source('async function startSaisie(', '\nfunction isIndicatorLinked');
function context(responses, {fail=false, admin=true}={}) {
    const nodes = new Map(), alerts = [], requests = [], loaders = [];
    const get = id => {
        if (!nodes.has(id)) nodes.set(id, {innerHTML:'', innerText:'', disabled:false, classList:{add(){},toggle(){},remove(){}}});
        return nodes.get(id);
    };
    let count = 0;
    const ctx = {document:{getElementById:get,querySelectorAll:()=>[]},
        user:{id:2,nom_entite:'ESPC',code_structure:'A'},districtSelectedEntite:null,currentM:11,currentA:2026,
        isDistrict:()=>admin,isLockedReportStatus:s=>['TRANSMIS','Validé'].includes(s),
        getPreviousPeriod:()=>({mois:10,annee:2026}),loader:v=>loaders.push(v),alert:s=>alerts.push(s),
        isIndicatorLinked:()=>false,updateIndicatorVisibility(){},showRequisitionReferences(){},
        neonQuery:async(sql,params,options)=>{requests.push({sql,params,options});if(fail)throw Error('lecture refusée');return responses[count++];}
    };
    vm.createContext(ctx);vm.runInContext(source('function htmlEscape(', '\nfunction '),ctx);vm.runInContext(loading,ctx);
    return {ctx,get,alerts,requests,loaders};
}
const rows = () => [
    [{id:7,dci:'Produit',unite_comptage:'comprimés'}], [{id:8,nom_indicateur:'Indicateur',est_pnsme:false}], [],
    [{medicament_id:7,stock_disponible:10}],
    [{medicament_id:7,stock_initial:50,quantite_recue:7,quantite_distribuee:3,perte:2,ajustement:2,stock_disponible:54,
        justification_perte:'Casse',justification_ajustement:'Comptage "A"'}],
    [{indicateur_id:8,val_unique:5,val_nouvelle:0,val_ancienne:0}],
    [{medicament_id:7,total_livre:99}], [{id:12,statut:'TRANSMIS'}]
];
test('reopening a report displays its saved opening stock, received quantity and indicators',async()=>{
    const c=context(rows());await c.ctx.startSaisie(1,'PNLS');
    const body=c.get('med-body').innerHTML;
    assert.match(body,/id="st_7">50</);
    assert.match(body,/id="rec_7" value="7"/);
    assert.match(body,/id="disp_7" value="54"/);
    assert.match(body,/id="pert_7" value="2"/);
    assert.match(body,/id="ajust_7" value="2"/);
    assert.match(body,/id="reason_pert_7" value="Casse"/);
    assert.match(body,/id="reason_ajust_7" value="Comptage &quot;A&quot;"/);
    assert.match(c.get('indic-body').innerHTML,/id="ind_u_8" value="5"/);
    assert.match(c.get('form-title').innerText,/Modification du rapport existant/);
    assert.equal(c.get('save-btn').disabled,false);
    assert.ok(c.requests.every(r=>r.options.strict));
});
test('a reopened editable report keeps the saved quantity rather than overwriting it with planned deliveries',async()=>{
    const r=rows();r[7]=[{id:12,statut:'REOUVERT'}];
    const c=context(r,{admin:false});await c.ctx.startSaisie(1,'PNLS');
    assert.match(c.get('med-body').innerHTML,/id="rec_7" value="7"/);
    assert.match(c.get('form-title').innerText,/Reprise du rapport enregistré/);
});
test('a failed load blocks saving and clears stale report fields',async()=>{
    const c=context([],{fail:true});c.get('med-body').innerHTML='stale';
    await c.ctx.startSaisie(1,'PNLS');
    assert.equal(c.get('save-btn').disabled,true);assert.equal(c.get('med-body').innerHTML,'');
    assert.match(c.get('form-title').innerText,/enregistrement bloqué/);
    assert.equal(c.alerts.length,1);assert.equal(c.loaders.at(-1),false);
});
test('the strict reader distinguishes server failure from an actually empty result',async()=>{
    const s=source('async function neonQuery(', '\nfunction loader(');
    for (const kind of ['server','network','invalid','empty']) {
        const ctx={API_URL:'/api/query',window:{clinicalToken:'test'},sessionExpired(){},console:{error(){}},
            fetch:async()=>{if(kind==='network')throw Error('network');return {ok:kind!=='server',status:kind==='server'?500:200,json:async()=>kind==='server'?{error:'refused'}:kind==='invalid'?{}:{rows:[]}};}};
        vm.createContext(ctx);vm.runInContext(s,ctx);
        if(kind==='empty') assert.equal((await ctx.neonQuery('SELECT 1',[],{strict:true})).length,0);
        else await assert.rejects(ctx.neonQuery('SELECT 1',[],{strict:true}));
    }
});
test('a failed status lookup never offers a new report as A SAISIR',async()=>{
    const c=context([],{fail:true,admin:false});
    vm.runInContext(source('async function showHome()', '\nasync function viewAscReport'),c.ctx);
    c.ctx.setNav=()=>{};
    await c.ctx.showHome();
    assert.match(c.get('home-body').innerHTML,/Chargement impossible/);
    assert.doesNotMatch(c.get('home-body').innerHTML,/A SAISIR|startSaisie/);
});
