/**
 * The decisions the golden param Forge exercises (spec 09 §11.3), shared by
 * `regen-golden-param.ts` and `test/golden-param.test.ts` so the committed plans and a fresh
 * `--save-plan` can be compared: every hunk becomes `take: param`, and each pre-filled key is
 * renamed from its suggested `param.<slug>` to the name a human would choose.
 */
export const RENAME: Record<string, string> = {
  "param.globex_api": "deploy.api",
  "param.globex_web": "deploy.web",
  "param.8080": "ports.api",
};

// A plan is parsed YAML here, typed loosely on purpose: this is test data, not the engine.
export function asParamPlan(plan: any): any {
  for (const f of plan.files) {
    for (const h of f.hunks ?? []) {
      h.take = "param";
      h.params = h.params.map((p: { token: string; key: string }) => ({ token: p.token, key: RENAME[p.key] ?? p.key }));
    }
  }
  return plan;
}
