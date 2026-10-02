const crypto=require('crypto');
const {Pool}=require('pg');
const model=require('./clinical-model');
const stats=require('./clinical-stats');
const fields=require('./clinical-fields');
const importer=require('./clinical-import');
const safeEqual=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
module.exports=function installClinical(app,pool,databaseUrl,legacyTables){
 if(!process.env.SESSION_SECRET)console.warn('⚠️  SESSION_SECRET absent : la clé de session est dérivée de DATABASE_URL. Définissez SESSION_SECRET (chaîne aléatoire de 32+ caractères).');
 const signingKey=crypto.createHash('sha256').update('clinical-session:'+(process.env.SESSION_SECRET||databaseUrl)).digest();let legacyPool;
 const fail=(message,status=400)=>Object.assign(new Error(message),{status});
 const ready=(async()=>{
  await pool.query(`ALTER TABLE entites ADD COLUMN IF NOT EXISTS code_dhis2 text;
   CREATE TABLE IF NOT EXISTS clinical_reports(code_dhis2 text NOT NULL,mois integer NOT NULL,annee integer NOT NULL,rows_json jsonb NOT NULL DEFAULT '[]',summary_json jsonb,status text NOT NULL DEFAULT 'BROUILLON',revision integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(code_dhis2,mois,annee));
   CREATE TABLE IF NOT EXISTS clinical_options(id integer PRIMARY KEY DEFAULT 1,payload jsonb NOT NULL);`);
  // The legacy SQL endpoint uses a separate login that has no access to patient tables or passwords.
  const role='reporting_legacy_api',pw=crypto.createHmac('sha256',signingKey).update('legacy-db-login').digest('hex');
  await pool.query(`DO $$ BEGIN CREATE ROLE ${role} LOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$; ALTER ROLE ${role} PASSWORD '${pw}'; GRANT USAGE ON SCHEMA public TO ${role};`);
  for(const table of legacyTables){if(['entites','parametres'].includes(table))continue;if(!(await pool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name)continue;await pool.query(`GRANT SELECT ON TABLE public.${table} TO ${role}`);if(['rapports','rapport_stock_details','rapport_indicateurs'].includes(table)){await pool.query(`GRANT INSERT,UPDATE,DELETE ON TABLE public.${table} TO ${role}`);const q=await pool.query('SELECT pg_get_serial_sequence($1,$2) AS seq',[table,'id']);if(q.rows[0]?.seq)await pool.query(`GRANT USAGE,SELECT ON SEQUENCE ${q.rows[0].seq} TO ${role}`);}}
  await pool.query(`GRANT SELECT(id,nom_entite,login,role,code_structure,code_dhis2) ON entites TO ${role}; REVOKE ALL ON clinical_reports,clinical_options FROM PUBLIC,${role};`);
  const url=new URL(databaseUrl);url.username=role;url.password=pw;legacyPool=new Pool({connectionString:url.toString(),ssl:{rejectUnauthorized:false}});
 })();ready.catch(e=>console.error('Clinical initialization failed:',e.message));
 const allowed=s=>s&&s.role==='ADMIN'||s&&s.role==='USER'&&!/ICCM/i.test((s.nom_entite||'')+' '+(s.code_structure||''));
 const actorById=async id=>(await pool.query('SELECT id,nom_entite,role,code_structure,code_dhis2 FROM entites WHERE id=$1',[id])).rows[0];
 const tokenFor=id=>{const payload=Buffer.from(JSON.stringify({id,exp:Date.now()+8*3600*1000})).toString('base64url');return payload+'.'+crypto.createHmac('sha256',signingKey).update(payload).digest('base64url');};
 const route=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await ready;await fn(req,res);}catch(e){if(!e.status)console.error('❌ '+req.method+' '+req.path+' :',e.message);res.status(e.status||500).json({ok:false,error:e.status?e.message:'Opération impossible. Réessayez ou contactez le district.'});}};
 // Route publique volontairement minimale : uniquement de quoi remplir la liste déroulante de la page d'accès.
 app.get('/api/clinical/bootstrap',route(async(_req,res)=>{const ents=await pool.query("SELECT id,nom_entite,role FROM entites WHERE role IN ('ADMIN','USER') AND upper(nom_entite) NOT LIKE '%ICCM%' AND upper(coalesce(code_structure,'')) NOT LIKE '%ICCM%' AND nom_entite NOT ILIKE 'ASC:%' ORDER BY role,nom_entite");res.json({ok:true,structures:ents.rows});}));
 const attempts=new Map(),WINDOW=15*60*1000;
 const throttle=(key,limit)=>{const now=Date.now();let e=attempts.get(key);if(!e||e.until<now)e={count:0,until:now+WINDOW};e.count++;attempts.set(key,e);if(e.count>limit)throw fail('Trop de tentatives. Réessayez dans 15 minutes.',429);};
 setInterval(()=>{const now=Date.now();for(const [k,e] of attempts)if(e.until<now)attempts.delete(k);},10*60*1000).unref();
 app.post('/api/clinical/login',route(async(req,res)=>{const id=Number(req.body?.id),password=req.body?.password;throttle('ip:'+req.ip,60);const key=req.ip+':'+id;throttle(key,10);if(!Number.isInteger(id)||typeof password!=='string'||!password)throw fail('Identifiants incorrects.',401);const q=await pool.query('SELECT * FROM entites WHERE id=$1',[id]);const u=q.rows[0];let valid=allowed(u)&&u.mot_de_passe&&safeEqual(password,u.mot_de_passe);if(u?.role==='ADMIN'){const g=(await pool.query("SELECT valeur FROM parametres WHERE cle='mot_de_passe_global'")).rows[0]?.valeur;if(g)valid ||=safeEqual(password,g);}if(!valid)throw fail('Identifiants incorrects.',401);attempts.delete(key);res.json({ok:true,token:tokenFor(id),user:await actorById(id)});}));
 app.use('/api',async(req,res,next)=>{try{await ready;const token=String(req.headers.authorization||'').replace(/^Bearer /,'');const [p,sig]=token.split('.');if(!p||!safeEqual(sig,crypto.createHmac('sha256',signingKey).update(p).digest('base64url')))throw fail('Connexion requise.',401);let data;try{data=JSON.parse(Buffer.from(p,'base64url'));}catch{throw fail('Session invalide.',401);}if(data.exp<Date.now())throw fail('Session expirée.',401);const actor=await actorById(data.id);if(!allowed(actor))throw fail('Accès refusé.',403);req.clinicalActor=actor;if(!req.path.startsWith('/clinical/')&&req.path!=='/query'&&actor.role!=='ADMIN')throw fail('Accès réservé au district.',403);next();}catch(e){res.status(e.status||503).json({ok:false,error:e.status?e.message:'Service en cours de démarrage.'});}});
 async function scope(req){const requested=String(req.body?.code_dhis2??req.query?.code_dhis2??'').trim(),a=req.clinicalActor;if(a.role!=='ADMIN'&&requested!==String(a.code_dhis2||''))throw fail('Accès limité aux patients de votre structure.',403);const q=await pool.query("SELECT id,nom_entite,role,code_structure,code_dhis2 FROM entites WHERE code_dhis2=$1 AND role='USER' AND upper(nom_entite) NOT LIKE '%ICCM%' AND upper(coalesce(code_structure,'')) NOT LIKE '%ICCM%'",[requested]);if(q.rows.length!==1)throw fail('Structure DHIS2 introuvable ou ambiguë.');return q.rows[0];}
 function period(b){const m=Number(b.mois),y=Number(b.annee);if(!Number.isInteger(m)||m<1||m>12||!Number.isInteger(y)||y<2020||y>2100)throw fail('Période invalide.');return[m,y];}
 async function reports(client,s,m,y){return(await client.query('SELECT * FROM clinical_reports WHERE code_dhis2=$1 AND (annee<$2 OR (annee=$2 AND mois<=$3)) ORDER BY annee,mois',[s.code_dhis2,y,m])).rows;}
 const listStructures=async actor=>actor.role==='ADMIN'?(await pool.query("SELECT id,nom_entite,role,code_structure,code_dhis2 FROM entites WHERE role='USER' AND upper(nom_entite) NOT LIKE '%ICCM%' AND upper(coalesce(code_structure,'')) NOT LIKE '%ICCM%' AND nom_entite NOT ILIKE 'ASC:%' ORDER BY nom_entite")).rows:[actor];
 // Données de session : uniquement après connexion (un ESPC ne reçoit que sa propre structure).
 app.get('/api/clinical/context',route(async(req,res)=>{const a=req.clinicalActor,[structures,params,families]=await Promise.all([listStructures(a),pool.query("SELECT cle,valeur FROM parametres WHERE cle IN ('mois_actif','annee_active','saisie_ouverte')"),pool.query('SELECT * FROM familles ORDER BY nom_famille')]);res.json({ok:true,user:a,structures,params:params.rows,families:families.rows});}));
 // Suivi des validations (ancien tableau de bord public, désormais réservé aux utilisateurs connectés).
 app.get('/api/clinical/tracking',route(async(req,res)=>{
  const [m,y]=period(req.query),a=req.clinicalActor,mine=a.role!=='ADMIN';
  const [structures,families,regular,clinical]=await Promise.all([
   listStructures(a),
   pool.query('SELECT id,nom_famille FROM familles ORDER BY nom_famille'),
   pool.query(`SELECT DISTINCT r.entite_id,COALESCE(r.famille_id,m.famille_id) AS famille_id,r.statut FROM rapports r LEFT JOIN rapport_stock_details d ON d.rapport_id=r.id LEFT JOIN medicaments m ON m.id=d.medicament_id WHERE r.mois=$1 AND r.annee=$2 AND ($3::int IS NULL OR r.entite_id=$3)`,[m,y,mine?a.id:null]),
   pool.query('SELECT code_dhis2,status FROM clinical_reports WHERE mois=$1 AND annee=$2 AND ($3::text IS NULL OR code_dhis2=$3)',[m,y,mine?String(a.code_dhis2||''):null])
  ]);
  res.json({ok:true,mois:m,annee:y,structures:structures.map(s=>({id:s.id,nom_entite:s.nom_entite,code_dhis2:s.code_dhis2})),families:families.rows,reports:regular.rows,clinical:clinical.rows});
 }));
 // Tableau de bord PVVIH : effectifs agrégés par structure et combinés (district). Aucun code patient n'est renvoyé.
 app.get('/api/clinical/dashboard',route(async(req,res)=>{
  const [m,y]=period(req.query),a=req.clinicalActor,structures=await listStructures(a),codes=structures.map(s=>s.code_dhis2).filter(Boolean).map(String);
  const reports=codes.length?(await pool.query('SELECT code_dhis2,mois,annee,rows_json,status FROM clinical_reports WHERE code_dhis2=ANY($1::text[]) AND (annee<$2 OR (annee=$2 AND mois<=$3))',[codes,y,m])).rows:[];
  res.json({ok:true,scope:a.role==='ADMIN'?'district':'structure',...stats.build({structures,reports,m,y})});
 }));
 app.post('/api/clinical/view',route(async(req,res)=>{const s=await scope(req),[m,y]=period(req.body),rs=await reports(pool,s,m,y),report=rs.find(r=>r.mois===m&&r.annee===y),opts=(await pool.query('SELECT payload FROM clinical_options WHERE id=1')).rows[0]?.payload||{};res.json({ok:true,structure:s,rows:report?.rows_json||[],patients:model.snapshot(rs,m,y),revision:report?.revision||0,status:report?.status||'NON SAISI',agenda:model.agenda(rs,m,y),issues:(report?.rows_json||[]).map(row=>({row,reasons:model.issues(row,m,y)})).filter(r=>r.reasons.length),summary:model.summary(rs,m,y,s,report?.status||'NON SAISI'),options:opts});}));
 app.post('/api/clinical/lookup',route(async(req,res)=>{const s=await scope(req),[m,y]=period(req.body),rs=await reports(pool,s,m,y),row=model.snapshot(rs,m,y).find(r=>r.patient_code===String(req.body.patient_code||'').trim());if(!row)throw fail('Patient introuvable dans votre structure.',404);res.json({ok:true,row,revision:rs.find(r=>r.mois===m&&r.annee===y)?.revision||0});}));
 async function mutate(req,fn){const s=await scope(req),[m,y]=period(req.body),c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[s.code_dhis2]);await c.query('SELECT pg_advisory_xact_lock(hashtext($1),$2)',[s.code_dhis2,y*100+m]);let rs=await reports(c,s,m,y);let target=rs.find(r=>r.mois===m&&r.annee===y);if(Number(req.body.revision)!==Number(target?.revision||0))throw fail('Les données ont changé. Rechargez la page.',409);if(!target){target={code_dhis2:s.code_dhis2,mois:m,annee:y,rows_json:[],revision:0,status:'BROUILLON'};rs.push(target);}await fn(target,rs,s,m,y);const sum=model.summary(rs,m,y,s,target.status);const saved=await c.query('INSERT INTO clinical_reports(code_dhis2,mois,annee,rows_json,summary_json,status,revision) VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(code_dhis2,mois,annee) DO UPDATE SET rows_json=EXCLUDED.rows_json,summary_json=EXCLUDED.summary_json,status=EXCLUDED.status,revision=clinical_reports.revision+1,updated_at=now() RETURNING revision',[s.code_dhis2,m,y,JSON.stringify(target.rows_json),JSON.stringify(sum),target.status]);await c.query('COMMIT');return saved.rows[0];}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 app.post('/api/clinical/visit',route(async(req,res)=>{const out=await mutate(req,async(t,rs,s,m,y)=>{const code=String(req.body.patient_code||'').trim(),old=model.snapshot(rs,m,y).find(r=>r.patient_code===code);if(!old)throw fail('Patient introuvable.',404);const date=String(req.body.derniere_dispensation||''),days=Number(req.body.jours_dispenses);if(!date.startsWith(`${y}-${String(m).padStart(2,'0')}-`)||!model.due({derniere_dispensation:date,jours_dispenses:days}))throw fail('Date ou durée invalide pour le mois choisi.');if(['deces','transfert_out','arret_tarv','perdu_vue'].some(k=>model.truth(old[k])))throw fail('Corrigez le statut de sortie avant la prise.');const i=t.rows_json.findIndex(r=>r.patient_code===code),row={...old,derniere_dispensation:date,jours_dispenses:days,updated_at:new Date().toISOString(),mois:m,annee:y};if(i<0){for(const k of ['nouvelle_inclusion','transfert_in','retour_soins'])row[k]=false;t.rows_json.push(row);}else t.rows_json[i]=row;t.status='BROUILLON';});res.json({ok:true,...out});}));
 app.post('/api/clinical/edit',route(async(req,res)=>{
  const opts=(await pool.query('SELECT payload FROM clinical_options WHERE id=1')).rows[0]?.payload||{};
  const out=await mutate(req,async(t,rs,s,m,y)=>{
   const code=String(req.body.original_code||'').trim(),old=model.snapshot(rs,m,y).find(r=>r.patient_code===code);
   if(!old)throw fail('Patient introuvable.',404);
   const i=t.rows_json.findIndex(r=>r.patient_code===code),baseline={...old};
   if(i<0)for(const k of ['nouvelle_inclusion','transfert_in','retour_soins'])baseline[k]='0';
   let row;try{row=fields.normalize(req.body.row,baseline,opts,m,y);}catch(e){throw fail(e.message);}
   row={...row,code_dhis2:s.code_dhis2,mois:m,annee:y,updated_at:new Date().toISOString()};
   if(i<0)t.rows_json.push(row);else t.rows_json[i]=row;
   t.status='BROUILLON';
  });res.json({ok:true,...out});
 }));
 app.post('/api/clinical/create',route(async(req,res)=>{
  const opts=(await pool.query('SELECT payload FROM clinical_options WHERE id=1')).rows[0]?.payload||{};
  const out=await mutate(req,async(t,rs,s,m,y)=>{
   let row;try{row=fields.normalize(req.body.row,null,opts,m,y,true);}catch(e){throw fail(e.message);}
   const exists=await pool.query("SELECT 1 FROM clinical_reports WHERE code_dhis2=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(rows_json) p WHERE p->>'patient_code'=$2) LIMIT 1",[s.code_dhis2,row.patient_code]);
   if(exists.rows.length)throw fail('Ce code patient existe déjà dans cette structure. Utilisez Modifier.',409);
   const issues=model.issues(row,m,y);if(issues.length)throw fail(issues.join(' ; '));
   t.rows_json.push({...row,code_dhis2:s.code_dhis2,mois:m,annee:y,updated_at:new Date().toISOString()});t.status='BROUILLON';
  });res.json({ok:true,...out});
 }));
 app.post('/api/clinical/validate',route(async(req,res)=>{const out=await mutate(req,async(t,_rs,_s,m,y)=>{if(!t.rows_json.length)throw fail('Aucun patient enregistré.');if(t.rows_json.some(r=>model.issues(r,m,y).length))throw fail('Corrigez les fiches signalées avant validation.');t.status='VALIDE';});res.json({ok:true,...out});}));
