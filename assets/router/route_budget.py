"""Provider quota snapshots and conservative balancing within an assigned role."""
from __future__ import annotations
import json
import math
import time
import urllib.error
import urllib.request
from pathlib import Path

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def parse_zai_limits(payload):
    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get('limits'), list):
        return []
    windows=[]
    for limit in data['limits']:
        if not isinstance(limit, dict) or limit.get('type') not in ('TOKENS_LIMIT','CREDIT_LIMIT'):
            continue  # MCP/monthly tool quotas cannot route code generation.
        percent=limit.get('percentage')
        if isinstance(percent, bool) or not isinstance(percent,(int,float)) or not math.isfinite(percent):
            continue
        unit=limit.get('unit')
        number=limit.get('number')
        label=f"tokens (unit={unit}, number={number})"
        if unit == 3 and number == 5: label='5h'
        elif unit == 6: label='week'
        reset=limit.get('nextResetTime')
        if isinstance(reset,(int,float)) and reset > 10**12: reset/=1000
        windows.append({'label':label,'percent':max(0,min(100,float(percent))), 'resets_at':reset})
    return windows

def zai_usage(route_dir, max_age=300):
    cache=Path(route_dir)/'zai-usage.json'
    try:
        cached=json.loads(cache.read_text(encoding='utf8'))
        if 0 <= time.time()-cached.get('ts',0) < max_age and cached.get('windows'):
            return cached
    except (OSError,ValueError,TypeError):pass
    key=None
    try:
        for line in (Path.home()/'.zai'/'env').read_text(encoding='utf8').splitlines():
            if line.strip().startswith('ZAI_API_KEY='):
                key=line.strip().split('=',1)[1].strip().strip("'\"")
                break
    except OSError:return None
    if not key:return None
    request=urllib.request.Request('https://api.z.ai/api/monitor/usage/quota/limit',
                                   headers={'Authorization':key,'Accept':'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect).open(request,timeout=10) as response:
            windows=parse_zai_limits(json.load(response))
        if not windows:return None
        snapshot={'ts':time.time(),'windows':windows}
        cache.parent.mkdir(parents=True,exist_ok=True)
        cache.write_text(json.dumps(snapshot,indent=2),encoding='utf8')
        return snapshot
    except (OSError,ValueError,urllib.error.URLError):return None

def effort_for(model, difficulty='medium', *, escalation=False):
    if model in ('gpt-6-luna','glm-5.3-flash'):return 'max'
    if model in ('claude-opus-5-5','claude-opus-5-5-antigravity'):return 'medium'
    return 'high' if escalation else {'easy':'low','medium':'medium','hard':'high'}[difficulty]

def choose_balanced(router,cfg,candidates,task_class,now=None):
    """Lower pressure first, retaining order inside a 5% band to avoid flapping.

    Pressure is max of 5h and week: a low 5h counter cannot hide an exhausted week.
    Availability guards and cooldown remain enforced by router.run_step.
    """
    now=time.time() if now is None else now
    rows=router.read_ledger()
    scores={m:router.pressure(cfg,rows,router.ACCOUNT[m],now) for m in candidates}
    return sorted(candidates,key=lambda m:int(scores[m]*100//5))
