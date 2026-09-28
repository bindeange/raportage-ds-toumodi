const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./clinical-fields'),M=require('./clinical-model');
const options={sexe:[{value:'F',active:true}],regime:[{value:'TDF/3TC/DTG',active:true}],type_vih:[{value:'VIH1',active:true}],ligne_therapeutique:[{value:'1',active:true}]};
const row={patient_code:'TEST-1',sexe:'F',age:'24',poids:'52',regime:'TDF/3TC/DTG',type_vih:'VIH1',ligne_therapeutique:'1',derniere_dispensation:'2026-09-05',jours_dispenses:'30'};
test('Inclusion complète : active, nouvelle, sans mouvement de sortie',()=>{const r=F.normalize({...row,deces:true},null,options,9,2026,true);assert.equal(r.deces,'0');assert.equal(r.nouvelle_inclusion,'1');assert.ok(F.active(r));assert.deepEqual(M.issues(r,9,2026),[]);});
test('Dates, champs obligatoires et options contrôlés',()=>{for(const change of [{age:-1},{poids:''},{derniere_dispensation:'2026-02-30'},{derniere_dispensation:'2026-10-01'},{jours_dispenses:1.5},{regime:'FAUX'},{patient_code:''}])assert.throws(()=>F.normalize({...row,...change},null,options,9,2026,true));});
test('Identité stable et anciennes options préservées',()=>{assert.throws(()=>F.normalize({patient_code:'OTHER'},row,options,9,2026));assert.equal(F.normalize({}, {...row,regime:'Ancien régime'},options,9,2026).regime,'Ancien régime');});
test('Croisements : chaque patient est compté une fois, âges manquants séparés',()=>{const p=F.pivot([{regime:'A',sexe:'F',age:14},{regime:'A',sexe:'H',age:20},{regime:'B',sexe:'M',age:null}],['regime','age_group'],'sexe');assert.equal(p.total,3);assert.equal(p.rows.reduce((s,r)=>s+r.total,0),3);assert.equal(p.rows.length,3);assert.deepEqual(p.columns,['Féminin','Masculin']);assert.ok(p.rows.some(r=>r.labels.includes('Non renseigné')));});
test('Sorties exclues de la file active',()=>{assert.equal(F.active({file_active:'1',deces:'1'}),false);assert.equal(F.active({file_active:'1',transfert_out:true}),false);assert.equal(F.active({file_active:'1'}),true);});
test('Tranches d’âge : toute la population est couverte, sans seuil unique',()=>{
 const g=a=>F.dimension({age:a},'age_group'),c=a=>F.dimension({age:a},'age_class');
 assert.equal(g(0.5),'<1 an');assert.equal(g(3),'1–4 ans');assert.equal(g(14),'10–14 ans');assert.equal(g(15),'15–19 ans');assert.equal(g(64),'60–64 ans');assert.equal(g(65),'65 ans et +');assert.equal(g(101),'65 ans et +');
 assert.equal(g(''),'Non renseigné');assert.equal(g(null),'Non renseigné');assert.equal(g('abc'),'Non renseigné');
 assert.equal(c(14),'Enfants (< 15 ans)');assert.equal(c(15),'Adultes (≥ 15 ans)');assert.equal(c(undefined),'Non renseigné');
 for(let age=0;age<=130;age+=0.5)assert.ok(F.ageBandIndex(age)>=0,'âge non classé : '+age);
});
test('Tableau croisé : les tranches d’âge restent dans l’ordre des âges',()=>{
 const rows=[70,2,30,12,0.4,17,null].map((age,i)=>({regime:'A',sexe:i%2?'F':'M',age}));
 const p=F.pivot(rows,['age_group'],'sexe');
 assert.deepEqual(p.rows.map(r=>r.labels[0]),['<1 an','1–4 ans','10–14 ans','15–19 ans','30–34 ans','65 ans et +','Non renseigné']);
 assert.equal(p.rows.reduce((s,r)=>s+r.total,0),7);
});
