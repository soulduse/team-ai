#!/usr/bin/env python3
"""Prompt-cache health from local Claude Code transcripts (~/.claude/projects/*/*.jsonl).
usage: affinity-metric.py <start_epoch> <end_epoch> [label]
Counts assistant turns with >=2K context tokens; a 'suspicious' cold turn is mid-session
(not first), <5min after the previous turn, yet cache_creation+input > cache_read —
the fingerprint an account switch leaves (compaction/tool-set changes also land here)."""
import json,glob,os,sys
from datetime import datetime
start=float(sys.argv[1]); end=float(sys.argv[2]); label=sys.argv[3] if len(sys.argv)>3 else ''
files=[f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) if os.path.getmtime(f)>=start-3600]
sessions=set(); turns=first=idle=susp=0; susp_tok=cr=cc=inp=0
for f in files:
    prev=None; n=0
    try:
        for line in open(f,errors='ignore'):
            if '"usage"' not in line: continue
            try: d=json.loads(line)
            except: continue
            if d.get('type')!='assistant': continue
            u=(d.get('message') or {}).get('usage') or {}
            r=u.get('cache_read_input_tokens',0) or 0; c=u.get('cache_creation_input_tokens',0) or 0; i=u.get('input_tokens',0) or 0
            if r+c+i<2000: continue
            try: t=datetime.fromisoformat(d['timestamp'].replace('Z','+00:00')).timestamp()
            except: continue
            n+=1
            if not (start<=t<end): prev=t; continue
            turns+=1; cr+=r; cc+=c; inp+=i; sessions.add(f)
            if (c+i)>r:
                if n==1: first+=1
                elif prev is None or t-prev>300: idle+=1
                else: susp+=1; susp_tok+=c+i
            prev=t
    except Exception: pass
tot=cr+cc+inp or 1
print(json.dumps({"label":label,"window_h":round((end-start)/3600,1),"sessions":len(sessions),"turns":turns,
  "cold_first":first,"cold_idle":idle,"cold_suspicious":susp,"suspicious_pct":round(susp/turns*100,2) if turns else None,
  "susp_rewrite_Mtok":round(susp_tok/1e6,1),"susp_Ktok_per_turn":round(susp_tok/1e3/turns,1) if turns else None,
  "cache_read_pct":round(cr/tot*100,2),"cache_write_Mtok":round(cc/1e6,1)}))
