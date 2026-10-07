(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ClinicalFields=factory();})(typeof globalThis==='object'?globalThis:this,function(){
 const fields={patient_code:['Code patient','text'],sexe:['Sexe','choice'],age:['Âge (années)','number'],poids:['Poids (kg)','number'],region:['Région','choice'],district:['District','choice'],nouvelle_inclusion:['Nouvelle inclusion','bool'],transfert_in:['Transfert entrant','bool'],retour_soins:['Retour dans les soins','bool'],tb_vih:['TB / VIH','bool'],type_vih:['Type de VIH','choice'],ligne_therapeutique:['Ligne thérapeutique','choice'],derniere_dispensation:['Dernière dispensation','date'],jours_dispenses:['Jours de traitement','integer'],regime:['Régime','choice'],stable:['Patient stable','choice'],transfert_out:['Transfert sortant','bool'],deces:['Décès','bool'],arret_tarv:['Arrêt TARV','bool'],servi_ailleurs:['Servi ailleurs','bool'],file_active:['Dans la file active','bool'],perdu_vue:['Perdu de vue','bool'],cas_aes:['Cas AES / particulier','bool'],patient_mobile:['Patient mobile','bool']};
 const truth=v=>[true,1,'1','t','true','Oui','oui'].includes(v);
 // Code patient : 5 chiffres / 2 chiffres-ou-2 lettres / 2 chiffres / 5 chiffres (ex. 22325/56/78/90123),
 // ou l'un des deux codes spéciaux AES / MOBILE (dispensation sans identité de patient, hors file active).
 // Le 2e groupe tolère 2 chiffres, 2 lettres ou un mélange (ex. « d4 », observé dans les données réelles).
 // Suffixe « e » final = enfant de la patiente qui porte ce même code sans le suffixe :
 //  - « e » seul (sans chiffre) : enfant sous trithérapie, compté normalement dans la file active ;
 //  - « e1 » à « e10 » : enfant sous prophylaxie (NVP/AZT/CTX), hors file active comme AES/MOBILE.
 const SPECIAL_CODES=['AES','MOBILE'],CODE_RE=/^\d{5}\/[A-Za-z0-9]{2}\/\d{2}\/\d{5}(?:[eE](?:10|[1-9])?)?$/;
 const isSpecialCode=c=>SPECIAL_CODES.includes(String(c||'').trim().toUpperCase());
 const childSuffix=c=>{const v=String(c||'').trim(),m=CODE_RE.test(v)&&v.match(/^(.*\d)([eE])(10|[1-9])?$/);return m?{mother:m[1],prophylaxis:!!m[3],n:m[3]?Number(m[3]):null}:null;};
 const isProphylaxisChild=c=>{const m=childSuffix(c);return !!(m&&m.prophylaxis);};
 const codeFormatOk=c=>isSpecialCode(c)||CODE_RE.test(String(c||'').trim());
 // Code de la mère pour un code « enfant de » (trithérapie ou prophylaxie) ; null si ce n'est pas un tel code.
 const motherCode=c=>childSuffix(c)?.mother??null;
 // Un patient transféré ou perdu de vue reste compté dans la file active tant que son traitement en cours
 // n'est pas terminé (dernière dispensation + jours dispensés). Les décès en sortent immédiatement.
 const dueDate=r=>{const s=String(r.derniere_dispensation||'').slice(0,10),n=Number(r.jours_dispenses);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isInteger(n)||n<=0)return null;const d=new Date(s+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==s)return null;d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
 const active=(r,refDate=new Date().toISOString().slice(0,10))=>{
  if(!truth(r.file_active)||isSpecialCode(r.patient_code)||isProphylaxisChild(r.patient_code))return false;
  if(truth(r.deces)||truth(r.arret_tarv)||truth(r.perdu_vue))return false;
  if(truth(r.transfert_out)){const end=dueDate(r);if(!end||end<refDate)return false;}
  return true;
 };
 // « Perdu de vue » au sens opérationnel : le patient n'a plus de traitement en cours (rendez-vous dépassé,
 // aucune dispensation depuis), qu'il soit ou non explicitement signalé comme tel. Exclut les codes spéciaux.
 const overdue=(r,refDate=new Date().toISOString().slice(0,10))=>{if(isSpecialCode(r.patient_code)||isProphylaxisChild(r.patient_code)||truth(r.deces))return false;const end=dueDate(r);return !end||end<refDate;};
 const status=(r,refDate)=>truth(r.deces)?'Décès':isSpecialCode(r.patient_code)?(String(r.patient_code).toUpperCase()==='AES'?'AES':'Mobile'):isProphylaxisChild(r.patient_code)?'Prophylaxie (enfant, hors file active)':truth(r.arret_tarv)?'Arrêt TARV':active(r,refDate)?'Actif':truth(r.transfert_out)?'Transfert sortant (traitement terminé)':truth(r.perdu_vue)||overdue(r,refDate)?'Perdu de vue':'Hors file active';
 const dimensions={regime:'Régime',sexe:'Sexe',age_group:'Tranche d’âge (5 ans)',age_class:'Enfants / adultes',ligne_therapeutique:'Ligne thérapeutique',statut:'Statut',mouvement:'Mouvement du mois'};
 // Tranches d'âge couvrant toute la population (aucun seuil unique) : <1, 1-4, puis 5 ans jusqu'à 65 et +.
 const ageBands=[['<1 an',0,1],['1–4 ans',1,5],['5–9 ans',5,10],['10–14 ans',10,15],['15–19 ans',15,20],['20–24 ans',20,25],['25–29 ans',25,30],['30–34 ans',30,35],['35–39 ans',35,40],['40–44 ans',40,45],['45–49 ans',45,50],['50–54 ans',50,55],['55–59 ans',55,60],['60–64 ans',60,65],['65 ans et +',65,Infinity]];
 const ageMissing='Non renseigné',ageBandLabels=ageBands.map(b=>b[0]),ageClassLabels=['Enfants (< 15 ans)','Adultes (≥ 15 ans)'];
 const ageBandIndex=age=>{if(age==null||age==='')return -1;const n=Number(age);if(!Number.isFinite(n)||n<0)return -1;return ageBands.findIndex(b=>n>=b[1]&&n<b[2]);};
 const displayOrder=[...ageBandLabels,...ageClassLabels,ageMissing];
 const compareLabels=(a,b)=>{const i=displayOrder.indexOf(a),j=displayOrder.indexOf(b);return i>=0&&j>=0?i-j:String(a).localeCompare(String(b),'fr');};
 function dimension(r,k){if(k==='age_group'){const i=ageBandIndex(r.age);return i<0?ageMissing:ageBandLabels[i];}if(k==='age_class'){const i=ageBandIndex(r.age);return i<0?ageMissing:Number(r.age)<15?ageClassLabels[0]:ageClassLabels[1];}if(k==='statut')return status(r);if(k==='mouvement')return truth(r.nouvelle_inclusion)?'Nouvelle inclusion':truth(r.deces)?'Décès':truth(r.transfert_out)?'Transfert out':truth(r.transfert_in)?'Transfert in':truth(r.retour_soins)?'Retour dans les soins':'Aucun mouvement signalé';if(k==='sexe')return ['H','M'].includes(String(r.sexe).toUpperCase())?'Masculin':String(r.sexe).toUpperCase()==='F'?'Féminin':'Non renseigné';return String(r[k]||'Non renseigné');}
 function pivot(rows,rowKeys,colKey){
  const keys=[...new Set(rowKeys)].filter(k=>dimensions[k]&&k!==colKey);if(!keys.length)keys.push('regime'===colKey?'sexe':'regime');
  const groups=new Map(),columns=new Set();
  for(const row of rows){const labels=keys.map(k=>dimension(row,k)),key=JSON.stringify(labels),column=dimension(row,colKey);columns.add(column);if(!groups.has(key))groups.set(key,{labels,counts:{},total:0});const g=groups.get(key);g.counts[column]=(g.counts[column]||0)+1;g.total++;}
  return{keys,columns:[...columns].sort(compareLabels),rows:[...groups.values()].sort((a,b)=>{for(let i=0;i<a.labels.length;i++){const c=compareLabels(a.labels[i],b.labels[i]);if(c)return c;}return 0;}),total:rows.length};
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
  if(isSpecialCode(row.patient_code))row.patient_code=row.patient_code.toUpperCase();
  if(old&&row.patient_code!==old.patient_code)throw Error('Le code patient ne peut pas être changé ici. Utilisez la correction de code (district).');
  const special=isSpecialCode(row.patient_code);
  row.code_ok=codeFormatOk(row.patient_code)?'1':'0';
  if(special){
   // AES / MOBILE : simple journal de dispensation, jamais dans la file active ni les rendez-vous.
   row.file_active='0';row.nouvelle_inclusion='0';
   if(row.patient_code==='AES')row.cas_aes='1';if(row.patient_code==='MOBILE')row.patient_mobile='1';
  }else if(isNew){
   row.nouvelle_inclusion='1';row.file_active='1';for(const k of ['transfert_in','retour_soins','transfert_out','deces','arret_tarv','perdu_vue'])row[k]='0';
   for(const key of ['sexe','age','poids','type_vih','ligne_therapeutique','regime','derniere_dispensation','jours_dispenses'])if(row[key]==null||row[key]==='')throw Error(fields[key][0]+' obligatoire.');
   if(Number(row.poids)<=0)throw Error('Le poids doit être supérieur à zéro.');
   if(!row.derniere_dispensation.startsWith(`${y}-${String(m).padStart(2,'0')}-`))throw Error('La première dispensation doit appartenir au mois choisi.');
  }
  return row;
 }
 return{fields,truth,active,overdue,status,dimensions,dimension,pivot,normalize,ageBands,ageBandLabels,ageClassLabels,ageMissing,ageBandIndex,compareLabels,SPECIAL_CODES,CODE_RE,isSpecialCode,isProphylaxisChild,childSuffix,codeFormatOk,motherCode,dueDate};
});
