(function(){
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const months=['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
 const validated=s=>['VALIDE','VALIDÉ','VALIDEE','VALIDÉE','NEANT','NÉANT'].includes(String(s).toUpperCase());
 const badge=s=>`<span class="pill ${validated(s)?'pill-ok':s?'pill-wait':'pill-empty'}">${validated(s)?'Validé':s?'En cours':'Non saisi'}</span>`;
 let sequence=0;
 window.portalHome=async(boot,m,y)=>{
  document.getElementById('public-month').innerHTML=months.map((n,i)=>`<option value="${i+1}">${n}</option>`).join('');
  document.getElementById('public-month').value=String(Number(m)||new Date().getMonth()+1);
  document.getElementById('public-year').value=Number(y)||new Date().getFullYear();
  document.getElementById('public-refresh').onclick=load;
  document.getElementById('pass').addEventListener('keydown',e=>{if(e.key==='Enter')login();});
  await load();
 };
 async function load(){
  const seq=++sequence,box=document.getElementById('public-result'),m=Number(document.getElementById('public-month').value),y=Number(document.getElementById('public-year').value);
  box.innerHTML='<p>Chargement du tableau de bord…</p>';
  try{
   const response=await fetch(`/api/clinical/public-dashboard?mois=${m}&annee=${y}`),data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'Chargement impossible.');if(seq!==sequence)return;
   const clinical=new Map(data.clinical.map(r=>[r.code_dhis2,r.status])),reports=new Map();
   for(const r of data.reports){const key=r.entite_id+':'+r.famille_id;if(!reports.has(key)||validated(r.statut))reports.set(key,r.statut);}
   const relevant=data.structures.filter(s=>s.code_dhis2),done=relevant.filter(s=>validated(clinical.get(s.code_dhis2))).length,inProgress=relevant.filter(s=>clinical.has(s.code_dhis2)&&!validated(clinical.get(s.code_dhis2))).length;
   box.innerHTML=`<div class="portal-kpis"><article><strong>${data.structures.length}</strong><span>Structures suivies</span></article><article><strong>${done}</strong><span>Files actives validées</span></article><article><strong>${inProgress}</strong><span>Files actives en cours</span></article><article><strong>${relevant.length-done-inProgress}</strong><span>Files actives non saisies</span></article></div><div class="section-heading"><div><h2>Suivi des validations</h2><p>${months[m-1]} ${y} · Choisissez votre structure pour ouvrir son espace.</p></div><label>Rechercher une structure<input id="public-search" type="search" placeholder="Nom de l’ESPC"></label></div><div class="table-scroll"><table class="public-table"><thead><tr><th scope="col">Structure</th><th scope="col">File active</th>${data.families.map(f=>`<th scope="col">${esc(f.nom_famille)}</th>`).join('')}<th scope="col">Accès</th></tr></thead><tbody>${data.structures.map(s=>`<tr data-name="${esc(s.nom_entite.toLocaleLowerCase('fr'))}"><th scope="row">${esc(s.nom_entite)}</th><td>${s.code_dhis2?badge(clinical.get(s.code_dhis2)):'<span class="muted">Non rattachée</span>'}</td>${data.families.map(f=>`<td>${badge(reports.get(s.id+':'+f.id))}</td>`).join('')}<td><button type="button" data-structure="${s.id}">Ouvrir</button></td></tr>`).join('')}</tbody></table></div><p class="muted">Les informations individuelles des patients sont accessibles dans l’espace sécurisé de leur structure.</p>`;
   document.getElementById('public-search').oninput=e=>{const q=e.target.value.toLocaleLowerCase('fr');box.querySelectorAll('tr[data-name]').forEach(r=>r.hidden=!r.dataset.name.includes(q));};
   box.querySelectorAll('[data-structure]').forEach(b=>b.onclick=()=>{document.getElementById('sel-structure').value=b.dataset.structure;document.getElementById('login-zone').scrollIntoView({behavior:'smooth'});document.getElementById('pass').focus({preventScroll:true});});
  }catch(e){if(seq===sequence)box.innerHTML=`<p role="alert" class="portal-error">${esc(e.message)} Utilisez Actualiser pour réessayer.</p>`;}
 }
})();