function evaluateImport(rawRows,known,monthlyRows,opts,m,y){
  const byCode=new Map(known.map(r=>[String(r.patient_code),r])),monthlySet=new Set(monthlyRows.map(r=>r.patient_code));
  const seen=new Set(),ready=[],errors=[];
  for(const {excelRow,raw} of rawRows){
   const {code,input}=importer.coerceRow(raw,opts);
   if(!code){errors.push({excelRow,code:'',reason:'Code patient manquant.'});continue;}
   if(seen.has(code)){errors.push({excelRow,code,reason:'Code patient en double dans le fichier : ligne ignorée.'});continue;}
   seen.add(code);
   const old=byCode.get(code)||null,isNew=!old;
   const baseline=old?{...old}:null;if(baseline&&!monthlySet.has(code))for(const k of ['nouvelle_inclusion','transfert_in','retour_soins'])baseline[k]='0';
   let row;try{row=fields.normalize({...input,patient_code:code},baseline,opts,m,y,isNew);}catch(e){errors.push({excelRow,code,reason:e.message});continue;}
   if(isNew){const issues=model.issues(row,m,y);if(issues.length){errors.push({excelRow,code,reason:issues.join(' ; ')});continue;}}
   ready.push({code,row});
  }
  return {ready,errors};
 }
 // Modèle Excel à compléter, puis liste actuelle (pour mise à jour) : mêmes colonnes, pour l'import en lot.
 app.get('/api/clinical/import/template',route(async(req,res)=>{const s=await scope(req),[m,y]=period(req.query),buf=await importer.buildWorkbook({structure:s,mois:m,annee:y,mode:'template'});res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.set('Content-Disposition',`attachment; filename="modele-dispensation-${s.code_structure||s.id}.xlsx"`);res.send(buf);}));
 app.get('/api/clinical/import/export',route(async(req,res)=>{const s=await scope(req),[m,y]=period(req.query),rs=await reports(pool,s,m,y),rows=model.snapshot(rs,m,y),buf=await importer.buildWorkbook({structure:s,mois:m,annee:y,mode:'export',rows});res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.set('Content-Disposition',`attachment; filename="dispensation-${s.code_structure||s.id}-${y}-${String(m).padStart(2,'0')}.xlsx"`);res.send(buf);}));
 // Import en lot : mode aperçu (commit=false, aucune écriture) puis import réel (commit=true), par lots de 8 Mo maximum.
 app.post('/api/clinical/import',route(async(req,res)=>{
  const opts=(await pool.query('SELECT payload FROM clinical_options WHERE id=1')).rows[0]?.payload||{};
  let buffer;try{buffer=Buffer.from(String(req.body.file_base64||''),'base64');}catch{buffer=Buffer.alloc(0);}
  if(!buffer.length||buffer.length>8*1024*1024)throw fail('Fichier manquant ou trop volumineux (8 Mo maximum).');
  let parsed;try{parsed=await importer.parseWorkbook(buffer);}catch(e){throw fail(e.message);}
  if(!parsed.rows.length)throw fail('Aucune ligne de données trouvée dans le fichier.');
  if(!req.body.commit){
   const s=await scope(req),[m,y]=period(req.body),rs=await reports(pool,s,m,y),known=model.snapshot(rs,m,y),monthly=rs.find(r=>r.mois===m&&r.annee===y)?.rows_json||[];
   const {ready,errors}=evaluateImport(parsed.rows,known,monthly,opts,m,y);
   res.json({ok:true,commit:false,total:parsed.rows.length,valid:ready.length,errors:errors.slice(0,500),missingColumns:parsed.missingColumns});return;
  }
  let report;
  const out=await mutate(req,async(t,rs,s,m,y)=>{
   const known=model.snapshot(rs,m,y),monthly=t.rows_json;
   const {ready,errors}=evaluateImport(parsed.rows,known,monthly,opts,m,y);
   if(!ready.length)throw fail('Aucune fiche valide dans le fichier. Corrigez les erreurs puis réessayez.');
   for(const {code,row} of ready){const finalRow={...row,code_dhis2:s.code_dhis2,mois:m,annee:y,updated_at:new Date().toISOString()};const i=t.rows_json.findIndex(r=>r.patient_code===code);if(i<0)t.rows_json.push(finalRow);else t.rows_json[i]=finalRow;}
   t.status='BROUILLON';report={imported:ready.length,errors};
  });
  res.json({ok:true,commit:true,...out,imported:report.imported,skipped:report.errors.length,errors:report.errors.slice(0,500)});
 }));
 app.get('/api/clinical/statuses',route(async(req,res)=>{if(req.clinicalActor.role!=='ADMIN')throw fail('Accès district requis.',403);const [m,y]=period(req.query);res.json({ok:true,rows:(await pool.query('SELECT code_dhis2,status,revision FROM clinical_reports WHERE mois=$1 AND annee=$2',[m,y])).rows});}));
 app.post('/api/clinical/sync',route(async(req,res)=>{if(req.clinicalActor.role!=='ADMIN')throw fail('Accès district requis.',403);const {structures=[],records=[],options}=req.body;if(!Array.isArray(records)||records.length>50)throw fail('Lot trop volumineux.');const c=await pool.connect();try{await c.query('BEGIN');for(const s of structures){if(!s.code_dhis2||/ICCM/i.test(s.code_structure))continue;const q=await c.query('SELECT id FROM entites WHERE code_structure=$1 AND role=$2',[s.code_structure,'USER']);if(q.rows.length!==1)throw fail('Structure non résolue : '+s.code_structure);await c.query('UPDATE entites SET code_dhis2=$1 WHERE id=$2',[s.code_dhis2,q.rows[0].id]);}if(options)await c.query('INSERT INTO clinical_options(id,payload) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload',[JSON.stringify(options)]);const result=[];for(const r of records){const [m,y]=period(r),dhis=String(r.code_dhis2);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[dhis]);if(!Array.isArray(r.rows)||r.rows.some(x=>String(x.code_dhis2)!==dhis))throw fail('Rattachement DHIS2 invalide.');if(new Set(r.rows.map(x=>x.patient_code)).size!==r.rows.length)throw fail('Doublons dans le lot.');await c.query('SELECT pg_advisory_xact_lock(hashtext($1),$2)',[dhis,y*100+m]);const old=(await c.query('SELECT revision FROM clinical_reports WHERE code_dhis2=$1 AND mois=$2 AND annee=$3',[dhis,m,y])).rows[0];if(Number(old?.revision||0)!==Number(r.base_revision||0))throw fail('Conflit de synchronisation : '+dhis+' '+y+'-'+m,409);const q=await c.query('INSERT INTO clinical_reports(code_dhis2,mois,annee,rows_json,summary_json,status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(code_dhis2,mois,annee) DO UPDATE SET rows_json=EXCLUDED.rows_json,summary_json=EXCLUDED.summary_json,status=EXCLUDED.status,revision=clinical_reports.revision+1,updated_at=now() RETURNING revision',[dhis,m,y,JSON.stringify(r.rows),JSON.stringify(r.summary||null),r.status||'BROUILLON']);result.push({code_dhis2:dhis,mois:m,annee:y,revision:q.rows[0].revision});}await c.query('COMMIT');res.json({ok:true,records:result});}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}));
 app.get('/api/clinical/sync/export',route(async(req,res)=>{if(req.clinicalActor.role!=='ADMIN')throw fail('Accès district requis.',403);const after=Number(req.query.offset||0);res.json({ok:true,records:(await pool.query('SELECT * FROM clinical_reports ORDER BY code_dhis2,annee,mois LIMIT 30 OFFSET $1',[after])).rows});}));
 return {ready,query:async(req,sql,params)=>{await ready;if(req.clinicalActor.role==='ADMIN')return pool.query(sql,params);if(/^\s*SELECT\s+cle\s*,\s*valeur\s+FROM\s+parametres\s*;?\s*$/i.test(sql))return pool.query("SELECT cle,valeur FROM parametres WHERE cle IN ('mois_actif','annee_active','saisie_ouverte')");return legacyPool.query(sql,params);}};
};
