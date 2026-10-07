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
test('Transfert sortant : délai de grâce jusqu’à la fin du traitement en cours, décès immédiat',()=>{
 const today='2026-09-20';
 const couvert={file_active:'1',transfert_out:'1',derniere_dispensation:'2026-09-01',jours_dispenses:'90'};
 assert.equal(F.active(couvert,today),true);assert.equal(F.status(couvert,today),'Actif');
 const expire={file_active:'1',transfert_out:'1',derniere_dispensation:'2026-01-01',jours_dispenses:'30'};
 assert.equal(F.active(expire,today),false);assert.equal(F.status(expire,today),'Transfert sortant (traitement terminé)');
 const deces={file_active:'1',deces:'1',derniere_dispensation:'2026-09-01',jours_dispenses:'90'};
 assert.equal(F.active(deces,today),false);assert.equal(F.status(deces,today),'Décès');
});
test('« Perdu de vue » calculé : rendez-vous dépassé sans nouvelle dispensation',()=>{
 const today='2026-09-20';
 assert.equal(F.overdue({derniere_dispensation:'2026-01-01',jours_dispenses:'30'},today),true);
 assert.equal(F.overdue({derniere_dispensation:'2026-09-01',jours_dispenses:'90'},today),false);
 assert.equal(F.overdue({derniere_dispensation:'2026-09-01',jours_dispenses:'90',deces:'1'},today),false);
 assert.equal(F.overdue({patient_code:'AES',derniere_dispensation:'2026-01-01',jours_dispenses:'30'},today),false);
});
test('Format du code patient : motif valide, deux lettres ou deux chiffres, codes spéciaux',()=>{
 assert.equal(F.codeFormatOk('22325/56/78/90123'),true);
 assert.equal(F.codeFormatOk('25325/D4/32/10987'),true);
 assert.equal(F.codeFormatOk('25325/d4/32/10987'),true);
 assert.equal(F.codeFormatOk('aes'),true);assert.equal(F.codeFormatOk('MOBILE'),true);
 assert.equal(F.codeFormatOk('12345'),false);assert.equal(F.codeFormatOk('22325/567/78/90123'),false);assert.equal(F.codeFormatOk(''),false);
 assert.equal(F.isSpecialCode('aes'),true);assert.equal(F.isSpecialCode('AES2'),false);
});
test('normalize() : code hors format accepté mais marqué en erreur (code_ok), jamais rejeté pour ce seul motif',()=>{
 const r=F.normalize({...row,patient_code:'12345'},null,options,9,2026,true);
 assert.equal(r.patient_code,'12345');assert.equal(r.code_ok,'0');
 const ok=F.normalize({...row,patient_code:'22325/56/78/90123'},null,options,9,2026,true);assert.equal(ok.code_ok,'1');
});
test('normalize() : codes spéciaux AES / MOBILE — hors file active, champs minimaux, flags auto',()=>{
 const aes=F.normalize({patient_code:'aes',derniere_dispensation:'2026-09-10'},null,{},9,2026,true);
 assert.equal(aes.patient_code,'AES');assert.equal(aes.file_active,'0');assert.equal(aes.nouvelle_inclusion,'0');assert.equal(aes.cas_aes,'1');assert.equal(aes.code_ok,'1');
 assert.equal(F.active(aes),false);
 const mobile=F.normalize({patient_code:'MOBILE'},null,{},9,2026,true);
 assert.equal(mobile.patient_mobile,'1');assert.equal(mobile.file_active,'0');
 assert.equal(M.issues(aes,9,2026).length,0); // pas de champs obligatoires pour un code spécial
});
test('Tableau croisé : dimension « mouvement » (nouvelle inclusion, décès, transfert out)',()=>{
 assert.equal(F.dimension({nouvelle_inclusion:'1'},'mouvement'),'Nouvelle inclusion');
 assert.equal(F.dimension({deces:'1'},'mouvement'),'Décès');
 assert.equal(F.dimension({transfert_out:'1'},'mouvement'),'Transfert out');
 assert.equal(F.dimension({},'mouvement'),'Aucun mouvement signalé');
});
test('model.snapshot() : les codes spéciaux ne sont jamais reportés d’un mois sur l’autre',()=>{
 const reports=[{mois:8,annee:2026,rows_json:[{...row,patient_code:'AES'},{...row,patient_code:'P1'}]}];
 const snap=M.snapshot(reports,9,2026);
 assert.ok(!snap.some(r=>r.patient_code==='AES'));
 assert.ok(snap.some(r=>r.patient_code==='P1'));
});
test('model.agenda() : les codes spéciaux ne génèrent jamais de rendez-vous',()=>{
 const reports=[{mois:9,annee:2026,rows_json:[{...row,patient_code:'AES',derniere_dispensation:'2026-09-01',jours_dispenses:'30'}]}];
 assert.deepEqual(M.agenda(reports,9,2026),[]);
});
test('Code « enfant de » : suffixe e/E accepté, code de la mère retrouvé',()=>{
 assert.equal(F.codeFormatOk('22325/56/78/90123e'),true);
 assert.equal(F.codeFormatOk('25325/d4/32/10987E'),true);
 assert.equal(F.motherCode('22325/56/78/90123e'),'22325/56/78/90123');
 assert.equal(F.motherCode('22325/56/78/90123'),null);
 assert.equal(F.motherCode('AES'),null);
 const r=F.normalize({...row,patient_code:'22325/56/78/90123e'},null,options,9,2026,true);
 assert.equal(r.code_ok,'1');assert.equal(r.patient_code,'22325/56/78/90123e');
});
test('Enfant « e+numéro » (prophylaxie) : hors file active comme AES/MOBILE, mais code unique et suivi normalement',()=>{
 const today='2026-09-20';
 const proph={...row,patient_code:'22325/56/78/90123e1',derniere_dispensation:'2026-09-01',jours_dispenses:'90'};
 assert.equal(F.active(proph,today),false);assert.equal(F.status(proph,today),'Prophylaxie (enfant, hors file active)');
 assert.equal(F.codeFormatOk('22325/56/78/90123e1'),true);
 assert.equal(F.isProphylaxisChild('22325/56/78/90123e1'),true);
 assert.equal(F.isSpecialCode('22325/56/78/90123e1'),false); // reste un code unique, pas répétable comme AES/MOBILE
 for(let n=1;n<=10;n++)assert.equal(F.isProphylaxisChild(`22325/56/78/90123e${n}`),true);
 assert.equal(F.isProphylaxisChild('22325/56/78/90123e11'),false);
});
test('Enfant « e » seul (sans chiffre) : sous trithérapie, compté normalement dans la file active',()=>{
 const tri={...row,file_active:'1',patient_code:'22325/56/78/90123e',derniere_dispensation:'2026-09-01',jours_dispenses:'90'};
 assert.equal(F.active(tri,'2026-09-20'),true);assert.equal(F.status(tri,'2026-09-20'),'Actif');
 assert.equal(F.isProphylaxisChild(tri.patient_code),false);
 assert.equal(F.motherCode(tri.patient_code),'22325/56/78/90123');
});
test('model.js : enfant sous prophylaxie exclu des rendez-vous, mais conservé dans le suivi mensuel (snapshot)',()=>{
 const reports=[{mois:9,annee:2026,rows_json:[{...row,patient_code:'22325/56/78/90123e2',derniere_dispensation:'2026-09-01',jours_dispenses:'30'}]}];
 assert.deepEqual(M.agenda(reports,9,2026),[]);
 const snap=M.snapshot(reports,9,2026);
 assert.ok(snap.some(r=>r.patient_code==='22325/56/78/90123e2')); // suivi comme un patient normal, contrairement à AES/MOBILE
});
