// @caveman-tool {"description":"Compute exact prorated refund amount in cents for unused days in a billing cycle.","effect":"read","input_schema":{"type":"object","required":["total_cents","days_used","cycle_days"],"properties":{"total_cents":{"type":"integer","minimum":0},"days_used":{"type":"integer","minimum":0},"cycle_days":{"type":"integer","minimum":1}}}}
export default function execute({ total_cents, days_used, cycle_days }) {
  const remaining = Math.max(0, cycle_days - days_used);
  const refund_cents = Math.round((total_cents * remaining) / cycle_days);
  return { refund_cents, remaining_days: remaining, requires_approval: refund_cents > 50000 };
}
