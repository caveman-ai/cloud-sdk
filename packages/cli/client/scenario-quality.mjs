// CI checks execution completeness and criterion evidence. This does not replace
// the server's independently qualified rollout gate or certify savings.
export function scenarioQuality(run){
 if(run?.status!=='completed')return 'incomplete';
 const cases=run.document?.cases?.filter(item=>item.split===run.split),variants=run.document?.variants;
 const repeats=run.document?.trials;
 if(!cases?.length||!variants?.length||!Number.isSafeInteger(repeats)||repeats<1||!Array.isArray(run.trials))return 'incomplete';
 const expected=new Map();
 for(const item of cases)for(const variant of variants)for(let repeat=0;repeat<repeats;repeat++){
  const key=JSON.stringify([item.id,variant.id,repeat]);
  if(expected.has(key)||!item.criteria?.length)return 'incomplete';
  expected.set(key,item);
 }
 if(run.trials.length!==expected.size)return 'incomplete';
 let failed=false;
 for(const trial of run.trials){
  const key=JSON.stringify([trial.case_id,trial.variant_id,trial.repeat]);
  const item=expected.get(key);if(!item)return 'incomplete';expected.delete(key);
  if(!['passed','failed'].includes(trial.status)||!Array.isArray(trial.verdicts)||trial.verdicts.length!==item.criteria.length)return 'incomplete';
  const criteria=new Set(item.criteria.map(criterion=>criterion.id));
  if(criteria.size!==item.criteria.length)return 'incomplete';
  let verdictFailed=false;
  for(const verdict of trial.verdicts){if(!criteria.delete(verdict.id)||!['passed','failed'].includes(verdict.status))return 'incomplete';verdictFailed ||= verdict.status==='failed';}
  if((trial.status==='failed')!==verdictFailed)return 'incomplete';
  failed ||= verdictFailed;
 }
 return failed?'failed':'passed';
}
