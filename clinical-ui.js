(function(){
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),F=window.ClinicalFields;
 const api=async(path,body,method='POST')=>{const r=await fetch('/api/clinical/'+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.clinicalToken},body:method==='GET'?undefined:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(r.status===401&&window.sessionExpired)window.sessionExpired();if(!r.ok||!j.ok)throw Error(j.error||'Opération impossible.');return j;};
 window.clinicalStatuses=async(m,y)=>{if(typeof user==='undefined'||user?.role!=='ADMIN')return{};const j=await api(`statuses?mois=${m}&annee=${y}`,{},'GET');return Object.fromEntries(j.rows.map(x=>[x.code_dhis2,x]));};
 window.clinicalStatusCell=(s,map)=>'<td>'+(!s.code_dhis2?'—':!map[s.code_dhis2]?'Non saisie':map[s.code_dhis2].status==='VALIDE'?'Validée':'Brouillon')+'</td>';
 let state=null,sequence=0,page=0,pendingImport=null,actorRef=null;
 const refDateFor=(m,y)=>{const monthEnd=new Date(Date.UTC(y,m,0)).toISOString().slice(0,10),today=new Date().toISOString().slice(0,10);return today<monthEnd?today:monthEnd;};
 const fileToBase64=file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(Error('Lecture du fichier impossible.'));r.readAsDataURL(file);});
 async function downloadFile(path,filename){const r=await fetch('/api/clinical/'+path,{headers:{Authorization:'Bearer '+window.clinicalToken}});if(r.status===401&&window.sessionExpired){window.sessionExpired();return;}if(!r.ok){const j=await r.json().catch(()=>({}));throw Error(j.error||'Téléchargement impossible.');}const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);}
 let districtChoices=[];
 const context=()=>{
  const c={code_dhis2:$('clinical-structure').value,mois:+$('clinical-month').value,annee:+$('clinical-year').value};
  const picker=$('clinical-district-picker');
  if(c.code_dhis2==='DISTRICT'&&picker)c.structures=[...picker.querySelectorAll('input[type=checkbox]:checked')].map(x=>x.value);
  return c;
 };
 function renderDistrictPicker(){
  const box=$('clinical-district-box');if(!box)return;
  if($('clinical-structure').value!=='DISTRICT'){box.innerHTML='';return;}
  box.innerHTML=`<fieldset id="clinical-district-picker"><legend>Structures à compiler</legend>${districtChoices.map(x=>`<label><input type="checkbox" value="${esc(x.code_dhis2)}" checked>${esc(x.nom_entite)}</label>`).join('')}</fieldset><div class="form-actions"><button type="button" id="clinical-district-all">Tout cocher</button><button type="button" id="clinical-district-none">Tout décocher</button><button type="button" id="clinical-district-apply" class="primary-action">Compiler la sélection</button></div>`;
  $('clinical-district-all').onclick=()=>{box.querySelectorAll('input').forEach(x=>x.checked=true);};
  $('clinical-district-none').onclick=()=>{box.querySelectorAll('input').forEach(x=>x.checked=false);};
  $('clinical-district-apply').onclick=refresh;
 }
 function bindEdits(host){host.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>edit(b.dataset.edit));host.querySelectorAll('[data-recode]').forEach(b=>b.onclick=()=>recode(b.dataset.recode,b.dataset.structure||state.context.code_dhis2));}
 const table=(headers,body)=>`<div class="table-scroll"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
 const editButton=code=>F.isSpecialCode(code)?'':`<button type="button" data-edit="${esc(code)}">Modifier / prise</button>`;
 const recodeButton=(code,structureCode)=>(actorRef?.role==='ADMIN'&&!F.isSpecialCode(code))?`<button type="button" class="link-action" data-recode="${esc(code)}" data-structure="${esc(structureCode||'')}">Corriger le code</button>`:'';
 const codeCell=r=>{const mother=F.motherCode(r.patient_code);return esc(r.patient_code)+(mother?` <span class="muted">(enfant de ${esc(mother)})</span>`:'');};

 async function refresh(){
  const seq=++sequence,c=context(),box=$('clinical-result');state=null;
  if(!c.code_dhis2){box.innerHTML='<p>Le district doit renseigner le code DHIS2 de cette structure.</p>';return;}
  box.innerHTML='<p>Chargement…</p>';
  try{const data=await api('view',c);if(seq!==sequence)return;state={...data,context:c,refDate:refDateFor(c.mois,c.annee)};page=0;render();}catch(e){if(seq===sequence)box.innerHTML=`<p role="alert" class="portal-error">${esc(e.message)}</p>`;}
 }

 function render(){
  const d=state.district;
  const kpis=d
   ?[[state.patients.length,'Patients connus (district)'],[state.perdus_de_vue.length,'Perdus de vue'],[state.codes_erreur.length,'Codes en erreur']]
   :[[state.patients.filter(r=>F.active(r,state.refDate)).length,'Patients actifs'],[state.agenda.filter(r=>r.statut==='Attendu').length,'Rendez-vous attendus'],[state.rows.length,'Fiches du mois'],[state.issues.length,'Fiches à compléter'],[state.perdus_de_vue.length,'Perdus de vue'],[state.codes_erreur.length,'Codes en erreur']];
  const tabs=d?[['patients','Patients'],['lost','Perdus de vue'],['errors','Codes en erreur'],['pivot','Tableau croisé']]
              :[['appointments','Rendez-vous'],['patients','Patients'],['lost','Perdus de vue'],['errors','Codes en erreur'],['pivot','Tableau croisé'],['summary','Synthèse et validation']];
  const actions=d?'':`<button id="clinical-new" class="primary-action">+ Nouvelle inclusion</button><button type="button" id="clinical-aes">+ AES</button><button type="button" id="clinical-mobile">+ Mobile</button><button type="button" id="clinical-import-open">Importer un tableau</button>`;
  $('clinical-result').innerHTML=`<div class="section-heading"><div><h3>${esc(state.structure.nom_entite)}</h3><p>${esc(state.status)} · ${state.context.mois}/${state.context.annee}${d?' · Vue combinée : un même code vu dans plusieurs structures n’apparaît qu’une fois, à sa structure la plus récente.':''}</p></div>${actions}</div><p id="clinical-notice" role="status"></p><div class="portal-kpis">${kpis.map(([n,l])=>`<article><strong>${n}</strong><span>${l}</span></article>`).join('')}</div>
  <div class="clinical-tabs" role="tablist" aria-label="File active">${tabs.map(([k,l],i)=>`<button role="tab" aria-selected="${i===0}" data-tab="${k}">${l}</button>`).join('')}</div>
  ${d?'':`<section id="clinical-tab-appointments" role="tabpanel"><div class="section-heading"><h3>Rendez-vous du mois</h3><label>Afficher<select id="appointment-filter"><option value="">Tous</option><option>Attendu</option><option>Servi</option></select></label></div><div id="appointment-table"></div></section>`}
  <section id="clinical-tab-patients" role="tabpanel" ${d?'':'hidden'}><div class="section-heading"><h3>${d?'Patients du district':'Fiches patients'}</h3><label>Rechercher un code<input id="clinical-search" type="search" placeholder="Code patient"></label></div><div id="patient-table"></div><div class="pagination"><button id="patients-prev">Précédent</button><span id="patients-page"></span><button id="patients-next">Suivant</button></div>${d?'':`<h4>AES / Mobile du mois</h4><div id="specials-table"></div>`}</section>
  <section id="clinical-tab-lost" role="tabpanel" hidden><div class="section-heading"><h3>Perdus de vue</h3><p>Patients sans traitement en cours (rendez-vous dépassé, aucune nouvelle dispensation depuis). Les décès et les codes AES/MOBILE sont exclus de cette liste.</p></div><div id="lost-table"></div></section>
  <section id="clinical-tab-errors" role="tabpanel" hidden><div class="section-heading"><h3>Codes en erreur</h3><p>Code attendu : 5 chiffres / 2 caractères / 2 chiffres / 5 chiffres (ex. 22325/56/78/90123), un « e » final pour l’enfant d’une patiente (ex. …/90123e), ou les codes AES / MOBILE. Ces fiches sont conservées ; seul le format du code est signalé.</p></div><div id="errors-table"></div></section>
  <section id="clinical-tab-pivot" role="tabpanel" hidden><h3>Composer le tableau de file active</h3><p>Combinez les critères en lignes et en colonnes. Seules les combinaisons présentes apparaissent.</p><div class="pivot-controls"><fieldset><legend>Critères en lignes</legend>${Object.entries(F.dimensions).map(([k,l])=>`<label><input type="checkbox" name="pivot-row" value="${k}" ${k==='regime'?'checked':''}>${l}</label>`).join('')}</fieldset><label>Colonnes<select id="pivot-column">${Object.entries(F.dimensions).map(([k,l])=>`<option value="${k}" ${k==='sexe'?'selected':''}>${l}</option>`).join('')}</select></label><label>Population<select id="pivot-population"><option value="active">File active</option><option value="all">Tous les patients connus</option>${d?'':'<option value="monthly">Fiches du mois</option>'}</select></label><label>Tranche d’âge<select id="pivot-age"><option value="">Toutes</option><optgroup label="Grandes classes">${F.ageClassLabels.map(l=>`<option>${esc(l)}</option>`).join('')}</optgroup><optgroup label="Tranches de 5 ans">${[...F.ageBandLabels,F.ageMissing].map(l=>`<option>${esc(l)}</option>`).join('')}</optgroup></select></label><label>Sexe<select id="pivot-sex"><option value="">Tous</option><option>Masculin</option><option>Féminin</option><option>Non renseigné</option></select></label></div><div class="table-scroll" id="pivot-table" aria-live="polite"></div></section>
  ${d?'':`<section id="clinical-tab-summary" role="tabpanel" hidden><h3>Synthèse mensuelle</h3><div class="table-scroll">${window.renderClinicalSummary?renderClinicalSummary(state.summary):''}</div><h3>Fiches à compléter</h3>${table(['Code patient','Points à compléter','Action'],state.issues.map(x=>`<tr><td>${esc(x.row.patient_code)}</td><td>${esc(x.reasons.join(' ; '))}</td><td>${editButton(x.row.patient_code)}</td></tr>`).join('')||'<tr><td colspan="3">Aucune fiche signalée.</td></tr>')}<button id="clinical-validate" class="primary-action" ${!state.rows.length||state.issues.length?'disabled':''}>Valider la file active du mois</button><p class="muted">Toute modification remet le rapport en brouillon.</p></section>`}
  <dialog id="import-dialog"><div class="section-heading"><h2>Importer un tableau de dispensation</h2><button type="button" id="import-close">Fermer</button></div><p>Pour les structures à file active élevée : téléchargez un tableau, complétez-le hors ligne, puis importez-le. Chaque ligne met à jour un patient déjà connu (même code) ou crée une nouvelle inclusion (code inconnu). Une cellule laissée vide ne modifie pas l'information déjà enregistrée pour ce patient. La colonne « Periode » du fichier n'est pas utilisée : l'import se fait dans la période actuellement sélectionnée. Les codes AES et MOBILE peuvent se répéter.</p><div class="import-downloads"><button type="button" id="import-template">Télécharger le modèle vierge</button><button type="button" id="import-export">Télécharger la liste actuelle (modifiable)</button></div><label>Fichier à importer (.xlsx)<input type="file" id="import-file" accept=".xlsx"></label><div class="form-actions"><button type="button" id="import-analyze" class="primary-action">Analyser le fichier</button></div><div id="import-summary" aria-live="polite"></div><p id="import-error" class="portal-error" role="alert"></p></dialog>
  <dialog id="patient-dialog"><form id="patient-form"><div class="section-heading"><h2 id="patient-title"></h2><button type="button" id="patient-close">Fermer</button></div><p id="patient-context"></p><div id="patient-fields" class="patient-fields"></div><p id="patient-error" class="portal-error" role="alert"></p><div class="form-actions"><button type="button" id="patient-cancel">Annuler</button><button type="submit" id="patient-save" class="primary-action">Enregistrer</button></div></form></dialog>
  <dialog id="recode-dialog"><form id="recode-form"><div class="section-heading"><h2>Corriger le code patient</h2><button type="button" id="recode-close">Fermer</button></div><p id="recode-context"></p><label>Nouveau code<input id="recode-new" type="text" maxlength="150" required placeholder="22325/56/78/90123"></label><p class="muted">Le code est corrigé sur tout l’historique de la structure (tous les mois), pas seulement le mois en cours.</p><p id="recode-error" class="portal-error" role="alert"></p><div class="form-actions"><button type="button" id="recode-cancel">Annuler</button><button type="submit" class="primary-action">Enregistrer</button></div></form></dialog>`;
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));tabs.forEach(([k])=>{const el=$('clinical-tab-'+k);if(el)el.hidden=k!==b.dataset.tab;});});
  if(!d){$('clinical-new').onclick=()=>edit(null);$('clinical-aes').onclick=()=>edit(null,'AES');$('clinical-mobile').onclick=()=>edit(null,'MOBILE');$('clinical-import-open').onclick=openImport;$('appointment-filter').onchange=appointments;appointments();}
  $('clinical-search').oninput=()=>{page=0;patientList();};$('patients-prev').onclick=()=>{page--;patientList();};$('patients-next').onclick=()=>{page++;patientList();};
  document.querySelectorAll('.pivot-controls input,.pivot-controls select').forEach(el=>el.onchange=pivot);
  if(!d){$('clinical-validate').onclick=validate;bindEdits($('clinical-tab-summary'));specialsList();}
  patientList();lostList();errorsList();pivot();
 }
 function appointments(){const filter=$('appointment-filter').value,rows=state.agenda.filter(r=>!filter||r.statut===filter),host=$('appointment-table');host.innerHTML=table(['Code patient','Rendez-vous','Statut','Action'],rows.map(r=>`<tr><td>${codeCell(r)}</td><td>${esc(r.date_rendez_vous)}</td><td><span class="pill ${r.statut==='Servi'?'pill-ok':'pill-wait'}">${esc(r.statut)}</span></td><td>${editButton(r.patient_code)}</td></tr>`).join('')||'<tr><td colspan="4">Aucun rendez-vous pour ce filtre.</td></tr>');bindEdits(host);}
 function patientList(){
  const q=$('clinical-search').value.toLocaleLowerCase('fr'),rows=state.patients.filter(r=>String(r.patient_code).toLocaleLowerCase('fr').includes(q)).sort((a,b)=>a.patient_code.localeCompare(b.patient_code,'fr'));
  page=Math.max(0,Math.min(page,Math.max(0,Math.ceil(rows.length/50)-1)));const host=$('patient-table');
  const headers=state.district?['Code patient','Sexe','Âge','Statut','Dernière prise','Lieux (historique)','Action']:['Code patient','Sexe','Âge','Régime','Statut','Action'];
  host.innerHTML=table(headers,rows.slice(page*50,page*50+50).map(r=>{
   const common=`<td>${codeCell(r)}</td><td>${esc(r.sexe||'—')}</td><td>${esc(r.age??'—')}</td>`;
   if(state.district){
    const hist=r._location_history||[],last=hist[hist.length-1];
    return `<tr>${common}<td>${esc(F.status(r,state.refDate))}</td><td>${last?`${esc(last.nom_entite)} (${last.mois}/${last.annee})`:'—'}</td><td>${hist.length>1?`<details><summary>${hist.length} structures</summary><ul>${hist.map(h=>`<li>${esc(h.nom_entite)} — ${h.mois}/${h.annee}</li>`).join('')}</ul></details>`:'Inchangé'}</td><td>${recodeButton(r.patient_code,r._structure?.code_dhis2)}</td></tr>`;
   }
   return `<tr>${common}<td>${esc(r.regime||'—')}</td><td>${esc(F.status(r,state.refDate))}</td><td>${editButton(r.patient_code)} ${recodeButton(r.patient_code)}</td></tr>`;
  }).join('')||`<tr><td colspan="${headers.length}">Aucun patient.</td></tr>`);
  $('patients-page').textContent=`${rows.length} patients · page ${page+1}/${Math.max(1,Math.ceil(rows.length/50))}`;$('patients-prev').disabled=page===0;$('patients-next').disabled=(page+1)*50>=rows.length;bindEdits(host);
 }
 function specialsList(){const host=$('specials-table');if(!host)return;const rows=state.specials||[];host.innerHTML=table(['Code','Date','Sexe','Âge'],rows.map(r=>`<tr><td>${esc(r.patient_code)}</td><td>${esc(r.derniere_dispensation||'—')}</td><td>${esc(r.sexe||'—')}</td><td>${esc(r.age??'—')}</td></tr>`).join('')||'<tr><td colspan="4">Aucun cas AES ou patient mobile ce mois-ci.</td></tr>');}
 function lostList(){const host=$('lost-table');const rows=[...state.perdus_de_vue].sort((a,b)=>(b.jours_retard??0)-(a.jours_retard??0));const cols=state.district?['Code patient','Structure','Dernière dispensation','Jours de retard','Action']:['Code patient','Dernière dispensation','Jours de retard','Action'];
  host.innerHTML=table(cols,rows.map(r=>`<tr><td>${codeCell(r)}</td>${state.district?`<td>${esc(r._structure?.nom_entite||'—')}</td>`:''}<td>${esc(r.derniere_dispensation||'—')}</td><td>${r.jours_retard??'—'}</td><td>${state.district?recodeButton(r.patient_code,r._structure?.code_dhis2):editButton(r.patient_code)}</td></tr>`).join('')||`<tr><td colspan="${cols.length}">Aucun patient perdu de vue.</td></tr>`);bindEdits(host);}
 function errorsList(){const host=$('errors-table');const rows=state.codes_erreur;const cols=state.district?['Code patient','Structure','Action']:['Code patient','Action'];
  host.innerHTML=table(cols,rows.map(r=>`<tr><td>${esc(r.patient_code)}</td>${state.district?`<td>${esc(r._structure?.nom_entite||'—')}</td>`:''}<td>${state.district?recodeButton(r.patient_code,r._structure?.code_dhis2):`${editButton(r.patient_code)} ${recodeButton(r.patient_code)}`}</td></tr>`).join('')||`<tr><td colspan="${cols.length}">Aucun code en erreur de format.</td></tr>`);bindEdits(host);}
 function pivot(){
  const col=$('pivot-column').value;document.querySelectorAll('[name="pivot-row"]').forEach(x=>{x.disabled=x.value===col;if(x.disabled)x.checked=false;});
  let keys=[...document.querySelectorAll('[name="pivot-row"]:checked')].map(x=>x.value);if(!keys.length){const first=document.querySelector('[name="pivot-row"]:not(:disabled)');first.checked=true;keys=[first.value];}
  const pop=$('pivot-population').value,age=$('pivot-age').value,sex=$('pivot-sex').value,source=pop==='monthly'?state.rows:state.patients;
  const rows=source.filter(r=>(pop!=='active'||F.active(r,state.refDate))&&(!age||F.dimension(r,'age_group')===age||F.dimension(r,'age_class')===age)&&(!sex||F.dimension(r,'sexe')===sex));
  const p=F.pivot(rows,keys,col),totals=Object.fromEntries(p.columns.map(c=>[c,0]));for(const r of p.rows)for(const c of p.columns)totals[c]+=r.counts[c]||0;
  $('pivot-table').innerHTML=`<table><caption>${p.total} patients · Colonnes : ${esc(F.dimensions[col])}</caption><thead><tr>${p.keys.map(k=>`<th>${F.dimensions[k]}</th>`).join('')}${p.columns.map(c=>`<th>${esc(c)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${p.rows.map(r=>`<tr>${r.labels.map(l=>`<td>${esc(l)}</td>`).join('')}${p.columns.map(c=>`<td>${r.counts[c]||0}</td>`).join('')}<td><b>${r.total}</b></td></tr>`).join('')||`<tr><td colspan="${p.keys.length+p.columns.length+1}">Aucune combinaison pour ces filtres.</td></tr>`}</tbody><tfoot><tr><th colspan="${p.keys.length}">Total</th>${p.columns.map(c=>`<td>${totals[c]}</td>`).join('')}<td>${p.total}</td></tr></tfoot></table>`;
 }
 function edit(code,special){
  const isNew=code===null,old=isNew?null:state.patients.find(r=>r.patient_code===code);if(!isNew&&!old)return;
  const baseline={...old};if(old&&!state.rows.some(r=>r.patient_code===code))for(const k of ['nouvelle_inclusion','transfert_in','retour_soins'])baseline[k]='0';
  if(special)baseline.patient_code=special;
  const forced=['nouvelle_inclusion','file_active','transfert_in','retour_soins','transfert_out','deces','arret_tarv','perdu_vue','code_ok'],
   required=special?['patient_code']:['patient_code','sexe','age','poids','type_vih','ligne_therapeutique','regime','derniere_dispensation','jours_dispenses'];
  $('patient-title').textContent=special?(special==='AES'?'Nouveau cas AES':'Nouvelle dispensation mobile'):isNew?'Nouvelle inclusion':'Modifier la fiche patient';
  $('patient-context').textContent=`${state.structure.nom_entite} · ${state.context.mois}/${state.context.annee}${isNew?' · Ajout à la file active':''}`;
  $('patient-fields').innerHTML=Object.entries(F.fields).filter(([key])=>(!isNew||!forced.includes(key))&&!(special&&isNew&&!['patient_code','sexe','age','poids','type_vih','ligne_therapeutique','regime','derniere_dispensation','jours_dispenses','stable'].includes(key))).map(([key,[label,type]])=>{
   const val=baseline[key]??'',need=isNew&&required.includes(key)?'required':'',v=type==='bool'?(val===''?'':F.truth(val)?'1':'0'):String(val);let input;
   if(type==='choice'||type==='bool'){
    const opts=type==='bool'?[{value:'1',label:'Oui'},{value:'0',label:'Non'}]:(state.options[key]||[]).filter(o=>o.active||String(o.value)===v);
    if(v&&!opts.some(o=>String(o.value)===v))opts.push({value:v,label:v});
    input=`<select name="${key}" ${need}><option value="">Non renseigné</option>${opts.map(o=>`<option value="${esc(o.value)}" ${String(o.value)===v?'selected':''}>${esc(o.label||o.value)}</option>`).join('')}</select>`;
   }else input=`<input name="${key}" type="${type==='date'?'date':type==='text'?'text':'number'}" ${type==='text'?'maxlength="150"':type==='date'?`max="${new Date(Date.UTC(state.context.annee,state.context.mois,0)).toISOString().slice(0,10)}"`:`min="${type==='integer'?1:0}" step="${type==='integer'?1:'any'}"`} value="${esc(v)}" ${key==='patient_code'&&(!isNew||special)?'readonly':''} ${need}>`;
   return `<label>${label}${need?' *':''}${input}</label>`;
  }).join('');
  $('patient-error').textContent='';const dialog=$('patient-dialog');$('patient-close').onclick=$('patient-cancel').onclick=()=>dialog.close();const c={...state.context,revision:state.revision};
  $('patient-form').onsubmit=async e=>{e.preventDefault();const save=$('patient-save');save.disabled=true;$('patient-error').textContent='';try{const row=Object.fromEntries(new FormData(e.currentTarget));if(special)row.patient_code=special;await api(isNew?'create':'edit',{...c,original_code:code,row});dialog.close();await refresh();if(state)$('clinical-notice').textContent=isNew?'Enregistré. Le rapport est en brouillon.':'Fiche enregistrée. Le rapport est en brouillon.';}catch(error){$('patient-error').textContent=error.message;}finally{save.disabled=false;}};dialog.showModal();
 }
 function recode(oldCode,structureCode){
  const dialog=$('recode-dialog');$('recode-error').textContent='';$('recode-new').value='';
  $('recode-context').textContent=`Code actuel : ${oldCode}${state.district?' · '+(state.patients.find(r=>r.patient_code===oldCode)?._structure?.nom_entite||''):''}`;
  $('recode-close').onclick=$('recode-cancel').onclick=()=>dialog.close();
  $('recode-form').onsubmit=async e=>{e.preventDefault();const btn=e.currentTarget.querySelector('button[type=submit]');btn.disabled=true;$('recode-error').textContent='';
   try{await api('recode',{code_dhis2:structureCode,old_code:oldCode,new_code:$('recode-new').value.trim()});dialog.close();await refresh();if(state)$('clinical-notice').textContent='Code patient corrigé.';}
   catch(error){$('recode-error').textContent=error.message;}finally{btn.disabled=false;}};
  dialog.showModal();
 }
 function errorTable(errors){return errors.length?table(['Ligne','Code patient','Motif'],errors.map(e=>`<tr><td>${e.excelRow}</td><td>${esc(e.code||'—')}</td><td>${esc(e.reason)}</td></tr>`).join('')):'';}
 function openImport(){
  pendingImport=null;const dialog=$('import-dialog'),c=state.context;
  $('import-file').value='';$('import-summary').innerHTML='';$('import-error').textContent='';
  $('import-close').onclick=()=>dialog.close();
  $('import-template').onclick=async()=>{try{await downloadFile(`import/template?code_dhis2=${encodeURIComponent(c.code_dhis2)}&mois=${c.mois}&annee=${c.annee}`,`modele-dispensation-${c.mois}-${c.annee}.xlsx`);}catch(e){$('import-error').textContent=e.message;}};
  $('import-export').onclick=async()=>{try{await downloadFile(`import/export?code_dhis2=${encodeURIComponent(c.code_dhis2)}&mois=${c.mois}&annee=${c.annee}`,`dispensation-${c.mois}-${c.annee}.xlsx`);}catch(e){$('import-error').textContent=e.message;}};
  $('import-analyze').onclick=()=>runImport(false);
  dialog.showModal();
 }
 async function runImport(commit){
  const err=$('import-error'),summary=$('import-summary'),button=commit?$('import-commit'):$('import-analyze');err.textContent='';
  if(!commit){const file=$('import-file').files[0];if(!file){err.textContent='Choisissez un fichier .xlsx.';return;}try{pendingImport=await fileToBase64(file);}catch(e){err.textContent=e.message;return;}}
  if(!pendingImport){err.textContent='Analysez d’abord le fichier.';return;}
  button.disabled=true;summary.innerHTML=`<p>${commit?'Import en cours…':'Analyse du fichier…'}</p>`;
  try{
   const payload={...state.context,revision:state.revision,commit,file_base64:pendingImport};
   const res=await api('import',payload);
   if(!commit){
    summary.innerHTML=`<p>${res.total} ligne(s) lue(s) · <strong>${res.valid} prête(s) à importer</strong>${res.errors.length?` · ${res.errors.length} en erreur`:''}</p>${res.missingColumns.length?`<p class="muted">Colonnes absentes du fichier, non modifiées : ${res.missingColumns.map(esc).join(', ')}</p>`:''}${errorTable(res.errors)}${res.valid?`<div class="form-actions"><button type="button" id="import-commit" class="primary-action">Importer ${res.valid} fiche(s)</button></div>`:''}`;
    if(res.valid)$('import-commit').onclick=()=>runImport(true);
   }else{
    pendingImport=null;$('import-dialog').close();await refresh();
    if(state)$('clinical-notice').textContent=`${res.imported} fiche(s) importée(s) par tableau${res.skipped?`, ${res.skipped} ignorée(s) (déjà signalée(s) lors de l’analyse)`:''}. Le rapport est en brouillon.`;
   }
  }catch(e){err.textContent=e.message;}finally{button.disabled=false;}
 }
 async function validate(){const button=$('clinical-validate');button.disabled=true;try{await api('validate',{...state.context,revision:state.revision});await refresh();if(state)$('clinical-notice').textContent='File active du mois validée.';}catch(e){$('clinical-notice').textContent=e.message;button.disabled=false;}}
 window.clinicalHome=async(actor,m,y)=>{
  actorRef=actor;
  const host=$('clinical-home');for(const id of ['dashboard-zone','agent-home','district-zone','saisie-zone'])$(id).classList.add('no-disp');host.classList.remove('no-disp');if(window.setNav)window.setNav('clinical');
  const choices=(window.clinicalStructures||[]).filter(x=>actor.role==='ADMIN'?x.role==='USER'&&x.code_dhis2:x.id===actor.id);
  districtChoices=choices;
  const districtOption=actor.role==='ADMIN'?`<option value="DISTRICT">— District Sanitaire de Toumodi (toutes structures) —</option>`:'';
  host.innerHTML=`<section class="clinical-card"><h2>File active</h2><p>Suivi des rendez-vous, fiches patients et nouvelles inclusions.</p><div class="portal-filters"><label>Structure<select id="clinical-structure" ${actor.role==='ADMIN'?'':'disabled'}>${districtOption}${choices.map(x=>`<option value="${esc(x.code_dhis2||'')}">${esc(x.nom_entite)}</option>`).join('')}</select></label><label>Mois<input id="clinical-month" type="number" min="1" max="12" value="${esc(m)}"></label><label>Année<input id="clinical-year" type="number" min="2020" max="2100" value="${esc(y)}"></label><button id="clinical-load">Actualiser</button></div><div id="clinical-district-box"></div><div id="clinical-result"></div></section>`;
  $('clinical-load').onclick=refresh;$('clinical-structure').onchange=()=>{renderDistrictPicker();refresh();};for(const id of ['clinical-month','clinical-year'])$(id).onchange=refresh;renderDistrictPicker();await refresh();
 };
})();
