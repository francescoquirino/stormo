"""Finite development workflows; roles cannot be promoted across model tiers."""
from __future__ import annotations

import json
import re
import sys
import time
import uuid
from pathlib import Path
from route_budget import effort_for

DEVELOPER = """You are the developer. Write the complete requested code, with the path
and code block for each file. Use the context provided. No placeholders or
extra functions. Do not claim to have run tests you have not run.
If you find an impossible requirement or missing information, state it clearly."""
REVIEWER = """You are the ONLY B reviewer for this task. Check correctness,
requirements and edge cases of the code. Do not rewrite code. Reply with ONLY JSON:
{"verdict":"approved" or "changes_requested","issues":[
{"severity":"minor" or "major" or "critical","path":"file",
"location":"line or function","problem":"concrete error","fix":"precise fix"}]}
minor = non-blocking defect; major/critical = wrong behavior, data at risk,
incomplete or non-executable code. If the code is correct use approved and issues [].
Do not request superfluous cosmetic changes. Review is not a substitute for real tests."""


def parse_review(text: str) -> dict:
    text = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*\n([\s\S]*?)\n```", text)
    if fenced:
        text = fenced.group(1)
    try:
        review = json.loads(text)
    except (ValueError, TypeError) as exc:
        raise ValueError("the reviewer must return a valid JSON object") from exc
    if not isinstance(review, dict) or review.get('verdict') not in ('approved', 'changes_requested'):
        raise ValueError("invalid review verdict")
    issues = review.get('issues')
    if not isinstance(issues, list):
        raise ValueError("issues must be a list")
    for issue in issues:
        if not isinstance(issue, dict) or issue.get('severity') not in ('minor', 'major', 'critical'):
            raise ValueError("invalid issue severity")
        for field in ('path', 'location', 'problem', 'fix'):
            if not isinstance(issue.get(field), str) or not issue[field].strip():
                raise ValueError(f"issue missing {field}: concrete errors and fixes are required")
    if review['verdict'] == 'changes_requested' and not issues:
        raise ValueError("changes requested without any issues listed")
    return {'verdict': review['verdict'], 'issues': issues}


def _prefer(pool, first):
    return ([first] + [m for m in pool if m != first]) if first else list(pool)


def run_workflow(router, cfg, args, task: str, preamble: str) -> int:
    work = args.work
    tier = 'C' if work == 'BC' else work
    first = args.model or (args.planner if tier == 'A' else args.writer if tier == 'C' else None)
    pool = [args.model] if args.model else _prefer(router.TIERS[tier], first)
    reviewers = _prefer(router.TIERS['B'], args.reviewer)
    cls = {'A': 'hard', 'B': 'med', 'C': 'easy'}[tier]
    difficulty = getattr(args,'difficulty',None) or ('hard' if work == 'B' or getattr(args,'task_class','med') == 'hard' else 'medium')
    effort = lambda model: effort_for(model,difficulty)
    label = {'A': 'design', 'B': 'develop-B', 'C': 'develop-C'}[tier]
    if args.dry_run:
        rc, model = router.run_step(cfg, pool, cls, '', effort,
                                    dry_run=True, label=label)
        if rc or not model:
            print(f"route-ask: no tier {tier} model available", file=sys.stderr)
            return 1
        if work == 'BC':
            rc, model = router.run_step(cfg, reviewers, 'med', '', effort,
                                        dry_run=True, label='review-B')
            if rc or not model:
                print("route-ask: no B reviewer available", file=sys.stderr)
                return 1
        return 0

    run_dir = router.ROUTE_DIR / 'runs' / (time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    run_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / 'task.md').write_text(task, encoding='utf-8')
    print(f"route-ask: work folder: {run_dir}", file=sys.stderr)
    result = dict(work=work, status='failed', writer=None, reviewer=None, returns=0,
                  artifact=None, issues=[], tests_executed=False)
    task_block = '# Original task\n\n' + task

    def call(candidates, task_class, role, sections, filename, step_label, step_effort):
        brief = router.write_brief([preamble, role, task_block, *sections])
        output = run_dir / filename
        try:
            rc, model = router.run_step(cfg, candidates, task_class, brief,
                                       step_effort, fast=args.fast,
                                       label=step_label, out_path=str(output))
        finally:
            Path(brief).unlink(missing_ok=True)
        text = output.read_text(encoding='utf-8-sig').strip() if output.exists() else ''
        if rc or not model or not text:
            raise ValueError(f"{step_label} failed (model={model}, status={rc}, chars={len(text)})")
        return model, text, output

    try:
        role = router.PLANNER_ROLE if tier == 'A' else DEVELOPER
        model, code, artifact = call(pool, cls, role, [], 'plan.md' if tier == 'A' else 'code-0.md', label, effort)
        result['writer'] = model
        result['artifact'] = str(artifact)
        result['status'] = 'planned' if tier == 'A' else 'ready-for-tests'
        if work == 'BC':
            writer = model
            review_effort = effort
            result['status'] = 'failed'
            while True:
                index = result['returns']
                reviewer, raw, _ = call(reviewers, 'med', REVIEWER,
                                         ['# Current code\n\n' + code],
                                         f'review-{index}.md', 'review-B', review_effort)
                result['reviewer'] = reviewer
                reviewers = [reviewer]  # Same model for every subsequent review and takeover.
                review = parse_review(raw)
                (run_dir / f'review-{index}.json').write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding='utf-8')
                result['issues'] = review['issues']
                blockers = any(i['severity'] != 'minor' for i in review['issues'])
                if blockers:
                    review_effort = lambda m: effort_for(m,difficulty,escalation=True)
                if (review['verdict'] == 'approved' and not blockers) or (index == 2 and not blockers):
                    result['status'] = 'approved-with-notes' if review['issues'] else 'ready-for-tests'
                    break
                correction = ['# Current code\n\n' + code,
                              '# Errors and precise fixes\n\n' + json.dumps(review, ensure_ascii=False)]
                if index == 2:
                    model, code, artifact = call([reviewer], 'med', DEVELOPER + '\nFix all listed defects directly, in a single pass.',
                                                 correction, 'takeover.md', 'fix-B', lambda m: effort_for(m,difficulty,escalation=True))
                    result.update(writer=model, artifact=str(artifact), status='needs-verification')
                    break
                result['returns'] += 1
                writer, code, artifact = call(_prefer(router.TIERS['C'], writer), 'easy',
                                              DEVELOPER + '\nFix the errors the reviewer listed and return the complete code.',
                                              correction, f"code-{result['returns']}.md", 'fix-C', effort)
                result.update(writer=writer, artifact=str(artifact))
        print(f"# Result {work}: {result['status']}\n\n{code}")
        if result['issues']:
            print('\n# Review notes\n' + json.dumps(result['issues'], ensure_ascii=False, indent=2))
        print('\nReal tests still need to be run.' if tier != 'A' else '\nDesign to be developed in a B/C/BC task.')
        return 0
    except (ValueError, OSError) as exc:
        result['status'] = 'failed'
        result['error'] = str(exc)
        print(f"route-ask: {exc}; results kept in {run_dir}", file=sys.stderr)
        return 1
    finally:
        (run_dir / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
