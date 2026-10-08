"""Behavioral workflow tests: no provider, CLI or network calls."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

BIN = Path.home() / '.local' / 'bin'
import sys
sys.path.insert(0, str(BIN))
from route_workflow import run_workflow, parse_review
from route_budget import effort_for, parse_zai_limits, choose_balanced
loader = importlib.machinery.SourceFileLoader('router_under_test', str(BIN / 'route-ask'))
spec = importlib.util.spec_from_loader(loader.name, loader)
router = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = router
loader.exec_module(router)

MINOR = {'severity':'minor','path':'a.py','location':'f','problem':'un messaggio poco chiaro','fix':'chiarire il testo'}
MAJOR = dict(MINOR, severity='major', problem='risultato errato', fix='restituire 42')
def review(verdict='approved', issues=None):
    return json.dumps(dict(verdict=verdict,issues=issues or []))

class FakeRouter:
    TIERS = {'A':['a'], 'B':['b1','b2'], 'C':['c1','c2']}
    MODELS = {m:dict(tier=t) for t,ms in TIERS.items() for m in ms}
    PLANNER_ROLE = 'architecture only'
    def __init__(self, root, reviews, *, fail=None, empty=None):
        self.ROUTE_DIR=Path(root); self.reviews=iter(reviews); self.calls=[]
        self.fail=fail; self.empty=empty; self.briefs=[]
    def write_brief(self, parts):
        p=self.ROUTE_DIR / f'brief-{len(self.briefs)}.md';p.write_text('\n'.join(parts),encoding='utf8')
        self.briefs.append(p);return str(p)
    def run_step(self,cfg,candidates,cls,brief,effort,**kw):
        label=kw['label'];self.calls.append((label,list(candidates)))
        if label==self.fail:return 1,None
        if kw.get('dry_run'):return 0,candidates[0]
        output = next(self.reviews) if label=='revisiona-B' else f'complete code {len(self.calls)}'
        if label==self.empty:output=' '
        Path(kw['out_path']).write_text(output,encoding='utf8')
        return 0,candidates[0]

class WorkflowTests(unittest.TestCase):
    def run_case(self, reviews, work='BC', **kwargs):
        with tempfile.TemporaryDirectory() as root:
            fake=FakeRouter(root,reviews,**kwargs)
            args=SimpleNamespace(work=work,model=None,planner=None,writer=None,reviewer=None,dry_run=False,fast=False)
            with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
                rc=run_workflow(fake,{},args,'task','method')
            runs=list((Path(root)/'runs').iterdir())
            self.assertEqual(len(runs),1)
            result=json.loads((runs[0]/'result.json').read_text(encoding='utf8'))
            self.assertFalse(result['tests_executed'])
            self.assertTrue(all(not p.exists() for p in fake.briefs))
            return rc,result,fake.calls,out.getvalue()
    def test_a_only_architect(self):
        rc,r,calls,_=self.run_case([],work='A');self.assertEqual(rc,0)
        self.assertEqual(calls,[('progetta',['a'])]);self.assertEqual(r['status'],'planned')
    def test_b_direct_development(self):
        rc,r,calls,_=self.run_case([],work='B');self.assertEqual(rc,0)
        self.assertEqual(calls,[('sviluppa-B',['b1','b2'])])
    def test_c_direct_development(self):
        rc,r,calls,_=self.run_case([],work='C');self.assertEqual(rc,0)
        self.assertEqual(calls,[('sviluppa-C',['c1','c2'])])
    def test_bc_approved_immediately(self):
        rc,r,calls,_=self.run_case([review()]);self.assertEqual(rc,0)
        self.assertEqual(r['returns'],0);self.assertEqual(r['reviewer'],'b1')
        self.assertEqual(len(calls),2)
    def test_two_returns_same_reviewer_then_minor_notes(self):
        rc,r,calls,out=self.run_case([review('changes_requested',[MAJOR])]*2+[review('changes_requested',[MINOR])])
        self.assertEqual(rc,0);self.assertEqual(r['returns'],2)
        self.assertEqual(r['status'],'approved-with-notes')
        self.assertEqual([pool for label,pool in calls if label=='revisiona-B'],[['b1','b2'],['b1'],['b1']])
        self.assertEqual(len([c for c in calls if c[0]=='corregge-C']),2)
        self.assertNotIn('complete code 1\n',out);self.assertIn('complete code 5',out)
    def test_false_approved_major_still_requires_changes(self):
        rc,r,calls,_=self.run_case([review('approved',[MAJOR]),review()])
        self.assertEqual(rc,0);self.assertEqual(r['returns'],1)
    def test_major_after_two_returns_same_b_takeover_once(self):
        rc,r,calls,out=self.run_case([review('changes_requested',[MAJOR])]*3)
        self.assertEqual(rc,0);self.assertEqual(r['status'],'needs-verification')
        self.assertEqual(r['writer'],'b1');self.assertEqual(r['returns'],2)
        self.assertEqual(calls[-1],('corregge-B',['b1']))
        self.assertEqual(len(calls),7);self.assertIn('complete code 7',out)
    def test_unavailable_reviewer_stops_with_code_saved(self):
        rc,r,calls,out=self.run_case([],fail='revisiona-B')
        self.assertEqual(rc,1);self.assertEqual(r['status'],'failed')
        self.assertTrue(r['artifact'].endswith('code-0.md'));self.assertEqual(out,'')
    def test_invalid_review_stops_without_spending_on_correction(self):
        rc,r,calls,out=self.run_case(['looks good'])
        self.assertEqual(rc,1);self.assertEqual(len(calls),2);self.assertEqual(out,'')
    def test_empty_output_is_failure(self):
        rc,r,calls,out=self.run_case([],empty='sviluppa-C')
        self.assertEqual(rc,1);self.assertEqual(len(calls),1);self.assertEqual(out,'')
    def test_failed_final_takeover_never_approved(self):
        rc,r,calls,out=self.run_case([review('changes_requested',[MAJOR])]*3,fail='corregge-B')
        self.assertEqual(rc,1);self.assertEqual(r['status'],'failed');self.assertEqual(out,'')
    def test_review_protocol_accepts_only_structured_errors(self):
        self.assertEqual(parse_review('```json\n'+review()+'\n```')['issues'],[])
        for invalid in ['[]','{}',review('changes_requested'),review('approved',[dict(MAJOR,fix='')]),
                        review('approved',[dict(MAJOR,severity='warning')])]:
            with self.assertRaises(ValueError):parse_review(invalid)

class DispatchTests(unittest.TestCase):
    def test_unavailable_model_fallback_no_cooldown(self):
        # Same-tier B candidate; stub both provider dispatches, do not spawn real CLIs.
        events=[]
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'task.md';p.write_text('task')
            with patch.object(router,'choose_balanced',side_effect=lambda r,c,p,t:list(p)),patch.object(router,'read_ledger',return_value=[]),patch.object(router,'has_headroom',return_value=(True,'')), \
                 patch.object(router,'dispatch',side_effect=[(1,'model is not supported when using Codex with a ChatGPT account'),(0,'ok')]), \
                 patch.object(router,'append_ledger',side_effect=events.append),contextlib.redirect_stderr(io.StringIO()):
                rc,m=router.run_step({},['claude-sonnet-5-5','gpt-6.1-sol'],'med',str(p),lambda _:'high')
            self.assertEqual((rc,m),(0,'gpt-6.1-sol'))
            self.assertEqual([e['event'] for e in events],['dispatch'])
    def test_real_success_text_mentions_quota_is_not_rate_limit(self):
        events=[]
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'task.md';p.write_text('task')
            with patch.object(router,'choose_balanced',side_effect=lambda r,c,p,t:list(p)),patch.object(router,'read_ledger',return_value=[]),patch.object(router,'has_headroom',return_value=(True,'')), \
                 patch.object(router,'dispatch',return_value=(0,'429 quota rate_limit')), \
                 patch.object(router,'append_ledger',side_effect=events.append),contextlib.redirect_stderr(io.StringIO()):
                rc,m=router.run_step({},['gpt-6.1-sol'],'med',str(p),lambda _:'high')
            self.assertEqual(rc,0);self.assertEqual([e['event'] for e in events],['dispatch'])

class BudgetTests(unittest.TestCase):
    def test_exact_effort_policy(self):
        for difficulty in ('easy','medium','hard'):
            self.assertEqual(effort_for('gpt-6-luna',difficulty),'max')
            self.assertEqual(effort_for('glm-5.3-flash',difficulty),'max')
            self.assertEqual(effort_for('claude-opus-5-5',difficulty),'medium')
        for model in ('claude-sonnet-5-5','gpt-6.1-sol'):
            self.assertEqual([effort_for(model,d) for d in ('easy','medium','hard')],['low','medium','high'])
            self.assertEqual(effort_for(model,'easy',escalation=True),'high')
    def test_zai_real_5h_and_week_credit_limits(self):
        result=parse_zai_limits({'data':{'limits':[
            {'type':'CREDIT_LIMIT','percentage':12,'unit':3,'number':5,'nextResetTime':1790792803773},
            {'type':'CREDIT_LIMIT','percentage':7,'unit':6,'number':1},
            {'type':'TIME_LIMIT','percentage':100},
        ]}})
        self.assertEqual([w['label'] for w in result],['5h','week'])
        self.assertEqual([w['percent'] for w in result],[12,7])
        self.assertAlmostEqual(result[0]['resets_at'],1790792803.773)
        self.assertEqual(parse_zai_limits({'data':{'limits':[{'type':'CREDIT_LIMIT','percentage':'bad'}]}}),[])
    def test_balance_changes_with_provider_consumption(self):
        levels={'claude':.8,'openai':.4,'zai':.1,'antigravity':.95,'locale':0.0}
        # Linux: i modelli locali gratis (pressione 0) restano in testa alla C;
        # tra quelli a pagamento vale lo stesso bilanciamento di Windows.
        fake=SimpleNamespace(read_ledger=lambda:[],ACCOUNT=router.ACCOUNT,pressure=lambda c,r,a,n:levels[a])
        local=getattr(router,'LOCAL_MODELS',())
        if local:
            self.assertIn(choose_balanced(fake,{},router.TIERS['C'],'easy')[0],local)
        paid_c=[m for m in router.TIERS['C'] if m not in local]
        self.assertEqual(choose_balanced(fake,{},router.TIERS['B'],'med')[0],'gpt-6.1-sol')
        levels.update(claude=.2,openai=.8)
        self.assertEqual(choose_balanced(fake,{},router.TIERS['B'],'med')[0],'claude-sonnet-5-5')
        self.assertEqual(choose_balanced(fake,{},paid_c,'easy')[0],'glm-5.3-flash')
        levels.update(zai=.9,openai=.4)
        self.assertEqual(choose_balanced(fake,{},paid_c,'easy')[0],'gpt-6-luna')
        levels.update(antigravity=.1)  # quota Antigravity quasi libera: Opus e Sonnet (Antigravity) passano davanti ai nativi
        self.assertEqual(choose_balanced(fake,{},router.TIERS['A'],'hard')[0],'claude-opus-5-5-antigravity')
        self.assertEqual(choose_balanced(fake,{},router.TIERS['B'],'med')[0],'claude-sonnet-5-5-antigravity')
    def test_pressure_week_cannot_be_hidden_by_5h(self):
        cfg={'openai':{'per_5h':100,'per_week':100}}
        with patch.object(router,'codex_real_limits',return_value={'primary':{'used_percent':4},'secondary':{'used_percent':92}}):
            self.assertEqual(router.pressure(cfg,[],'openai',0),.92)
    def test_claude_and_codex_cli_receive_real_effort_arguments(self):
        with tempfile.TemporaryDirectory() as root:
            brief=Path(root)/'task.md';brief.write_text('task')
            output=Path(root)/'out.md'
            with patch.object(router.subprocess,'run') as run:
                run.return_value.returncode=0
                router.dispatch({},'claude-opus-5-5',str(brief),'medium',out_path=str(output))
                argv=run.call_args.args[0]
                self.assertEqual(argv[argv.index('--effort')+1],'medium')
            with patch.object(router,'run_capped',return_value=0) as run:
                router.dispatch({},'gpt-6-luna',str(brief),'max',fast=True,out_path=str(output))
                self.assertIn('model_reasoning_effort=max',run.call_args.args[0])

if __name__=='__main__':unittest.main()
