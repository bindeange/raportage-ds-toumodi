(function(root){
 const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function render(summary){
  const m=summary.meta;let html=`<p><strong>${escape(m.structure)}</strong> · ${escape(m.mois)}/${escape(m.annee)} · <strong>${m.statut==='VALIDE'?'Validé':escape(m.statut)}</strong></p>`;
  for(const [key,section] of Object.entries(summary.sections)){
   const entries=Object.entries(section.groups),width=k=>['aes','mobile'].includes(k)?2:k==='outside'?1:5;
   html+=`<h3>${escape(section.title)}</h3><div class="disp-table-scroll"><table class="clinical-aggregate"><thead><tr><th rowspan="3">Régime</th>`+entries.map(([k,label])=>`<th colspan="${width(k)}" ${width(k)<5?'rowspan="2"':''}>${escape(label)}</th>`).join('')+'</tr><tr>'+entries.filter(([k])=>width(k)===5).map(()=>'<th colspan="2">Adulte</th><th colspan="2">Enfant</th><th rowspan="2">Total</th>').join('')+'</tr><tr>'+entries.map(([k])=>width(k)===5?'<th>M</th><th>F</th><th>M</th><th>F</th>':width(k)===2?'<th>M</th><th>F</th>':'<th>Total</th>').join('')+'</tr></thead><tbody>';
   html+=section.rows.map(r=>`<tr${r.regime==='TOTAL'?' class="clinical-total"':''}><th>${escape(r.regime)}</th>`+entries.map(([k])=>{const vals=r.groups[k];const cells=vals?(width(k)===5?vals:width(k)===2?[vals[0]+vals[2],vals[1]+vals[3]]:[vals[4]]):Array(width(k)).fill('n.r.');return cells.map(v=>`<td>${escape(v)}</td>`).join('');}).join('')+'</tr>').join('');html+='</tbody></table></div>';
  }
  html+='<p>'+summary.notes.map(escape).join('<br>')+'</p>';if(summary.unclassified_age_sex)html+=`<p>${summary.unclassified_age_sex} patients sont inclus dans les totaux mais non répartis par âge/sexe faute d’information.</p>`;if(summary.unclassified_duration)html+=`<p>${summary.unclassified_duration} dispensations ont une durée hors des classes du modèle.</p>`;return html;
 }
 root.renderClinicalSummary=render;
})(typeof window==='undefined'?globalThis:window);
