(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ClinicalFields=factory();})(typeof globalThis==='object'?globalThis:this,function(){
 const fields={patient_code:['Code patient','text'],sexe:['Sexe','choice'],age:['Âge (années)','number'],poids:['Poids (kg)','number'],region:['Région','choice'],district:['District','choice'],nouvelle_inclusion:['Nouvelle inclusion','bool'],transfert_in:['Transfert entrant','bool'],retour_soins:['Retour dans les soins','bool'],tb_vih:['TB / VIH','bool'],type_vih:['Type de VIH','choice'],ligne_therapeutique:['Ligne thérapeutique','choice'],derniere_dispensation:['Dernière dispensation','date'],jours_dispenses:['Jours de traitement','integer'],regime:['Régime','choice'],stable:['Patient stable','choice'],transfert_out:['Transfert sortant','bool'],deces:['Décès','bool'],arret_tarv:['Arrêt TARV','bool'],servi_ailleurs:['Servi ailleurs','bool'],file_active:['Dans la file active','bool'],perdu_vue:['Perdu de vue','bool'],cas_aes:['Cas AES / particulier','bool'],patient_mobile:['Patient mobile','bool']};
 const truth=v=>[true,1,'1','t','true','Oui','oui'].includes(v);
 const active=r=>truth(r.file_active)&&!['deces','transfert_out','arret_tarv','perdu_vue'].some(k=>truth(r[k]));
 const status=r=>truth(r.deces)?'Décès':truth(r.transfert_out)?'Transfert sortant':truth(r.arret_tarv)?'Arrêt TARV':truth(r.perdu_vue)?'Perdu de vue':active(r)?'Actif':'Hors file active';
 const dimensions={regime:'Régime',sexe:'Sexe',age_group:'Tranche d’âge',ligne_therapeutique:'Ligne thérapeutique',statut:'Statut'};
 function dimension(r,k){if(k==='age_group')return r.age==null||r.age===''?'Non renseigné':Number(r.age)<15?'Enfants (< 15 ans)':'Adultes (≥ 15 ans)';if(k==='statut')return status(r);if(k==='sexe')return ['H','M'].includes(String(r.sexe).toUpperCase())?'Masculin':String(r.sexe).toUpperCase()==='F'?'Féminin':'Non renseigné';return String(r[k]||'Non renseigné');}
 function pivot(rows,rowKeys,colKey){
  const keys=[...new Set(rowKeys)].filter(k=>dimensions[k]&&k!==colKey);if(!keys.length)keys.push('regime'===colKey?'sexe':'regime');
  const groups=new Map(),columns=new Set();
  for(const row of rows){const labels=keys.map(k=>dimension(row,k)),key=JSON.stringify(labels),column=dimension(row,colKey);columns.add(column);if(!groups.has(key))groups.set(key,{labels,counts:{},total:0});const g=groups.get(key);g.counts[column]=(g.counts[column]||0)+1;g.total++;}
  return{keys,columns:[...columns].sort((a,b)=>a.localeCompare(b,'fr')),rows:[...groups.values()].sort((a,b)=>a.labels.join(' / ').localeCompare(b.labels.join(' / '),'fr')),total:rows.length};
 }
 function normalize(input,old,options,m,y,isNew=false){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Fiche invalide.');
  const row={};
  for(const [key,[label,type]] of Object.entries(fields)){
   let v=Object.hasOwn(input,key)?input[key]:old?.[key]??null;
   if(v!=null&&typeof v==='object')throw Error(label+' : valeur invalide.');
   if(v==null||v===''){row[key]=null;continue;}
   if(type==='bool'){if(![true,false,0,1,'0','1','t','f','true','false','Oui','Non','oui','non'].includes(v))throw Error(label+' : choisissez Oui ou Non.');row[key]=truth(v)?'1':'0';continue;}
   if(type==='number'||type==='integer'){v=Number(String(v).replace(',','.'));if(!Number.isFinite(v)||v<0||(type==='integer'&&(!Number.isInteger(v)||v<1||v>3660)))throw Error(label+' : nombre invalide.');if(key==='age'&&v>130)throw Error('Âge supérieur à 130 ans.');row[key]=String(v);continue;}
   v=String(v).trim();if(v.length>500)throw Error(label+' : valeur trop longue.');
   if(type==='date'){const d=new Date(v+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(+d)||d.toISOString().slice(0,10)!==v||v>new Date(Date.UTC(y,m,0)).toISOString().slice(0,10))throw Error('Date invalide ou postérieure à la période.');}
   if(type==='choice'&&v!==String(old?.[key]??'')&&!(options[key]||[]).some(o=>o.active&&String(o.value)===v))throw Error(label+' : choisissez une option disponible.');
   row[key]=v;
  }
  if(!row.patient_code||row.patient_code.length>150)throw Error('Code patient obligatoire (150 caractères maximum).');
  if(old&&row.patient_code!==old.patient_code)throw Error('Le code patient ne peut pas être changé ici.');
  if(isNew){row.nouvelle_inclusion='1';row.file_active='1';for(const k of ['transfert_in','retour_soins','transfert_out','deces','arret_tarv','perdu_vue'])row[k]='0';
   for(const key of ['sexe','age','poids','type_vih','ligne_therapeutique','regime','derniere_dispensation','jours_dispenses'])if(row[key]==null||row[key]==='')throw Error(fields[key][0]+' obligatoire.');
   if(Number(row.poids)<=0)throw Error('Le poids doit être supérieur à zéro.');
   if(!row.derniere_dispensation.startsWith(`${y}-${String(m).padStart(2,'0')}-`))throw Error('La première dispensation doit appartenir au mois choisi.');
  }
  return row;
 }
 return{fields,truth,active,status,dimensions,dimension,pivot,normalize};
});
